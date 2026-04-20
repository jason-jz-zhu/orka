import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type NodeTypes,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useGraph, type OrkaNode } from "./lib/graph-store";
import ChatNode from "./nodes/ChatNode";
import AgentNode from "./nodes/AgentNode";
import KnowledgeBaseNode from "./nodes/KnowledgeBaseNode";
import SessionNode from "./nodes/SessionNode";
import OutputNode from "./nodes/OutputNode";
import PipelineRefNode from "./nodes/PipelineRefNode";
import SkillRefNode from "./nodes/SkillRefNode";
import WorkspaceSwitcher from "./components/WorkspaceSwitcher";
// Lazy — SessionDashboard pulls react-markdown + block renderer. Keeping
// it off the main chunk cuts cold-start bundle cost for users whose
// first action isn't the Monitor tab.
const SessionDashboard = lazy(() => import("./components/SessionDashboard"));
import StatusBar from "./components/StatusBar";
import { SkillsTab } from "./components/SkillsTab";
import { usePersistence } from "./lib/persistence";
import { runAll, requestRunAllSkip } from "./lib/run-all";
import { invokeCmd, listenEvent } from "./lib/tauri";
import { parseLine } from "./lib/stream-parser";
import { alertDialog, promptDialog } from "./lib/dialogs";
import { hasCompletedOnboarding } from "./lib/onboarding";
import {
  listSchedules,
  saveSchedule,
  refreshNextRun,
  osNotify,
  type Schedule,
} from "./lib/schedules";

// Lazy-loaded modules. Split out of the main bundle because they're either
// only opened on user action (modals) or only mounted when the user
// switches to a non-default tab (canvas library, runs).
const PipelineLibrary = lazy(() => import("./components/PipelineLibrary"));
const SkillPalette = lazy(() => import("./components/SkillPalette"));
const RunsDashboard = lazy(() => import("./components/RunsDashboard"));
const ModelSettingsModal = lazy(() =>
  import("./components/ModelSettingsModal").then((m) => ({
    default: m.ModelSettingsModal,
  })),
);
const OnboardingModal = lazy(() => import("./components/OnboardingModal"));
const SettingsModal = lazy(() => import("./components/SettingsModal"));
const ScheduleModal = lazy(() => import("./components/ScheduleModal"));
import { playReadyPing } from "./lib/sound";
import { installPerfGlobals } from "./lib/perf";
import "./App.css";

const nodeTypes: NodeTypes = {
  chat: ChatNode as any,
  agent: AgentNode as any,
  kb: KnowledgeBaseNode as any,
  session: SessionNode as any,
  output: OutputNode as any,
  pipeline_ref: PipelineRefNode as any,
  skill_ref: SkillRefNode as any,
};

type Tab = "skills" | "pipeline" | "monitor" | "runs";

/** Read initial canvas visibility from URL (?canvas=1) or a localStorage
 *  flag that persists across restarts once the user opts in once. */
function initialCanvasEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (new URLSearchParams(window.location.search).get("canvas") === "1") return true;
  try {
    return localStorage.getItem("orka-canvas-enabled") === "1";
  } catch {
    return false;
  }
}

