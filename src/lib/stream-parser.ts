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
  | { kind: "system"; sessionId: string }
  | { kind: "result"; text: string; costUsd: number; isError: boolean }
  | { kind: "ignore" };

export function parseLine(line: string): StreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (obj.type === "system" && obj.subtype === "init") {
    return [{ kind: "system", sessionId: obj.session_id ?? "" }];
  }

  if (obj.type === "assistant" && obj.message?.content) {
    const out: StreamEvent[] = [];
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
    return out;
  }

  if (obj.type === "user" && obj.message?.content) {
    const out: StreamEvent[] = [];
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
    return out;
  }

  if (obj.type === "result") {
    return [
      {
        kind: "result",
        text: typeof obj.result === "string" ? obj.result : "",
        costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0,
        isError: obj.is_error === true || obj.subtype !== "success",
      },
    ];
  }

  return [{ kind: "ignore" }];
}
