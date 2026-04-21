import { test, expect } from "@playwright/test";
import {
  installSessionStubs,
  openSessionsTab,
  happyProject,
  recapSession,
  THROW_SENTINEL,
} from "./_helpers/stubs";

test.describe("recap → instant brief", () => {
  test("recap-backed brief renders without hitting generate_session_brief", async ({ page }) => {
    await installSessionStubs(page, {
      projects: [happyProject],
      sessions: [recapSession],
      extra: {
        // Recap-derived brief, shape identical to what get_session_brief
        // returns in production when the Rust side successfully extracted
        // a `※ recap:` line from the JSONL.
        get_session_brief: {
          sessionId: recapSession.id,
          youWere: "Built the end-to-end ETL pipeline with three stages",
          progress: "all smoke tests pass.",
          nextLikely: "wire up the Grafana dashboard.",
          sourceMtimeMs: recapSession.modified_ms,
          generatedAt: new Date().toISOString(),
        },
        // Bomb if the LLM path fires for a session that already has a
        // recap — that would mean the recap-first code path regressed.
        generate_session_brief: THROW_SENTINEL,
      },
    });

    await page.goto("/");
    await openSessionsTab(page);

    const card = page.locator(".session-card").first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText("Built the end-to-end ETL pipeline");
    await expect(card).toContainText("wire up the Grafana dashboard");
  });
});
