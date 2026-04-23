import { describe, expect, it } from "vitest";
import { bucketForToday } from "./today-buckets";
import { makeSession } from "../test-helpers/session-fixtures";
import type { RunRecord } from "./runs";

const NOW = Date.parse("2026-04-21T09:00:00Z");

function run(partial: Partial<RunRecord> & { started_at: string }): RunRecord {
  return {
    id: partial.id ?? "r-" + Math.random().toString(36).slice(2, 8),
    skill: partial.skill ?? "repo-tldr",
    inputs: partial.inputs ?? [],
    status: partial.status ?? "ok",
    trigger: partial.trigger ?? "manual",
    ...partial,
  };
}

describe("bucketForToday", () => {
  it("puts runs within the overnight window into the overnight bucket", () => {
    const result = bucketForToday({
      sessions: [],
      runs: [
        run({ id: "r1", started_at: "2026-04-21T03:00:00Z" }), // 6h ago: in
        run({ id: "r2", started_at: "2026-04-20T15:00:00Z" }), // 18h ago: in
        run({ id: "r3", started_at: "2026-04-20T10:00:00Z" }), // 23h ago: out
      ],
      pinned: new Set(),
      now: NOW,
    });
    expect(result.overnight.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("includes live+awaiting sessions in the review bucket", () => {
    const live = makeSession({
      id: "s-live",
      status: "live",
      awaiting_user: true,
      modified_ms: NOW - 60_000,
    });
    const liveBusy = makeSession({
      id: "s-busy",
      status: "live",
      awaiting_user: false,
      modified_ms: NOW - 60_000,
    });
    const result = bucketForToday({
      sessions: [live, liveBusy],
      runs: [],
      pinned: new Set(),
      now: NOW,
    });
    expect(result.awaitingReview.map((s) => s.id)).toEqual(["s-live"]);
  });

  it("includes done sessions from the last 48h but skips older ones", () => {
    const recent = makeSession({
      id: "s-recent",
      status: "done",
      modified_ms: NOW - 12 * 60 * 60 * 1000,
    });
    const stale = makeSession({
      id: "s-stale",
      status: "done",
      modified_ms: NOW - 5 * 24 * 60 * 60 * 1000,
    });
    const result = bucketForToday({
      sessions: [recent, stale],
      runs: [],
      pinned: new Set(),
      now: NOW,
    });
    expect(result.awaitingReview.map((s) => s.id)).toEqual(["s-recent"]);
  });

  it("sorts awaiting review newest-first", () => {
    const older = makeSession({
      id: "s-older",
      status: "live",
      awaiting_user: true,
      modified_ms: NOW - 60 * 60 * 1000,
    });
    const newer = makeSession({
      id: "s-newer",
      status: "live",
      awaiting_user: true,
      modified_ms: NOW - 30 * 60 * 1000,
    });
    const result = bucketForToday({
      sessions: [older, newer],
      runs: [],
      pinned: new Set(),
      now: NOW,
    });
    expect(result.awaitingReview.map((s) => s.id)).toEqual(["s-newer", "s-older"]);
  });

  it("picks up pinned sessions regardless of status", () => {
    const pinnedStale = makeSession({
      id: "s-pin",
      status: "idle",
      modified_ms: NOW - 30 * 24 * 60 * 60 * 1000, // 30 days old
    });
    const result = bucketForToday({
      sessions: [pinnedStale],
      runs: [],
      pinned: new Set(["s-pin"]),
      now: NOW,
    });
    expect(result.pinned.map((s) => s.id)).toEqual(["s-pin"]);
  });

  it("computes weekly totals and identifies the top skill", () => {
    const runs = [
      run({ id: "a", skill: "repo-tldr", started_at: "2026-04-20T09:00:00Z" }),
      run({ id: "b", skill: "repo-tldr", started_at: "2026-04-19T09:00:00Z" }),
      run({ id: "c", skill: "demo-maker", started_at: "2026-04-18T09:00:00Z" }),
      // 10 days ago — out of the week window
      run({ id: "d", skill: "repo-tldr", started_at: "2026-04-11T09:00:00Z" }),
    ];
    const result = bucketForToday({
      sessions: [],
      runs,
      pinned: new Set(),
      now: NOW,
    });
    expect(result.weekly.totalRuns).toBe(3);
    expect(result.weekly.distinctSkills).toBe(2);
    expect(result.weekly.topSkill).toEqual({ skill: "repo-tldr", count: 2 });
  });

  it("returns sensible zeros when all inputs are empty", () => {
    const result = bucketForToday({
      sessions: [],
      runs: [],
      pinned: new Set(),
      now: NOW,
    });
    expect(result.overnight).toEqual([]);
    expect(result.awaitingReview).toEqual([]);
    expect(result.pinned).toEqual([]);
    expect(result.weekly).toEqual({
      totalRuns: 0,
      distinctSkills: 0,
      topSkill: null,
    });
  });
});
