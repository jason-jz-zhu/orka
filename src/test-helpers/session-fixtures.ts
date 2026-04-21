import type { SessionInfo, SessionStatus } from "../lib/session-types";

/**
 * Build a SessionInfo for unit tests. All required fields default to
 * sensible values; override anything relevant to the test.
 */
export function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const base: SessionInfo = {
    id: "s-test-1",
    path: "/tmp/orka-fixture/s-test-1.jsonl",
    project_key: "-tmp-orka-fixture",
    project_cwd: "/tmp/orka-fixture",
    modified_ms: Date.now() - 60_000,
    size_bytes: 1024,
    first_user_preview: "hello",
    last_message_preview: "hi back",
    last_user_preview: null,
    spawn_label: null,
    status: "done" as SessionStatus,
    turn_count: 2,
    awaiting_user: false,
  };
  return { ...base, ...overrides };
}
