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
import { MeetingModal } from "./MeetingModal";
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
  /** A session id to auto-select when the list arrives. Used by the
   *  Runs tab's "Open session" affordance so users can jump from a
   *  historic run record to its live or archived session detail. */
  pendingSessionOpen?: string | null;
  /** Called once the pendingSessionOpen has been handled, so the
   *  parent can clear it and avoid re-triggering. */
  onPendingSessionConsumed?: () => void;
};

export default function SessionDashboard({
  active = true,
  onJumpToPipeline,
  pendingSessionOpen,
  onPendingSessionConsumed,
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
  // Attendee selection for the "Call a meeting" action (cross-session
  // synthesis under the hood — same Rust command, but operator-layer
  // vocabulary everywhere user-facing).
  const [attendeeIds, setAttendeeIds] = useState<Set<string>>(new Set());
  const [showMeeting, setShowMeeting] = useState(false);
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
  const refreshInFlight = useRef(false);
  const lastProjectMtimes = useRef<Map<string, number>>(new Map());

  async function refresh() {
    // Guard: a previous refresh may still be in flight. The watcher can
    // fire bursts of `sessions:changed` events while Claude is actively
    // writing — coalesce into one inflight request at a time.
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    const stop = timeStart("refresh");
    try {
      const ps = await invokeCmd<ProjectInfo[]>("list_projects");
      setProjects(ps);
      // Only re-list sessions for projects whose dir mtime changed since
      // the previous refresh. On first refresh the map is empty so every
      // project qualifies (cold start cost). Subsequent refreshes touch
      // only the projects the user was actually active in — typically 1–2.
      const prior = lastProjectMtimes.current;
      const nextMtimes = new Map<string, number>();
      const stale: typeof ps = [];
      for (const p of ps) {
        nextMtimes.set(p.key, p.last_modified_ms);
        if (prior.get(p.key) !== p.last_modified_ms) stale.push(p);
      }
      if (stale.length === 0 && prior.size > 0) {
        // Nothing changed — keep the existing sessions list, just update
        // the projects snapshot (which may have gained/lost entries).
        return;
      }
      const allByProject = new Map<string, SessionInfo[]>();
      await Promise.all(
        stale.map(async (p) => {
          try {
            const ss = await invokeCmd<SessionInfo[]>("list_sessions", {
              projectKey: p.key,
            });
            allByProject.set(p.key, ss);
          } catch (e) {
            console.warn(`list_sessions(${p.key}) failed:`, e);
          }
        })
      );
      setSessions((existing) => {
        // Merge: keep unchanged projects' sessions from state, replace
        // stale ones with fresh results, drop any project no longer in `ps`.
        const keepKeys = new Set(ps.map((p) => p.key));
        const merged: SessionInfo[] = existing.filter(
          (s) =>
            keepKeys.has(s.project_key) &&
            !allByProject.has(s.project_key),
        );
        for (const ss of allByProject.values()) merged.push(...ss);
        merged.sort((a, b) => b.modified_ms - a.modified_ms);
        return merged;
      });
      lastProjectMtimes.current = nextMtimes;
    } catch (e) {
      console.warn("refresh failed:", e);
    } finally {
      refreshInFlight.current = false;
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
    let watcherOk = false;
    invokeCmd("start_projects_watcher")
      .then(() => {
        watcherOk = true;
      })
      .catch(() => {});
    let unlisten: (() => void) | null = null;
    listenEvent("sessions:changed", () => refreshDebounced()).then(
      (fn) => (unlisten = fn)
    );
    // Safety-net poll — only runs when the OS file watcher failed to
    // start (FS that doesn't support fsevents/inotify, or mount
    // quirks). A one-shot 10s check confirms the watcher is healthy;
    // if it fired at least once, we disable the fallback poll. This
    // removes the redundant refresh cycle that used to double the
    // list_projects load on every mount.
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    const fallbackStart = setTimeout(() => {
      if (!watcherOk) {
        fallbackTimer = setInterval(refresh, 60_000);
      }
    }, 10_000);
    return () => {
      clearTimeout(fallbackStart);
      if (fallbackTimer) clearInterval(fallbackTimer);
      unlisten?.();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Keep the selected session's data fresh across refreshes, and
  // close the drawer only if the session vanished from the list
  // (e.g. file deleted). We used to auto-close on status !== "live",
  // but that conflicted with opening archived sessions from the Runs
  // tab's history links. The user can close the drawer themselves.
  useEffect(() => {
    if (!selected) return;
    const fresh = sessions.find((s) => s.id === selected.id);
    if (!fresh) {
      setSelected(null);
      return;
    }
    if (fresh !== selected) setSelected(fresh);
  }, [sessions, selected]);

  // Consume a pendingSessionOpen request (from the Runs tab). Strategy:
  // try the in-memory sessions list first (cheap, covers live
  // sessions). Fall back to `find_session_by_id` which walks every
  // project dir — covers archived sessions that list_sessions's
  // live-only filter would've hidden. Either way, clear the pending
  // slot when done so re-navigating doesn't re-trigger.
  useEffect(() => {
    if (!pendingSessionOpen) return;
    if (loading) return;
    const quick = sessions.find((s) => s.id === pendingSessionOpen);
    if (quick) {
      setSelected(quick);
      onPendingSessionConsumed?.();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const found = await invokeCmd<SessionInfo | null>(
          "find_session_by_id",
          { sessionId: pendingSessionOpen },
        );
        if (cancelled) return;
        if (found) {
          setSelected(found);
        } else {
          setToast(
            `Session ${pendingSessionOpen.slice(0, 8)}… not found. File may have been deleted.`,
          );
          setTimeout(() => setToast(null), 6000);
        }
      } catch (e) {
        if (!cancelled) console.warn("find_session_by_id failed:", e);
      } finally {
        if (!cancelled) onPendingSessionConsumed?.();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingSessionOpen, sessions, loading, onPendingSessionConsumed]);

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

  // Defer the query so typing doesn't re-run the filter on every keystroke.
  // The input stays responsive (controlled by `query`); the list updates
  // using `deferredQuery` which React can interrupt for higher-priority work.
  const deferredQuery = useDeferredValue(query);

  const liveSessions = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
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
  }, [sessions, orkaKeys, deferredQuery, showOrka]);

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

  /**
   * Group live sessions by `project_cwd` so the Workforce surface
   * scales past 5+ active projects without the cards becoming a
   * scroll tax. Each group becomes a collapsible `<details>`; we
   * pre-compute the open set so React can decide once per render
   * which projects to expand by default:
   *   - any awaiting_user session in the group  → open
   *   - search query is non-empty                → open all
   * Otherwise the group starts collapsed.
   *
   * Insertion order is preserved (newest-modified first via the
   * filter step), so the most recently active project appears at
   * the top.
   */
  const groupedByProject = useMemo(() => {
    const groups = new Map<string, SessionInfo[]>();
    for (const s of deferredLiveSessions) {
      const key = s.project_cwd || "(unknown)";
      const arr = groups.get(key);
      if (arr) arr.push(s);
      else groups.set(key, [s]);
    }
    return Array.from(groups.entries()).map(([cwd, items]) => ({
      cwd,
      items,
      awaitingCount: items.filter((s) => s.awaiting_user).length,
    }));
  }, [deferredLiveSessions]);

  const searchActive = deferredQuery.trim().length > 0;

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

        {loading && (
          <div className="dashboard__grid">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="session-card session-card--skeleton">
                <div className="skeleton-line skeleton-line--sm" />
                <div className="skeleton-line skeleton-line--md" />
                <div className="skeleton-line skeleton-line--lg" />
              </div>
            ))}
          </div>
        )}
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

        {/* Pipeline-node cards stay ungrouped — they're the user's
            currently-running canvas runs and aren't tied to a project
            cwd. Render them in their own row above the project groups. */}
        {runningPipelineNodes.length > 0 && (
          <div className="dashboard__grid">
            {runningPipelineNodes.map((n) => (
              <PipelineNodeCard
                key={`pn-${n.id}`}
                node={n}
                onOpen={() => onJumpToPipeline?.()}
              />
            ))}
          </div>
        )}

        {groupedByProject.map(({ cwd, items, awaitingCount }) => {
          const projectName =
            cwd.split("/").filter(Boolean).slice(-1)[0] || cwd;
          const open = searchActive || awaitingCount > 0;
          return (
            <details
              key={cwd}
              open={open}
              className="dashboard__group"
              title={cwd}
            >
              <summary className="dashboard__group-head">
                <span className="dashboard__group-name">{projectName}</span>
                <span className="dashboard__group-counts">
                  {items.length} session{items.length === 1 ? "" : "s"}
                  {awaitingCount > 0 && (
                    <span className="dashboard__group-awaiting">
                      {" · "}
                      {awaitingCount} awaiting
                    </span>
                  )}
                </span>
              </summary>
              <div className="dashboard__grid">
                {items.map((s) => (
                  <SessionCard
                    key={s.id}
                    session={s}
                    isReviewed={reviewedMap[s.id] === s.modified_ms}
                    isPinned={pinnedSessionIds.has(s.id)}
                    selected={selected?.id === s.id}
                    synthSelected={attendeeIds.has(s.id)}
                    onOpen={openSession}
                    onPin={pinSession}
                    onUnpin={unpinSession}
                    onSynthToggle={(session) => {
                      setAttendeeIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(session.id)) next.delete(session.id);
                        else next.add(session.id);
                        return next;
                      });
                    }}
                  />
                ))}
              </div>
            </details>
          );
        })}
      </div>

      {attendeeIds.size > 0 && (
        <div className="dashboard__synth-bar">
          <span className="dashboard__synth-hint">
            {attendeeIds.size} attendee
            {attendeeIds.size === 1 ? "" : "s"} selected — pick ≥2 to call a
            cross-functional sync
          </span>
          <div className="dashboard__synth-spacer" />
          <button
            className="dashboard__synth-btn dashboard__synth-btn--ghost"
            onClick={() => setAttendeeIds(new Set())}
          >
            Clear
          </button>
          <button
            className="dashboard__synth-btn"
            disabled={attendeeIds.size < 2}
            onClick={() => setShowMeeting(true)}
            title={
              attendeeIds.size < 2
                ? "Add one more attendee to start a meeting"
                : "Synthesise all selected sessions into meeting minutes"
            }
          >
            ☎ Call a meeting with {attendeeIds.size}
          </button>
        </div>
      )}

      {showMeeting && (
        <MeetingModal
          attendees={sessions.filter((s) => attendeeIds.has(s.id))}
          onClose={() => setShowMeeting(false)}
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
