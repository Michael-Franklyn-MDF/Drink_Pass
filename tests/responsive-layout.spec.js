import { expect, test } from "@playwright/test";

test("all screen headers stay near the top across phone heights without a home indicator", async ({ page }) => {
  for (const role of ["staff", "manager", "bartender", "admin"]) {
    await page.goto(`/${role}?demo=1`);

    const topBar = page.locator(".top-bar");
    await expect(topBar).toBeVisible();
    await expect(page.locator(".home-indicator")).toHaveCount(0);

    for (const height of [667, 852, 932]) {
      await page.setViewportSize({ width: 393, height });
      const top = await topBar.evaluate((element) => element.getBoundingClientRect().top);
      expect(top).toBeGreaterThanOrEqual(24);
      expect(top).toBeLessThanOrEqual(44);
    }
  }
});

test("bartender scan layout fits the reference and a short phone viewport", async ({ page }) => {
  for (const height of [812, 667]) {
    await page.setViewportSize({ width: 402, height });
    await page.goto("/bartender?demo=1");

    await expect(page.locator(".screen-title")).toBeVisible();
    await expect(page.locator(".scanner-view")).toBeVisible();
    await expect(page.getByRole("button", { name: "Enable camera" })).toBeVisible();
    await expect(page.locator(".bottom-nav")).toBeVisible();

    const layout = await page.evaluate(() => {
      const bounds = (selector) => {
        const { top, right, bottom } = document.querySelector(selector).getBoundingClientRect();
        return { top, right, bottom };
      };
      return {
        pageHeight: document.documentElement.scrollHeight,
        scanner: bounds(".scanner-view"),
        action: bounds(".screen-actions .button-primary"),
        navigation: bounds(".bottom-nav"),
      };
    });

    expect(layout.pageHeight).toBeLessThanOrEqual(height);
    expect(layout.scanner.right).toBeLessThanOrEqual(402);
    expect(layout.scanner.bottom).toBeLessThan(layout.action.top);
    expect(layout.action.bottom).toBeLessThan(layout.navigation.top);
    expect(layout.navigation.bottom).toBeLessThanOrEqual(height);
  }
});
