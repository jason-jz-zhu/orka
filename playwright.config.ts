import { defineConfig, devices } from "@playwright/test";

// Orka runs as a Tauri desktop app; for day-to-day E2E we target the
// same Vite dev server the app uses (`npm run dev` on port 1420). The
// `inTauri` check in src/lib/tauri.ts falls through to its browser
// fallback, which stubs out native commands — fast, deterministic, and
// CI-friendly. A separate `tauri-driver` harness covers the real
// bundled binary in release smoke.
export default defineConfig({
  testDir: "./e2e/specs",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html"], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
