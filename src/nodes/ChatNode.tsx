import { useEffect } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { invokeCmd, listenEvent } from "../lib/tauri";
import { parseLine } from "../lib/stream-parser";
import { buildContext, composePrompt } from "../lib/context";
import { useGraph, type OrkaNode } from "../lib/graph-store";


type Props = NodeProps<Extract<OrkaNode, { type: "chat" | "agent" }>> & {
  variant?: "chat" | "agent";
};

export default function ChatNode({ id, data, variant = "chat" }: Props) {
  const update = useGraph((s) => s.updateNodeData);

  // Subscribe to stream + done events from the Rust side (or browser fallback).
  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    (async () => {
      const unlistenStream = await listenEvent<string>(`node:${id}:stream`, (raw) => {
        const events = parseLine(raw);
        for (const ev of events) {
          if (ev.kind === "text") {
            const cur = useGraph.getState().nodes.find((n) => n.id === id);
            const prev = (cur?.data as any)?.output ?? "";
            update(id, { output: prev + ev.text });
          } else if (ev.kind === "tool_use") {
            const cur = useGraph.getState().nodes.find((n) => n.id === id);
            const count = ((cur?.data as any)?.toolCount ?? 0) + 1;
            update(id, { toolCount: count });
          } else if (ev.kind === "tool_result") {
            // Silent — tool I/O stays out of the node output.
          } else if (ev.kind === "result") {
            update(id, { costUsd: ev.costUsd });
          }
        }
      });
      if (cancelled) { unlistenStream(); return; }
      cleanups.push(unlistenStream);

      const unlistenDone = await listenEvent<{ ok: boolean; error?: string }>(
        `node:${id}:done`,
        (payload) => {
          update(id, { running: false });
          if (payload && !payload.ok && payload.error) {
            const cur = useGraph.getState().nodes.find((n) => n.id === id);
            const prev = (cur?.data as any)?.output ?? "";
            update(id, { output: prev + `\n\n[error] ${payload.error}` });
          }
        }
      );
      if (cancelled) { unlistenDone(); return; }
      cleanups.push(unlistenDone);
    })();

    return () => {
      cancelled = true;
      for (const fn of cleanups) fn();
    };
  }, [id, update]);

  async function run() {
    update(id, { running: true, output: "", toolCount: 0 });
    try {
      const { nodes, edges } = useGraph.getState();
      const ctx = buildContext(id, nodes, edges);
      const composed = composePrompt(ctx.text, data.prompt);
      const cmd = variant === "agent" ? "run_agent_node" : "run_node";
      await invokeCmd(cmd, {
        id,
        prompt: composed,
        resumeId: (data as any).resumeSessionId ?? null,
        addDirs: ctx.addDirs,
      });
    } catch (e) {
      update(id, {
        output: `Error: ${String(e)}`,
        running: false,
      });
    }
  }

  const label = variant === "agent" ? "AGENT" : "CHAT";
  const hasError = !!data.output && /\[error\]/i.test(data.output);
  const stateClass = data.running
    ? "chat-node--running"
    : hasError
      ? "chat-node--errored"
      : data.output
        ? "chat-node--done"
        : "chat-node--idle";
  return (
    <div className={`chat-node chat-node--${variant} ${stateClass}`}>
      <Handle type="target" position={Position.Left} />
      <div className="chat-node__header">
        {label} · {id}
        {typeof data.toolCount === "number" && data.toolCount > 0 && (
          <span className="chat-node__tools">
            {" "}· 🔧 {data.toolCount} {data.toolCount === 1 ? "tool" : "tools"}
          </span>
        )}
      </div>
      <textarea
        className="chat-node__input nodrag nowheel"
        placeholder="Prompt…"
        value={data.prompt}
        onChange={(e) => update(id, { prompt: e.target.value })}
        rows={3}
      />
      <div className="chat-node__row">
        <button
          className="chat-node__run"
          onClick={run}
          disabled={data.running || !data.prompt.trim()}
        >
          {data.running ? "Running…" : variant === "agent" ? "Run Agent" : "Run"}
        </button>
        {data.running && (
          <button
            className="chat-node__stop"
            onClick={async () => {
              await invokeCmd("cancel_node", { nodeId: id });
              update(id, { running: false });
            }}
          >
            Stop
          </button>
        )}
        {typeof data.costUsd === "number" && data.costUsd > 0 && (
          <span className="chat-node__cost">
            ${data.costUsd.toFixed(4)}
          </span>
        )}
      </div>
      {data.output && (
        <pre
          className="chat-node__output nodrag nowheel"
          onWheelCapture={(e) => e.stopPropagation()}
        >
          {data.output}
        </pre>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
