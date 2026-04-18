import { create } from "zustand";
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
} from "@xyflow/react";

/** Permission scope for Agent-mode runs.
 *
 *   full      = --dangerously-skip-permissions (current default, unrestricted tool access)
 *   readonly  = --allowed-tools Read,Glob,Grep,WebFetch,WebSearch
 *   safe      = readonly + TodoWrite,NotebookEdit (no filesystem mutation, no bash)
 *   custom    = user-supplied comma-separated list in customTools
 *
 * Chat mode never uses tools regardless of this setting.
 */
export type ToolMode = "full" | "readonly" | "safe" | "custom";

const TOOL_MODE_PRESETS: Record<Exclude<ToolMode, "full" | "custom">, string[]> = {
  readonly: ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
  safe: ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "NotebookEdit"],
};

/** Resolve a node's (toolMode, customTools) into the Vec<String> payload for
 *  the Rust `run_agent_node` / `run_node` commands. Returns `null` when the
 *  backend should fall back to `--dangerously-skip-permissions` (full access). */
export function computeAllowedTools(data: {
  toolMode?: ToolMode;
  customTools?: string;
}): string[] | null {
  const mode = data.toolMode ?? "full";
  if (mode === "full") return null;
  if (mode === "custom") {
    const list = (data.customTools ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return list;
  }
  return TOOL_MODE_PRESETS[mode];
}

export function toolModeLabel(mode: ToolMode | undefined): string {
  switch (mode) {
    case "readonly": return "🔒 Read-only";
    case "safe": return "🛡 Safe";
    case "custom": return "⚙ Custom";
    case "full":
    case undefined:
    default:
      return "⚠ Full access";
  }
}

export type ChatNodeData = {
  prompt: string;
  output: string;
  running: boolean;
  costUsd?: number;
  resumeSessionId?: string;
  /** Latest session id observed from the stream-json `system init` event.
   * Used to chain follow-up "↪ Continue" turns via `--resume`. Runtime only;
   * stripped on template save. */
  lastSessionId?: string;
  toolCount?: number;
  /** Agent-mode permission scope. Omitted = "full" (preserves prior behavior). */
  toolMode?: ToolMode;
  /** Comma-separated tool whitelist when `toolMode === "custom"`. */
  customTools?: string;
};

export type InputSource = "folder" | "url" | "clipboard" | "text";

export type KBNodeData = {
  source?: InputSource;
  files: string[];
  dir: string;
  url?: string;
  manualText?: string;
  fetchedContent?: string;
};

export type AgentNodeData = ChatNodeData;

export type SessionNodeData = {
  sessionId: string;
  path: string;
  projectCwd: string;
  live: boolean;
};

export type OutputFormat = "markdown" | "json" | "text";
export type OutputMergeMode = "concat" | "list" | "json";
export type OutputDestination =
  | "local"      // write to dir/filename
  | "icloud"     // write to ~/Library/Mobile Documents/com~apple~CloudDocs/Orka/
  | "notes"      // append to Apple Notes note (title = notesTitle)
  | "webhook"    // HTTP POST body to webhookUrl
  | "shell"      // run shellCommand with $CONTENT replaced
  | "profile";   // route via a configured destination profile (Settings)
export type OutputNodeData = {
  /** Where the formatted body goes. Defaults to "local". */
  destination: OutputDestination;
  filename: string;            // e.g. "report.md" — relative or absolute
  dir: string;                 // absolute or empty (= default outputs dir)
  format: OutputFormat;
  mergeMode: OutputMergeMode;  // how to combine multiple upstreams
  template: string;            // optional, e.g. "# {nodeId}\n\n{content}"
  overwrite: boolean;          // false = append timestamp suffix
  // destination-specific:
  webhookUrl?: string;         // used when destination = "webhook"
  webhookHeaders?: string;     // "Key: value\nKey: value"
  shellCommand?: string;       // used when destination = "shell". $CONTENT placeholder.
  notesTitle?: string;         // used when destination = "notes"
  profileId?: string;          // used when destination = "profile"
  // Runtime (not persisted in templates):
  lastWrittenPath?: string;    // path OR summary of what happened
  lastWrittenAt?: number;
  lastError?: string;
  running?: boolean;
};

/** A node that delegates execution to another saved pipeline (legacy alias for skill_ref). */
export type PipelineRefNodeData = {
  pipelineName: string;
  inputBindings: Record<string, string>;
  output?: string;
  running?: boolean;
  lastError?: string;
};

/** A node that invokes an external SKILL.md by slug name. */
export type SkillRefNodeData = {
  skill: string;
  bind: Record<string, string>;
  output?: string;
  running?: boolean;
  lastError?: string;
};

export type OrkaNode =
  | Node<ChatNodeData, "chat">
  | Node<AgentNodeData, "agent">
  | Node<KBNodeData, "kb">
  | Node<SessionNodeData, "session">
  | Node<OutputNodeData, "output">
  | Node<PipelineRefNodeData, "pipeline_ref">
  | Node<SkillRefNodeData, "skill_ref">;

/** Declared input of a pipeline. Used as a `{{name}}` placeholder in node
 * prompts and as the call-site argument when this pipeline is referenced
 * by another (Pipeline-as-Node). */
export type PipelineInput = {
  name: string;
  type?: "string" | "number";
  default?: string;
  description?: string;
};

/** Declared output: the textual result of a particular node becomes the
 * pipeline's named output. */
export type PipelineOutput = {
  name: string;
  from: string; // node id whose `output` becomes this named output
};

export type PipelineMeta = {
  description?: string;
  inputs?: PipelineInput[];
  outputs?: PipelineOutput[];
};

type GraphState = {
  nodes: OrkaNode[];
  edges: Edge[];
  activePipelineName: string | null;
  pipelineMeta: PipelineMeta;
  /** Runtime input values for the active pipeline (`{{name}} → value`). */
  pipelineInputs: Record<string, string>;
  onNodesChange: OnNodesChange<OrkaNode>;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  addChatNode: (init?: Partial<ChatNodeData>) => string;
  addAgentNode: (init?: Partial<ChatNodeData>) => string;
  addKBNode: () => string;
  addOutputNode: () => string;
  addPipelineRefNode: () => string;
  addSkillRefNode: (slug?: string) => string;
  addSessionNode: (info: {
    sessionId: string;
    path: string;
    projectCwd: string;
  }) => string;
  addEdge: (source: string, target: string) => void;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  /** Atomic read-modify-write of a node's data. Use this instead of reading
   *  state then calling updateNodeData when two rapid updates could race
   *  (e.g., stream-chunk handlers for chat/agent output). */
  updateNodeDataWith: (
    id: string,
    patcher: (data: Record<string, unknown>) => Record<string, unknown>
  ) => void;
  setGraph: (nodes: OrkaNode[], edges: Edge[]) => void;
  setActivePipelineName: (name: string | null) => void;
  setPipelineMeta: (m: PipelineMeta) => void;
  setPipelineInput: (name: string, value: string) => void;
  /** Remove any SessionNode that mirrors the given claude session id. */
  removeSessionNodeBySessionId: (sessionId: string) => void;
};

const ACTIVE_PIPELINE_KEY = "orka:activePipelineName";
function readInitialActivePipeline(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PIPELINE_KEY);
  } catch {
    return null;
  }
}
function persistActivePipeline(name: string | null) {
  try {
    if (name === null) localStorage.removeItem(ACTIVE_PIPELINE_KEY);
    else localStorage.setItem(ACTIVE_PIPELINE_KEY, name);
  } catch {}
}

