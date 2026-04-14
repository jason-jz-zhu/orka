import { useEffect, useMemo, useRef, useState } from "react";
import { invokeCmd, listenEvent } from "../lib/tauri";
import type { ProjectInfo, SessionInfo } from "../lib/session-types";
import { useGraph } from "../lib/graph-store";
import SessionCard from "./SessionCard";
import SessionDetail from "./SessionDetail";
import PipelineNodeCard from "./PipelineNodeCard";

type DashProps = {
  active?: boolean;
  onJumpToPipeline?: () => void;
};

export default function SessionDashboard({
  active = true,
  onJumpToPipeline,
}: DashProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [showOrka, setShowOrka] = useState(false);
  const [selected, setSelected] = useState<SessionInfo | null>(null);
  const addSessionNode = useGraph((s) => s.addSessionNode);
  const removeSessionNodeBySessionId = useGraph(
    (s) => s.removeSessionNodeBySessionId
  );
  const graphNodes = useGraph((s) => s.nodes);
  const [toast, setToast] = useState<string | null>(null);

  function flashToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  // Which claude session ids are currently pinned as SessionNodes in the graph.
  const pinnedSessionIds = useMemo(
    () =>
      new Set(
        graphNodes
          .filter((n) => n.type === "session")
          .map((n) => (n.data as { sessionId: string }).sessionId)
      ),
    [graphNodes]
  );

  // Orka-spawned pipeline nodes currently running (ChatNode / AgentNode
  // whose `data.running` flag is true). Surfaced alongside Claude Code
  // interactive sessions so the user sees a single Monitor view.
  const runningPipelineNodes = useMemo(
    () =>
      graphNodes.filter(
        (n): n is typeof n & { type: "chat" | "agent" } =>
          (n.type === "chat" || n.type === "agent") &&
          (n.data as { running?: boolean }).running === true
      ),
    [graphNodes]
  );

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function refresh() {
    try {
      const ps = await invokeCmd<ProjectInfo[]>("list_projects");
      setProjects(ps);
      const all: SessionInfo[] = [];
      await Promise.all(
        ps.map(async (p) => {
          try {
            const ss = await invokeCmd<SessionInfo[]>("list_sessions", {
              projectKey: p.key,
            });
            all.push(...ss);
          } catch (e) {
            console.warn(`list_sessions(${p.key}) failed:`, e);
          }
        })
      );
      all.sort((a, b) => b.modified_ms - a.modified_ms);
      setSessions(all);
    } catch (e) {
      console.warn("refresh failed:", e);
    } finally {
      setLoading(false);
    }
  }

  function refreshDebounced() {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(refresh, 300);
  }

  useEffect(() => {
    // Only subscribe / poll when the Monitor tab is visible. Otherwise we
    // burn CPU + I/O (each refresh fans out list_sessions over N projects)
    // while the user is in Pipeline.
    if (!active) return;
    refresh();
    invokeCmd("start_projects_watcher").catch(() => {});
    let unlisten: (() => void) | null = null;
    listenEvent("sessions:changed", () => refreshDebounced()).then(
      (fn) => (unlisten = fn)
    );
    const t = setInterval(refresh, 15_000);
    return () => {
      clearInterval(t);
      unlisten?.();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // If the selected session stops being live, auto-close the drawer —
  // Monitor is a live-only view. But keep it open for awaiting_user state
  // (that's the "cooked, review me" state which is still worth reading).
  useEffect(() => {
    if (!selected) return;
    const fresh = sessions.find((s) => s.id === selected.id);
    if (!fresh || fresh.status !== "live") {
      setSelected(null);
      return;
    }
    if (fresh !== selected) setSelected(fresh);
  }, [sessions, selected]);

  const orkaKeys = useMemo(
    () => new Set(projects.filter((p) => p.is_orka).map((p) => p.key)),
    [projects]
  );

  const liveSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (s.status !== "live") return false;
      if (!showOrka && orkaKeys.has(s.project_key)) return false;
      if (q) {
        const hay = `${s.project_cwd} ${s.first_user_preview ?? ""} ${
          s.last_message_preview ?? ""
        }`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [sessions, orkaKeys, query, showOrka]);

  const counts = useMemo(() => {
    let generating = runningPipelineNodes.length; // Orka pipeline nodes count as generating
    let review = 0;
    for (const s of liveSessions) {
      if (s.awaiting_user) review += 1;
      else generating += 1;
    }
    return { generating, review };
  }, [liveSessions, runningPipelineNodes]);

  const hiddenOrkaCount = useMemo(
    () =>
      sessions.filter(
        (s) => s.status === "live" && orkaKeys.has(s.project_key)
      ).length,
    [sessions, orkaKeys]
  );

  function pinSession(s: SessionInfo) {
    addSessionNode({
      sessionId: s.id,
      path: s.path,
      projectCwd: s.project_cwd,
    });
    flashToast(`📌 Pinned ${s.id.slice(0, 8)} to current pipeline`);
  }

  function unpinSession(s: SessionInfo) {
    removeSessionNodeBySessionId(s.id);
    flashToast(`Unpinned ${s.id.slice(0, 8)}`);
  }

  return (
    <div className="dashboard">
      <div className="dashboard__main">
        <div className="dashboard__overview">
          <div className="dashboard__stat dashboard__stat--live dashboard__stat--readonly">
            <span className="dashboard__stat-num">{counts.generating}</span>
            <span className="dashboard__stat-label">generating</span>
          </div>
          <div className="dashboard__stat dashboard__stat--review dashboard__stat--readonly">
            <span className="dashboard__stat-num">{counts.review}</span>
            <span className="dashboard__stat-label">for review</span>
          </div>
          <div className="dashboard__overview-fill" />
          {hiddenOrkaCount > 0 && (
            <label className="dashboard__toggle-orka">
              <input
                type="checkbox"
                checked={showOrka}
                onChange={(e) => setShowOrka(e.target.checked)}
              />
              <span>show Orka ({hiddenOrkaCount})</span>
            </label>
          )}
          <input
            className="dashboard__search"
            placeholder="search project, goal, last message…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {loading && <div className="dashboard__empty">loading sessions…</div>}
        {!loading &&
          liveSessions.length === 0 &&
          runningPipelineNodes.length === 0 && (
            <div className="dashboard__empty">
              <div className="dashboard__empty-title">No active sessions</div>
              <div className="dashboard__empty-hint">
                Monitor shows Claude sessions currently running and Pipeline
                nodes currently generating. Start one in Claude Code or the
                Pipeline tab and it will appear here.
              </div>
            </div>
          )}

        <div className="dashboard__grid">
          {runningPipelineNodes.map((n) => (
            <PipelineNodeCard
              key={`pn-${n.id}`}
              node={n}
              onOpen={() => onJumpToPipeline?.()}
            />
          ))}
          {liveSessions.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              isReviewed={false}
              isPinned={pinnedSessionIds.has(s.id)}
              selected={selected?.id === s.id}
              onOpen={() => setSelected(s)}
              onPin={() => pinSession(s)}
              onUnpin={() => unpinSession(s)}
            />
          ))}
        </div>
      </div>

      {toast && <div className="dashboard__toast">{toast}</div>}

      {selected && (
        <div className="dashboard__drawer">
          <button
            className="dashboard__drawer-close"
            onClick={() => setSelected(null)}
            title="Close"
          >
            ×
          </button>
          <SessionDetail session={selected} />
        </div>
      )}
    </div>
  );
}
