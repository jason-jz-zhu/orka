import { useEffect, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invokeCmd, listenEvent } from "../lib/tauri";
import { parseLine } from "../lib/stream-parser";
import { buildContext, composePrompt } from "../lib/context";
import {
  useGraph,
  type OrkaNode,
  type ToolMode,
  computeAllowedTools,
  toolModeLabel,
} from "../lib/graph-store";
import { alertDialog } from "../lib/dialogs";
import { waitForDone } from "../lib/run-all";
import { OutputAnnotator } from "../components/OutputAnnotator";


type Props = NodeProps<Extract<OrkaNode, { type: "chat" | "agent" }>> & {
  variant?: "chat" | "agent";
};

export default function ChatNode({ id, data, variant = "chat" }: Props) {
  const update = useGraph((s) => s.updateNodeData);
  const updateWith = useGraph((s) => s.updateNodeDataWith);
  const [replyText, setReplyText] = useState("");
  const [outputExpanded, setOutputExpanded] = useState(false);

  // Subscribe to stream + done events from the Rust side (or browser fallback).
  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    (async () => {
      const unlistenStream = await listenEvent<string>(`node:${id}:stream`, (raw) => {
        const events = parseLine(raw);
        for (const ev of events) {
          if (ev.kind === "text") {
            // Atomic read-modify-write: prevents characters getting lost when
            // two stream chunks race through the handler.
            const text = ev.text;
            updateWith(id, (d) => ({
              output: String((d as { output?: string }).output ?? "") + text,
            }));
          } else if (ev.kind === "tool_use") {
            updateWith(id, (d) => ({
              toolCount: Number((d as { toolCount?: number }).toolCount ?? 0) + 1,
            }));
          } else if (ev.kind === "tool_result") {
            // Silent — tool I/O stays out of the node output.
          } else if (ev.kind === "result") {
            update(id, { costUsd: ev.costUsd });
          } else if (ev.kind === "system") {
            // Capture the session id Claude assigned to this run so the
            // user can ↪ Continue the conversation by --resuming it.
            if (ev.sessionId) update(id, { lastSessionId: ev.sessionId });
          }
        }
      });
      if (cancelled) { unlistenStream(); return; }
      cleanups.push(unlistenStream);

      const unlistenDone = await listenEvent<{ ok: boolean; error?: string }>(
        `node:${id}:done`,
        (payload) => {
          if (payload && !payload.ok && payload.error) {
            const err = payload.error;
            updateWith(id, (d) => ({
              running: false,
              output: String((d as { output?: string }).output ?? "") + `\n\n[error] ${err}`,
            }));
          } else {
            update(id, { running: false });
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
  }, [id, update, updateWith]);

  async function exportOutput() {
    if (!data.output) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const defaultName = `${id}-${ts}.md`;
    const path = await saveDialog({
      defaultPath: defaultName,
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "Text", extensions: ["txt"] },
        { name: "All", extensions: ["*"] },
      ],
      title: "Export node output",
    });
    if (!path) return;
    try {
      const written = await invokeCmd<string>("write_output_file", {
        path,
        content: data.output,
      });
      console.log(`[orka:export] wrote ${written}`);
    } catch (e) {
      await alertDialog(`Export failed: ${e}`);
    }
  }

  async function run() {
    // Wait for any upstream chat/agent that's still running so this node
    // doesn't kick off with an empty/stale context. Mirrors what Run All
    // does sequentially.
    const { nodes: n0, edges: e0 } = useGraph.getState();
    const upstreamRunning = e0
      .filter((e) => e.target === id)
      .map((e) => n0.find((x) => x.id === e.source))
      .filter(
        (u): u is OrkaNode =>
          !!u &&
          (u.type === "chat" || u.type === "agent") &&
          (u.data as { running?: boolean }).running === true
      );
    if (upstreamRunning.length > 0) {
      update(id, {
        running: true,
        output: `(waiting for upstream: ${upstreamRunning
          .map((u) => u.id)
          .join(", ")})`,
        toolCount: 0,
      });
      await Promise.all(upstreamRunning.map((u) => waitForDone(u.id)));
    }

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
        allowedTools: computeAllowedTools(data),
      });
    } catch (e) {
      update(id, {
        output: `Error: ${String(e)}`,
        running: false,
      });
    }
  }

  async function continueConversation() {
    const reply = replyText.trim();
    if (!reply || !data.lastSessionId || data.running) return;
    // Append user reply to the visible output as a separator turn so the
    // user sees their message above the assistant's incoming response.
    const prev = (data as { output?: string }).output ?? "";
    const separator = prev.endsWith("\n") ? "" : "\n\n";
    update(id, {
      running: true,
      output: prev + separator + `\n---\n\n**👤 you:** ${reply}\n\n**🤖 claude:**\n\n`,
      toolCount: 0,
    });
    setReplyText("");
    try {
      const cmd = variant === "agent" ? "run_agent_node" : "run_node";
      await invokeCmd(cmd, {
        id,
        prompt: reply,
        resumeId: data.lastSessionId,
        addDirs: [],
        allowedTools: computeAllowedTools(data),
      });
    } catch (e) {
      update(id, {
        output: prev + `\n\n[continue error] ${String(e)}`,
        running: false,
      });
    }
  }

  const label = variant === "agent" ? "AGENT" : "CHAT";
  const hasError = !!data.output && /\[error\]/i.test(data.output);
  const toolMode: ToolMode = (data as { toolMode?: ToolMode }).toolMode ?? "full";
  const showToolMode = variant === "agent";
  const toolBadgeClass =
    toolMode === "full"
      ? "chat-node__tool-badge--warn"
      : "chat-node__tool-badge--ok";
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
        <span className="chat-node__header-label">
          {label} · {id}
          {typeof data.toolCount === "number" && data.toolCount > 0 && (
            <span className="chat-node__tools">
              {" "}· 🔧 {data.toolCount} {data.toolCount === 1 ? "tool" : "tools"}
            </span>
          )}
        </span>
        {data.running ? (
          <span className="chat-node__badge chat-node__badge--running">
            ⋯ running
          </span>
        ) : hasError ? (
          <span className="chat-node__badge chat-node__badge--err">✗ error</span>
        ) : data.output ? (
          <span className="chat-node__badge chat-node__badge--done">✓ done</span>
        ) : null}
      </div>
      {showToolMode && (
        <div className="chat-node__tools-row nodrag">
          <span className={`chat-node__tool-badge ${toolBadgeClass}`}>
            {toolModeLabel(toolMode)}
          </span>
          <select
            className="chat-node__tool-select nodrag"
            value={toolMode}
            onChange={(e) => update(id, { toolMode: e.target.value as ToolMode })}
            title="Tool permission scope"
          >
            <option value="full">Full access (unrestricted)</option>
            <option value="safe">Safe (read + notebook)</option>
            <option value="readonly">Read-only</option>
            <option value="custom">Custom…</option>
          </select>
          {toolMode === "custom" && (
            <input
              className="chat-node__tool-custom nodrag"
              placeholder="Read, Glob, Bash"
              value={(data as { customTools?: string }).customTools ?? ""}
              onChange={(e) => update(id, { customTools: e.target.value })}
            />
          )}
        </div>
      )}
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
        {data.output && !data.running && (
          <button
            className="chat-node__export"
            onClick={exportOutput}
            title="Export this node's output to a file"
          >
            ⤓ Export
          </button>
        )}
      </div>
      {data.output && (
        <div
          className={
            "chat-node__output chat-node__output--md nodrag nowheel" +
            (outputExpanded ? " chat-node__output--expanded" : "")
          }
          onWheelCapture={(e) => e.stopPropagation()}
        >
          <OutputAnnotator
            markdown={data.output}
            runId={id}
            onAnnotate={(block) => {
              // Day-1 scope: log the target. Day-2 will wire the annotation sidebar.
              console.log("[annotator] clicked block", { nodeId: id, idx: block.idx, type: block.type });
            }}
          />
          {data.output.length > 200 && (
            <button
              className="chat-node__output-toggle"
              onClick={() => setOutputExpanded(!outputExpanded)}
            >
              {outputExpanded ? "Show less" : "Show more..."}
            </button>
          )}
        </div>
      )}
      {data.lastSessionId && data.output && !data.running && (
        <div className="chat-node__reply nodrag">
          <textarea
            className="chat-node__reply-input nowheel"
            placeholder="Reply to continue this conversation…"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                continueConversation();
              }
            }}
            rows={2}
          />
          <button
            className="chat-node__reply-send"
            onClick={continueConversation}
            disabled={!replyText.trim()}
            title="Continue conversation (Cmd/Ctrl+Enter)"
          >
            ↪ Continue
          </button>
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
