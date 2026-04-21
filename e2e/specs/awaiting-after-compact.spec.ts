import { test, expect } from "@playwright/test";
import { installSessionStubs, openSessionsTab, happyProject, compactedSession } from "./_helpers/stubs";

test.describe("/compact post-condition", () => {
  test("session that just ran /compact shows FOR REVIEW, not GENERATING", async ({ page }) => {
    // The Rust side of this already has a regression test
    // (sessions.rs :: awaiting_skips_compact_command_wrappers). This spec
    // locks in the end-to-end wiring so a future change that disconnects
    // `awaiting_user` from the UI status badge fails loudly.
    await installSessionStubs(page, {
      projects: [happyProject],
      sessions: [compactedSession],
    });
    await page.goto("/");
    await openSessionsTab(page);

    const card = page.locator(".session-card").first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator(".session-card__status")).toContainText("FOR REVIEW");
  });
});
