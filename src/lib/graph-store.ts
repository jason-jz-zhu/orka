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
};

export type KBNodeData = {
  files: string[];
  dir: string;
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
export type OutputNodeData = {
  filename: string;            // e.g. "report.md" — relative or absolute
  dir: string;                 // absolute or empty (= default outputs dir)
  format: OutputFormat;
  mergeMode: OutputMergeMode;  // how to combine multiple upstreams
  template: string;            // optional, e.g. "# {nodeId}\n\n{content}"
  overwrite: boolean;          // false = append timestamp suffix
  // Runtime (not persisted in templates):
  lastWrittenPath?: string;
  lastWrittenAt?: number;
  lastError?: string;
  running?: boolean;
};

export type OrkaNode =
  | Node<ChatNodeData, "chat">
  | Node<AgentNodeData, "agent">
  | Node<KBNodeData, "kb">
  | Node<SessionNodeData, "session">
  | Node<OutputNodeData, "output">;

type GraphState = {
  nodes: OrkaNode[];
  edges: Edge[];
  activePipelineName: string | null;
  onNodesChange: OnNodesChange<OrkaNode>;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  addChatNode: (init?: Partial<ChatNodeData>) => string;
  addAgentNode: (init?: Partial<ChatNodeData>) => string;
  addKBNode: () => string;
  addOutputNode: () => string;
  addSessionNode: (info: {
    sessionId: string;
    path: string;
    projectCwd: string;
  }) => string;
  addEdge: (source: string, target: string) => void;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  setGraph: (nodes: OrkaNode[], edges: Edge[]) => void;
  setActivePipelineName: (name: string | null) => void;
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

let seq = 0;
const nextId = () => `n${++seq}`;

function stagger(): { x: number; y: number } {
  const n = seq;
  return { x: 60 + (n % 4) * 320, y: 80 + Math.floor(n / 4) * 260 };
}

export const useGraph = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  activePipelineName: readInitialActivePipeline(),
  setActivePipelineName: (name) => {
    persistActivePipeline(name);
    set({ activePipelineName: name });
  },
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
      data: { files: [], dir: "" },
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
        filename: "report.md",
        dir: "",
        format: "markdown",
        mergeMode: "concat",
        template: "",
        overwrite: false,
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
  addEdge: (source, target) => {
    const id = `e-${source}-${target}`;
    if (get().edges.some((e) => e.id === id)) return;
    set({ edges: [...get().edges, { id, source, target }] });
  },
  removeSessionNodeBySessionId: (sessionId) => {
    const kept = get().nodes.filter(
      (n) => !(n.type === "session" && (n.data as any).sessionId === sessionId)
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
    for (const n of valid) {
      const m = /^n(\d+)$/.exec(n.id);
      if (m) seq = Math.max(seq, parseInt(m[1], 10));
    }
    set({ nodes: valid, edges });
  },
}));
