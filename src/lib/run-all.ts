import type { Edge } from "@xyflow/react";
import { invokeCmd, listenEvent } from "../lib/tauri";
import { useGraph, type OrkaNode } from "./graph-store";
import { buildContext, composePrompt } from "./context";

/**
 * Kahn's topological sort. Returns node ids in upstream-first order.
 * Cycles (shouldn't happen in a DAG UI) get their remaining nodes appended at the end.
 */
function topoOrder(nodes: OrkaNode[], edges: Edge[]): string[] {
  const indeg = new Map<string, number>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  for (const n of nodes) indeg.set(n.id, 0);
  for (const e of edges) {
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  const queue: string[] = [];
  for (const [id, d] of indeg) if (d === 0) queue.push(id);
  while (queue.length) {
    const id = queue.shift()!;
    out.push(id);
    for (const e of edges) {
      if (e.source !== id) continue;
      const d = (indeg.get(e.target) ?? 0) - 1;
      indeg.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }
  // Append any unvisited (cycles) so we don't silently drop them.
  for (const n of nodes) if (!out.includes(n.id)) out.push(n.id);
  return out.filter((id) => byId.has(id));
}

// Module-level signal set by App toolbar's "Skip →" button during grace.
let skipRequested = false;
export function requestRunAllSkip() {
  skipRequested = true;
}

function endsWithQuestion(text: string | undefined): boolean {
  if (!text) return false;
  const tail = text.slice(-400);
  return /[?？]/.test(tail);
}

function anyChatAgentRunning(): boolean {
  return useGraph
    .getState()
    .nodes.some(
      (n) =>
        (n.type === "chat" || n.type === "agent") &&
        (n.data as { running?: boolean }).running === true
    );
}

function currentOutput(nodeId: string): string {
  const n = useGraph.getState().nodes.find((x) => x.id === nodeId);
  return (n?.data as { output?: string } | undefined)?.output ?? "";
}

/**
 * After a node's `done` fires, give the user a chance to start a follow-up
 * "↪ Continue" turn before Run All marches on.
 *
 * Behaviour:
 *   - If the just-finished node ends with a question mark, wait INDEFINITELY
 *     until either (a) the user clicks ↪ Continue (which we then await and
 *     re-evaluate), or (b) the user explicitly clicks Skip in the toolbar.
 *   - Otherwise wait a short 3s grace to absorb quick Continues, then move on.
 *
 * While waiting, fires `onPaused(true/false)` so the toolbar can surface a
 * "Skip" button.
 */
async function settleBeforeNext(
  currentNodeId: string,
  onPaused?: (paused: boolean) => void
): Promise<void> {
  skipRequested = false;
  const SHORT_GRACE_MS = 3000;
  const TICK_MS = 200;

  const recompute = () => {
    const out = currentOutput(currentNodeId);
    return endsWithQuestion(out);
  };

  let isQuestion = recompute();
  let shortDeadline = Date.now() + SHORT_GRACE_MS;

  onPaused?.(isQuestion);
  try {
    for (;;) {
      if (skipRequested) return;
      if (anyChatAgentRunning()) {
        onPaused?.(false);
        // Wait for whichever Continue is in flight.
        const running = useGraph
          .getState()
          .nodes.filter(
            (n) =>
              (n.type === "chat" || n.type === "agent") &&
              (n.data as { running?: boolean }).running === true
          );
        await Promise.all(running.map((n) => waitForDone(n.id)));
        // Re-evaluate — maybe Claude answered fully (no ?) or asked again.
        isQuestion = recompute();
        shortDeadline = Date.now() + SHORT_GRACE_MS;
        onPaused?.(isQuestion);
        continue;
      }
      if (!isQuestion && Date.now() >= shortDeadline) return;
      if (isQuestion) {
        // Indefinite — only exit on skip or a new Continue starting.
        await new Promise((r) => setTimeout(r, TICK_MS));
        continue;
      }
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
  } finally {
    skipRequested = false;
    onPaused?.(false);
  }
}

export function waitForDone(nodeId: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let fired = false;
    listenEvent<{ ok: boolean; error?: string }>(
      `node:${nodeId}:done`,
      (payload) => {
        if (fired) return;
        fired = true;
        resolve(payload ?? { ok: true });
      }
    ).then((unlisten) => {
      // Safety timeout: 10 minutes.
      setTimeout(
        () => {
          if (fired) return;
          fired = true;
          unlisten();
          resolve({ ok: false, error: "timeout" });
        },
        10 * 60 * 1000
      );
    });
  });
}

export type RunAllResult = {
  ran: string[];
  skipped: string[];
  failed: Array<{ id: string; error: string }>;
};

export type RunAllProgress = {
  /** 0-based index of the node currently being processed. */
  index: number;
  /** Total number of runnable nodes (chat/agent/output) in topological order. */
  total: number;
  /** Node currently running, or null when finished. */
  currentId: string | null;
  /** Optional human-readable label for the current node, e.g. "n2 (chat)". */
  label: string | null;
  /** True when Run All is paused awaiting a user reply (question detected). */
  pausedForReply?: boolean;
};

/**
 * Collect the immediate upstream chat/agent outputs of an output-type sink,
 * format them per the node's mergeMode + format, and write to disk.
 */
async function runOutputNode(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const store = useGraph.getState();
  const node = store.nodes.find((n) => n.id === id);
  if (!node || node.type !== "output") return { ok: false, error: "not an output node" };
  const data = node.data as {
    filename: string;
    dir: string;
    format: "markdown" | "json" | "text";
    mergeMode: "concat" | "list" | "json";
    template: string;
    overwrite: boolean;
  };

  // Mark running, clear last-error.
  store.updateNodeData(id, { running: true, lastError: undefined });

  try {
    const upstream = collectUpstream(id, store.nodes, store.edges);
    if (upstream.length === 0) {
      throw new Error("no upstream chat/agent nodes connected");
    }
    const body = formatBody(upstream, data);
    const path = await resolveTargetPath(data);
    const written = await invokeCmd<string>("write_output_file", {
      path,
      content: body,
    });
    store.updateNodeData(id, {
      running: false,
      lastWrittenPath: written,
      lastWrittenAt: Date.now(),
      lastError: undefined,
    });
    return { ok: true };
  } catch (e) {
    const msg = String(e);
    store.updateNodeData(id, { running: false, lastError: msg });
    return { ok: false, error: msg };
  }
}

type UpstreamHit = { id: string; type: string; output: string; prompt?: string };

function collectUpstream(
  targetId: string,
  nodes: OrkaNode[],
  edges: Edge[]
): UpstreamHit[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const order = topoOrder(nodes, edges); // upstream-first
  const incoming = new Set<string>();
  // BFS backwards from target through edges.
  const stack = [targetId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of edges) {
      if (e.target !== cur) continue;
      if (incoming.has(e.source)) continue;
      incoming.add(e.source);
      stack.push(e.source);
    }
  }
  const out: UpstreamHit[] = [];
  for (const nid of order) {
    if (!incoming.has(nid)) continue;
    const n = byId.get(nid);
    if (!n) continue;
    if (n.type !== "chat" && n.type !== "agent") continue;
    const d = n.data as { output?: string; prompt?: string };
    out.push({
      id: n.id,
      type: n.type,
      output: (d.output ?? "").trim(),
      prompt: d.prompt,
    });
  }
  return out;
}

