import { useEffect, useRef, useState } from "react";
import { invokeCmd } from "../lib/tauri";

export interface SessionBrief {
  sessionId: string;
  youWere: string;
  progress: string;
  nextLikely: string;
  sourceMtimeMs: number;
  generatedAt: string;
}

type Props = {
  sessionId: string;
  sessionPath: string;
  /** Compact variant squeezes into a narrow card; default expanded. */
  compact?: boolean;
};

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "generating" }
  | { kind: "ready"; brief: SessionBrief }
  | { kind: "error"; message: string };

/**
 * "You were: …" card. On mount, checks for a cached brief under the
 * current JSONL mtime. If present, render it instantly. If absent,
 * leave an explicit "Generate brief" affordance so the user controls
 * when to spend a claude -p call (and sees the latency, short as it is).
 *
 * Rationale for manual generation: auto-generating on every session open
 * would blast claude-p for every pinned session on every app start. The
 * cache is mtime-aware, so a one-time click per new session is fine.
 */
export function SessionBriefCard({ sessionId, sessionPath, compact }: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      try {
        const cached = await invokeCmd<SessionBrief | null>("get_session_brief", {
          sessionId,
          sessionPath,
        });
        if (cancelled) return;
        if (cached) {
          setState({ kind: "ready", brief: cached });
        } else {
          setState({ kind: "idle" });
        }
      } catch (e) {
        if (!cancelled) setState({ kind: "error", message: String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, sessionPath]);

  async function generate() {
    setState({ kind: "generating" });
    try {
      const brief = await invokeCmd<SessionBrief>("generate_session_brief", {
        sessionId,
        sessionPath,
      });
      if (mountedRef.current) setState({ kind: "ready", brief });
    } catch (e) {
      if (mountedRef.current)
        setState({ kind: "error", message: String(e) });
    }
  }

  async function regenerate() {
    try {
      await invokeCmd("clear_session_brief", { sessionId });
    } catch {}
    await generate();
  }

  const klass = `session-brief${compact ? " session-brief--compact" : ""}`;

  if (state.kind === "loading") {
    return (
      <div className={klass}>
        <div className="session-brief__status">…</div>
      </div>
    );
  }

  if (state.kind === "idle") {
    return (
      <div className={klass}>
        <button
          type="button"
          className="session-brief__generate"
          onClick={(e) => {
            e.stopPropagation();
            void generate();
          }}
          title="Have Claude summarize what this session was about"
        >
          ✨ Brief me
        </button>
      </div>
    );
  }

  if (state.kind === "generating") {
    return (
      <div className={klass}>
        <div className="session-brief__status">⏳ Summarizing…</div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className={klass}>
        <div className="session-brief__error" title={state.message}>
          ✗ Brief failed
          <button
            type="button"
            className="session-brief__regen"
            onClick={(e) => {
              e.stopPropagation();
              void generate();
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const { brief } = state;
  return (
    <div className={klass}>
      <div className="session-brief__row">
        <span className="session-brief__label">You were:</span>
        <span className="session-brief__value">{brief.youWere}</span>
      </div>
      <div className="session-brief__row">
        <span className="session-brief__label">Progress:</span>
        <span className="session-brief__value">{brief.progress}</span>
      </div>
      <div className="session-brief__row">
        <span className="session-brief__label">Next likely:</span>
        <span className="session-brief__value">{brief.nextLikely}</span>
      </div>
      <button
        type="button"
        className="session-brief__regen"
        onClick={(e) => {
          e.stopPropagation();
          void regenerate();
        }}
        title="Regenerate this brief"
      >
        ↻
      </button>
    </div>
  );
}
