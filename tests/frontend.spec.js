import { expect, test } from "@playwright/test";
import { readSheet } from "read-excel-file/node";
import writeWorkbook from "write-excel-file/node";
import decode from "jsqr";

async function register(page, identifier = "STF-TEST") {
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByLabel("Full name", { exact: true }).fill("Taylor Demo");
  await page.getByLabel("Staff ID", { exact: true }).fill(identifier);
  await page.getByLabel("Department", { exact: true }).fill("Operations");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Choose a drink" })).toBeVisible();
}

async function issueCode(page) {
  await page.getByRole("button", { name: "Continue" }).click();
  const qr = page.getByRole("img", { name: "Voucher QR code" });
  await expect(qr).toBeVisible();
  const src = await qr.getAttribute("src");
  const pixels = await qr.evaluate(async (img) => {
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(img, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let pixels = "";
    for (let offset = 0; offset < data.length; offset += 32_768) {
      pixels += String.fromCharCode(...data.subarray(offset, offset + 32_768));
    }
    return btoa(pixels);
  });
  const data = Buffer.from(pixels, "base64");
  const side = Math.sqrt(data.length / 4);
  const code = decode(new Uint8ClampedArray(data), side, side)?.data;
  expect(code).toMatch(/^drink-pass:[0-9a-f-]{36}$/);
  return { code, src };
}

async function enterCode(page, code) {
  await page.getByLabel("Demo voucher code").fill(code);
  await page.getByRole("button", { name: "Scan code" }).click();
}

test("camera decodes a Staff voucher and updates receipt, balance, stock and orders once", async ({ page, context }) => {
  await page.goto("/");
  await register(page);
  await page.getByRole("radio", { name: "Sparkling water" }).check();
  const { code, src } = await issueCode(page);

  const bar = await context.newPage();
  await bar.addInitScript(({ qr }) => {
    const camera = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 400;
      const image = new Image();
      image.src = qr;
      await image.decode();
      const stream = canvas.captureStream(15);
      const paint = () => canvas.getContext("2d").drawImage(image, 0, 0);
      paint();
      const interval = setInterval(() => {
        if (!stream.active) clearInterval(interval);
        else paint();
      }, 65);
      return stream;
    };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: camera });
  }, { qr: src });

  await bar.goto("/bartender?demo=1&bar=Bar%202");
  await expect(bar.getByRole("heading", { name: "Scan a voucher" })).toBeVisible();
  await bar.getByRole("button", { name: "Enable camera" }).click();
  await expect(bar.getByRole("heading", { name: "Serve this drink" })).toBeVisible();
  await expect(bar.getByText("Taylor Demo · STF-TEST")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Voucher redeemed" })).toBeVisible();
  await expect(page.getByRole("dialog").getByText("4 drinks left")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await page.reload();
  await expect(page.getByText("4 drinks left")).toBeVisible();

  const secondBar = await context.newPage();
  await secondBar.goto("/bartender?demo=1");
  await enterCode(secondBar, code);
  await expect(secondBar.getByRole("heading", { name: "Already redeemed" })).toBeVisible();
  await expect(secondBar.getByText("Taylor Demo · Sparkling water")).toBeVisible();

  const admin = await context.newPage();
  await admin.goto("/admin");
  await admin.getByRole("button", { name: "Stock" }).click();
  await expect(admin.getByRole("button", { name: "Sparkling water · 17 bottles" })).toBeVisible();
  await admin.getByRole("button", { name: "Orders" }).click();
  await admin.getByLabel("Filter by bartender").selectOption("Bar 2");
  await expect(admin.locator(".order-list li")).toHaveCount(1);
  await expect(admin.getByText("Taylor Demo · STF-TEST")).toBeVisible();
  const downloadPromise = admin.waitForEvent("download");
  await admin.getByRole("button", { name: "Export spreadsheet" }).click();
  const download = await downloadPromise;
  const rows = await readSheet(await download.path());
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual(["Drink", "Guest", "Date", "Time", "Bartender"]);
  expect(rows[1]).toEqual(["Sparkling water", "Taylor Demo", expect.any(String), expect.any(String), "Bar 2"]);

  await admin.evaluate(() => { window.print = () => { document.body.dataset.printed = "yes"; }; });
  await admin.getByRole("button", { name: "Export PDF" }).click();
  await expect(admin.locator("body")).toHaveAttribute("data-printed", "yes");
  await admin.emulateMedia({ media: "print" });
  await expect(admin.getByRole("table").getByText("Taylor Demo")).toBeVisible();
  await expect(admin.getByRole("table").getByText("STF-TEST")).toHaveCount(0);
  await expect(admin.getByRole("table").getByText("Operations")).toHaveCount(0);
  await expect(admin.getByRole("table").getByText("Alex Kamau")).toHaveCount(0);
  expect((await admin.pdf()).subarray(0, 5).toString()).toBe("%PDF-");
});