/** Compute the next safe node id by scanning all existing ids. Prevents
 *  collisions after `setGraph` loads a pipeline with high-numbered ids, or
 *  when a user imports a template whose ids overlap the current canvas. */
function nextId(): string {
  const nodes = useGraph.getState().nodes;
  let max = 0;
  for (const n of nodes) {
    const m = /^n(\d+)$/.exec(n.id);
    if (m) {
      const v = parseInt(m[1], 10);
      if (v > max) max = v;
    }
  }
  return `n${max + 1}`;
}

/** Place new nodes near the center of existing nodes, with slight random offset
 *  so they don't stack on top of each other. */
function stagger(): { x: number; y: number } {
  const nodes = useGraph.getState().nodes;
  if (nodes.length === 0) {
    return { x: 200, y: 150 };
  }
  // Find center of existing nodes
  let cx = 0, cy = 0;
  for (const n of nodes) {
    cx += n.position.x;
    cy += n.position.y;
  }
  cx /= nodes.length;
  cy /= nodes.length;
  // Find the rightmost node to place new node after it
  let maxX = 0;
  for (const n of nodes) {
    if (n.position.x > maxX) maxX = n.position.x;
  }
  const jitterY = (Math.random() - 0.5) * 80;
  return { x: maxX + 300, y: cy + jitterY };
}

