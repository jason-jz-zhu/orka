import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRuns, type RunRecord } from "../lib/runs";
import type { SessionInfo } from "../lib/session-types";
import { invokeCmd } from "../lib/tauri";
import { alertDialog, confirmDialog } from "../lib/dialogs";
import { TerminalLaunchButton } from "./TerminalLaunchButton";
import { MeetingModal } from "./MeetingModal";
import { meetingSessionIdsForRuns } from "../lib/run-meeting";
import { runSubtitle } from "../lib/run-subtitle";
// Lazy so the OutputAnnotator + markdown renderer only load when the
// user opens the drawer — idle Runs tab stays lightweight.
const RunDetailDrawer = lazy(() => import("./RunDetailDrawer"));

type Props = {
  /** Called when the user clicks a run row that has a session id.
   *  App routes it: switches to the Sessions tab and pre-selects the
   *  matching session. */
  onOpenSession?: (sessionId: string) => void;
};

export default function RunsDashboard({ onOpenSession }: Props = {}) {
  const { runs, loading, refresh } = useRuns();
  const [clearing, setClearing] = useState(false);
  const [activeRun, setActiveRun] = useState<RunRecord | null>(null);

  // "Call a meeting across these runs" — same operator-narrative flow
  // as the Workforce tab, applied to past deliverables. Tracks the
  // selected run ids; only runs that persisted a session_id can join
  // a meeting (pure `claude -p` runs have no resumable tail).
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const [meetingAttendees, setMeetingAttendees] = useState<SessionInfo[] | null>(
    null,
  );
  const [resolvingMeeting, setResolvingMeeting] = useState(false);

  const toggleRunSelected = useCallback((id: string) => {
    setSelectedRunIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  async function callMeetingFromSelection() {
    if (resolvingMeeting) return;
    const sessionIds = meetingSessionIdsForRuns(runs, selectedRunIds);
    if (sessionIds.length < 2) return;
    setResolvingMeeting(true);
    try {
      const resolved = await Promise.all(
        sessionIds.map((sid) =>
          invokeCmd<SessionInfo | null>("find_session_by_id", {
            sessionId: sid,
          }).catch(() => null),
        ),
      );
      const attendees = resolved.filter((x): x is SessionInfo => x != null);
      if (attendees.length < 2) {
        await alertDialog(
          `Couldn't resolve enough session files — only found ${attendees.length} out of ${sessionIds.length}. The underlying JSONLs may have been deleted.`,
        );
        return;
      }
      setMeetingAttendees(attendees);
    } finally {
      setResolvingMeeting(false);
    }
  }

  // Reference-stabilise the callback so `memo(RunRow)` compares equal on
  // every parent re-render. Without this, App.tsx's inline `onOpenSession`
  // arrow defeats memoisation and all 200 rows still re-render.
  const openSessionRef = useRef(onOpenSession);
  openSessionRef.current = onOpenSession;
  const stableOpenSession = useCallback(
    (sid: string) => openSessionRef.current?.(sid),
    [],
  );
  const stableOpenDetail = useCallback((run: RunRecord) => {
    setActiveRun(run);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function clearAll() {
    if (clearing) return;
    const ok = await confirmDialog(
      `Delete ALL run history? This removes every record in ~/OrkaCanvas/runs/ and cannot be undone.`,
      {
        title: "Clear run history",
        okLabel: "Delete all",
        cancelLabel: "Cancel",
      },
    );
    if (!ok) return;
    setClearing(true);
    try {
      const n = await invokeCmd<number>("clear_runs");
      await refresh();
      await alertDialog(
        n === 0
          ? "No run-history files to delete."
          : `Deleted ${n} run-history file${n === 1 ? "" : "s"}.`,
        "Cleared",
      );
    } catch (e) {
      await alertDialog(`Clear failed: ${e}`);
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="runs-dash">
      <div className="runs-dash__header">
        <span className="runs-dash__title">Run History</span>
        <div className="runs-dash__actions">
          {runs.length > 0 && (
            <button
              className="runs-dash__clear"
              onClick={() => void clearAll()}
              disabled={clearing}
              title="Delete all run records (irreversible)"
            >
              {clearing ? "Clearing…" : "🗑 Clear"}
            </button>
          )}
          <button className="sidebar__toggle" onClick={refresh} title="Refresh">
            ↻
          </button>
        </div>
      </div>
      {loading && <div className="runs-dash__status">Loading...</div>}
      {!loading && runs.length === 0 && (
        <div className="runs-dash__status">
          No runs yet. Use <code>orka run &lt;skill&gt;</code> or Run All in the canvas.
        </div>
      )}
      {!loading && runs.length > 0 && (
        <table className="runs-dash__table">
          <thead>
            <tr>
              <th className="runs-dash__select-col" aria-label="Select" />
              <th>Skill</th>
              <th>Time</th>
              <th>Status</th>
              <th>Trigger</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <RunRow
                key={r.id}
                run={r}
                selected={selectedRunIds.has(r.id)}
                onToggleSelected={toggleRunSelected}
                onOpenSession={stableOpenSession}
                onOpenDetail={stableOpenDetail}
              />
            ))}
          </tbody>
        </table>
      )}

      {selectedRunIds.size > 0 && (
        <div className="dashboard__synth-bar runs-dash__meeting-bar">
          <span className="dashboard__synth-hint">
            {selectedRunIds.size} deliverable
            {selectedRunIds.size === 1 ? "" : "s"} selected — pick ≥2 to review
            as a team
          </span>
          <div className="dashboard__synth-spacer" />
          <button
            className="dashboard__synth-btn dashboard__synth-btn--ghost"
            onClick={() => setSelectedRunIds(new Set())}
          >
            Clear
          </button>
          <button
            className="dashboard__synth-btn"
            disabled={
              meetingSessionIdsForRuns(runs, selectedRunIds).length < 2 ||
              resolvingMeeting
            }
            onClick={() => void callMeetingFromSelection()}
            title={
              meetingSessionIdsForRuns(runs, selectedRunIds).length < 2
                ? "Pick at least two runs that have a captured session"
                : "Synthesise these deliverables into a meeting briefing"
            }
          >
            {resolvingMeeting
              ? "⏳ Resolving…"
              : `☎ Call a meeting across ${
                  meetingSessionIdsForRuns(runs, selectedRunIds).length
                } runs`}
          </button>
        </div>
      )}

      {meetingAttendees && (
        <MeetingModal
          attendees={meetingAttendees}
          onClose={() => setMeetingAttendees(null)}
        />
      )}
      {activeRun && (
        <Suspense fallback={null}>
          <RunDetailDrawer
            run={activeRun}
            onClose={() => setActiveRun(null)}
            onOpenSession={stableOpenSession}
          />
        </Suspense>
      )}
    </div>
  );
}

// Memoized so a single row change doesn't re-render every other row.
// Identity-stable props come from the parent via useCallback below.
const RunRow = memo(function RunRow({
  run,
  selected,
  onToggleSelected,
  onOpenSession,
  onOpenDetail,
}: {
  run: RunRecord;
  selected: boolean;
  onToggleSelected: (id: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenDetail?: (run: RunRecord) => void;
}) {
  const time = (() => {
    try {
      return new Date(run.started_at).toLocaleString();
    } catch {
      return run.started_at;
    }
  })();
  const duration = run.duration_ms
    ? `${(run.duration_ms / 1000).toFixed(1)}s`
    : "—";

  const hasSession = !!run.session_id;
  const clickable = hasSession && !!onOpenSession;
  // One-line descriptor so three rows of the same skill don't read as
  // identical. Priority: first input → workdir basename → "(empty)".
  const subtitle = runSubtitle(run);

  return (
    <tr
      className={
        `runs-dash__row runs-dash__row--${run.status}` +
        (clickable ? " runs-dash__row--clickable" : "") +
        (selected ? " runs-dash__row--selected" : "")
      }
      onClick={() => {
        if (clickable) onOpenSession?.(run.session_id!);
      }}
      title={
        clickable
          ? `Open session ${run.session_id!.slice(0, 8)}… in Sessions tab`
          : hasSession
            ? undefined
            : "No session captured for this run"
      }
    >
      <td
        className="runs-dash__cell runs-dash__select-cell"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          aria-label="Select run for meeting"
          checked={selected}
          disabled={!hasSession}
          onChange={() => onToggleSelected(run.id)}
          title={
            hasSession
              ? selected
                ? "Remove from meeting"
                : "Add to meeting"
              : "Legacy run — no session captured, can't join a meeting"
          }
        />
      </td>
      <td className="runs-dash__cell">
        <div className="runs-dash__skill-group">
          <div className="runs-dash__skill-name">
            {run.skill}
            {hasSession && (
              <span
                className="runs-dash__session-chip"
                title={`Session id: ${run.session_id}`}
              >
                → session
              </span>
            )}
          </div>
          <div
            className={
              "runs-dash__subtitle" +
              (subtitle.empty ? " runs-dash__subtitle--empty" : "")
            }
            title={subtitle.title}
          >
            {subtitle.text}
          </div>
        </div>
        {hasSession && (
          // The runs dashboard row is itself clickable; stopPropagation
          // on the wrapper prevents the row's onClick from firing when
          // the user is targeting the split button or its menu.
          <div
            className="runs-dash__term-slot"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <TerminalLaunchButton
              runId={run.id}
              sessionId={run.session_id!}
              workdir={run.workdir}
              onError={(msg) => void alertDialog(msg)}
            />
          </div>
        )}
        {run.workdir && (
          <button
            type="button"
            className="runs-dash__term-btn"
            title={`Reveal in Finder: ${run.workdir}`}
            onClick={async (e) => {
              e.stopPropagation();
              try {
                await invokeCmd("reveal_in_finder", { path: run.workdir });
              } catch (err) {
                await alertDialog(`Reveal failed: ${err}`);
              }
            }}
          >
            📄 Open
          </button>
        )}
        {onOpenDetail && (run.workdir || run.session_id) && (
          <button
            type="button"
            className="runs-dash__term-btn"
            title="View output and add annotations"
            onClick={(e) => {
              e.stopPropagation();
              onOpenDetail(run);
            }}
          >
            📝 Notes
          </button>
        )}
      </td>
      <td className="runs-dash__cell runs-dash__cell--time">{time}</td>
      <td className="runs-dash__cell">
        <span
          className={`runs-dash__status-badge runs-dash__status-badge--${run.status}`}
        >
          {run.status === "ok" ? "✓" : "✗"} {run.status}
        </span>
      </td>
      <td className="runs-dash__cell">{run.trigger}</td>
      <td className="runs-dash__cell">{duration}</td>
    </tr>
  );
});
