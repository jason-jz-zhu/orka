// localStorage-only helpers for tracking onboarding state. Extracted
// from OnboardingModal so consumers that just want to know "has the
// user dismissed the welcome flow" don't drag the entire modal's
// React + IPC code into the main bundle.

const ONBOARDED_KEY = "orka:onboardingCompleted";

export function hasCompletedOnboarding(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markOnboardingCompleted() {
  try {
    localStorage.setItem(ONBOARDED_KEY, "1");
  } catch {
    /* storage disabled */
  }
}

export function resetOnboarding() {
  try {
    localStorage.removeItem(ONBOARDED_KEY);
  } catch {
    /* storage disabled */
  }
}
