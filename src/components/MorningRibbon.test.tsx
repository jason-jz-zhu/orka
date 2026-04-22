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

  it("renders four chips with zero counts on an empty workspace", async () => {
    render(
      <MorningRibbon onJumpToSessions={() => {}} onJumpToRuns={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText("overnight")).toBeInTheDocument();
    });
    expect(screen.getByText("awaiting")).toBeInTheDocument();
    expect(screen.getByText("pinned")).toBeInTheDocument();
    expect(screen.getByText("this week")).toBeInTheDocument();
    // Empty workspace → every chip shows "0".
    const zeros = screen.getAllByText("0");
    expect(zeros.length).toBe(4);
  });

  it("routes overnight + weekly chips to Runs, awaiting + pinned chips to Sessions", async () => {
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
    await userEvent.click(screen.getByText("this week"));
    await userEvent.click(screen.getByText("awaiting"));
    await userEvent.click(screen.getByText("pinned"));

    expect(onJumpToRuns).toHaveBeenCalledTimes(2);
    expect(onJumpToSessions).toHaveBeenCalledTimes(2);
  });
});
