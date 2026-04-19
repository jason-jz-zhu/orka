import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { invokeCmd, listenEvent } from "../lib/tauri";
import type { ProjectInfo, SessionInfo } from "../lib/session-types";
import { useGraph } from "../lib/graph-store";
import SessionCard from "./SessionCard";
import SessionDetail from "./SessionDetail";
import PipelineNodeCard from "./PipelineNodeCard";
import { SynthesisModal } from "./SynthesisModal";
import { useReviewedSessions } from "../hooks/useReviewedSessions";
import {
  playReadyPing,
  isSoundEnabled,
  setSoundEnabled,
} from "../lib/sound";
import { bump, timeStart } from "../lib/perf";

type DashProps = {
  active?: boolean;
  onJumpToPipeline?: () => void;
};

export default function SessionDashboard({
  active = true,
  onJumpToPipeline,
}: DashProps) {
  bump("SessionDashboard");
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [showOrka, setShowOrka] = useState(false);
  const [selected, setSelected] = useState<SessionInfo | null>(null);
  // Single shallow selector — one subscription, one re-render trigger.
  const { addSessionNode, removeSessionNodeBySessionId, graphNodes } = useGraph(
    useShallow((s) => ({
      addSessionNode: s.addSessionNode,
      removeSessionNodeBySessionId: s.removeSessionNodeBySessionId,
      graphNodes: s.nodes,
    }))
  );
  const [toast, setToast] = useState<string | null>(null);
  const { reviewedMap, markReviewed } = useReviewedSessions();
  const [soundOn, setSoundOn] = useState<boolean>(() => isSoundEnabled());
  const [synthSelected, setSynthSelected] = useState<Set<string>>(new Set());
  const [showSynth, setShowSynth] = useState(false);
  // Per-session awaiting_user from last frame — used to detect the
  // "Claude just finished a turn" transition so we can ping and reset
  // the reviewed flag at the right moments.
  const prevAwaitingRef = useRef<Map<string, boolean>>(new Map());

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
    const stop = timeStart("refresh");
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
      stop();
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

  // awaiting_user transition detection:
  //   false→true  →  Claude just cooked this turn  →  ping
  //
  // Reviewed state persists across Orka launches, keyed by mtime in
  // useReviewedSessions — we no longer need to unmark on true→false
  // transitions. When Claude writes a new turn, mtime advances and
  // isReviewed(id, newMtime) naturally returns false.
  useEffect(() => {
    if (sessions.length === 0) return;
    const prev = prevAwaitingRef.current;
    const next = new Map<string, boolean>();
    // Seed missing entries (first frame after mount) without firing any
    // ping — we only want the ping on a *real* false→true transition.
    const seeded = prev.size > 0;
    for (const s of sessions) {
      if (s.status !== "live") continue;
      const was = prev.get(s.id);
      const now = s.awaiting_user;
      next.set(s.id, now);
      if (seeded && was === false && now === true) {
        playReadyPing();
      }
    }
    prevAwaitingRef.current = next;
  }, [sessions]);

  const orkaKeys = useMemo(
    () => new Set(projects.filter((p) => p.is_orka).map((p) => p.key)),
    [projects]
  );

  const liveSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (s.status !== "live") return false;
      if (!showOrka && orkaKeys.has(s.project_key)) return false;
      // Hide transient sessions that Orka's own claude -p calls briefly
      // create before --no-session-persistence deletes them. Two checks:
      //   1. 0 turns + no user preview — nothing useful to show regardless
      //   2. first user message matches our brief-prompt signature —
      //      catches the rare case where the file has the prompt written
      //      before the persistence-disable cleanup fires.
      if (s.turn_count === 0 && !s.first_user_preview) return false;
      if (
        s.first_user_preview &&
        s.first_user_preview.includes("You are summarizing a Claude Code session")
      ) {
        return false;
      }
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
    let generating = runningPipelineNodes.length;
    let review = 0;
    for (const s of liveSessions) {
      if (!s.awaiting_user) {
        generating += 1;
        continue;
      }
      // Reviewed only if stored mtime === current mtime.
      if (reviewedMap[s.id] !== s.modified_ms) review += 1;
    }
    return { generating, review };
  }, [liveSessions, runningPipelineNodes, reviewedMap]);

  const hiddenOrkaCount = useMemo(
    () =>
      sessions.filter(
        (s) => s.status === "live" && orkaKeys.has(s.project_key)
      ).length,
    [sessions, orkaKeys]
  );

  // Stable callbacks so memoized SessionCards don't re-render on unrelated
  // dashboard state changes (toast, query, search, etc).
  const pinSession = useCallback(
    (s: SessionInfo) => {
      addSessionNode({
        sessionId: s.id,
        path: s.path,
        projectCwd: s.project_cwd,
      });
      setToast(`📌 Pinned ${s.id.slice(0, 8)} to current pipeline`);
      setTimeout(() => setToast(null), 2500);
    },
    [addSessionNode]
  );

  const unpinSession = useCallback(
    (s: SessionInfo) => {
      removeSessionNodeBySessionId(s.id);
      setToast(`Unpinned ${s.id.slice(0, 8)}`);
      setTimeout(() => setToast(null), 2500);
    },
    [removeSessionNodeBySessionId]
  );

  const openSession = useCallback(
    (s: SessionInfo) => {
      if (s.status !== "live") setSelected(s);
      markReviewed(s.id, s.modified_ms);
    },
    [markReviewed]
  );

  // Defer the (potentially long) card list render so the rest of the
  // Dashboard chrome (stats, filters, toast) stays responsive even when
  // a fresh refresh swaps the array reference.
  const deferredLiveSessions = useDeferredValue(liveSessions);

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
          <button
            className={
              "dashboard__sound" +
              (soundOn ? " dashboard__sound--on" : "")
            }
            onClick={() => {
              const next = !soundOn;
              setSoundOn(next);
              setSoundEnabled(next);
              if (next) playReadyPing(); // preview tone on enable
            }}
            title={
              soundOn
                ? "Sound on — pings when a session is ready to review"
                : "Sound off — click to enable"
            }
          >
            {soundOn ? "🔔" : "🔕"}
          </button>
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
                Live shows Claude sessions currently running and Studio nodes
                currently generating. Start one in Claude Code or the Studio
                tab and it will appear here.
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
          {deferredLiveSessions.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              isReviewed={reviewedMap[s.id] === s.modified_ms}
              isPinned={pinnedSessionIds.has(s.id)}
              selected={selected?.id === s.id}
              synthSelected={synthSelected.has(s.id)}
              onOpen={openSession}
              onPin={pinSession}
              onUnpin={unpinSession}
              onSynthToggle={(session) => {
                setSynthSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(session.id)) next.delete(session.id);
                  else next.add(session.id);
                  return next;
                });
              }}
            />
          ))}
        </div>
      </div>

      {synthSelected.size > 0 && (
        <div className="dashboard__synth-bar">
          <span className="dashboard__synth-hint">
            {synthSelected.size} session{synthSelected.size === 1 ? "" : "s"} selected ·
            shift-click to toggle
          </span>
          <div className="dashboard__synth-spacer" />
          <button
            className="dashboard__synth-btn dashboard__synth-btn--ghost"
            onClick={() => setSynthSelected(new Set())}
          >
            Clear
          </button>
          <button
            className="dashboard__synth-btn"
            disabled={synthSelected.size < 2}
            onClick={() => setShowSynth(true)}
            title={
              synthSelected.size < 2
                ? "Shift-click a second session to enable"
                : "Ask a question across all selected sessions"
            }
          >
            📚 Ask across {synthSelected.size}
          </button>
        </div>
      )}

      {showSynth && (
        <SynthesisModal
          sources={sessions.filter((s) => synthSelected.has(s.id))}
          onClose={() => setShowSynth(false)}
        />
      )}

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
