import { memo } from "react";
import type { SessionInfo } from "../lib/session-types";
import { invokeCmd } from "../lib/tauri";
import { alertDialog } from "../lib/dialogs";
import { bump } from "../lib/perf";
import { SessionBriefCard } from "./SessionBriefCard";

export type CardState = "generating" | "for-review" | "reviewed" | "errored" | "idle";

export function stateOf(session: SessionInfo, isReviewed: boolean): CardState {
  if (session.status === "errored") return "errored";
  if (session.status === "live") {
    if (!session.awaiting_user) return "generating";
    // Awaiting user — green CTA, but if you've already opened it this turn
    // we dim it down so the inbox of "what to do next" stays readable.
    return isReviewed ? "reviewed" : "for-review";
  }
  if (session.status === "done") return isReviewed ? "reviewed" : "for-review";
  return "idle";
}

function fmtAgo(ms: number): string {
  if (!ms) return "—";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function projectName(cwd: string): string {
  return cwd.split("/").filter(Boolean).slice(-1)[0] || cwd;
}

const STATE_META: Record<
  CardState,
  { label: string; icon: string }
> = {
  generating: { label: "GENERATING", icon: "●" },
  "for-review": { label: "FOR REVIEW", icon: "✓" },
  reviewed: { label: "REVIEWED", icon: "✓" },
  errored: { label: "ERRORED", icon: "✗" },
  idle: { label: "IDLE", icon: "◦" },
};

type Props = {
  session: SessionInfo;
  isReviewed: boolean;
  isPinned: boolean;
  selected: boolean;
  /** Currently in the user's cross-session synthesis selection. */
  synthSelected?: boolean;
  onOpen: (s: SessionInfo) => void;
  onPin: (s: SessionInfo) => void;
  onUnpin: (s: SessionInfo) => void;
  /** Called when the user shift-clicks or toggles the synth checkbox. */
  onSynthToggle?: (s: SessionInfo) => void;
};

async function focusTerminal(path: string) {
  try {
    const msg = await invokeCmd<string>("focus_session_terminal", { path });
    console.log(`[orka:focus] ${msg}`);
  } catch (e) {
    console.warn("[orka:focus] failed:", e);
    await alertDialog(
      `Could not find the terminal for this session:\n${e}\n\n` +
        `Tip: the session must be running in Terminal.app or iTerm2 (macOS only).`
    );
  }
}

function SessionCardImpl({
  session,
  isReviewed,
  isPinned,
  selected,
  synthSelected,
  onOpen,
  onPin,
  onUnpin,
  onSynthToggle,
}: Props) {
  bump("SessionCard");
  const state = stateOf(session, isReviewed);
  const meta = STATE_META[state];
  // Primary content: the most recent *real* user ask (filters tool_results /
  // command wrappers / meta). Falls back to the original first prompt only
  // when the session has no follow-up yet.
  const ask =
    session.last_user_preview ||
    session.first_user_preview ||
    session.spawn_label ||
    "(agent-spawned)";
  const now = session.last_message_preview || "";
  const primaryAction = state === "for-review" ? "Review" : "Open";

  return (
    <div
      className={
        `session-card session-card--${state}` +
        (selected ? " session-card--selected" : "") +
        (synthSelected ? " session-card--synth-selected" : "")
      }
      onClick={(e) => {
        // Shift+click = toggle cross-session synthesis selection.
        // Regular click = open the session drawer.
        if (e.shiftKey && onSynthToggle) {
          e.preventDefault();
          onSynthToggle(session);
          return;
        }
        onOpen(session);
      }}
    >
      <div className="session-card__head">
        {onSynthToggle && (
          // Always-visible selector checkbox: picks this session as an
          // attendee in the next "Call a meeting" action. Clicking here
          // does NOT open the drawer (stopPropagation) — shift+click
          // on the card body still works as the power-user path.
          <label
            className="session-card__select"
            onClick={(e) => e.stopPropagation()}
            title={
              synthSelected
                ? "Remove from next meeting"
                : "Add to next meeting"
            }
          >
            <input
              type="checkbox"
              checked={!!synthSelected}
              onChange={() => onSynthToggle(session)}
              aria-label="Include in meeting"
            />
          </label>
        )}
        <span className="session-card__status">
          <span className="session-card__status-icon">{meta.icon}</span>
          {meta.label}
        </span>
        <span className="session-card__project" title={session.project_cwd}>
          {projectName(session.project_cwd)}
        </span>
        <span className="session-card__ago">{fmtAgo(session.modified_ms)}</span>
      </div>

      <div className="session-card__ask" title={ask}>
        <span className="session-card__label">💬</span>
        <span className="session-card__ask-text">{ask}</span>
      </div>

      <SessionBriefCard
        sessionId={session.id}
        sessionPath={session.path}
        compact
        // Auto-generate at stable checkpoints:
        //  - session modified in last 7 days (older ones unlikely to be revisited)
        //  - session is settled: either fully `done`, or live-but-awaiting-user
        //    (Claude has stopped streaming and is waiting on you — a natural
        //    pause point where the brief won't be stale).
        // Streaming sessions (status=live && !awaiting_user) still get the
        // manual ✨ Brief me button.
        autoGenerate={
          Date.now() - session.modified_ms < 7 * 24 * 60 * 60 * 1000 &&
          (session.status === "done" || session.awaiting_user === true)
        }
      />


      {now && (
        <div className="session-card__now" title={now}>
          {state === "generating" ? (
            <>
              <span className="session-card__label session-card__label--live">⋯</span>
              <span className="session-card__now-text">{now}</span>
            </>
          ) : (
            <>
              <span className="session-card__label">▷</span>
              <span className="session-card__now-text">{now}</span>
            </>
          )}
        </div>
      )}

      <div className="session-card__footer">
        <span className="session-card__metrics">
          {session.turn_count} turns
        </span>
        <span className="session-card__id">{session.id.slice(0, 8)}</span>
      </div>

      <div className="session-card__actions">
        <button
          className="session-card__primary"
          title={
            session.status === "live"
              ? "Jump back to the terminal running this session · Alt+Click for debug info"
              : "Open transcript · Alt+Click for debug info"
          }
          onClick={(e) => {
            e.stopPropagation();
            if (e.altKey) {
              invokeCmd("debug_session", { path: session.path }).then((r) => {
                // eslint-disable-next-line no-console
                console.log(`[orka:debug_session] ${session.id.slice(0, 8)}`, r);
              });
              return;
            }
            // Any live session — whether Claude is still generating OR
            // awaiting user input — maps to "take me back to that terminal".
            // Non-live (done / errored) sessions open the transcript drawer.
            // Either way, notify the parent so the FOR-REVIEW → REVIEWED
            // transition fires.
            if (session.status === "live") {
              focusTerminal(session.path);
            }
            onOpen(session);
          }}
        >
          {primaryAction}
        </button>
        <button
          className={
            "session-card__secondary" +
            (isPinned ? " session-card__secondary--active" : "")
          }
          onClick={(e) => {
            e.stopPropagation();
            if (isPinned) onUnpin(session);
            else onPin(session);
          }}
          title={
            isPinned
              ? "Unpin — remove SessionNode from pipeline"
              : "Pin as SessionNode to current pipeline"
          }
        >
          {isPinned ? "📌 Pinned" : "⊹ Pin"}
        </button>
      </div>
    </div>
  );
}

const SessionCard = memo(SessionCardImpl);
export default SessionCard;
