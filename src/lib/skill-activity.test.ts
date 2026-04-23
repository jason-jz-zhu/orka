import { describe, expect, it } from "vitest";
import {
  lastDeliveredBySkill,
  fmtLastDelivered,
  runCountBySkill,
  recentRunsForSkill,
} from "./skill-activity";
import type { RunRecord } from "./runs";

function run(skill: string, started_at: string): RunRecord {
  return {
    id: skill + "-" + started_at,
    skill,
    inputs: [],
    started_at,
    status: "ok",
    trigger: "manual",
  };
}

describe("lastDeliveredBySkill", () => {
  it("returns the max timestamp per skill slug", () => {
    const runs = [
      run("a", "2026-04-20T10:00:00Z"),
      run("a", "2026-04-22T10:00:00Z"),
      run("b", "2026-04-21T10:00:00Z"),
    ];
    const m = lastDeliveredBySkill(runs);
    expect(m.get("a")).toBe(Date.parse("2026-04-22T10:00:00Z"));
    expect(m.get("b")).toBe(Date.parse("2026-04-21T10:00:00Z"));
  });

  it("ignores runs with an unparseable started_at", () => {
    const runs = [run("a", "not-a-date"), run("a", "2026-04-22T10:00:00Z")];
    const m = lastDeliveredBySkill(runs);
    expect(m.get("a")).toBe(Date.parse("2026-04-22T10:00:00Z"));
  });

  it("is order-robust (doesn't rely on newest-first)", () => {
    const runs = [
      run("a", "2026-04-20T10:00:00Z"),
      run("a", "2026-04-22T10:00:00Z"),
      run("a", "2026-04-21T10:00:00Z"),
    ];
    expect(lastDeliveredBySkill(runs).get("a")).toBe(
      Date.parse("2026-04-22T10:00:00Z"),
    );
  });

  it("skills with no runs are absent from the map", () => {
    const m = lastDeliveredBySkill([run("a", "2026-04-22T10:00:00Z")]);
    expect(m.has("b")).toBe(false);
  });
});

describe("recentRunsForSkill", () => {
  it("filters by slug and returns newest-first", () => {
    const runs = [
      run("a", "2026-04-18T10:00:00Z"),
      run("b", "2026-04-22T10:00:00Z"),
      run("a", "2026-04-22T10:00:00Z"),
      run("a", "2026-04-21T10:00:00Z"),
    ];
    const out = recentRunsForSkill(runs, "a");
    expect(out.map((r) => r.started_at)).toEqual([
      "2026-04-22T10:00:00Z",
      "2026-04-21T10:00:00Z",
      "2026-04-18T10:00:00Z",
    ]);
  });

  it("honours the limit argument", () => {
    const runs = Array.from({ length: 10 }, (_, i) =>
      run("a", `2026-04-${String(10 + i).padStart(2, "0")}T00:00:00Z`),
    );
    expect(recentRunsForSkill(runs, "a", 3)).toHaveLength(3);
  });

  it("skips runs with unparseable started_at", () => {
    const runs = [
      run("a", "not-a-date"),
      run("a", "2026-04-22T10:00:00Z"),
    ];
    expect(recentRunsForSkill(runs, "a")).toHaveLength(1);
  });

  it("returns an empty array when the slug has no runs", () => {
    expect(recentRunsForSkill([run("a", "2026-04-22T10:00:00Z")], "b")).toEqual([]);
  });
});

describe("runCountBySkill", () => {
  it("counts runs per skill slug across the full list", () => {
    const runs = [
      run("a", "2026-04-20T10:00:00Z"),
      run("a", "2026-04-21T10:00:00Z"),
      run("b", "2026-04-22T10:00:00Z"),
    ];
    const m = runCountBySkill(runs);
    expect(m.get("a")).toBe(2);
    expect(m.get("b")).toBe(1);
  });

  it("returns an empty map when there are no runs", () => {
    expect(runCountBySkill([]).size).toBe(0);
  });
});

describe("fmtLastDelivered", () => {
  const NOW = Date.parse("2026-04-22T10:00:00Z");
  it("renders seconds / minutes / hours / days", () => {
    expect(fmtLastDelivered(NOW - 30 * 1000, NOW)).toBe("30s ago");
    expect(fmtLastDelivered(NOW - 5 * 60 * 1000, NOW)).toBe("5m ago");
    expect(fmtLastDelivered(NOW - 3 * 60 * 60 * 1000, NOW)).toBe("3h ago");
    expect(fmtLastDelivered(NOW - 2 * 24 * 60 * 60 * 1000, NOW)).toBe(
      "2d ago",
    );
  });

  it("returns 'never' for non-finite input", () => {
    expect(fmtLastDelivered(Number.NaN, NOW)).toBe("never");
  });
});
