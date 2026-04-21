import { test, expect } from "@playwright/test";
import {
  installSessionStubs,
  openSessionsTab,
  happyProject,
  happySession,
  compactedSession,
  recapSession,
} from "./_helpers/stubs";

test.describe("session dashboard", () => {
  test("renders three session cards with correct state badges", async ({ page }) => {
    await installSessionStubs(page, {
      projects: [happyProject],
      sessions: [happySession, compactedSession, recapSession],
    });
    await page.goto("/");
    await openSessionsTab(page);

    const cards = page.locator(".session-card");
    await expect(cards).toHaveCount(3, { timeout: 10_000 });

    // The compacted session is our regression anchor for the /compact
    // awaiting-vs-generating fix. It must show FOR REVIEW (green),
    // not GENERATING (red). We filter by its unique first_user_preview
    // text because cards only render the first 8 chars of the id.
    const compactedCard = cards.filter({ hasText: "add a test for the parser" });
    await expect(compactedCard).toHaveCount(1);
    await expect(compactedCard.locator(".session-card__status")).not.toContainText("GENERATING");
  });

  test("spawn_label is rendered when no real user ask exists", async ({ page }) => {
    const toolSpawned = {
      ...happySession,
      id: "subagent-001",
      first_user_preview: null,
      last_user_preview: null,
      spawn_label: "[tool: Task]",
    };
    await installSessionStubs(page, {
      projects: [happyProject],
      sessions: [toolSpawned],
    });
    await page.goto("/");
    await openSessionsTab(page);

    const card = page.locator(".session-card").first();
    await expect(card).toContainText("[tool: Task]", { timeout: 10_000 });
  });
});
