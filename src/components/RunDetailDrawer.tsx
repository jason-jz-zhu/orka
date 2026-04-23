import { useEffect, useState } from "react";
import type { RunRecord } from "../lib/runs";
import { invokeCmd } from "../lib/tauri";
import { alertDialog } from "../lib/dialogs";
import { OutputAnnotator } from "./OutputAnnotator";
import { RunChatPanel } from "./RunChatPanel";
import { TerminalLaunchButton } from "./TerminalLaunchButton";

type ReconstructResult = {
  markdown: string;
  source: "workdir" | "session" | "none";
  source_path: string | null;
  truncated: boolean;
};

type Props = {
  /** The run being viewed. Null closes the drawer. */
  run: RunRecord | null;
  onClose: () => void;
  /** Forwarded to the OutputAnnotator's "→ session" action. */
  onOpenSession?: (sessionId: string) => void;
};

/**
 * Side drawer opened from the Runs tab. Reconstructs a past run's
 * output (from its workdir artifact or the session transcript) and
 * hands it to OutputAnnotator so the user can add notes post-hoc.
 *
 * Annotations are keyed on `run.id` and share storage with the
 * annotations created live during the run — opening the drawer on a
 * run you previously annotated in SkillRunner will show those notes.
 */
export default function RunDetailDrawer({
  run,
  onClose,
  onOpenSession,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ReconstructResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!run) {
      setData(null);
      setError(null);
      return;
    }
    // Guard against rapid open/close/reopen: capture the current
    // effect's lifetime so a late IPC response for a stale run can't
    // stomp the state with data from a run the user already navigated
    // away from. Tauri doesn't support native abort, but the cleanup
    // flag is sufficient to drop the late result.
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const r = await invokeCmd<ReconstructResult>("reconstruct_run_output", {
          runId: run.id,
          sessionId: run.session_id ?? null,
          workdir: run.workdir ?? null,
        });
        if (!cancelled) {
          setData(r);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [run?.id, run?.session_id, run?.workdir]);

  if (!run) return null;

  const status = data?.source ?? (loading ? "loading" : "none");
  const timeStr = (() => {
    try {
      return new Date(run.started_at).toLocaleString();
    } catch {
      return run.started_at;
    }
  })();

  return (
    <div className="run-drawer__overlay" onClick={onClose}>
      <div
        className="run-drawer"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="run-drawer__header">
          <div className="run-drawer__title">
            <span className="run-drawer__skill">/{run.skill}</span>
            <span className="run-drawer__time">{timeStr}</span>
            <span
              className={`run-drawer__status run-drawer__status--${run.status}`}
            >
              {run.status === "ok" ? "✓" : "✗"} {run.status}
            </span>
            <span className="run-drawer__trigger">{run.trigger}</span>
          </div>
          <button
            type="button"
            className="run-drawer__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="run-drawer__meta">
          {status === "loading" && (
            <span className="run-drawer__meta-item">Loading output…</span>
          )}
          {status === "workdir" && data?.source_path && (
            <span className="run-drawer__meta-item" title={run.workdir}>
              📄 {data.source_path}
              {data.truncated && " · truncated"}
            </span>
          )}
          {status === "session" && data?.source_path && (
            <span className="run-drawer__meta-item">
              📜 {data.source_path}
              {data.truncated && " · truncated"}
            </span>
          )}
          {status === "none" && !loading && (
            <span className="run-drawer__meta-item run-drawer__meta-item--warn">
              No output available — the workdir was removed and no session
              transcript is accessible.
            </span>
          )}
          <span className="run-drawer__meta-spacer" />
          {run.workdir && (
            <button
              type="button"
              className="run-drawer__action"
              onClick={async () => {
                try {
                  await invokeCmd("reveal_in_finder", { path: run.workdir });
                } catch (e) {
                  await alertDialog(`Reveal failed: ${e}`);
                }
              }}
            >
              📂 Folder
            </button>
          )}
          {run.session_id && onOpenSession && (
            <button
              type="button"
              className="run-drawer__action"
              onClick={() => {
                onOpenSession(run.session_id!);
                onClose();
              }}
            >
              → session
            </button>
          )}
          {run.session_id && (
            <TerminalLaunchButton
              runId={run.id}
              sessionId={run.session_id}
              workdir={run.workdir}
              onError={(msg) => void alertDialog(msg)}
            />
          )}
        </div>

        <div className="run-drawer__body">
          {error && <div className="run-drawer__error">{error}</div>}
          {status === "none" && !loading && !error && (
            <div className="run-drawer__empty">
              Nothing to annotate for this run. Skills that don't write an
              output artifact can still be annotated by viewing the session
              transcript — but this run's session isn't available either.
            </div>
          )}
          {data && data.markdown && (
            <OutputAnnotator
              markdown={data.markdown}
              runId={run.id}
              sourceTitle={run.skill}
              sessionId={run.session_id}
              workdir={run.workdir}
            />
          )}
          {/* Chat panel: complements the block-level annotator above
              with a free-form thread about the whole run. Both
              co-exist — block annotations for targeted markup,
              chat for unscoped follow-ups and iterative refinement. */}
          <RunChatPanel
            runId={run.id}
            sessionId={run.session_id}
            workdir={run.workdir}
            sourceTitle={run.skill}
          />
        </div>
      </div>
    </div>
  );
}
