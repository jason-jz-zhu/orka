import { test, expect } from "@playwright/test";
import {
  installSessionStubs,
  openSessionsTab,
  happyProject,
  happySession,
  compactedSession,
} from "./_helpers/stubs";

test.describe("Call a meeting flow", () => {
  test("selecting ≥2 attendees via checkbox opens the meeting modal", async ({ page }) => {
    await installSessionStubs(page, {
      projects: [happyProject],
      sessions: [happySession, compactedSession],
    });
    await page.goto("/");
    await openSessionsTab(page);

    // Two session cards, each with a visible select checkbox.
    const checkboxes = page.locator(".session-card__select input[type='checkbox']");
    await expect(checkboxes).toHaveCount(2);

    await checkboxes.nth(0).click();
    await checkboxes.nth(1).click();

    // Call-a-meeting button appears once ≥2 are picked.
    const meetingBtn = page.getByRole("button", {
      name: /Call a meeting with 2/,
    });
    await expect(meetingBtn).toBeVisible();

    await meetingBtn.click();

    // Meeting modal opens with both attendees listed.
    const modalTitle = page.getByText("☎ Call a meeting", { exact: true });
    await expect(modalTitle).toBeVisible();
    // 3 preset agenda chips rendered.
    const presets = page.locator(".meeting-modal__preset");
    await expect(presets).toHaveCount(3);
  });

  test("button stays disabled with only one attendee", async ({ page }) => {
    await installSessionStubs(page, {
      projects: [happyProject],
      sessions: [happySession, compactedSession],
    });
    await page.goto("/");
    await openSessionsTab(page);

    const first = page.locator(".session-card__select input[type='checkbox']").first();
    await first.click();

    const meetingBtn = page.getByRole("button", {
      name: /Call a meeting with 1/,
    });
    await expect(meetingBtn).toBeVisible();
    await expect(meetingBtn).toBeDisabled();
  });
});
