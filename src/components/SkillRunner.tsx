import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invokeCmd, listenEvent } from "../lib/tauri";
import { parseLineInto, type StreamEvent } from "../lib/stream-parser";
import { alertDialog } from "../lib/dialogs";
import { OutputAnnotator } from "./OutputAnnotator";
// Lazy so the modal lands in its own chunk (also imported lazily in
// App.tsx). Static import here would inline it into the main bundle.
const ScheduleModal = lazy(() => import("./ScheduleModal"));
import { SkillEvolutionModal } from "./SkillEvolutionModal";
import {
  SkillTrustModal,
  type SkillTrustState,
} from "./SkillTrustModal";
import {
  deleteSchedule,
  describeSchedule,
  listSchedulesForSkill,
  type Schedule,
} from "../lib/schedules";
import { confirmDialog } from "../lib/dialogs";
import { useSkills } from "../lib/skills";
import type { SkillMeta } from "../lib/skills";

/** Prefix for schedules targeting an atomic skill (as opposed to a
 *  canvas pipeline). Lets runScheduledPipeline route to the right
 *  executor without breaking the existing pipeline-schedule path. */
const SKILL_SCHEDULE_PREFIX = "skill:";

type Props = {
  skill: SkillMeta;
  /** Supplied by SkillsTab → App. Opens the composite skill's DAG in
   *  the canvas editor (reveals Studio tab + loads graph.json). */
  onOpenInCanvas?: (slug: string, path: string) => Promise<void> | void;
  /** Seed the free-text prompt. Used by the "Hire by describe" flow:
   *  SkillsTab asks the user a one-sentence goal, auto-selects the
   *  orka-skill-builder skill, then drops the sentence into this prop
   *  so the runner lands ready-to-Run without the user re-typing. */
  initialPrompt?: string;
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
export function SkillRunner({ skill, onOpenInCanvas, initialPrompt }: Props) {
  // A stable id for this runner instance. Annotations persist under this
  // key so revisiting the skill reloads notes on the same output if
  // nothing's been re-run. We reset on explicit run.
  const [runId, setRunId] = useState(() => freshRunId(skill.slug));
  const [state, setState] = useState<RunState>(INITIAL);
  const [reply, setReply] = useState("");
  // Schedule editor opens in either "new" mode (label === null) or
  // "edit mode" (label === existing). Closed when null.
  const [showSchedule, setShowSchedule] = useState<
    { label: string | null } | null
  >(null);
  const [showEvolve, setShowEvolve] = useState(false);
  const [pendingTrust, setPendingTrust] = useState<SkillTrustState | null>(
    null,
  );
  const [suggesting, setSuggesting] = useState(false);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [outputFolder, setOutputFolder] = useState<string | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>(
    () => seedInputValues(skill),
  );
  // Free-form prompt text. Always shown above the controls. Gets
  // prepended to the composed /slug prompt so users can add context
  // without needing frontmatter-declared inputs. The existing structured
  // inputs (if any) still work — this is additive.
  // Seed from `initialPrompt` on first mount only — once the user has
  // edited or fired a run, we never stomp their text.
  const [freeText, setFreeText] = useState(initialPrompt ?? "");
  // Advanced inputs disclosure — collapsed by default. Structured inputs
  // are now optional overrides, not the primary input surface.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const refreshSkills = useSkills((s) => s.refresh);
  const cleanupsRef = useRef<Array<() => void>>([]);
  // Start-time stash for the Run History record. Set when the spawn
  // actually fires; read by the `done` listener below. A ref (not
  // state) because the listener closes over stale state otherwise.
  const runStartRef = useRef<
    { startedAt: string; inputs: string[]; workdir: string | null } | null
  >(null);
  // Session id captured from the stream's `system init` event. Stored in
  // a ref (not state) so the `done` handler reads the *latest* value
  // synchronously — React state batching can otherwise leave the closure
  // reading a stale snapshot, which was dropping session_id from the
  // Run History JSONL and breaking the row → session jump.
  const sessionIdRef = useRef<string | undefined>(undefined);

  const scheduleName = `${SKILL_SCHEDULE_PREFIX}${skill.slug}`;

  // Load all schedules attached to this skill. Refreshes when the modal
  // closes so edits/deletes reflect immediately.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listSchedulesForSkill(skill.slug);
        if (!cancelled) setSchedules(list);
      } catch {
        if (!cancelled) setSchedules([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [skill.slug, showSchedule]);

  async function handleDeleteSchedule(label: string | null) {
    const ok = await confirmDialog(
      `Delete schedule "${label ?? "(default)"}"? History will be lost.`,
      { title: "Delete schedule", okLabel: "Delete", cancelLabel: "Cancel" },
    );
    if (!ok) return;
    try {
      await deleteSchedule(scheduleName, label);
      const list = await listSchedulesForSkill(skill.slug);
      setSchedules(list);
      window.dispatchEvent(new Event("orka:schedule-changed"));
    } catch (e) {
      await alertDialog(`Delete failed: ${e}`);
    }
  }

  // Load the configured output folder for this skill. Null when none
  // is configured (falls back to the default per-workspace node dir).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await invokeCmd<
          { output_folder: string } | null
        >("get_skill_output_config", { slug: skill.slug });
        if (!cancelled) setOutputFolder(cfg?.output_folder ?? null);
      } catch {
        if (!cancelled) setOutputFolder(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [skill.slug]);

  async function pickOutputFolder() {
    try {
      const chosen = await openDialog({
        directory: true,
        multiple: false,
        title: `Choose output folder for ${skill.slug}`,
      });
      if (!chosen || Array.isArray(chosen)) return;
      await invokeCmd("set_skill_output_folder", {
        slug: skill.slug,
        folder: chosen,
        subfolderTemplate: null,
        scheduledSubfolderTemplate: null,
      });
      setOutputFolder(chosen);
    } catch (e) {
      await alertDialog(`Set folder failed: ${e}`);
    }
  }

  async function clearOutputFolder() {
    try {
      await invokeCmd("clear_skill_output_folder", { slug: skill.slug });
      setOutputFolder(null);
    } catch (e) {
      await alertDialog(`Clear folder failed: ${e}`);
    }
  }

  // Reset state + subscriptions when the user switches to a different skill.
  useEffect(() => {
    for (const fn of cleanupsRef.current) fn();
    cleanupsRef.current = [];
    setRunId(freshRunId(skill.slug));
    setState(INITIAL);
    setReply("");
    setInputValues(seedInputValues(skill));
    setFreeText("");
    setAdvancedOpen(false);
    sessionIdRef.current = undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill.slug]);

  // Subscribe to stream + done events for the current runId. Re-subscribes
  // whenever runId changes (i.e., on explicit re-run).
  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    // Pending deltas accumulated since the last flush. Claude streams
    // at ~100-300 tokens/sec; calling setState for each event forces
    // 100+ renders/sec and triggers a noticeable main-thread hiccup.
    // rAF-batching collapses bursts into one render per frame (~60 Hz),
    // so render count drops by 2-5x on fast streams.
    const pending: {
      outputDelta: string;
      toolDelta: number;
      costUsd?: number;
      sessionId?: string;
    } = { outputDelta: "", toolDelta: 0 };
    let rafHandle: number | null = null;

    function flush() {
      rafHandle = null;
      if (cancelled) return;
      const snapshot = {
        outputDelta: pending.outputDelta,
        toolDelta: pending.toolDelta,
        costUsd: pending.costUsd,
        sessionId: pending.sessionId,
      };
      pending.outputDelta = "";
      pending.toolDelta = 0;
      pending.costUsd = undefined;
      pending.sessionId = undefined;
      if (
        !snapshot.outputDelta &&
        snapshot.toolDelta === 0 &&
        snapshot.costUsd === undefined &&
        snapshot.sessionId === undefined
      ) {
        return;
      }
      setState((prev) => {
        const next = { ...prev };
        if (snapshot.outputDelta) {
          next.output = (next.output ?? "") + snapshot.outputDelta;
        }
        if (snapshot.toolDelta) {
          next.toolCount = (next.toolCount ?? 0) + snapshot.toolDelta;
        }
        if (snapshot.costUsd !== undefined) {
          next.costUsd = snapshot.costUsd;
        }
        if (snapshot.sessionId) {
          next.sessionId = snapshot.sessionId;
        }
        return next;
      });
    }

    function schedule() {
      if (rafHandle !== null) return;
      // When the window is hidden (user switched apps, tab minimized),
      // rAF in a browser pauses automatically — but Tauri's WKWebView
      // keeps firing rAF at 60Hz even in the background, burning CPU
      // for renders nobody sees. Detect `hidden` and fall back to a
      // throttled setTimeout; still flushes eventually so state stays
      // consistent, just not at every frame.
      const isHidden =
        typeof document !== "undefined" &&
        document.visibilityState === "hidden";
      if (isHidden) {
        rafHandle = setTimeout(flush, 250) as unknown as number;
        return;
      }
      if (typeof requestAnimationFrame === "function") {
        rafHandle = requestAnimationFrame(flush);
      } else {
        rafHandle = setTimeout(flush, 16) as unknown as number;
      }
    }

    // Scratch array reused across every stream line. Passing this into
    // parseLineInto() avoids 3-5 allocations per token; at 300 tokens/sec
    // that's ~1000 events/sec we no longer churn through the GC.
    const scratch: StreamEvent[] = [];
    (async () => {
      const unStream = await listenEvent<string>(`node:${runId}:stream`, (raw) => {
        scratch.length = 0;
        parseLineInto(raw, scratch);
        for (const ev of scratch) {
          if (ev.kind === "text") {
            pending.outputDelta += ev.text;
          } else if (ev.kind === "tool_use") {
            pending.toolDelta += 1;
          } else if (ev.kind === "result" && typeof ev.costUsd === "number") {
            pending.costUsd = ev.costUsd;
          } else if (ev.kind === "system" && ev.sessionId) {
            pending.sessionId = ev.sessionId;
            // Keep the ref update synchronous — the done handler reads
            // it on the next tick and needs the latest value even if
            // we haven't flushed the rAF batch yet.
            sessionIdRef.current = ev.sessionId;
          }
        }
        schedule();
      });
      if (cancelled) { unStream(); return; }
      cleanups.push(unStream);

      const unDone = await listenEvent<{ ok: boolean; error?: string }>(
        `node:${runId}:done`,
        (payload) => {
          // Flush any rAF-batched tokens synchronously so the final
          // state snapshot includes everything that streamed in. Without
          // this the last partial frame of tokens can be dropped if
          // `done` arrives before the next rAF tick.
          if (rafHandle !== null) {
            if (typeof cancelAnimationFrame === "function") {
              cancelAnimationFrame(rafHandle);
            } else {
              clearTimeout(rafHandle as unknown as ReturnType<typeof setTimeout>);
            }
            flush();
          }
          setState((prev) => ({
            ...prev,
            running: false,
            error: payload && !payload.ok ? payload.error : undefined,
          }));

          // Persist to Run History. Canvas runs already do this via
          // run-all.ts; SkillRunner is the other entry point so it
          // needs its own log. Best-effort — a failed history write
          // shouldn't surface an error after the run already completed.
          const start = runStartRef.current;
          if (start) {
            runStartRef.current = null;
            const endedAt = new Date().toISOString();
            const ok = payload?.ok ?? false;
            // Read session id directly from the ref — the stream
            // listener updates it synchronously when the `system init`
            // event arrives, so by the time `done` fires it holds the
            // final value. Previously this read from state via a
            // setState-identity trick which could return stale data
            // under React batching, dropping session_id from logs.
            const capturedSessionId = sessionIdRef.current;
            invokeCmd("append_run", {
              record: {
                id: runId,
                skill: skill.slug,
                inputs: start.inputs,
                started_at: start.startedAt,
                ended_at: endedAt,
                duration_ms:
                  new Date(endedAt).getTime() -
                  new Date(start.startedAt).getTime(),
                status: ok ? "ok" : "error",
                trigger: "manual",
                error_message: ok ? undefined : payload?.error,
                session_id: capturedSessionId,
                workdir: start.workdir ?? undefined,
              },
            }).catch((e) => console.warn("append_run failed:", e));
          }
        },
      );
      if (cancelled) { unDone(); return; }
      cleanups.push(unDone);
    })();

    cleanupsRef.current = cleanups;
    return () => {
      cancelled = true;
      if (rafHandle !== null) {
        if (typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(rafHandle);
        } else {
          clearTimeout(rafHandle as unknown as ReturnType<typeof setTimeout>);
        }
      }
      for (const fn of cleanups) fn();
    };
  }, [runId]);

  /** The actual spawn — gated `run()` calls through to this after the
   *  trust check. Kept separate so the trust modal's onApprove can
   *  resume execution without duplicating the try/catch. */
  async function spawnRun() {
    // Snapshot inputs for the history record. Free-text first so it
    // appears as the most recognizable line in the Runs list; declared
    // inputs follow as `key=value`.
    const inputsSummary: string[] = [];
    const trimmedFree = freeText.trim();
    if (trimmedFree) {
      inputsSummary.push(
        trimmedFree.length > 140
          ? trimmedFree.slice(0, 138) + "…"
          : trimmedFree,
      );
    }
    for (const inp of skill.inputs ?? []) {
      const v = (inputValues[inp.name] ?? "").trim();
      if (v) inputsSummary.push(`${inp.name}=${v}`);
    }
    // Capture the resolved workdir at start time so Runs → 📄 Open
    // knows where the run's artifacts ended up — this works even when
    // the run errors, because we need the path regardless of outcome.
    let resolvedWorkdir: string | null = null;
    try {
      resolvedWorkdir = await invokeCmd<string>("preview_run_workdir", {
        skillSlug: skill.slug,
        scheduleLabel: null,
        runId,
        inputs: inputsSummary,
      });
    } catch {
      resolvedWorkdir = null;
    }
    runStartRef.current = {
      startedAt: new Date().toISOString(),
      inputs: inputsSummary,
      workdir: resolvedWorkdir,
    };

    setState({
      ...INITIAL,
      running: true,
    });
    try {
      await invokeCmd("run_agent_node", {
        id: runId,
        prompt: composeSkillPrompt(skill, inputValues, freeText),
        resumeId: null,
        addDirs: [],
        allowedTools: null,
        skillSlug: skill.slug,
        scheduleLabel: null,
        inputsForTemplate: inputsSummary,
        // Pass the already-resolved workdir (captured just above via
        // `preview_run_workdir`) so the backend doesn't re-resolve
        // with a later `Local::now()` and land in a different minute
        // bucket. Otherwise the Run History's `workdir` field and
        // the actual output-writing directory drift apart — breaking
        // "📂 Folder" reveal-in-finder on slow-to-start runs.
        explicitWorkdir: resolvedWorkdir ?? null,
      });
    } catch (e) {
      setState((s) => ({ ...s, running: false, error: String(e) }));
      await alertDialog(`Run failed: ${e}`);
    }
  }

  /** Ask Claude to generate 3 natural-language example prompts from this
   *  skill's SKILL.md, then persist them to the file. On success the
   *  skills watcher picks up the change and chips appear under the
   *  textarea automatically. */
  async function suggestExamples() {
    if (suggesting) return;
    setSuggesting(true);
    try {
      await invokeCmd<{ slug: string; examples: string[] }>(
        "suggest_skill_examples",
        { slug: skill.slug },
      );
      await refreshSkills();
    } catch (e) {
      await alertDialog(`Couldn't generate examples: ${e}`);
    } finally {
      setSuggesting(false);
    }
  }

  /** Check the TOFU trust store before running. Three outcomes:
   *    1. trusted & hash matches      → spawn immediately
   *    2. never-trusted (first run)   → show consent modal
   *    3. hash changed since approval → show re-consent modal
   *  The backend persists approvals; this fn only reads state. */
  async function run() {
    try {
      const state = await invokeCmd<SkillTrustState>("check_skill_trust", {
        slug: skill.slug,
      });
      if (state.trusted) {
        await spawnRun();
      } else {
        setPendingTrust(state);
      }
    } catch (e) {
      await alertDialog(`Trust check failed: ${e}`);
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
        <div className="skill-runner__output-folder">
          <span className="skill-runner__output-folder-label">📁</span>
          {outputFolder ? (
            <>
              <code
                className="skill-runner__output-folder-path"
                title={outputFolder}
              >
                {shortenPath(outputFolder)}
              </code>
              <button
                type="button"
                className="skill-runner__output-folder-btn"
                onClick={() => void pickOutputFolder()}
              >
                Change
              </button>
              <button
                type="button"
                className="skill-runner__output-folder-btn"
                onClick={() => void clearOutputFolder()}
                title="Use the default (per-workspace) location instead"
              >
                ×
              </button>
            </>
          ) : (
            <>
              <span className="skill-runner__output-folder-default">
                Default (internal)
              </span>
              <button
                type="button"
                className="skill-runner__output-folder-btn"
                onClick={() => void pickOutputFolder()}
                title="Pick a folder on your filesystem — runs will save here instead of Orka's internal workdir"
              >
                Set folder…
              </button>
            </>
          )}
        </div>
      </div>

      <div className="skill-runner__prompt">
        <textarea
          className="skill-runner__prompt-input"
          placeholder={computePlaceholder(skill)}
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter = Run. Plain Enter allows newlines so users
            // can write multi-line context without accidentally firing.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (!state.running) void (hasOutput ? runFresh() : run());
            }
          }}
          rows={3}
          disabled={state.running}
        />
        {skill.examples && skill.examples.length > 0 ? (
          <div className="skill-runner__examples">
            <span className="skill-runner__examples-label">examples</span>
            {skill.examples.map((ex, i) => (
              <button
                key={i}
                type="button"
                className="skill-runner__example-chip"
                onClick={() => setFreeText(ex)}
                title="Click to use this example as your prompt"
                disabled={state.running}
              >
                {ex.length > 60 ? ex.slice(0, 58) + "…" : ex}
              </button>
            ))}
          </div>
        ) : (
          <div className="skill-runner__prompt-help">
            <span>
              💡 Describe what you want in natural language, or
            </span>
            <button
              type="button"
              className="skill-runner__suggest-btn"
              onClick={() => void suggestExamples()}
              disabled={suggesting || state.running}
              title="Ask Claude to generate 3 example prompts for this skill and save them to SKILL.md"
            >
              {suggesting ? "✨ Generating…" : "✨ Suggest examples"}
            </button>
          </div>
        )}
      </div>

      {skill.inputs && skill.inputs.length > 0 && (
        <div className="skill-runner__advanced">
          <button
            type="button"
            className="skill-runner__advanced-toggle"
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
          >
            {advancedOpen ? "▾" : "▸"} Advanced · {skill.inputs.length} optional{" "}
            input{skill.inputs.length === 1 ? "" : "s"}
          </button>
          {advancedOpen && (
            <div className="skill-runner__inputs">
              {skill.inputs.map((inp) => (
                <div key={inp.name} className="skill-runner__input-row">
                  <label
                    className="skill-runner__input-label"
                    title={inp.description ?? undefined}
                  >
                    {inp.name}
                    {inp.type && inp.type !== "string" && (
                      <span className="skill-runner__input-type">
                        · {inp.type}
                      </span>
                    )}
                  </label>
                  <input
                    className="skill-runner__input-field"
                    type="text"
                    value={inputValues[inp.name] ?? ""}
                    placeholder={inp.default ?? ""}
                    onChange={(e) =>
                      setInputValues((v) => ({
                        ...v,
                        [inp.name]: e.target.value,
                      }))
                    }
                    disabled={state.running}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
        <button
          className="skill-runner__schedule-btn"
          onClick={() => setShowSchedule({ label: null })}
          title="Create a new schedule for this skill (you can have multiple)"
        >
          {schedules.length > 0
            ? `⏰ Schedules (${schedules.length})  + Add`
            : "⏰ Schedule"}
        </button>
        <button
          className="skill-runner__evolve-btn"
          onClick={() => setShowEvolve(true)}
          title="Suggest SKILL.md updates based on your annotations on past runs"
        >
          💡 Evolve
        </button>
        {skill.has_graph && onOpenInCanvas && (
          <button
            className="skill-runner__graph-hint"
            onClick={() => void onOpenInCanvas(skill.slug, skill.path)}
            title="Open this multi-step skill's DAG in the canvas editor"
          >
            ◆ Edit in canvas
          </button>
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

      {schedules.length > 0 && (
        <div className="skill-runner__sched-list">
          <div className="skill-runner__sched-list-head">
            ⏰ Schedules for /{skill.slug}
          </div>
          {schedules.map((s) => {
            const effectiveLabel = s.label ?? null;
            const rowKey = effectiveLabel ?? "__default__";
            const promptPreview = (s.prompt ?? "").trim();
            const truncated =
              promptPreview.length > 40
                ? promptPreview.slice(0, 38) + "…"
                : promptPreview;
            return (
              <div key={rowKey} className="skill-runner__sched-row">
                <span className="skill-runner__sched-label">
                  {effectiveLabel ?? "(default)"}
                </span>
                <span className="skill-runner__sched-meta">
                  {describeSchedule(s)}
                </span>
                {truncated && (
                  <span
                    className="skill-runner__sched-prompt"
                    title={promptPreview}
                  >
                    “{truncated}”
                  </span>
                )}
                <span className="skill-runner__sched-spacer" />
                <button
                  type="button"
                  className="skill-runner__sched-btn"
                  onClick={() =>
                    setShowSchedule({ label: effectiveLabel })
                  }
                  title="Edit this schedule"
                >
                  edit
                </button>
                <button
                  type="button"
                  className="skill-runner__sched-btn skill-runner__sched-btn--danger"
                  onClick={() => void handleDeleteSchedule(effectiveLabel)}
                  title="Delete this schedule"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

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
      {showSchedule && (
        <Suspense fallback={null}>
          <ScheduleModal
            pipelineName={scheduleName}
            label={showSchedule.label}
            onClose={() => setShowSchedule(null)}
          />
        </Suspense>
      )}
      {showEvolve && (
        <SkillEvolutionModal
          slug={skill.slug}
          onClose={() => setShowEvolve(false)}
          onApplied={() => {
            void refreshSkills();
          }}
        />
      )}
      {pendingTrust && (
        <SkillTrustModal
          skill={skill}
          trustState={pendingTrust}
          onCancel={() => setPendingTrust(null)}
          onApprove={() => {
            setPendingTrust(null);
            void spawnRun();
          }}
        />
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

/** Collapse $HOME to ~ for display. Keeps the full path in the title
 *  attribute for hover tooltip. */
function shortenPath(p: string): string {
  // Access the user's home via a guess — we can't synchronously call
  // Tauri here, but on macOS/Linux paths start with /Users/<name> or
  // /home/<name>. Replace the first two segments with ~.
  const m = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+)(\/.*)?$/);
  if (m) return "~" + (m[2] ?? "");
  return p;
}

/** Seed the form with each input's default (falling back to empty). */
function seedInputValues(skill: SkillMeta): Record<string, string> {
  const out: Record<string, string> = {};
  for (const inp of skill.inputs ?? []) {
    out[inp.name] = inp.default ?? "";
  }
  return out;
}

/** Pick a placeholder for the prompt textarea that actually hints at
 *  what this specific skill expects. Fallback chain:
 *    1. First `examples:` entry from SKILL.md → "e.g., <example>"
 *    2. If skill has declared inputs → "e.g., describe the <input1>,
 *       <input2>…" composed from input names
 *    3. Generic "Tell Claude what you want (optional)" for prose skills
 *       with no declared hints
 *  Total length capped so the textarea doesn't balloon visually. */
function computePlaceholder(skill: SkillMeta): string {
  const first = skill.examples?.[0]?.trim();
  if (first) {
    const clipped = first.length > 100 ? first.slice(0, 98) + "…" : first;
    return `e.g., ${clipped}`;
  }
  const inputs = skill.inputs ?? [];
  if (inputs.length > 0) {
    const names = inputs.slice(0, 3).map((i) => i.name).join(", ");
    return `e.g., describe the ${names}${inputs.length > 3 ? "…" : ""}`;
  }
  return "Tell Claude what you want (optional)";
}

/** Build the prompt sent to Claude.
 *
 *  Sections, in order:
 *    1. `/<slug>` — invokes the skill's SKILL.md
 *    2. Free-text (if the user typed anything) — plain prose context
 *    3. Structured inputs as `key: value` lines — only included when the
 *       skill declares them; falls back to defaults if the user didn't
 *       override. Matches how orka-cli passes --inputs.
 *
 *  Any section can be empty; if all three are empty, just the `/slug`
 *  goes through (identical to the pre-textarea behavior). */
function composeSkillPrompt(
  skill: SkillMeta,
  inputValues: Record<string, string>,
  freeText: string,
): string {
  const parts: string[] = [`/${skill.slug}`];
  const prose = freeText.trim();
  if (prose) parts.push(prose);

  const inputs = skill.inputs ?? [];
  if (inputs.length > 0) {
    const lines = inputs
      .map((inp) => {
        const v = (inputValues[inp.name] ?? inp.default ?? "").trim();
        return v ? `${inp.name}: ${v}` : null;
      })
      .filter((s): s is string => s !== null);
    if (lines.length > 0) parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}