test("expiry and cancellation preserve balances, and offline retry records only after reconnection", async ({ page, context }) => {
  await page.clock.install();
  await page.goto("/staff?demo=1");
  await register(page);
  const expired = await issueCode(page);
  await expect(page.getByText("120 seconds left")).toHaveCount(1);
  await page.clock.fastForward(30_000);
  await expect(page.getByText("90 seconds left")).toHaveCount(1);
  await page.clock.fastForward(90_000);
  await expect(page.getByRole("heading", { name: "Voucher expired" })).toBeVisible();
  await page.getByRole("button", { name: "Back to drinks" }).click();
  await expect(page.getByText("5 drinks left")).toBeVisible();

  const bar = await context.newPage();
  await bar.clock.install({ time: new Date(Date.now() + 125_000) });
  await bar.goto("/bartender?demo=1");
  await enterCode(bar, expired.code);
  await expect(bar.getByRole("heading", { name: "Voucher expired" })).toBeVisible();
  await bar.getByRole("button", { name: "Scan next" }).click();

  const cancelled = await issueCode(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("5 drinks left")).toBeVisible();
  await enterCode(bar, cancelled.code);
  await expect(bar.getByRole("heading", { name: "Voucher not recognized" })).toBeVisible();
  await bar.getByRole("button", { name: "Scan next" }).click();

  const active = await issueCode(page);
  await context.setOffline(true);
  await enterCode(bar, active.code);
  await expect(bar.getByRole("heading", { name: "No connection" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Show this at the bar" })).toBeVisible();
  await context.setOffline(false);
  await bar.getByRole("button", { name: "Try again" }).click();
  await expect(bar.getByRole("heading", { name: "Serve this drink" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Voucher redeemed" })).toBeVisible();
});

test("Manager details are prefilled and Staff see the zero-balance screen after the final drink", async ({ page, context }) => {
  await page.goto("/manager?demo=1");
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.getByLabel("Full name")).toHaveValue("Sam Kato");
  await expect(page.getByLabel("Full name")).toHaveAttribute("readonly", "");
  await expect(page.getByLabel("Department")).toHaveValue("Operations");
  await expect(page.getByText("Registered as Manager")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("radio")).toHaveCount(3);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Choose a drink" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Simulate successful scan" }).click();
  await expect(page.getByRole("heading", { name: "Voucher redeemed" })).toBeVisible();
  await expect(page.getByRole("dialog").getByText(/drinks left/)).toHaveCount(0);

  const staff = await context.newPage();
  await staff.goto("/staff?demo=1");
  await register(staff, "STF-042");
  for (const remaining of [1, 0]) {
    await staff.getByRole("button", { name: "Continue" }).click();
    await staff.getByRole("button", { name: "Simulate successful scan" }).click();
    await expect(staff.getByRole("dialog").getByText(remaining === 1 ? "1 drink left" : "0 drinks left")).toBeVisible();
    await staff.getByRole("button", { name: "Done" }).click();
  }
  await expect(staff.getByRole("heading", { name: "No drinks left" })).toBeVisible();
  await staff.reload();
  await expect(staff.getByRole("heading", { name: "No drinks left" })).toBeVisible();
});

test("Admin imports and searches guests, adds stock, and updates the Staff menu", async ({ page, context }) => {
  await page.goto("/admin");
  const workbook = await writeWorkbook([
    ["Full name", "Identifier", "Department", "Vouchers"],
    ["Imported Demo", "STF-IMPORT", "Operations", 3],
    ["Alex Kamau", "STF-042", "Operations", 2],
  ]).toBuffer();
  await page.getByRole("button", { name: "Import" }).click();
  const panel = page.getByRole("dialog");
  await panel.getByLabel("Excel workbook").setInputFiles({
    name: "guests.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbook,
  });
  await panel.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText("1 imported. 1 duplicates skipped.")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search guests" }).fill("imported");
  await expect(page.getByText("Imported Demo · 3 left")).toBeVisible();
  await expect(page.getByText("Alex Kamau")).toHaveCount(0);

  await page.getByRole("button", { name: "Add guest" }).click();
  await panel.getByLabel("Full name").fill("Added Demo");
  await panel.getByLabel("Identifier", { exact: true }).fill("STF-ADD");
  await panel.getByLabel("Department").fill("Operations");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("searchbox", { name: "Search guests" }).fill("added");
  await expect(page.getByText("Added Demo · 5 left")).toBeVisible();

  await page.getByRole("button", { name: "Stock" }).click();
  await page.getByRole("button", { name: "Add drink" }).click();
  await panel.getByLabel("Drink name").fill("Lemonade");
  await panel.getByLabel("Bottles in stock").fill("7");
  await panel.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Lemonade · 7 bottles" }).click();
  await panel.getByLabel("Bottles in stock").fill("0");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Lemonade · 0 bottles" })).toBeVisible();

  const staff = await context.newPage();
  await staff.goto("/");
  await register(staff, "STF-IMPORT");
  await expect(staff.getByText("3 drinks left")).toBeVisible();
  await expect(staff.getByRole("radio", { name: /Lemonade.*Out of stock/ })).toBeDisabled();
});

test("registration validates through the form and fits a short phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Full name")).toBeFocused();
  await expect(page.getByText("Full name is required.")).toBeVisible();
  await page.getByLabel("Staff ID", { exact: true }).fill("STF-123");
  await page.getByRole("button", { name: "Phone number" }).click();
  await expect(page.getByLabel("Phone number", { exact: true })).toHaveAttribute("inputmode", "tel");
  await expect(page.getByLabel("Phone number", { exact: true })).toHaveValue("");
  await page.getByLabel("Phone number", { exact: true }).fill("5550100");
  await page.getByRole("button", { name: "Staff ID" }).click();
  await expect(page.getByLabel("Staff ID", { exact: true })).toHaveValue("STF-123");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

test("Guest voucher sheet keeps focus through expiry and can renew the same drink", async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/staff?demo=1");
  await register(page);
  await expect(page.getByRole("heading", { name: "Choose a drink" })).toBeFocused();
  await page.getByRole("radio", { name: "Sparkling water" }).check();
  const original = await issueCode(page);
  const dialog = page.getByRole("dialog");
  const sheet = await dialog.elementHandle();
  await expect(dialog.getByRole("heading", { name: "Show this at the bar" })).toBeFocused();
  await expect(dialog).toHaveCSS("animation-name", "sheet-enter");

  await page.clock.fastForward(91_000);
  await expect(dialog.getByText("Expires soon")).toBeVisible();
  await expect(dialog.getByText("30 seconds left")).toHaveCount(1);
  await page.clock.fastForward(30_000);
  await expect(dialog.getByRole("heading", { name: "Voucher expired" })).toBeFocused();
  expect(await sheet.evaluate((node) => node.isConnected && node.open)).toBe(true);

  await dialog.getByRole("button", { name: "Get a new voucher" }).click();
  await expect(dialog.getByRole("heading", { name: "Show this at the bar" })).toBeFocused();
  await expect(dialog.getByText("Sparkling water")).toBeVisible();
  await expect(dialog.getByText("120 seconds left")).toHaveCount(1);
  await expect(dialog.getByRole("img", { name: "Voucher QR code" })).not.toHaveAttribute("src", original.src);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(dialog).toHaveCSS("animation-name", "none");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Continue" })).toBeFocused();
  await expect(page.getByText("5 drinks left")).toBeVisible();
});

test("Bartender manages availability and restocks drinks across guest menus", async ({ page: bar, context }) => {
  await bar.goto("/bartender?demo=1");
  const nav = bar.getByRole("navigation", { name: "Bartender sections" });
  await expect(nav.getByRole("button", { name: "Scan", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(bar.getByRole("button", { name: "Add drink" })).toHaveCount(0);
  await nav.getByRole("button", { name: "Drinks" }).click();
  await expect(bar.getByRole("heading", { name: "Drinks and stock" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Drinks" })).toHaveAttribute("aria-current", "page");
  await bar.getByRole("button", { name: "Add drink" }).click();
  const dialog = bar.getByRole("dialog");
  await dialog.getByLabel("Drink name").fill("Tonic water");
  await dialog.getByLabel("Bottles in stock").fill("1");
  await dialog.getByRole("button", { name: "Save" }).click();
  const tonic = bar.getByRole("listitem", { name: "Tonic water" });
  await expect(tonic.getByText("1 bottle · Available")).toBeVisible();

  const staff = await context.newPage();
  await staff.goto("/staff");
  await register(staff);
  await staff.getByRole("radio", { name: "Tonic water" }).check();
  const { code } = await issueCode(staff);
  await bar.getByRole("button", { name: "Disable Tonic water" }).click();
  await expect(tonic.getByText("1 bottle · Disabled")).toBeVisible();

  const manager = await context.newPage();
  await manager.goto("/manager");
  await manager.getByRole("button", { name: "Get started" }).click();
  await manager.getByRole("button", { name: "Continue" }).click();
  await expect(manager.getByRole("radio", { name: /Tonic water.*Unavailable/ })).toBeDisabled();

  await nav.getByRole("button", { name: "Scan", exact: true }).click();
  await expect(nav.getByRole("button", { name: "Scan", exact: true })).toHaveAttribute("aria-current", "page");
  await enterCode(bar, code);
  await expect(bar.getByRole("heading", { name: "Drink unavailable" })).toBeVisible();
  await expect(staff.getByRole("heading", { name: "Show this at the bar" })).toBeVisible();
  await nav.getByRole("button", { name: "Drinks" }).click();
  await bar.getByRole("button", { name: "Enable Tonic water" }).click();
  await expect(manager.getByRole("radio", { name: "Tonic water" })).toBeEnabled();
  await nav.getByRole("button", { name: "Scan", exact: true }).click();
  await expect(bar.getByRole("heading", { name: "Drink unavailable" })).toBeVisible();
  await bar.getByRole("button", { name: "Scan next" }).click();
  await enterCode(bar, code);
  await expect(bar.getByRole("heading", { name: "Serve this drink" })).toBeVisible();
  await expect(staff.getByRole("dialog").getByText("4 drinks left")).toBeVisible();
  await expect(manager.getByRole("radio", { name: /Tonic water.*Out of stock/ })).toBeDisabled();

  await nav.getByRole("button", { name: "Drinks" }).click();
  await expect(tonic.getByText("0 bottles · Out of stock")).toBeVisible();
  await bar.getByRole("button", { name: "Restock Tonic water" }).click();
  await dialog.getByLabel("Bottles to add").fill("3");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(tonic.getByText("3 bottles · Available")).toBeVisible();
  await expect(manager.getByRole("radio", { name: "Tonic water" })).toBeEnabled();

  await bar.getByRole("button", { name: "Edit stock for Tonic water" }).click();
  await dialog.getByLabel("Bottles in stock").fill("0");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(tonic.getByText("0 bottles · Out of stock")).toBeVisible();
  await expect(manager.getByRole("radio", { name: /Tonic water.*Out of stock/ })).toBeDisabled();
});
