import type { SessionInfo } from "../lib/session-types";
import { invokeCmd } from "../lib/tauri";
import { alertDialog } from "../lib/dialogs";

export type CardState = "generating" | "for-review" | "reviewed" | "errored" | "idle";

function stateOf(session: SessionInfo, isReviewed: boolean): CardState {
  if (session.status === "errored") return "errored";
  if (session.status === "live") {
    // Claude finished the current turn (last line = assistant with text)
    // → waiting for user → "for review". Otherwise still mid-generation.
    return session.awaiting_user ? "for-review" : "generating";
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
  onOpen: () => void;
  onPin: () => void;
  onUnpin: () => void;
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

export default function SessionCard({
  session,
  isReviewed,
  isPinned,
  selected,
  onOpen,
  onPin,
  onUnpin,
}: Props) {
  const state = stateOf(session, isReviewed);
  const meta = STATE_META[state];
  // Primary content: the most recent *real* user ask (filters tool_results /
  // command wrappers / meta). Falls back to the original first prompt only
  // when the session has no follow-up yet.
  const ask =
    session.last_user_preview ||
    session.first_user_preview ||
    "(no user messages)";
  const now = session.last_message_preview || "";
  const primaryAction = state === "for-review" ? "Review" : "Open";

  return (
    <div
      className={
        `session-card session-card--${state}` +
        (selected ? " session-card--selected" : "")
      }
      onClick={onOpen}
    >
      <div className="session-card__head">
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
            state === "for-review"
              ? "Review: jump back to the terminal running this session · Alt+Click for debug info"
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
            // For "Review" (live + awaiting_user), jump to terminal instead
            // of opening the transcript drawer.
            if (state === "for-review" && session.status === "live") {
              focusTerminal(session.path);
              return;
            }
            onOpen();
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
            if (isPinned) onUnpin();
            else onPin();
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
