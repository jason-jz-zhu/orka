import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MorningRibbon } from "./MorningRibbon";

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

describe("MorningRibbon", () => {
  it("mounts without an infinite re-render loop", async () => {
    // Regression guard: the pinned-ids selector is derived via useMemo
    // on top of the stable `nodes` array. A future change that moves
    // Set construction back into the zustand selector would re-trigger
    // the same loop TodayDashboard originally had.
    render(
      <MorningRibbon onJumpToSessions={() => {}} onJumpToRuns={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
  });

  it("renders three chips with zero counts on an empty workspace", async () => {
    render(
      <MorningRibbon onJumpToSessions={() => {}} onJumpToRuns={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText("overnight")).toBeInTheDocument();
    });
    expect(screen.getByText("awaiting")).toBeInTheDocument();
    expect(screen.getByText("pinned")).toBeInTheDocument();
    // The weekly stat only renders when there's activity — empty
    // workspace should not show it.
    expect(screen.queryByText(/runs this week/)).toBeNull();
    // Empty workspace → every chip shows "0".
    const zeros = screen.getAllByText("0");
    expect(zeros.length).toBe(3);
  });

  it("routes overnight to Runs, awaiting + pinned to Sessions (no duplicate targets)", async () => {
    // Regression: an earlier iteration had a "this week" chip that
    // also routed to Runs — two chips fighting for the same
    // destination is a UX bug. Each clickable chip should go somewhere
    // unique.
    const onJumpToSessions = vi.fn();
    const onJumpToRuns = vi.fn();
    render(
      <MorningRibbon
        onJumpToSessions={onJumpToSessions}
        onJumpToRuns={onJumpToRuns}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("overnight")).toBeInTheDocument();
    });
    await userEvent.click(screen.getByText("overnight"));
    await userEvent.click(screen.getByText("awaiting"));
    await userEvent.click(screen.getByText("pinned"));

    expect(onJumpToRuns).toHaveBeenCalledTimes(1);
    expect(onJumpToSessions).toHaveBeenCalledTimes(2);
  });
});
