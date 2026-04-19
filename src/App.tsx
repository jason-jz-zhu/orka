import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useRef, useState } from "react";
import { useGraph } from "./lib/graph-store";
import ChatNode from "./nodes/ChatNode";
import AgentNode from "./nodes/AgentNode";
import KnowledgeBaseNode from "./nodes/KnowledgeBaseNode";
import SessionNode from "./nodes/SessionNode";
import OutputNode from "./nodes/OutputNode";
import PipelineRefNode from "./nodes/PipelineRefNode";
import SkillRefNode from "./nodes/SkillRefNode";
import WorkspaceSwitcher from "./components/WorkspaceSwitcher";
import PipelineLibrary from "./components/PipelineLibrary";
import SkillPalette from "./components/SkillPalette";
import RunsDashboard from "./components/RunsDashboard";
import SessionDashboard from "./components/SessionDashboard";
import StatusBar from "./components/StatusBar";
import { SkillsTab } from "./components/SkillsTab";
import { usePersistence } from "./lib/persistence";
import { runAll, requestRunAllSkip } from "./lib/run-all";
import { invokeCmd } from "./lib/tauri";
import { alertDialog, confirmDialog, promptDialog } from "./lib/dialogs";
import OnboardingModal, {
  hasCompletedOnboarding,
} from "./components/OnboardingModal";
import GeneratePipelineModal from "./components/GeneratePipelineModal";
import SettingsModal from "./components/SettingsModal";
import ScheduleModal from "./components/ScheduleModal";
import {
  listSchedules,
  saveSchedule,
  refreshNextRun,
  osNotify,
  type Schedule,
} from "./lib/schedules";
import { playReadyPing } from "./lib/sound";
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

/** Canvas tab is hidden from the default nav — it's still the right tool
 *  for composite-skill authoring, but the new Skills tab handles the
 *  99% "pick a skill, run, annotate, continue" flow without it.
 *  Set ?canvas=1 in the dev URL to re-enable the Studio tab. */
