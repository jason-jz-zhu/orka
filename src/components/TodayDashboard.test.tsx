import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { TodayDashboard } from "./TodayDashboard";

// The tauri bridge: default stubs return empty lists so the component
// settles into the "nothing yet" empty state.
vi.mock("../lib/tauri", () => ({
  invokeCmd: vi.fn(async (cmd: string) => {
    if (cmd === "list_projects") return [];
    if (cmd === "list_sessions") return [];
    if (cmd === "list_runs") return [];
    return null;
  }),
  inTauri: false,
  listenEvent: vi.fn(() => Promise.resolve(() => undefined)),
}));

describe("TodayDashboard", () => {
  it("mounts without triggering an infinite render loop", async () => {
    // Regression: the initial version computed `pinned` inside the
    // zustand selector, returning a fresh Set each call. Zustand's
    // default === equality meant every render saw a different Set →
    // infinite re-render, browser crashed with "Maximum update depth
    // exceeded". This test mounts the component; if the loop ever
    // comes back, React throws and RTL surfaces it as a test failure.
    const { container } = render(
      <TodayDashboard onOpenSession={() => {}} onJumpToRuns={() => {}} />,
    );
    // Wait for the mount-effect (list_projects / list_runs) to settle.
    await waitFor(() => {
      expect(screen.getByText("Today")).toBeInTheDocument();
    });
    expect(container).toBeInTheDocument();
  });
});
