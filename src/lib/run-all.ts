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

function waitForDone(nodeId: string): Promise<{ ok: boolean; error?: string }> {
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

export async function runAll(): Promise<RunAllResult> {
  const store = useGraph.getState();
  const order = topoOrder(store.nodes, store.edges);
  const ran: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of order) {
    const n = useGraph.getState().nodes.find((x) => x.id === id);
    if (!n) continue;
    if (n.type !== "chat" && n.type !== "agent") {
      skipped.push(id);
      continue;
    }
    const data = n.data as any;
    if (!data.prompt || !data.prompt.trim()) {
      skipped.push(id);
      continue;
    }

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
  }
  return { ran, skipped, failed };
}