const CANVAS_ENABLED =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("canvas") === "1";

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
  const [showOnboarding, setShowOnboarding] = useState(
    () => !hasCompletedOnboarding()
  );
  const [showGenerate, setShowGenerate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
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

  async function writeTemplate(name: string) {
    const meta = useGraph.getState().pipelineMeta;
    const stripped = {
      version: 1,
      name,
      description: meta.description ?? "",
      inputs: meta.inputs ?? [],
      outputs: meta.outputs ?? [],
      nodes: nodes.map((n) => {
        const d = { ...(n.data as any) };
        delete d.output;
        delete d.running;
        delete d.costUsd;
        delete d.toolCount;
        delete d.lastSessionId;
        // OutputNode runtime fields:
        delete d.lastWrittenPath;
        delete d.lastWrittenAt;
        delete d.lastError;
        return { ...n, data: d };
      }),
      edges,
    };
    await invokeCmd("save_template", {
      name,
      content: JSON.stringify(stripped, null, 2),
    });
  }

  async function onSaveTemplate() {
    // If there is an active pipeline, offer overwrite vs save-as-new.
    let name: string | null | undefined;
    if (activePipelineName) {
      const overwrite = await confirmDialog(
        `Overwrite active pipeline "${activePipelineName}"?\n\nOK to overwrite, Cancel to save as a new pipeline.`,
        { title: "Save pipeline", okLabel: "Overwrite", cancelLabel: "Save as new" }
      );
      if (overwrite) {
        name = activePipelineName;
      } else {
        name = await promptDialog("New pipeline name:", { title: "Save as new" });
      }
    } else {
      name = await promptDialog("Pipeline name:", { title: "Save pipeline" });
    }
    if (!name) return;
    try {
      await writeTemplate(name);
      setActivePipelineName(name);
      setRunStatus(`saved pipeline "${name}"`);
      setTimeout(() => setRunStatus(null), 4000);
    } catch (e) {
      await alertDialog(`Save failed: ${e}`);
    }
  }

  async function onNewPipeline() {
    // Only confirm if there's something to lose.
    if (nodes.length > 0 || edges.length > 0) {
      const ok = await confirmDialog(
        activePipelineName
          ? `Discard current canvas and start a new pipeline?\n\n` +
              `Unsaved changes to "${activePipelineName}" will be lost unless you Save first.`
          : `Discard current canvas and start a new pipeline?`,
        { title: "New pipeline", okLabel: "Discard", cancelLabel: "Cancel" }
      );
      if (!ok) return;
    }
    setGraph([], []);
    setActivePipelineName(null);
    setRunStatus("started new pipeline");
    setTimeout(() => setRunStatus(null), 3000);
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
      await saveSchedule(refreshNextRun(skipped));
      setRunStatus(
        `⏰ skipped "${target.pipeline_name}" — you're editing "${cur.activePipelineName}"`
      );
      setTimeout(() => setRunStatus(null), 6000);
      return;
    }

    scheduleRunningRef.current = true;
    setRunStatus(`⏰ running scheduled "${target.pipeline_name}"…`);
    try {
      const raw = await invokeCmd<string>("load_template", {
        name: target.pipeline_name,
      });
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
        throw new Error("template is malformed");
      }
      setGraph(parsed.nodes, parsed.edges);
      setActivePipelineName(target.pipeline_name);
      // Let React commit + nodes register before we run.
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
    } catch (e) {
      ok = false;
      error = String(e);
    } finally {
      scheduleRunningRef.current = false;
    }

    const updated: Schedule = {
      ...target,
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
    await saveSchedule(refreshNextRun(updated));

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

  async function tickSchedules() {
    if (scheduleRunningRef.current) return;
    let list: Schedule[] = [];
    try {
      list = await listSchedules();
    } catch {
      return;
    }
    setScheduledNames(new Set(list.map((s) => s.pipeline_name)));
    const now = Date.now();
    const due = list.filter(
      (s) => s.enabled && s.next_run_at !== null && s.next_run_at! <= now
    );
    if (!due.length) return;
    due.sort((a, b) => (a.next_run_at ?? 0) - (b.next_run_at ?? 0));
    await runScheduledPipeline(due[0]);
  }

  // Tick every 30s to check for due schedules. Also fires once on mount.
  useEffect(() => {
    tickSchedules();
    const t = setInterval(tickSchedules, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One-shot cleanup of ghost brief sessions on app start. Prior builds
  // of session brief generation didn't use --no-session-persistence, so
  // every brief call wrote a polluting "You are summarizing…" session
  // into ~/.claude/projects/. This scan is surgically narrow — only
  // files whose first user message contains the exact brief preamble
  // get deleted — so it's safe to run unconditionally.
  useEffect(() => {
    (async () => {
      try {
        const removed = await invokeCmd<number>("cleanup_ghost_brief_sessions");
        if (removed > 0) {
          console.log(`[orka] cleaned up ${removed} ghost brief session file(s)`);
        }
      } catch (e) {
        console.warn("[orka] ghost cleanup failed:", e);
      }
    })();
  }, []);


  return (
    <div className="app">
      <div className="toolbar">
        <WorkspaceSwitcher />
        <div className="toolbar__divider" />
        <div className="tabs" role="tablist">
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
            aria-selected={tab === "monitor"}
            className={"tabs__item" + (tab === "monitor" ? " tabs__item--active" : "")}
            onClick={() => setTab("monitor")}
          >
            Sessions
          </button>
          <button
            role="tab"
            aria-selected={tab === "runs"}
            className={"tabs__item" + (tab === "runs" ? " tabs__item--active" : "")}
            onClick={() => setTab("runs")}
          >
            Runs
          </button>
          {CANVAS_ENABLED && (
            <button
              role="tab"
              aria-selected={tab === "pipeline"}
              className={"tabs__item" + (tab === "pipeline" ? " tabs__item--active" : "")}
              onClick={() => setTab("pipeline")}
              title="Canvas editor — hidden by default. Visible because ?canvas=1 is set."
            >
              Studio
            </button>
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
          onClick={() => setShowSettings(true)}
          title="Settings · destinations"
        >
          ⚙︎
        </button>
        <span className="toolbar__title">Orka</span>
      </div>
      {/* All tabs stay mounted; hide the inactive ones with `hidden` (display:none).
          Keeps SessionDashboard + SkillsTab state + ReactFlow instance alive across switches. */}
      <div className="main" hidden={tab !== "skills"}>
        <SkillsTab />
      </div>
      <div className="main" hidden={tab !== "pipeline"}>
        <div className="sidebar">
          <PipelineLibrary
            onLoad={loadTemplateByName}
            onSaveCurrent={onSaveTemplate}
            onNew={onNewPipeline}
            onGenerate={() => setShowGenerate(true)}
            onSchedule={(name) => setScheduleFor(name)}
            scheduledNames={scheduledNames}
          />
          <SkillPalette />
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
      <div className="main monitor" hidden={tab !== "monitor"}>
        <SessionDashboard
          active={tab === "monitor"}
          onJumpToPipeline={() => setTab("pipeline")}
        />
      </div>
      <div className="main" hidden={tab !== "runs"}>
        <RunsDashboard />
      </div>
      {tab === "pipeline" && <StatusBar />}
      {showOnboarding && (
        <OnboardingModal onClose={() => setShowOnboarding(false)} />
      )}
      {showGenerate && (
        <GeneratePipelineModal
          onClose={() => setShowGenerate(false)}
          onApplied={() => {
            setShowGenerate(false);
            setTab("pipeline");
            setRunStatus("✨ pipeline ready — click ▶ Run All to execute in order");
            setTimeout(() => setRunStatus(null), 8000);
          }}
        />
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
    </div>
  );
}
