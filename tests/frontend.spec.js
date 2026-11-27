import { expect, test } from "@playwright/test";
import { readSheet } from "read-excel-file/node";
import writeWorkbook from "write-excel-file/node";
import QRCode from "qrcode";

async function seedRehearsalVoucher(page) {
  const guest = {
    id: "scan-guest", fullName: "Taylor Demo", identifier: "STF-TEST",
    department: "Operations", role: "staff", allowance: 5, remaining: 5,
  };
  const id = "10000000-1000-4000-8000-000000000001";
  await page.addInitScript(({ guest, id }) => {
    if (localStorage.getItem("drink-pass-event-v1")) return;
    localStorage.setItem("drink-pass-event-v1", JSON.stringify({
      guests: [guest],
      drinks: [{ id: "sparkling-water", name: "Sparkling water", stock: 18 }],
      vouchers: { [id]: { id, guestId: guest.id, drinkId: "sparkling-water", status: "open", expiresAt: Date.now() + 120000 } },
      orders: [],
    }));
  }, { guest, id });
  return "drink-pass:" + id;
}

async function enterCode(page, code) {
  await page.getByLabel("Demo voucher code").fill(code);
  await page.getByRole("button", { name: "Scan code" }).click();
}

test("old guest links show physical-card instructions without loading live data", async ({ page }) => {
  const rpcCalls = [];
  page.on("request", (request) => {
    if (request.url().includes("/rest/v1/rpc/") || request.url().includes("/auth/v1/")) rpcCalls.push(request.url());
  });
  for (const url of [
    "/staff", "/manager?demo=1", "/?role=staff&backend=1",
    "/?role=manager&backend=1&event=00000000-0000-4000-8000-000000000001",
    "/manager?role=admin",
  ]) {
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "Use your physical Drink Pass card" })).toBeVisible();
    await expect(page.getByText("Show your card to the bartender.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Get started" })).toHaveCount(0);
    await expect(page.getByLabel("Invitation code")).toHaveCount(0);
  }
  expect(rpcCalls).toEqual([]);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Guest list" })).toBeVisible();
});

test("the rehearsal scanner records one order and Admin exports it", async ({ page: bar, context }) => {
  const code = await seedRehearsalVoucher(bar);
  const src = await QRCode.toDataURL(code);
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

test("Admin still imports and adds Staff and Manager guests", async ({ page }) => {
  await page.goto("/admin");
  const workbook = await writeWorkbook([
    ["Full name", "Identifier", "Department", "Role", "Vouchers"],
    ["Imported Demo", "STF-IMPORT", "Operations", "staff", 3],
    ["Alex Kamau", "STF-042", "Operations", "staff", 2],
    ["Imported Manager", "MGR-IMPORT", "Operations", "manager", ""],
  ]).toBuffer();
  await page.getByRole("button", { name: "Import" }).click();
  const panel = page.getByRole("dialog");
  await panel.getByLabel("Excel workbook").setInputFiles({
    name: "guests.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbook,
  });
  await panel.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText("2 imported. 1 duplicates skipped.")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search guests" }).fill("imported");
  await expect(page.getByText("Imported Demo · 3 left")).toBeVisible();
  await expect(page.getByText("Imported Manager · Manager")).toBeVisible();
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

  await expect(page.getByRole("button", { name: /copy invitation/i })).toHaveCount(0);
});

test("the rehearsal bartender can still manage the rehearsal drink list", async ({ page: bar }) => {
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

  await bar.getByRole("button", { name: "Disable Tonic water" }).click();
  await expect(tonic.getByText("1 bottle · Disabled")).toBeVisible();
  await bar.getByRole("button", { name: "Enable Tonic water" }).click();
  await expect(tonic.getByText("1 bottle · Available")).toBeVisible();
  await bar.getByRole("button", { name: "Restock Tonic water" }).click();
  await dialog.getByLabel("Bottles to add").fill("3");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(tonic.getByText("4 bottles · Available")).toBeVisible();
});

test("live Admin offers a stock-free card menu and no guest access links", async ({ page }) => {
  const event = {
    id: "10000000-1000-4000-8000-000000000001",
    name: "Card event", date: "2026-11-27", usesCards: true, defaultVouchers: 5,
  };
  const guest = {
    id: "guest", fullName: "Test Manager", identifier: "MGR-TEST", department: "Test", role: "manager",
    invite: "old-test-invite-do-not-display", remaining: null,
  };
  const drinks = [{ id: "tonic", name: "Tonic", active: true }];
  await page.addInitScript(() => {
    localStorage.setItem("drink-pass-auth-admin", JSON.stringify({
      access_token: "local-test-token",
      refresh_token: "local-test-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: "test-admin" },
    }));
  });
  await page.route("**/rest/v1/rpc/drink_pass_state", (route) => route.fulfill({
    json: { event, events: [event], guests: [guest], drinks, orders: [] },
  }));
  await page.route("**/rest/v1/rpc/drink_pass_card_menu", (route) => {
    const { p_action: action, p_values: values, p_event: selectedEvent } = route.request().postDataJSON();
    expect(selectedEvent).toBe(event.id);
    if (action === "enable") {
      expect(values).toEqual({ id: "tonic", enabled: false });
      drinks[0].active = values.enabled;
    } else {
      expect(action).toBe("add");
      expect(values).toEqual({ name: "Lime soda" });
      drinks.push({ id: "lime", name: values.name, active: true });
    }
    return route.fulfill({ json: true });
  });

  await page.goto("/?backend=1&role=admin&event=" + event.id);
  await expect(page.getByText("Test Manager · Manager")).toBeVisible();
  await expect(page.getByText("Guests use physical cards. Bartenders use the Flutter app.")).toBeVisible();
  await expect(page.getByRole("button", { name: /copy invitation/i })).toHaveCount(0);
  await expect(page.getByRole("link")).toHaveCount(0);
  await page.getByRole("button", { name: "Drinks", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Drink menu" })).toBeVisible();
  await page.getByRole("button", { name: "Disable Tonic" }).click();
  await expect(page.getByText("Tonic · Disabled")).toBeVisible();
  await page.getByRole("button", { name: "Add drink" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Bottles in stock")).toHaveCount(0);
  await dialog.getByLabel("Drink name").fill("Lime soda");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Lime soda · Enabled")).toBeVisible();
});
