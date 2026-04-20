import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRuns, type RunRecord } from "../lib/runs";
import { invokeCmd } from "../lib/tauri";
import { alertDialog, confirmDialog } from "../lib/dialogs";
import { openSessionInTerminal } from "../lib/terminal-config";
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
                onOpenSession={stableOpenSession}
                onOpenDetail={stableOpenDetail}
              />
            ))}
          </tbody>
        </table>
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
  onOpenSession,
  onOpenDetail,
}: {
  run: RunRecord;
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

  return (
    <tr
      className={
        `runs-dash__row runs-dash__row--${run.status}` +
        (clickable ? " runs-dash__row--clickable" : "")
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
      <td className="runs-dash__cell">
        {run.skill}
        {hasSession && (
          <span
            className="runs-dash__session-chip"
            title={`Session id: ${run.session_id}`}
          >
            → session
          </span>
        )}
        {hasSession && (
          <button
            type="button"
            className="runs-dash__term-btn"
            title="Continue in terminal (claude --resume)"
            onClick={async (e) => {
              e.stopPropagation();
              try {
                const result = await openSessionInTerminal(
                  run.id,
                  run.session_id!,
                  run.workdir ?? null,
                );
                if (result.clipboard_payload) {
                  try {
                    await navigator.clipboard.writeText(
                      result.clipboard_payload,
                    );
                    await alertDialog(
                      `Opened ${result.resolved}. Command copied to clipboard — press Ctrl+\` in VS Code and paste:\n\n${result.clipboard_payload}`,
                      "Opened in VS Code",
                    );
                  } catch {
                    await alertDialog(
                      `Opened ${result.resolved}. Paste this in the terminal:\n\n${result.clipboard_payload}`,
                      "Opened in VS Code",
                    );
                  }
                }
              } catch (err) {
                await alertDialog(`Open terminal failed: ${err}`);
              }
            }}
          >
            ⌨ Terminal
          </button>
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
