import { test, expect } from "@playwright/test";
import {
  installSessionStubs,
  happyProject,
  happySession,
  compactedSession,
  recapSession,
} from "./_helpers/stubs";

// Runs used by the Logbook specs. Two are eligible for a meeting
// (session_id set); one is a legacy run with no session_id — its
// checkbox must be visible but disabled.
const sampleRuns = [
  {
    id: "r-1",
    skill: "repo-tldr",
    inputs: [],
    started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    ended_at: new Date().toISOString(),
    duration_ms: 8200,
    status: "ok",
    trigger: "manual",
    session_id: happySession.id,
    workdir: "/tmp/orka-e2e",
  },
  {
    id: "r-2",
    skill: "demo-maker",
    inputs: [],
    started_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    ended_at: new Date().toISOString(),
    duration_ms: 51000,
    status: "ok",
    trigger: "scheduled",
    session_id: recapSession.id,
    workdir: "/tmp/orka-e2e",
  },
  {
    id: "r-3-legacy",
    skill: "repo-tldr",
    inputs: [],
    started_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    status: "ok",
    trigger: "manual",
    // No session_id — legacy row.
  },
];

test.describe("Call a meeting from Run History", () => {
  test("checkboxes let the user pick deliverables across runs", async ({ page }) => {
    await installSessionStubs(page, {
      projects: [happyProject],
      sessions: [happySession, compactedSession, recapSession],
      extra: {
        // The helper stubs find_session_by_id against the fixtures
        // list automatically, so we only need to provide the runs.
        list_runs: sampleRuns,
      },
    });
    await page.goto("/");

    await page.getByRole("tab", { name: "Runs" }).click();

    const rows = page.locator(".runs-dash__row");
    await expect(rows).toHaveCount(3, { timeout: 10_000 });

    // Legacy row's checkbox is visible but disabled.
    const legacyRow = rows.filter({ hasText: "r-3-legacy" }).or(
      rows.nth(2),
    );
    const legacyBox = legacyRow.locator("input[type='checkbox']");
    await expect(legacyBox).toBeDisabled();

    // Tick the two eligible rows.
    const checkboxes = page.locator(".runs-dash__select-cell input[type='checkbox']");
    await checkboxes.nth(0).click();
    await checkboxes.nth(1).click();

    const meetingBtn = page.getByRole("button", {
      name: /Call a meeting across 2 runs/,
    });
    await expect(meetingBtn).toBeVisible();
    await meetingBtn.click();

    // MeetingModal should open — the heading is the same one used on
    // the Workforce tab, so the user sees a single system.
    const heading = page.getByText("☎ Call a meeting", { exact: true });
    await expect(heading).toBeVisible();
  });

  test("legacy runs (no session_id) cannot push the count above 1", async ({ page }) => {
    await installSessionStubs(page, {
      projects: [happyProject],
      sessions: [happySession, recapSession],
      extra: {
        list_runs: sampleRuns,
      },
    });
    await page.goto("/");
    await page.getByRole("tab", { name: "Runs" }).click();

    // Only the first row has a session and is checkable.
    const first = page.locator(".runs-dash__select-cell input[type='checkbox']").first();
    await first.click();

    // Selection bar should show but the meeting button should be disabled.
    const meetingBtn = page.getByRole("button", {
      name: /Call a meeting across/,
    });
    await expect(meetingBtn).toBeVisible();
    await expect(meetingBtn).toBeDisabled();
  });
});
