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
  /**
   * When true (default), auto-generate a brief on mount if no cached one
   * exists. Throttled globally so many session cards don't all hit
   * `claude -p` at once. Pass false for older / less-relevant sessions.
   */
  autoGenerate?: boolean;
};

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "generating" }
  | { kind: "ready"; brief: SessionBrief }
  | { kind: "error"; message: string };

// ────────── global concurrency throttle ──────────────────────────────
//
// Each brief generation spawns one `claude -p` subprocess. Without a cap,
// loading the Sessions tab with 20 fresh sessions would fire 20 parallel
// claude processes — CPU spike, possible rate-limit, and terrible UX
// feedback (everything pending at once).
//
// Limit to 2 concurrent generations. The queue is FIFO, so the first
// visible cards brief first.

const MAX_CONCURRENT_GENERATIONS = 2;
let activeJobs = 0;
const jobQueue: Array<() => Promise<void>> = [];

function scheduleBriefJob(job: () => Promise<void>): { cancel: () => void } {
  let cancelled = false;
  const wrapped = async () => {
    if (cancelled) return;
    activeJobs++;
    try {
      await job();
    } finally {
      activeJobs--;
      const next = jobQueue.shift();
      if (next) void next();
    }
  };
  if (activeJobs < MAX_CONCURRENT_GENERATIONS) {
    void wrapped();
  } else {
    jobQueue.push(wrapped);
  }
  return {
    cancel: () => {
      cancelled = true;
      const i = jobQueue.indexOf(wrapped);
      if (i >= 0) jobQueue.splice(i, 1);
    },
  };
}

/**
 * "You were: …" card. Auto-generates on mount if no cached brief exists
 * and `autoGenerate` is true (default). Parent typically passes false
 * for sessions older than ~7 days to avoid hammering claude -p for
 * sessions unlikely to be revisited.
 *
 * Cache is mtime-keyed on the backend: if the session's JSONL hasn't
 * changed since the last brief was written, we hydrate instantly. If
 * it has, we regenerate once and cache.
 */
export function SessionBriefCard({
  sessionId,
  sessionPath,
  compact,
  autoGenerate = true,
}: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const mountedRef = useRef(true);
  const jobHandleRef = useRef<{ cancel: () => void } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      jobHandleRef.current?.cancel();
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
          return;
        }
        // No cache. If auto-generation is enabled, enqueue one via the
        // shared throttle. Otherwise leave idle so the user can trigger
        // manually.
        if (!autoGenerate) {
          setState({ kind: "idle" });
          return;
        }
        setState({ kind: "generating" });
        jobHandleRef.current = scheduleBriefJob(async () => {
          console.log(`[session-brief] auto-gen starting: ${sessionId}`);
          try {
            const brief = await invokeCmd<SessionBrief | null>(
              "generate_session_brief",
              { sessionId, sessionPath },
            );
            if (!mountedRef.current || cancelled) return;
            if (!brief) {
              // Backend returned no brief (unreachable in prod, but a
              // permissive test stub or race can hit it). Falling back
              // to idle keeps the card interactive instead of crashing
              // on a null destructure.
              setState({ kind: "idle" });
              return;
            }
            console.log(`[session-brief] auto-gen OK: ${sessionId}`);
            setState({ kind: "ready", brief });
          } catch (e) {
            // Surface the error: previously we silently fell back to
            // idle which made "why didn't it auto-brief?" impossible
            // to debug. Shows a compact retry with the real error on
            // hover; user can still click Brief me to retry.
            if (mountedRef.current && !cancelled) {
              const msg = String(e);
              console.warn(`[session-brief] auto-gen failed for ${sessionId}:`, msg);
              setState({ kind: "error", message: msg });
            }
          }
        });
      } catch (e) {
        if (!cancelled) setState({ kind: "error", message: String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, sessionPath, autoGenerate]);

  async function generateNow() {
    setState({ kind: "generating" });
    try {
      const brief = await invokeCmd<SessionBrief | null>(
        "generate_session_brief",
        { sessionId, sessionPath },
      );
      if (!mountedRef.current) return;
      if (!brief) {
        setState({ kind: "idle" });
        return;
      }
      setState({ kind: "ready", brief });
    } catch (e) {
      if (mountedRef.current)
        setState({ kind: "error", message: String(e) });
    }
  }

  async function regenerate() {
    try {
      await invokeCmd("clear_session_brief", { sessionId });
    } catch {}
    await generateNow();
  }

  const klass = `session-brief${compact ? " session-brief--compact" : ""}`;

  // Shared pre-ready skeleton. Fills the same vertical footprint the
  // final brief will take so the card doesn't reflow when the brief
  // arrives. Used for both "loading" (checking cache) and
  // "generating" (Haiku actively summarising) states; the footer
  // label differentiates them.
  function skeletonContent(label: string) {
    return (
      <>
        <div className="session-brief__skeleton session-brief__skeleton--headline" />
        <div className="session-brief__skeleton session-brief__skeleton--body" />
        <div className="session-brief__skeleton session-brief__skeleton--body" />
        <div className="session-brief__status session-brief__status--inline">{label}</div>
      </>
    );
  }

  if (state.kind === "loading") {
    return (
      <div className={klass}>
        {skeletonContent("Loading brief…")}
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
            void generateNow();
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
        {skeletonContent("⏳ Summarizing…")}
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
              void generateNow();
            }}
            title={state.message}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const { brief } = state;
  const progress = brief.progress.trim();
  const nextLikely = brief.nextLikely.trim();
  return (
    <div className={klass}>
      <div className="session-brief__headline">{brief.youWere}</div>
      {(progress || nextLikely) && (
        <div className="session-brief__body">
          {progress}
          {progress && nextLikely ? " " : ""}
          {nextLikely && (
            <>
              <span className="session-brief__arrow">→</span>
              {" "}
              {nextLikely}
            </>
          )}
        </div>
      )}
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
