import { describe, expect, it } from "vitest";
import { stateOf } from "./SessionCard";
import { makeSession } from "../test-helpers/session-fixtures";

describe("stateOf", () => {
  it("returns 'errored' regardless of awaiting_user when status is errored", () => {
    const s = makeSession({ status: "errored", awaiting_user: true });
    expect(stateOf(s, false)).toBe("errored");
    expect(stateOf(s, true)).toBe("errored");
  });

  it("live + NOT awaiting_user → 'generating'", () => {
    const s = makeSession({ status: "live", awaiting_user: false });
    expect(stateOf(s, false)).toBe("generating");
    // Reviewed flag is irrelevant while generating.
    expect(stateOf(s, true)).toBe("generating");
  });

  it("live + awaiting_user + not reviewed → 'for-review'", () => {
    const s = makeSession({ status: "live", awaiting_user: true });
    expect(stateOf(s, false)).toBe("for-review");
  });

  it("live + awaiting_user + reviewed → 'reviewed' (dims the CTA)", () => {
    const s = makeSession({ status: "live", awaiting_user: true });
    expect(stateOf(s, true)).toBe("reviewed");
  });

  it("done + not reviewed → 'for-review'", () => {
    const s = makeSession({ status: "done", awaiting_user: false });
    expect(stateOf(s, false)).toBe("for-review");
  });

  it("done + reviewed → 'reviewed'", () => {
    const s = makeSession({ status: "done" });
    expect(stateOf(s, true)).toBe("reviewed");
  });

  it("idle status → 'idle'", () => {
    const s = makeSession({ status: "idle" });
    expect(stateOf(s, false)).toBe("idle");
    expect(stateOf(s, true)).toBe("idle");
  });
});
