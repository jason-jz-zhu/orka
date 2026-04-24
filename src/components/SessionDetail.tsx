import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invokeCmd, listenEvent } from "../lib/tauri";
import type { SessionInfo, SessionLine } from "../lib/session-types";
import { useGraph } from "../lib/graph-store";
import { alertDialog } from "../lib/dialogs";
// Lazy: xterm bundle (~150KB) only loads when the user opens the
// embedded-terminal details below; keeps default drawer cost flat.
const EmbeddedTerminal = lazy(() =>
  import("./EmbeddedTerminal").then((m) => ({ default: m.EmbeddedTerminal })),
);

type Props = {
  session: SessionInfo | null;
};

// Virtual node id for the session detail drawer — used as the watcher key so
// it doesn't clash with SessionNode instances that watch the same file.
const DRAWER_WATCH_ID = "__orka_drawer__";

export default function SessionDetail({ session }: Props) {
  const [lines, setLines] = useState<SessionLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const addSessionNode = useGraph((s) => s.addSessionNode);

  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    setLines([]);
    setLive(false);
    if (!session) return;
    setLoading(true);

    (async () => {
      try {
        const out = await invokeCmd<SessionLine[]>("read_session", {
          path: session.path,
        });
        if (cancelled) return;
        setLines(out);
      } catch (e) {
        console.warn("read_session failed:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }

      // Live tail — mirrors SessionNode but keyed on DRAWER_WATCH_ID.
      try {
        const unlisten = await listenEvent<SessionLine[]>(
          `session:${DRAWER_WATCH_ID}:append`,
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
        await invokeCmd("watch_session", {
          nodeId: DRAWER_WATCH_ID,
          path: session.path,
        });
        if (!cancelled) setLive(true);
      } catch (e) {
        console.warn("watch_session failed:", e);
      }
    })();

    return () => {
      cancelled = true;
      for (const fn of cleanups) fn();
      invokeCmd("unwatch_session", { nodeId: DRAWER_WATCH_ID }).catch(() => {});
    };
  }, [session?.path]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  if (!session) {
    return (
      <div className="monitor__empty">
        <div className="monitor__empty-title">Session Monitor</div>
        <div className="monitor__empty-hint">
          Click a session on the left to inspect its transcript.
        </div>
      </div>
    );
  }

  const cwdName =
    session.project_cwd.split("/").filter(Boolean).slice(-1)[0] ||
    session.project_cwd;

  async function openInVSCode() {
    if (!session) return;
    try {
      await invokeCmd("open_in_vscode", { path: session.project_cwd });
    } catch (e) {
      await alertDialog(`VSCode failed: ${e}`);
    }
  }

  function pinToCanvas() {
    if (!session) return;
    addSessionNode({
      sessionId: session.id,
      path: session.path,
      projectCwd: session.project_cwd,
    });
  }

  return (
    <div className="session-detail">
      <div className="session-detail__header">
        <div className="session-detail__title">
          <span className="session-detail__id">{session.id.slice(0, 8)}</span>
          <span className="session-detail__cwd" title={session.project_cwd}>
            {cwdName}
          </span>
          <span className={`session-detail__status session-detail__status--${session.status}`}>
            {session.status}
          </span>
          {live && <span className="session-detail__live">● LIVE</span>}
        </div>
        <div className="session-detail__actions">
          <button onClick={pinToCanvas} title="Add as SessionNode on canvas">
            ⊹ Pin to canvas
          </button>
          <button onClick={openInVSCode}>VSCode</button>
        </div>
      </div>
      <div className="session-detail__meta">
        {session.turn_count} turns · {session.path}
      </div>
      <div className="session-detail__body" ref={bodyRef}>
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
        <SessionDetailTerminal session={session} />
      </div>
    </div>
  );
}

/**
 * Same lazy "Continue this session in an embedded terminal" pattern
 * we already use in RunDetailDrawer. Symmetry: clicking Open on a
 * Workforce SessionCard now reaches the same in-app terminal that
 * Logbook's drawer does, so users don't have to bounce to external
 * Terminal.app to resume.
 */
function SessionDetailTerminal({ session }: { session: SessionInfo }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="run-drawer__terminal"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="run-drawer__terminal-summary">
        ⌨ Continue in an embedded terminal
        <span className="run-drawer__terminal-hint">
          claude --resume {session.id.slice(0, 8)}…
        </span>
      </summary>
      {open && (
        <div className="run-drawer__terminal-host">
          <Suspense fallback={<div className="run-drawer__terminal-loading">Loading terminal…</div>}>
            <EmbeddedTerminal
              key={session.id}
              cwd={session.project_cwd}
              command="claude"
              args={["--resume", session.id]}
            />
          </Suspense>
        </div>
      )}
    </details>
  );
}