function applyTemplate(tpl: string, hit: UpstreamHit): string {
  if (!tpl) return hit.output;
  return tpl
    .split("{nodeId}").join(hit.id)
    .split("{type}").join(hit.type)
    .split("{prompt}").join(hit.prompt ?? "")
    .split("{content}").join(hit.output);
}

function formatBody(
  upstream: UpstreamHit[],
  data: {
    format: "markdown" | "json" | "text";
    mergeMode: "concat" | "list" | "json";
    template: string;
  }
): string {
  if (data.format === "json" || data.mergeMode === "json") {
    return JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        nodes: upstream.map((h) => ({
          id: h.id,
          type: h.type,
          prompt: h.prompt,
          output: h.output,
        })),
      },
      null,
      2
    );
  }
  if (data.mergeMode === "list") {
    return upstream
      .map((h, i) => `${i + 1}. ${applyTemplate(data.template, h)}`)
      .join("\n\n");
  }
  // concat: respect template per node, separator between
  if (data.format === "markdown") {
    return upstream
      .map((h) =>
        data.template
          ? applyTemplate(data.template, h)
          : `## ${h.id} (${h.type})\n\n${h.output}`
      )
      .join("\n\n---\n\n");
  }
  // plain text
  return upstream
    .map((h) =>
      data.template ? applyTemplate(data.template, h) : `[${h.id}] ${h.output}`
    )
    .join("\n\n");
}

