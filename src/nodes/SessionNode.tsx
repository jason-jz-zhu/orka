import { useEffect, useRef, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { invokeCmd, listenEvent } from "../lib/tauri";
import { useGraph, type OrkaNode } from "../lib/graph-store";
import type { SessionLine } from "../lib/session-types";
import { alertDialog } from "../lib/dialogs";

type Props = NodeProps<Extract<OrkaNode, { type: "session" }>>;

export default function SessionNode({ id, data }: Props) {
  const [lines, setLines] = useState<SessionLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const addChatNode = useGraph((s) => s.addChatNode);
  const addEdge = useGraph((s) => s.addEdge);

  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    (async () => {
      try {
        const out = await invokeCmd<SessionLine[]>("read_session", {
          path: data.path,
        });
        if (cancelled) return;
        setLines(out);
      } catch (e) {
        console.warn("read_session failed:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }

      // Start live tail.
      try {
        const unlisten = await listenEvent<SessionLine[]>(
          `session:${id}:append`,
          (payload) => {
            if (!payload || payload.length === 0) return;
            setLines((prev) => [...prev, ...payload]);
          }
        );
        if (cancelled) {
          unlisten();
          return;
        }
        cleanups.push(unlisten);
        await invokeCmd("watch_session", { nodeId: id, path: data.path });
        if (!cancelled) setLive(true);
      } catch (e) {
        console.warn("watch_session failed:", e);
      }
    })();

    return () => {
      cancelled = true;
      for (const fn of cleanups) fn();
      invokeCmd("unwatch_session", { nodeId: id }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, data.path]);

  // Auto-scroll to bottom when new lines arrive.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const cwdName =
    data.projectCwd.split("/").filter(Boolean).slice(-1)[0] ||
    data.projectCwd;

  function resumeInNewNode() {
    const newId = addChatNode({
      resumeSessionId: data.sessionId,
      prompt: "",
    });
    addEdge(id, newId);
  }

  async function openInVSCode() {
    try {
      await invokeCmd("open_in_vscode", { path: data.projectCwd });
    } catch (e) {
      await alertDialog(`VSCode failed: ${e}`);
    }
  }
  async function openInTerminal() {
    try {
      await invokeCmd("open_in_terminal", { path: data.projectCwd });
    } catch (e) {
      await alertDialog(`Terminal failed: ${e}`);
    }
  }

  const assistantTurns = lines.filter((l) => l.role === "assistant").length;
  const userTurns = lines.filter((l) => l.role === "user").length;

  return (
    <div className="session-node">
      <Handle type="target" position={Position.Left} />
      <div className="chat-node__header">
        SESSION · {id} · {cwdName}
        {live && <span className="session-node__live"> ● LIVE</span>}
      </div>
      <div className="session-node__meta" title={data.path}>
        {data.sessionId.slice(0, 8)} · {data.projectCwd}
      </div>
      {!loading && (
        <div className="session-node__progress">
          {userTurns} user · {assistantTurns} assistant turns
        </div>
      )}
      <div
        className="session-node__body nodrag nowheel"
        ref={bodyRef}
        onWheelCapture={(e) => e.stopPropagation()}
      >
        {loading && <em>loading…</em>}
        {!loading && lines.length === 0 && <em>empty transcript</em>}
        {lines.map((l, i) => (
          <div
            key={i}
            className={`session-node__line session-node__line--${l.role}`}
          >
            <span className="session-node__role">{l.role}</span>
            <span className="session-node__text">{l.text}</span>
          </div>
        ))}
      </div>
      <div className="session-node__actions">
        <button className="chat-node__run" onClick={resumeInNewNode}>
          ↪ Resume
        </button>
        <button className="chat-node__run" onClick={openInVSCode}>
          VSCode
        </button>
        <button className="chat-node__run" onClick={openInTerminal}>
          Terminal
        </button>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
