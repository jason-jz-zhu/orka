import { useEffect, useRef, useState } from "react";
import { invokeCmd, listenEvent } from "../lib/tauri";
import { parseLine } from "../lib/stream-parser";
import { alertDialog } from "../lib/dialogs";
import { OutputAnnotator } from "./OutputAnnotator";
import type { SkillMeta } from "../lib/skills";

type Props = {
  skill: SkillMeta;
};

type RunState = {
  output: string;
  running: boolean;
  costUsd?: number;
  toolCount: number;
  sessionId?: string;
  error?: string;
};

const INITIAL: RunState = {
  output: "",
  running: false,
  toolCount: 0,
};

/**
 * Canvas-free skill runner. One skill at a time: pick it on the left,
 * hit Run, watch the output stream in with block-level annotations,
 * then keep chatting inline. Replaces the old "open Studio, drop a
 * skill_ref node, run canvas" path for atomic skills.
 *
 * Composite skills (with an embedded DAG) redirect to Studio — they're
 * the one legitimate reason to visit the canvas.
 *
 * Each runner holds its own subprocess stream subscription; no canvas
 * store involvement. The annotator owns persistence for any notes the
 * user adds, keyed by a stable runId derived from skill slug.
 */
export function SkillRunner({ skill }: Props) {
  // A stable id for this runner instance. Annotations persist under this
  // key so revisiting the skill reloads notes on the same output if
  // nothing's been re-run. We reset on explicit run.
  const [runId, setRunId] = useState(() => freshRunId(skill.slug));
  const [state, setState] = useState<RunState>(INITIAL);
  const [reply, setReply] = useState("");
  const cleanupsRef = useRef<Array<() => void>>([]);

  // Reset state + subscriptions when the user switches to a different skill.
  useEffect(() => {
    for (const fn of cleanupsRef.current) fn();
    cleanupsRef.current = [];
    setRunId(freshRunId(skill.slug));
    setState(INITIAL);
    setReply("");
  }, [skill.slug]);

  // Subscribe to stream + done events for the current runId. Re-subscribes
  // whenever runId changes (i.e., on explicit re-run).
  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    (async () => {
      const unStream = await listenEvent<string>(`node:${runId}:stream`, (raw) => {
        const events = parseLine(raw);
        setState((prev) => {
          let next = { ...prev };
          for (const ev of events) {
            if (ev.kind === "text") {
              next.output = (next.output ?? "") + ev.text;
            } else if (ev.kind === "tool_use") {
              next.toolCount = (next.toolCount ?? 0) + 1;
            } else if (ev.kind === "result" && typeof ev.costUsd === "number") {
              next.costUsd = ev.costUsd;
            } else if (ev.kind === "system" && ev.sessionId) {
              next.sessionId = ev.sessionId;
            }
          }
          return next;
        });
      });
      if (cancelled) { unStream(); return; }
      cleanups.push(unStream);

      const unDone = await listenEvent<{ ok: boolean; error?: string }>(
        `node:${runId}:done`,
        (payload) => {
          setState((prev) => ({
            ...prev,
            running: false,
            error: payload && !payload.ok ? payload.error : undefined,
          }));
        },
      );
      if (cancelled) { unDone(); return; }
      cleanups.push(unDone);
    })();

    cleanupsRef.current = cleanups;
    return () => {
      cancelled = true;
      for (const fn of cleanups) fn();
    };
  }, [runId]);

  async function run() {
    setState({
      ...INITIAL,
      running: true,
    });
    try {
      await invokeCmd("run_agent_node", {
        id: runId,
        prompt: `/${skill.slug}`,
        resumeId: null,
        addDirs: [],
        allowedTools: null,
      });
    } catch (e) {
      setState((s) => ({ ...s, running: false, error: String(e) }));
      await alertDialog(`Run failed: ${e}`);
    }
  }

  async function runFresh() {
    // Rotate the runId so the old event listeners detach and annotations
    // for the previous output stay intact under their old key.
    const next = freshRunId(skill.slug);
    setRunId(next);
  }

  // When the user hits "Run" while a prior run exists, rotate the runId
  // on the FIRST run — thereafter `run()` reuses the current runId so
  // follow-up replies land in the same annotation namespace.
  // Handled via a small wrapper: initial Run creates fresh, Continue uses
  // the existing session id.

  async function continueConversation() {
    const text = reply.trim();
    if (!text || !state.sessionId || state.running) return;
    const prevOutput = state.output;
    setState((s) => ({
      ...s,
      running: true,
      output:
        (prevOutput ? prevOutput + "\n\n" : "") +
        `\n---\n\n**👤 you:** ${text}\n\n**🤖 claude:**\n\n`,
      toolCount: 0,
    }));
    setReply("");
    try {
      await invokeCmd("run_agent_node", {
        id: runId,
        prompt: text,
        resumeId: state.sessionId,
        addDirs: [],
        allowedTools: null,
      });
    } catch (e) {
      setState((s) => ({ ...s, running: false, error: String(e) }));
      await alertDialog(`Continue failed: ${e}`);
    }
  }

  const hasOutput = !!state.output;
  const hasError = !!state.error;

  return (
    <div className="skill-runner">
      <div className="skill-runner__header">
        <div className="skill-runner__title">
          <span className="skill-runner__icon">{skill.has_graph ? "◆" : "◇"}</span>
          <span className="skill-runner__slug">/{skill.slug}</span>
          <span className="skill-runner__source">{skill.source}</span>
        </div>
        {skill.description && (
          <div className="skill-runner__desc">{skill.description}</div>
        )}
      </div>

      {skill.has_graph ? (
        <div className="skill-runner__composite-note">
          This is a composite skill — it contains a multi-step DAG. Open
          the canvas (set <code>?canvas=1</code> in the URL) to run it as
          a pipeline. Atomic-skill runs in this surface coming for
          composites later.
        </div>
      ) : (
        <>
          <div className="skill-runner__controls">
            <button
              className="skill-runner__run-btn"
              onClick={hasOutput ? runFresh : run}
              disabled={state.running}
            >
              {state.running
                ? "Running…"
                : hasOutput
                  ? "Run again (fresh session)"
                  : "▶ Run skill"}
            </button>
            {!hasOutput && !state.running && (
              <button
                className="skill-runner__run-btn skill-runner__run-btn--ghost"
                onClick={run}
                disabled={state.running}
                style={{ display: "none" }}
              />
            )}
            {typeof state.costUsd === "number" && state.costUsd > 0 && (
              <span className="skill-runner__cost">
                ${state.costUsd.toFixed(4)}
              </span>
            )}
            {state.toolCount > 0 && (
              <span className="skill-runner__tools">
                🔧 {state.toolCount} {state.toolCount === 1 ? "tool" : "tools"}
              </span>
            )}
            {state.running && <span className="skill-runner__pulse">⋯ streaming</span>}
          </div>

          {hasError && (
            <div className="skill-runner__error">✗ {state.error}</div>
          )}

          {hasOutput && (
            <OutputAnnotator
              markdown={state.output}
              runId={runId}
              sourceTitle={skill.slug}
              sessionId={state.sessionId}
            />
          )}

          {hasOutput && !state.running && state.sessionId && (
            <div className="skill-runner__reply">
              <textarea
                className="skill-runner__reply-input"
                placeholder="Reply to continue this conversation… (⌘+Enter to send)"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void continueConversation();
                  }
                }}
                rows={2}
              />
              <button
                className="skill-runner__reply-btn"
                onClick={() => void continueConversation()}
                disabled={!reply.trim()}
              >
                ↪ Continue
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Stable-but-unique run id — tied to slug so annotations persist for the
 *  same skill across revisits, but rotated on each explicit fresh run so
 *  we don't mix old annotations onto new output. */
function freshRunId(slug: string): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 6);
  return `skill-${slug}-${ts}${rnd}`;
}
