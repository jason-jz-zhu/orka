import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useState } from "react";
import { useGraph } from "./lib/graph-store";
import ChatNode from "./nodes/ChatNode";
import AgentNode from "./nodes/AgentNode";
import KnowledgeBaseNode from "./nodes/KnowledgeBaseNode";
import SessionNode from "./nodes/SessionNode";
import WorkspaceSwitcher from "./components/WorkspaceSwitcher";
import PipelineLibrary from "./components/PipelineLibrary";
import SessionDashboard from "./components/SessionDashboard";
import StatusBar from "./components/StatusBar";
import { usePersistence } from "./lib/persistence";
import { runAll } from "./lib/run-all";
import { invokeCmd } from "./lib/tauri";
import { alertDialog, confirmDialog, promptDialog } from "./lib/dialogs";
import OnboardingModal, {
  hasCompletedOnboarding,
} from "./components/OnboardingModal";
import "./App.css";

const nodeTypes: NodeTypes = {
  chat: ChatNode as any,
  agent: AgentNode as any,
  kb: KnowledgeBaseNode as any,
  session: SessionNode as any,
};

type Tab = "pipeline" | "monitor";

export default function App() {
  usePersistence();
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addChatNode,
    addAgentNode,
    addKBNode,
    setGraph,
    activePipelineName,
    setActivePipelineName,
  } = useGraph();
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("monitor");
  const [showOnboarding, setShowOnboarding] = useState(
    () => !hasCompletedOnboarding()
  );

  async function onRunAll() {
    setRunning(true);
    setRunStatus("running…");
    try {
      const r = await runAll();
      const parts: string[] = [];
      if (r.ran.length) parts.push(`${r.ran.length} ran`);
      if (r.skipped.length) parts.push(`${r.skipped.length} skipped`);
      if (r.failed.length) parts.push(`${r.failed.length} failed`);
      setRunStatus(parts.join(" · ") || "nothing to run");
      setTimeout(() => setRunStatus(null), 6000);
    } finally {
      setRunning(false);
    }
  }

  async function writeTemplate(name: string) {
    const stripped = {
      nodes: nodes.map((n) => {
        const d = { ...(n.data as any) };
        delete d.output;
        delete d.running;
        delete d.costUsd;
        delete d.toolCount;
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
        setRunStatus(`loaded pipeline "${name}"`);
        setTimeout(() => setRunStatus(null), 4000);
      } else {
        await alertDialog("Template is malformed.");
      }
    } catch (e) {
      await alertDialog(`Load template failed: ${e}`);
    }
  }

  async function onLoadTemplate() {
    try {
      const names = await invokeCmd<string[]>("list_templates");
      if (!names.length) {
        await alertDialog("No templates saved yet. Save one first.");
        return;
      }
      const choice = await promptDialog(
        `Available:\n${names.map((n) => `• ${n}`).join("\n")}\n\nType name to load:`,
        { title: "Load pipeline" }
      );
      if (!choice) return;
      await loadTemplateByName(choice);
    } catch (e) {
      await alertDialog(`Load templates failed: ${e}`);
    }
  }

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
            Monitor
          </button>
          <button
            role="tab"
            aria-selected={tab === "pipeline"}
            className={"tabs__item" + (tab === "pipeline" ? " tabs__item--active" : "")}
            onClick={() => setTab("pipeline")}
          >
            Pipeline
          </button>
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
            <button onClick={() => addChatNode()}>+ Chat</button>
            <button onClick={() => addAgentNode()}>+ Agent</button>
            <button onClick={() => addKBNode()}>+ KB</button>
            <div className="toolbar__divider" />
            <button onClick={onRunAll} disabled={running} className="toolbar__primary">
              {running ? "Running…" : "▶ Run All"}
            </button>
            <button onClick={onSaveTemplate}>Save</button>
            <button onClick={onLoadTemplate}>Load</button>
            {runStatus && <span className="toolbar__status">{runStatus}</span>}
          </>
        )}
        <span className="toolbar__title">Orka</span>
      </div>
      {/* Both tabs stay mounted; hide the inactive one with `hidden` (display:none).
          Keeps SessionDashboard state + ReactFlow instance alive across switches. */}
      <div className="main" hidden={tab !== "pipeline"}>
        <PipelineLibrary
          onLoad={loadTemplateByName}
          onSaveCurrent={onSaveTemplate}
          onNew={onNewPipeline}
        />
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
      {tab === "pipeline" && <StatusBar />}
      {showOnboarding && (
        <OnboardingModal onClose={() => setShowOnboarding(false)} />
      )}
    </div>
  );
}
