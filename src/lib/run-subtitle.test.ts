import { describe, expect, it } from "vitest";
import { runSubtitle } from "./run-subtitle";
import type { RunRecord } from "./runs";

function run(partial: Partial<RunRecord>): RunRecord {
  return {
    id: "r",
    skill: "repo-tldr",
    inputs: [],
    started_at: "2026-04-22T00:00:00Z",
    status: "ok",
    trigger: "manual",
    ...partial,
  };
}

describe("runSubtitle", () => {
  it("uses the first input when the run has one", () => {
    const s = runSubtitle(run({ inputs: ["https://github.com/x/y"] }));
    expect(s.text).toBe("https://github.com/x/y");
    expect(s.empty).toBe(false);
    expect(s.title).toContain("https://github.com/x/y");
  });

  it("annotates additional inputs with a counter", () => {
    const s = runSubtitle(run({ inputs: ["repo-a", "repo-b", "repo-c"] }));
    expect(s.text).toBe("repo-a (+2)");
    expect(s.title.split("\n")).toHaveLength(3);
  });

  it("truncates long first inputs with an ellipsis", () => {
    const long = "a".repeat(120);
    const s = runSubtitle(run({ inputs: [long] }), 20);
    expect(s.text.length).toBeLessThanOrEqual(20);
    expect(s.text.endsWith("…")).toBe(true);
  });

  it("falls back to workdir basename when there are no inputs", () => {
    const s = runSubtitle(
      run({ inputs: [], workdir: "/Users/jz/Desktop/code/Orka" }),
    );
    expect(s.text).toBe("Orka");
    expect(s.title).toBe("/Users/jz/Desktop/code/Orka");
    expect(s.empty).toBe(false);
  });

  it("marks rows with neither inputs nor workdir as empty", () => {
    const s = runSubtitle(run({ inputs: [], workdir: undefined }));
    expect(s.empty).toBe(true);
    expect(s.text).toMatch(/no inputs captured/);
  });
});
