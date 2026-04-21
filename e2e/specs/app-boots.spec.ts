import { test, expect } from "@playwright/test";

test.describe("app boot", () => {
  test("app loads and shows the primary tabs", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".app")).toBeVisible();
    // Tab strip is the main nav chrome; if any of these shift we want the
    // test to flag it loudly — rename + update here.
    await expect(page.getByRole("tablist")).toBeVisible();
    const tabItems = page.locator(".tabs__item");
    expect(await tabItems.count()).toBeGreaterThanOrEqual(3);
  });

  test("first paint lands under the perf budget", async ({ page }) => {
    const t0 = Date.now();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".app")).toBeVisible();
    const elapsed = Date.now() - t0;
    // Budget from docs/TESTING-PLAN.md — generous for CI cold-cache.
    // Fires early-warning before the release smoke budget (2s/3.5s).
    expect(elapsed).toBeLessThan(5000);
  });
});
