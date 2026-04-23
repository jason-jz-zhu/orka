import { describe, expect, it } from "vitest";
import { meetingSessionIdsForRuns } from "./run-meeting";
import type { RunRecord } from "./runs";

function run(
  id: string,
  session_id: string | undefined,
  skill = "x",
): RunRecord {
  return {
    id,
    skill,
    inputs: [],
    started_at: "2026-04-22T00:00:00Z",
    status: "ok",
    trigger: "manual",
    session_id,
  };
}

describe("meetingSessionIdsForRuns", () => {
  it("returns session ids only for selected runs", () => {
    const runs = [run("r1", "s-a"), run("r2", "s-b"), run("r3", "s-c")];
    expect(
      meetingSessionIdsForRuns(runs, new Set(["r1", "r3"])),
    ).toEqual(["s-a", "s-c"]);
  });

  it("dedupes when multiple runs share a session", () => {
    // User ran the same skill three times, resuming into the same
    // session each time. Inviting `s-a` once is enough.
    const runs = [run("r1", "s-a"), run("r2", "s-a"), run("r3", "s-b")];
    expect(
      meetingSessionIdsForRuns(runs, new Set(["r1", "r2", "r3"])),
    ).toEqual(["s-a", "s-b"]);
  });

  it("silently drops runs with no session_id", () => {
    // Legacy runs / direct `claude -p` (no persisted session) can't
    // participate — we just skip them.
    const runs = [run("r1", undefined), run("r2", "s-b")];
    expect(
      meetingSessionIdsForRuns(runs, new Set(["r1", "r2"])),
    ).toEqual(["s-b"]);
  });

  it("preserves the table's display order, not the Set iteration order", () => {
    // RunsDashboard shows newest-first; the meeting attendee list
    // should honour that order for a less jarring match to what the
    // user sees onscreen.
    const runs = [run("r2", "s-b"), run("r1", "s-a"), run("r3", "s-c")];
    expect(
      meetingSessionIdsForRuns(runs, new Set(["r1", "r2", "r3"])),
    ).toEqual(["s-b", "s-a", "s-c"]);
  });

  it("returns [] when nothing is selected or nothing is selectable", () => {
    const runs = [run("r1", undefined)];
    expect(meetingSessionIdsForRuns(runs, new Set())).toEqual([]);
    expect(meetingSessionIdsForRuns(runs, new Set(["r1"]))).toEqual([]);
  });
});
