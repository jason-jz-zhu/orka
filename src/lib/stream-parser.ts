/**
 * Parse a single JSONL line emitted by `claude -p --output-format stream-json`.
 *
 * Shapes we care about (ignore the rest):
 *   { type: "system", subtype: "init", session_id, ... }
 *   { type: "assistant", message: { content: [{ type: "text", text }, { type: "tool_use", name, input }] } }
 *   { type: "user",      message: { content: [{ type: "tool_result", content: [...] }] } }
 *   { type: "result",    subtype: "success" | ..., result, total_cost_usd, usage }
 */
export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "tool_result"; text: string }
  | { kind: "system"; sessionId: string | undefined }
  | { kind: "result"; text: string; costUsd: number; isError: boolean }
  | { kind: "ignore" };

const EMPTY: readonly StreamEvent[] = Object.freeze([]);

/**
 * Parse a stream line. Callers iterating hundreds of lines per second
 * should prefer `parseLineInto(line, out)` which writes into a scratch
 * array, avoiding 100s of allocations/sec. `parseLine` is kept for
 * one-shot callers and tests.
 */
export function parseLine(line: string): StreamEvent[] {
  const out: StreamEvent[] = [];
  parseLineInto(line, out);
  return out;
}

/**
 * Allocation-minimising variant: appends events into `out` and returns
 * the number of events pushed. Caller is expected to reset `out.length = 0`
 * (or read + discard) between lines. Used in SkillRunner's stream
 * loop to cut GC pressure during long runs — at 300 tokens/sec the
 * allocating variant was creating 900–1500 StreamEvent objects/sec.
 */
export function parseLineInto(line: string, out: StreamEvent[]): number {
  const before = out.length;
  const trimmed = line.trim();
  if (!trimmed) return 0;
  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return 0;
  }

  if (obj.type === "system" && obj.subtype === "init") {
    // Emit undefined (not "") when session_id is absent — downstream
    // consumers gate on `ev.sessionId && …` and an empty string is
    // falsy for that check but would slip through stricter checks.
    // Pairs with backend valid_session_id() which rejects "".
    const sid =
      typeof obj.session_id === "string" && obj.session_id.length > 0
        ? obj.session_id
        : undefined;
    out.push({ kind: "system", sessionId: sid });
    return out.length - before;
  }

  if (obj.type === "assistant" && obj.message?.content) {
    for (const block of obj.message.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        out.push({ kind: "text", text: block.text });
      } else if (block?.type === "tool_use") {
        out.push({
          kind: "tool_use",
          name: block.name ?? "?",
          input: block.input ?? {},
        });
      }
    }
    return out.length - before;
  }

  if (obj.type === "user" && obj.message?.content) {
    for (const block of obj.message.content) {
      if (block?.type === "tool_result") {
        const content = block.content;
        let text = "";
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
          text = content
            .map((c: any) => (typeof c === "string" ? c : c?.text ?? ""))
            .join("");
        }
        out.push({ kind: "tool_result", text });
      }
    }
    return out.length - before;
  }

  if (obj.type === "result") {
    out.push({
      kind: "result",
      text: typeof obj.result === "string" ? obj.result : "",
      costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0,
      isError: obj.is_error === true || obj.subtype !== "success",
    });
    return out.length - before;
  }

  out.push({ kind: "ignore" });
  return out.length - before;
}

// Re-export for internal ergonomics (e.g. unit tests asserting on the
// frozen empty array without re-allocating).
export const EMPTY_STREAM_EVENTS = EMPTY;