export const useGraph = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  activePipelineName: readInitialActivePipeline(),
  pipelineMeta: {},
  pipelineInputs: {},
  setActivePipelineName: (name) => {
    persistActivePipeline(name);
    set({ activePipelineName: name });
  },
  setPipelineMeta: (m) => set({ pipelineMeta: m }),
  setPipelineInput: (name, value) =>
    set({ pipelineInputs: { ...get().pipelineInputs, [name]: value } }),
  onNodesChange: (changes) =>
    set({ nodes: applyNodeChanges(changes, get().nodes) }),
  onEdgesChange: (changes) =>
    set({ edges: applyEdgeChanges(changes, get().edges) }),
  onConnect: (conn) => set({ edges: addEdge(conn, get().edges) }),
  addChatNode: (init) => {
    const id = nextId();
    const node: OrkaNode = {
      id,
      type: "chat",
      position: stagger(),
      data: { prompt: "", output: "", running: false, ...(init ?? {}) },
    };
    set({ nodes: [...get().nodes, node] });
    return id;
  },
  addAgentNode: (init) => {
    const id = nextId();
    const node: OrkaNode = {
      id,
      type: "agent",
      position: stagger(),
      data: { prompt: "", output: "", running: false, ...(init ?? {}) },
    };
    set({ nodes: [...get().nodes, node] });
    return id;
  },
  addKBNode: () => {
    const id = nextId();
    const node: OrkaNode = {
      id,
      type: "kb",
      position: stagger(),
      data: { source: "folder", files: [], dir: "" },
    };
    set({ nodes: [...get().nodes, node] });
    return id;
  },
  addPipelineRefNode: () => {
    const id = nextId();
    const node: OrkaNode = {
      id,
      type: "pipeline_ref",
      position: stagger(),
      data: { pipelineName: "", inputBindings: {} },
    };
    set({ nodes: [...get().nodes, node] });
    return id;
  },
  addSkillRefNode: (slug = "") => {
    const id = nextId();
    const node: OrkaNode = {
      id,
      type: "skill_ref",
      position: stagger(),
      data: { skill: slug, bind: {} },
    };
    set({ nodes: [...get().nodes, node] });
    return id;
  },
  addOutputNode: () => {
    const id = nextId();
    const node: OrkaNode = {
      id,
      type: "output",
      position: stagger(),
      data: {
        destination: "local",
        filename: "report.md",
        dir: "",
        format: "markdown",
        mergeMode: "concat",
        template: "",
        overwrite: false,
        webhookUrl: "",
        webhookHeaders: "",
        shellCommand: "",
        notesTitle: "Orka Inbox",
      },
    };
    set({ nodes: [...get().nodes, node] });
    return id;
  },
  addSessionNode: ({ sessionId, path, projectCwd }) => {
    const id = nextId();
    const node: OrkaNode = {
      id,
      type: "session",
      position: stagger(),
      data: { sessionId, path, projectCwd, live: false },
    };
    set({ nodes: [...get().nodes, node] });
    return id;
  },
  updateNodeData: (id, patch) =>
    set({
      nodes: get().nodes.map((n) =>
        n.id === id
          ? ({ ...n, data: { ...n.data, ...patch } } as OrkaNode)
          : n
      ),
    }),
  updateNodeDataWith: (id, patcher) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id
          ? ({
              ...n,
              data: {
                ...n.data,
                ...patcher(n.data as Record<string, unknown>),
              },
            } as OrkaNode)
          : n
      ),
    })),
  addEdge: (source, target) => {
    const id = `e-${source}-${target}`;
    if (get().edges.some((e) => e.id === id)) return;
    set({ edges: [...get().edges, { id, source, target }] });
  },
  removeSessionNodeBySessionId: (sessionId) => {
    const kept = get().nodes.filter(
      (n) => !(n.type === "session" && (n.data as SessionNodeData).sessionId === sessionId)
    );
    const removedIds = new Set(
      get()
        .nodes.filter((n) => !kept.includes(n))
        .map((n) => n.id)
    );
    const edges = get().edges.filter(
      (e) => !removedIds.has(e.source) && !removedIds.has(e.target)
    );
    set({ nodes: kept, edges });
  },
  setGraph: (nodes, edges) => {
    // Defensive: drop malformed nodes so React Flow never crashes on undefined .position.
    const valid = nodes.filter(
      (n) =>
        n &&
        typeof n.id === "string" &&
        n.position &&
        typeof n.position.x === "number" &&
        typeof n.position.y === "number"
    );
    // nextId() reads current store state on demand, so no seq to maintain here.
    set({ nodes: valid, edges });
  },
}));