function defaultExt(format: "markdown" | "json" | "text"): string {
  return format === "json" ? ".json" : format === "text" ? ".txt" : ".md";
}

async function resolveTargetPath(data: {
  filename: string;
  dir: string;
  format: "markdown" | "json" | "text";
  overwrite: boolean;
}): Promise<string> {
  let dir = data.dir.trim();
  if (!dir) {
    dir = await invokeCmd<string>("outputs_dir");
  }
  let name = data.filename.trim() || `report${defaultExt(data.format)}`;
  // If user gave no extension, infer from format.
  if (!/\.[a-z0-9]+$/i.test(name)) name += defaultExt(data.format);
  if (!data.overwrite) {
    const ts = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .slice(0, 19);
    const dot = name.lastIndexOf(".");
    name =
      dot > 0 ? `${name.slice(0, dot)}-${ts}${name.slice(dot)}` : `${name}-${ts}`;
  }
  const sep = dir.endsWith("/") ? "" : "/";
  return `${dir}${sep}${name}`;
}

export async function runAll(
  onProgress?: (p: RunAllProgress) => void
): Promise<RunAllResult> {
  const store = useGraph.getState();
  const order = topoOrder(store.nodes, store.edges);
  const ran: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  // Clear stale content from every node so the user sees a fresh run, not
  // a mix of "just ran" and "leftover from last Run All".
  for (const n of store.nodes) {
    if (n.type === "chat" || n.type === "agent") {
      store.updateNodeData(n.id, {
        output: "",
        toolCount: 0,
        costUsd: undefined,
        lastSessionId: undefined,
      });
    } else if (n.type === "output") {
      store.updateNodeData(n.id, {
        lastWrittenPath: undefined,
        lastWrittenAt: undefined,
        lastError: undefined,
      });
    }
  }

  // Pre-count the runnable nodes (chat/agent/output) for the progress total.
  const runnable = order.filter((id) => {
    const n = store.nodes.find((x) => x.id === id);
    return (
      n &&
      (n.type === "chat" || n.type === "agent" || n.type === "output")
    );
  });
  const total = runnable.length;
  let index = 0;

  for (const id of order) {
    const n = useGraph.getState().nodes.find((x) => x.id === id);
    if (!n) continue;

    // Output nodes are sinks: no Claude call. Just gather upstream and write.
    if (n.type === "output") {
      index += 1;
      onProgress?.({ index, total, currentId: id, label: `${id} (output)` });
      const r = await runOutputNode(id);
      if (r.ok) ran.push(id);
      else failed.push({ id, error: r.error });
      continue;
    }

    if (n.type !== "chat" && n.type !== "agent") {
      skipped.push(id);
      continue;
    }
    const data = n.data as any;
    if (!data.prompt || !data.prompt.trim()) {
      skipped.push(id);
      continue;
    }

    index += 1;
    onProgress?.({ index, total, currentId: id, label: `${id} (${n.type})` });
    store.updateNodeData(id, { running: true, output: "", toolCount: 0 });

    const { nodes, edges } = useGraph.getState();
    const ctx = buildContext(id, nodes, edges);
    const composed = composePrompt(ctx.text, data.prompt);
    const cmd = n.type === "agent" ? "run_agent_node" : "run_node";

    try {
      const donePromise = waitForDone(id);
      await invokeCmd(cmd, {
        id,
        prompt: composed,
        resumeId: data.resumeSessionId ?? null,
        addDirs: ctx.addDirs,
      });
      const done = await donePromise;
      if (done.ok) ran.push(id);
      else failed.push({ id, error: done.error ?? "unknown" });
    } catch (e) {
      failed.push({ id, error: String(e) });
    } finally {
      // done handler already sets running=false, but just in case:
      useGraph.getState().updateNodeData(id, { running: false });
    }
    // Grace window — let the user click ↪ Continue on this node before we
    // march to the next one. If the node ends with a question, wait until
    // the user either replies or clicks Skip.
    await settleBeforeNext(id, (paused) => {
      onProgress?.({
        index,
        total,
        currentId: id,
        label: paused
          ? `${id} is asking — reply below or Skip`
          : `${id} done · waiting briefly…`,
        pausedForReply: paused,
      });
    });
  }
  onProgress?.({ index: total, total, currentId: null, label: null });
  return { ran, skipped, failed };
}