export default function App() {
  usePersistence();
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addAgentNode,
    addKBNode,
    addOutputNode,
    setGraph,
    activePipelineName,
    setActivePipelineName,
  } = useGraph();
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("skills");
  // Latches true on first visit to Monitor. SessionDashboard's first
  // mount pulls in react-markdown + session chunk; we avoid paying
  // that cost for users whose first (or only) action is a skill run.
  // Once opened we keep the subtree mounted (via `hidden`) so state
  // survives tab switches.
  const [monitorEverOpened, setMonitorEverOpened] = useState(false);
  useEffect(() => {
    if (tab === "monitor") setMonitorEverOpened(true);
  }, [tab]);
  // Session id the Runs tab asked us to open. SessionDashboard watches
  // this prop and auto-selects the matching session when it lands in
  // its list; cleared after being consumed so re-navigating doesn't
  // re-trigger the selection.
  const [pendingSessionOpen, setPendingSessionOpen] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(
    () => !hasCompletedOnboarding()
  );
  const [showSettings, setShowSettings] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [canvasEnabled, setCanvasEnabled] = useState<boolean>(() => initialCanvasEnabled());

  // Persist canvas visibility so re-enabling via an "Open in Canvas"
  // button sticks across app restarts.
  useEffect(() => {
    try {
      if (canvasEnabled) {
        localStorage.setItem("orka-canvas-enabled", "1");
      } else {
        localStorage.removeItem("orka-canvas-enabled");
      }
    } catch {}
  }, [canvasEnabled]);

  // Expose window.__ORKA_PERF_SMOKE__() for devtools-driven perf runs.
  // No-op until the user explicitly invokes it.
  useEffect(() => {
    installPerfGlobals();
  }, []);

  /** Called by SkillsTab → SkillRunner when the user wants to open a
   *  composite skill's DAG in the canvas editor. Reveals the Studio
   *  tab, switches to it, then loads the skill graph via the existing
   *  load_skill_md + setGraph path. */
  async function openSkillInCanvas(skillSlug: string, skillPath: string) {
    setCanvasEnabled(true);
    setTab("pipeline");
    try {
      const raw = await invokeCmd<string>("load_skill_md", { path: skillPath });
      const parsed = JSON.parse(raw);
      const graphData = parsed.graph;
      if (!graphData || !Array.isArray(graphData.nodes)) {
        await alertDialog(
          `"${skillSlug}" doesn't contain a runnable graph block.`,
        );
        return;
      }
      const nodes: OrkaNode[] = graphData.nodes.map((n: any) => {
        const pos = Array.isArray(n.pos)
          ? { x: n.pos[0], y: n.pos[1] }
          : { x: 200, y: 200 };
        if (n.type === "skill_ref") {
          return {
            id: n.id,
            type: "skill_ref" as const,
            position: pos,
            data: { skill: n.data?.skill ?? "", bind: n.data?.bind ?? {} },
          };
        }
        if (n.type === "agent" || n.type === "chat") {
          return {
            id: n.id,
            type: n.type as "agent" | "chat",
            position: pos,
            data: {
              prompt: n.data?.prompt ?? "",
              output: "",
              running: false,
            },
          };
        }
        return {
          id: n.id,
          type: "agent" as const,
          position: pos,
          data: { prompt: n.data?.prompt ?? "", output: "", running: false },
        };
      });
      const loadedEdges: Edge[] = (graphData.edges ?? []).map(
        (e: [string, string]) => ({ id: `e-${e[0]}-${e[1]}`, source: e[0], target: e[1] }),
      );
      setGraph(nodes, loadedEdges);
      setActivePipelineName(skillSlug);
    } catch (e) {
      await alertDialog(`Failed to load skill graph: ${e}`);
    }
  }
  const [scheduleFor, setScheduleFor] = useState<string | null>(null);
  const [scheduledNames, setScheduledNames] = useState<Set<string>>(
    () => new Set()
  );
  const scheduleRunningRef = useRef(false);
  const [runPaused, setRunPaused] = useState(false);

  async function onRunAll() {
    // Collect any declared but unset pipeline inputs and prompt the user.
    const meta = useGraph.getState().pipelineMeta;
    const inputs = useGraph.getState().pipelineInputs;
    if (Array.isArray(meta.inputs) && meta.inputs.length > 0) {
      for (const inp of meta.inputs) {
        if (inputs[inp.name] && inputs[inp.name].length > 0) continue;
        const val = await promptDialog(
          `Pipeline input · ${inp.name}${inp.description ? ` — ${inp.description}` : ""}`,
          { default: inp.default ?? "", title: "Run pipeline" }
        );
        if (val === null) {
          setRunStatus("run cancelled");
          setTimeout(() => setRunStatus(null), 3000);
          return;
        }
        useGraph.getState().setPipelineInput(inp.name, val);
      }
    }

    setRunning(true);
    setRunStatus("running…");
    try {
      const r = await runAll((p) => {
        setRunPaused(!!p.pausedForReply);
        if (p.currentId) {
          setRunStatus(
            `${p.pausedForReply ? "⏸" : "▶"} ${p.label} · ${p.index}/${p.total}`
          );
        }
      });
      const parts: string[] = [];
      if (r.ran.length) parts.push(`${r.ran.length} ran`);
      if (r.skipped.length) parts.push(`${r.skipped.length} skipped`);
      if (r.failed.length) parts.push(`${r.failed.length} failed`);
      setRunStatus(parts.join(" · ") || "nothing to run");
      setTimeout(() => setRunStatus(null), 6000);
    } finally {
      setRunning(false);
      setRunPaused(false);
    }
  }

  async function loadTemplateByName(name: string) {
    try {
      const raw = await invokeCmd<string>("load_template", { name });
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
        setGraph(parsed.nodes, parsed.edges);
        setActivePipelineName(name);
        // Restore declared inputs/outputs/description if present.
        useGraph.getState().setPipelineMeta({
          description: parsed.description ?? "",
          inputs: Array.isArray(parsed.inputs) ? parsed.inputs : [],
          outputs: Array.isArray(parsed.outputs) ? parsed.outputs : [],
        });
        setRunStatus(`loaded pipeline "${name}"`);
        setTimeout(() => setRunStatus(null), 4000);
      } else {
        await alertDialog("Template is malformed.");
      }
    } catch (e) {
      await alertDialog(`Load template failed: ${e}`);
    }
  }

  async function runScheduledPipeline(target: Schedule) {
    if (scheduleRunningRef.current) return;
    const startedAt = Date.now();
    let ok = false;
    let error: string | null = null;
    let outputPath: string | null = null;

    // Q1: skip if user is editing a different named pipeline.
    const cur = useGraph.getState();
    const editingDifferent =
      cur.nodes.length > 0 &&
      cur.activePipelineName !== null &&
      cur.activePipelineName !== target.pipeline_name;

    if (editingDifferent) {
      const skipped: Schedule = {
        ...target,
        last_run_at: startedAt,
        history: [
          {
            ran_at: startedAt,
            ok: false,
            duration_ms: 0,
            error: `skipped (editing "${cur.activePipelineName}")`,
            output_path: null,
          },
          ...target.history.slice(0, 19),
        ],
      };
      await saveSchedule(refreshNextRun(skipped), skipped.label ?? null);
      setRunStatus(
        `⏰ skipped "${target.pipeline_name}" — you're editing "${cur.activePipelineName}"`
      );
      setTimeout(() => setRunStatus(null), 6000);
      return;
    }

    scheduleRunningRef.current = true;
    setRunStatus(`⏰ running scheduled "${target.pipeline_name}"…`);
    // Hoisted so the post-run `saveSchedule(updated)` block can back-fill
    // legacy schedules (target.label === null) with the auto-computed
    // label. Without this, old-format `skill_<slug>.json` files stay
    // label-less forever even after firing — they'd never migrate to
    // the composite-key scheme.
    let migratedLabel: string | null = target.label ?? null;
    try {
      // Two execution paths depending on what the schedule targets:
      //
      //   "skill:<slug>" → atomic skill, run directly via claude -p
      //   "<name>"       → legacy canvas pipeline, load template and runAll
      //
      // The prefix keeps backward compat with existing pipeline schedules
      // while letting the Skills-tab scheduler land without touching the
      // canvas path.
      if (target.pipeline_name.startsWith("skill:")) {
        const slug = target.pipeline_name.slice("skill:".length);
        const runId = `scheduled-${slug}-${Date.now().toString(36)}`;
        // Compose the prompt the same way SkillRunner does — start with
        // the slash-command, tack on any saved natural-language prompt,
        // then any declared-input overrides. This keeps scheduled runs
        // behaviorally identical to manual Run clicks.
        const parts: string[] = [`/${slug}`];
        const savedPrompt = target.prompt?.trim();
        if (savedPrompt) parts.push(savedPrompt);
        // `inputs` in the run-log JSONL is a flat string[] (backend
        // RunRecord.inputs: Vec<String>). Anything else — a Record object,
        // for instance — fails serde deserialization at the Tauri boundary
        // and the whole append_run call silently errors out. Use the same
        // "key=value" shape SkillRunner does for manual runs so the two
        // trigger paths produce identical rows.
        const inputsSummary: string[] = [];
        if (savedPrompt) inputsSummary.push(savedPrompt);
        if (target.inputs && typeof target.inputs === "object") {
          const lines: string[] = [];
          for (const [k, v] of Object.entries(target.inputs)) {
            const val = String(v ?? "").trim();
            if (val) {
              lines.push(`${k}: ${val}`);
              inputsSummary.push(`${k}=${val}`);
            }
          }
          if (lines.length > 0) parts.push(lines.join("\n"));
        }
        // Capture session_id from the stream so the Runs row can link
        // back to the archived session. The `system init` event fires
        // early in the stream, so by the time run_agent_node resolves
        // it's populated.
        let capturedSessionId: string | undefined;
        const unStream = await listenEvent<string>(
          `node:${runId}:stream`,
          (raw) => {
            if (capturedSessionId) return;
            for (const ev of parseLine(raw)) {
              if (ev.kind === "system" && ev.sessionId) {
                capturedSessionId = ev.sessionId;
                break;
              }
            }
          },
        );
        let capturedWorkdir: string | null = null;
        try {
          // Compute a schedule subfolder label. Prefer the user-supplied
          // label; fall back to a default derived from the schedule's
          // kind+spec so the output folder is always named something
          // meaningful even for legacy schedules.
          let scheduleLabel: string | null = (target.label ?? null) || null;
          if (!scheduleLabel) {
            try {
              scheduleLabel = await invokeCmd<string>(
                "compute_default_schedule_label",
                { kind: target.kind, spec: target.spec },
              );
            } catch {
              scheduleLabel = null;
            }
          }
          migratedLabel = scheduleLabel;
          // Preview the resolved workdir so Runs → 📄 Open works. The
          // backend will end up producing the same path since we use
          // the same clock-bucket (minute granularity in templates).
          try {
            capturedWorkdir = await invokeCmd<string>("preview_run_workdir", {
              skillSlug: slug,
              scheduleLabel,
              runId,
              inputs: inputsSummary,
            });
          } catch {
            capturedWorkdir = null;
          }
          await invokeCmd("run_agent_node", {
            id: runId,
            prompt: parts.join("\n\n"),
            resumeId: null,
            addDirs: [],
            allowedTools: null,
            skillSlug: slug,
            scheduleLabel,
            inputsForTemplate: inputsSummary,
            // Same rationale as SkillRunner's manual path: pass the
            // workdir we previewed so the logged `run.workdir` and
            // the actual cwd agree. Critical for scheduled runs
            // which often have a user-configured output folder.
            explicitWorkdir: capturedWorkdir ?? null,
          });
          ok = true;
        } catch (e) {
          ok = false;
          error = String(e);
        } finally {
          unStream();
        }
        // Persist to global Run History (separate from per-schedule
        // history) so the Runs tab shows scheduled fires alongside
        // manual ones. Best-effort; a logging failure shouldn't
        // alter the run result.
        const endedAt = new Date().toISOString();
        invokeCmd("append_run", {
          record: {
            id: runId,
            skill: slug,
            inputs: inputsSummary,
            started_at: new Date(startedAt).toISOString(),
            ended_at: endedAt,
            duration_ms: Date.now() - startedAt,
            status: ok ? "ok" : "error",
            trigger: "scheduled",
            error_message: ok ? undefined : error ?? undefined,
            session_id: capturedSessionId,
            workdir: capturedWorkdir ?? undefined,
          },
        }).catch((e) => console.warn("append_run failed:", e));
      } else {
        const raw = await invokeCmd<string>("load_template", {
          name: target.pipeline_name,
        });
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
          throw new Error("template is malformed");
        }
        setGraph(parsed.nodes, parsed.edges);
        setActivePipelineName(target.pipeline_name);
        await new Promise((r) => setTimeout(r, 50));
        const result = await runAll();
        ok = result.failed.length === 0;
        if (!ok) {
          error = result.failed.map((f) => `${f.id}: ${f.error}`).join("; ");
        }
        const out = useGraph
          .getState()
          .nodes.find(
            (n) =>
              n.type === "output" &&
              (n.data as { lastWrittenPath?: string }).lastWrittenPath
          );
        if (out) {
          outputPath =
            (out.data as { lastWrittenPath?: string }).lastWrittenPath ?? null;
        }
      }
    } catch (e) {
      ok = false;
      error = String(e);
    } finally {
      scheduleRunningRef.current = false;
    }

    const updated: Schedule = {
      ...target,
      // Migrate label on first fire: legacy schedules have `label: null`
      // on disk but used a computed default for their output subfolder
      // this run. Persisting the computed label now means future fires
      // and future edits agree on identity, and the schedule file name
      // migrates to the composite-key convention next save.
      label: target.label ?? migratedLabel ?? null,
      last_run_at: startedAt,
      history: [
        {
          ran_at: startedAt,
          ok,
          duration_ms: Date.now() - startedAt,
          error,
          output_path: outputPath,
        },
        ...target.history.slice(0, 19),
      ],
    };
    // previousLabel must reflect the label that identified the file we
    // just loaded (i.e. target.label, possibly null). Passing
    // updated.label would confuse save_schedule's rename-cleanup when
    // we're migrating a legacy file for the first time.
    await saveSchedule(refreshNextRun(updated), target.label ?? null);

    if (target.notify) {
      await osNotify(
        ok
          ? `✓ ${target.pipeline_name} done`
          : `✗ ${target.pipeline_name} failed`,
        ok
          ? outputPath
            ? `${((Date.now() - startedAt) / 1000).toFixed(1)}s · ${outputPath}`
            : `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
          : (error ?? "Unknown error")
      );
    }
    if (target.sound && ok) playReadyPing();
    setRunStatus(
      ok
        ? `⏰ "${target.pipeline_name}" done`
        : `⏰ "${target.pipeline_name}" failed: ${error}`
    );
    setTimeout(() => setRunStatus(null), 6000);
  }

  // Cached view of whether any schedules exist at all. When false we
  // skip the IPC round-trip in tickSchedules since there's nothing to
  // fire. Populated on mount + whenever a schedule is saved/deleted
  // elsewhere (the ScheduleModal's onClose triggers a refetch).
  const hasAnySchedulesRef = useRef<boolean | null>(null);

  async function tickSchedules() {
    if (scheduleRunningRef.current) return;
    // Fast path for the overwhelmingly common case: no schedules exist.
    // Without this, the app does one `listSchedules` IPC every 30s forever
    // even on an idle machine — a measurable waste on low-power laptops.
    // The first call populates hasAnySchedulesRef; subsequent calls only
    // do IPC when the ref says "maybe".
    if (hasAnySchedulesRef.current === false) return;
    let list: Schedule[] = [];
    try {
      list = await listSchedules();
    } catch {
      return;
    }
    hasAnySchedulesRef.current = list.length > 0;
    setScheduledNames(new Set(list.map((s) => s.pipeline_name)));
    const now = Date.now();
    const due = list.filter(
      (s) => s.enabled && s.next_run_at !== null && s.next_run_at! <= now
    );
    if (!due.length) return;
    due.sort((a, b) => (a.next_run_at ?? 0) - (b.next_run_at ?? 0));
    await runScheduledPipeline(due[0]);
    // If more schedules are also due (common when two daily-09:00
    // schedules exist), re-tick immediately so the second one fires
    // this cycle rather than being dropped until the next 30s tick.
    // setTimeout detaches execution so we don't recurse and can't
    // overwhelm — scheduleRunningRef still gates concurrency.
    if (due.length > 1) {
      setTimeout(() => {
        void tickSchedules();
      }, 0);
    }
  }

  // Tick every 30s to check for due schedules. Also fires once on mount.
  // The hasAnySchedulesRef fast-path inside tickSchedules makes this a
  // no-op on idle machines.
  useEffect(() => {
    tickSchedules();
    const t = setInterval(tickSchedules, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When a ScheduleModal closes or a SkillRunner saves a schedule, the
  // "maybe has schedules" assumption changes. The listeners below are
  // cheap — they just re-poll on the next tick by invalidating the ref.
  useEffect(() => {
    function onScheduleChanged() {
      hasAnySchedulesRef.current = null;
    }
    window.addEventListener("orka:schedule-changed", onScheduleChanged);
    return () =>
      window.removeEventListener("orka:schedule-changed", onScheduleChanged);
  }, []);

  // One-shot cleanup of ghost brief sessions on app start. Prior builds
  // of session brief generation didn't use --no-session-persistence, so
  // every brief call wrote a polluting "You are summarizing…" session
  // into ~/.claude/projects/. This scan is surgically narrow — only
  // files whose first user message contains the exact brief preamble
  // get deleted — so it's safe to run unconditionally.
  // First-run demo skill seed. Also idle-deferred so it never blocks
  // first paint — the user doesn't need the demo available until they
  // actually open the Skills tab. The backend is idempotent via a
  // marker file, so repeated calls are free.
  useEffect(() => {
    const run = () => {
      void invokeCmd<boolean>("seed_demo_skill_if_first_run").catch(() => {
        /* best-effort — missing demo isn't worth surfacing */
      });
    };
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof ric === "function") ric(run, { timeout: 5000 });
    else setTimeout(run, 2000);
  }, []);

  // One-shot cleanup of ghost brief session files. Deferred off the
  // critical mount path via requestIdleCallback (falls back to a 2s
  // setTimeout on platforms without it) — it's a hygiene scan, not
  // a first-paint-blocking command. Keeps the startup IPC budget
  // clean.
  useEffect(() => {
    const run = () => {
      void (async () => {
        try {
          const removed = await invokeCmd<number>(
            "cleanup_ghost_brief_sessions",
          );
          if (removed > 0) {
            console.log(
              `[orka] cleaned up ${removed} ghost brief session file(s)`,
            );
          }
        } catch (e) {
          console.warn("[orka] ghost cleanup failed:", e);
        }
      })();
    };
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof ric === "function") {
      const h = ric(run, { timeout: 5000 });
      return () => {
        const cancel = (window as unknown as {
          cancelIdleCallback?: (h: number) => void;
        }).cancelIdleCallback;
        if (typeof cancel === "function") cancel(h);
      };
    }
    const t = setTimeout(run, 2000);
    return () => clearTimeout(t);
  }, []);


  return (
    <div className="app">
      <div className="toolbar">
        <WorkspaceSwitcher />
        <div className="toolbar__divider" />
        <div className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "monitor"}
            className={"tabs__item" + (tab === "monitor" ? " tabs__item--active" : "")}
            onClick={() => setTab("monitor")}
          >
            Sessions
          </button>
          <button
            role="tab"
            aria-selected={tab === "skills"}
            className={"tabs__item" + (tab === "skills" ? " tabs__item--active" : "")}
            onClick={() => setTab("skills")}
          >
            Skills
          </button>
          <button
            role="tab"
            aria-selected={tab === "runs"}
            className={"tabs__item" + (tab === "runs" ? " tabs__item--active" : "")}
            onClick={() => setTab("runs")}
          >
            Runs
          </button>
          {canvasEnabled && (
            <div
              role="tab"
              aria-selected={tab === "pipeline"}
              className={"tabs__item tabs__item--closable" + (tab === "pipeline" ? " tabs__item--active" : "")}
              onClick={() => setTab("pipeline")}
              title="Canvas editor — opened for composite skills. Click × to hide."
            >
              <span className="tabs__item-label">Studio</span>
              <button
                className="tabs__item-close"
                onClick={(e) => {
                  e.stopPropagation();
                  setCanvasEnabled(false);
                  setTab("skills");
                }}
                title="Hide Studio tab"
                aria-label="Hide Studio tab"
              >
                ×
              </button>
            </div>
          )}
        </div>
        {tab === "pipeline" && (
          <>
            <div className="toolbar__divider" />
            <span
              className="toolbar__active-pipeline"
              title={
                activePipelineName
                  ? `Active pipeline: ${activePipelineName}`
                  : "No pipeline loaded — save to give it a name"
              }
            >
              <span className="toolbar__active-pipeline-label">pipeline</span>
              <span className="toolbar__active-pipeline-name">
                {activePipelineName ?? "(unsaved)"}
              </span>
            </span>
            <div className="toolbar__divider" />
            <button onClick={() => addAgentNode()}>+ Agent</button>
            <button onClick={() => addKBNode()}>+ Input</button>
            <button onClick={() => addOutputNode()}>+ Output</button>
            <div className="toolbar__divider" />
            <button onClick={onRunAll} disabled={running} className="toolbar__primary">
              {running ? "Running…" : "▶ Run All"}
            </button>
            {runStatus && <span className="toolbar__status">{runStatus}</span>}
            {runPaused && (
              <button
                className="toolbar__skip"
                onClick={requestRunAllSkip}
                title="Skip the current pause and proceed to the next node"
              >
                Skip →
              </button>
            )}
          </>
        )}
        <button
          className="toolbar__settings"
          onClick={() => setShowModels(true)}
          title="Claude models per feature"
        >
          🤖
        </button>
        <button
          className="toolbar__settings"
          onClick={() => setShowSettings(true)}
          title="Settings · destinations"
        >
          ⚙︎
        </button>
        <span className="toolbar__title">Orka</span>
      </div>
      {/* Skills + Sessions stay mounted (cheap, preserves scroll/filter state).
          Pipeline canvas + RunsDashboard conditionally mount — ReactFlow in particular
          is expensive to keep alive when hidden. */}
      <div className="main" hidden={tab !== "skills"}>
        <SkillsTab onOpenInCanvas={openSkillInCanvas} />
      </div>
      {tab === "pipeline" && (
        <div className="main">
          <div className="sidebar">
            <Suspense fallback={<div className="lazy-fallback">…</div>}>
              <PipelineLibrary
                onLoad={loadTemplateByName}
                onSchedule={(name) => setScheduleFor(name)}
                scheduledNames={scheduledNames}
              />
              <SkillPalette />
            </Suspense>
          </div>
          <div className="canvas">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodeTypes={nodeTypes}
              fitView
              elevateNodesOnSelect
            >
              <Background gap={16} />
              <Controls />
              <MiniMap pannable zoomable />
            </ReactFlow>
          </div>
        </div>
      )}
      {/* Monitor tab: mount on first visit, then keep alive via `hidden`
          so internal state (selected session, scroll pos, open drawer)
          survives tab switches. `monitorEverOpened` latches true on
          first visit and stays true — we pay the lazy chunk cost once. */}
      {monitorEverOpened && (
        <div className="main monitor" hidden={tab !== "monitor"}>
          <Suspense fallback={<div className="lazy-fallback">…</div>}>
            <SessionDashboard
              active={tab === "monitor"}
              onJumpToPipeline={() => setTab("pipeline")}
              pendingSessionOpen={pendingSessionOpen}
              onPendingSessionConsumed={() => setPendingSessionOpen(null)}
            />
          </Suspense>
        </div>
      )}
      {tab === "runs" && (
        <div className="main">
          <Suspense fallback={<div className="lazy-fallback">…</div>}>
            <RunsDashboard
              onOpenSession={(sid) => {
                // Jump to Sessions tab and ask SessionDashboard to open
                // this session's detail drawer. Cleared after consumption.
                setPendingSessionOpen(sid);
                setTab("monitor");
              }}
            />
          </Suspense>
        </div>
      )}
      {tab === "pipeline" && <StatusBar />}
      <Suspense fallback={null}>
        {showOnboarding && (
          <OnboardingModal onClose={() => setShowOnboarding(false)} />
        )}
        {scheduleFor && (
          <ScheduleModal
            pipelineName={scheduleFor}
            onClose={() => {
              setScheduleFor(null);
              // Refresh indicator immediately after the modal closes.
              tickSchedules();
            }}
          />
        )}
        {showSettings && (
          <SettingsModal onClose={() => setShowSettings(false)} />
        )}
        {showModels && (
          <ModelSettingsModal onClose={() => setShowModels(false)} />
        )}
      </Suspense>
    </div>
  );
}
