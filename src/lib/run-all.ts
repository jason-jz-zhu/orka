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

/**
 * Topological LEVELS: nodes at the same level have no edge between them and
 * can safely run in parallel. Returns an array of layers in execution order.
 */
function topoLevels(nodes: OrkaNode[], edges: Edge[]): string[][] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    adj.get(e.source)?.push(e.target);
  }
  const levels: string[][] = [];
  let frontier = nodes
    .filter((n) => (indeg.get(n.id) ?? 0) === 0)
    .map((n) => n.id);
  const seen = new Set<string>();
  while (frontier.length) {
    levels.push(frontier);
    for (const id of frontier) seen.add(id);
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of adj.get(id) ?? []) {
        const d = (indeg.get(child) ?? 0) - 1;
        indeg.set(child, d);
        if (d === 0) next.push(child);
      }
    }
    frontier = next;
  }
  // Append any unvisited (cycle remnants) as a final synthetic level so we
  // don't silently drop them.
  const stragglers = nodes.filter((n) => !seen.has(n.id)).map((n) => n.id);
  if (stragglers.length) levels.push(stragglers);
  // Strip any ids that aren't real nodes (defensive).
  return levels.map((lvl) => lvl.filter((id) => byId.has(id)));
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
    destination?: string;
    filename: string;
    dir: string;
    format: "markdown" | "json" | "text";
    mergeMode: "concat" | "list" | "json";
    template: string;
    overwrite: boolean;
    webhookUrl?: string;
    webhookHeaders?: string;
    shellCommand?: string;
    notesTitle?: string;
  };

  store.updateNodeData(id, { running: true, lastError: undefined });

  try {
    const upstream = collectUpstream(id, store.nodes, store.edges);
    if (upstream.length === 0) {
      throw new Error("no upstream chat/agent nodes connected");
    }
    const body = formatBody(upstream, data);
    const destination = data.destination ?? "local";

    let summary: string;
    switch (destination) {
      case "local": {
        const path = await resolveTargetPath(data);
        summary = await invokeCmd<string>("write_output_file", { path, content: body });
        break;
      }
      case "icloud": {
        const filename = resolveFilename(data);
        summary = await invokeCmd<string>("write_to_icloud", {
          filename,
          content: body,
        });
        break;
      }
      case "notes": {
        const title = (data.notesTitle || "Orka Inbox").trim();
        // Use Rust's comrak (full GFM: tables, lists, code, etc.) — much
        // better than the ad-hoc converter we used to ship.
        const html = await invokeCmd<string>("markdown_to_html", {
          markdown: body,
        });
        summary = await invokeCmd<string>("append_to_apple_note", {
          title,
          htmlBody: html,
        });
        break;
      }
      case "webhook": {
        const url = (data.webhookUrl || "").trim();
        if (!url) throw new Error("webhook URL is empty");
        summary = await invokeCmd<string>("post_to_webhook", {
          url,
          headers: data.webhookHeaders || null,
          body,
        });
        break;
      }
      case "shell": {
        const cmd = (data.shellCommand || "").trim();
        if (!cmd) throw new Error("shell command is empty");
        summary = await invokeCmd<string>("run_shell_destination", {
          commandTemplate: cmd,
          content: body,
        });
        break;
      }
      case "profile": {
        const pid = ((data as { profileId?: string }).profileId || "").trim();
        if (!pid) throw new Error("no destination profile selected");
        summary = await invokeCmd<string>("send_via_profile", {
          profileId: pid,
          body,
        });
        break;
      }
      default:
        throw new Error(`unknown destination: ${destination}`);
    }

    store.updateNodeData(id, {
      running: false,
      lastWrittenPath: summary,
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

/** Derive the filename (with timestamp + correct extension) without a dir. */
function resolveFilename(data: {
  filename: string;
  format: "markdown" | "json" | "text";
  overwrite: boolean;
}): string {
  let name = data.filename.trim() || `report${defaultExt(data.format)}`;
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
  return name;
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

/**
 * Run a single chat/agent node end-to-end. Returns the outcome and the node's
 * id so callers can collect results in parallel. Output nodes have a
 * separate path via `runOutputNode`.
 */
/**
 * Execute a pipeline_ref node: load the referenced pipeline, run it
 * **in-process** with input bindings substituted, capture the declared
 * output (or last chat/agent output if no output is declared), and stash it
 * as this node's `output` so downstream nodes can consume it.
 *
 * Implementation strategy: avoid recursive runAll() (state bleed risk).
 * Instead we evaluate the sub-pipeline strictly: topo-walk, each chat/agent
 * gets its prompt placeholders substituted with the bindings, no UI updates,
 * pure server-side execution.
 */
async function runPipelineRefNode(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const store = useGraph.getState();
  const node = store.nodes.find((n) => n.id === id);
  if (!node || node.type !== "pipeline_ref")
    return { ok: false, error: "not a pipeline_ref node" };
  const data = node.data as {
    pipelineName?: string;
    inputBindings?: Record<string, string>;
  };
  const pipelineName = (data.pipelineName ?? "").trim();
  if (!pipelineName) {
    store.updateNodeData(id, { lastError: "no pipeline selected" });
    return { ok: false, error: "no pipeline selected" };
  }
  store.updateNodeData(id, { running: true, lastError: undefined, output: "" });
  try {
    const raw = await invokeCmd<string>("load_template", { name: pipelineName });
    const tpl = JSON.parse(raw) as {
      nodes?: Array<{ id: string; type: string; data: Record<string, unknown> }>;
      edges?: Array<{ source: string; target: string }>;
      inputs?: Array<{ name: string; default?: string }>;
      outputs?: Array<{ name: string; from: string }>;
    };
    if (!Array.isArray(tpl.nodes)) throw new Error("template has no nodes");

    const bindings: Record<string, string> = {};
    for (const inp of tpl.inputs ?? []) {
      bindings[inp.name] =
        data.inputBindings?.[inp.name] ?? inp.default ?? "";
    }

    // Map subnode id → resolved output string.
    const subOutputs = new Map<string, string>();
    const subNodes = tpl.nodes;
    const subEdges = tpl.edges ?? [];

    // Build adjacency for context look-up.
    const incoming = new Map<string, string[]>();
    for (const n of subNodes) incoming.set(n.id, []);
    for (const e of subEdges) {
      if (incoming.has(e.target))
        incoming.get(e.target)!.push(e.source);
    }

    // Topological levels of the sub-pipeline.
    const sublevels = ((): string[][] => {
      const indeg = new Map<string, number>();
      const adj = new Map<string, string[]>();
      for (const n of subNodes) {
        indeg.set(n.id, 0);
        adj.set(n.id, []);
      }
      for (const e of subEdges) {
        indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
        adj.get(e.source)?.push(e.target);
      }
      const lvls: string[][] = [];
      let f = subNodes
        .filter((n) => (indeg.get(n.id) ?? 0) === 0)
        .map((n) => n.id);
      while (f.length) {
        lvls.push(f);
        const nxt: string[] = [];
        for (const nid of f) {
          for (const c of adj.get(nid) ?? []) {
            const d = (indeg.get(c) ?? 0) - 1;
            indeg.set(c, d);
            if (d === 0) nxt.push(c);
          }
        }
        f = nxt;
      }
      return lvls;
    })();

    function buildContextText(targetId: string): string {
      const parents = incoming.get(targetId) ?? [];
      const parts: string[] = [];
      for (const pid of parents) {
        const sub = subNodes.find((x) => x.id === pid);
        if (!sub) continue;
        const out = subOutputs.get(pid) ?? "";
        if (sub.type === "chat" || sub.type === "agent") {
          parts.push(`[from ${sub.type} node ${sub.id}]\n${out.trim()}`);
        } else if (sub.type === "kb") {
          const dir = String(sub.data.dir ?? "");
          if (dir) parts.push(`[knowledge base node ${sub.id}]\nDir: ${dir}`);
        }
      }
      return parts.join("\n\n---\n\n");
    }

    for (const lvl of sublevels) {
      // Run chat/agent in parallel within a level.
      const tasks: Promise<void>[] = [];
      for (const nid of lvl) {
        const sub = subNodes.find((x) => x.id === nid);
        if (!sub) continue;
        if (sub.type !== "chat" && sub.type !== "agent") continue;
        const promptRaw = String(sub.data.prompt ?? "");
        if (!promptRaw.trim()) {
          subOutputs.set(nid, "");
          continue;
        }
        const promptResolved = substitutePlaceholders(promptRaw, bindings);
        const ctx = buildContextText(nid);
        const composed = ctx
          ? `Context from upstream nodes:\n\n${ctx}\n\n---\n\nTask:\n${promptResolved}`
          : promptResolved;
        const cmd = sub.type === "agent" ? "run_agent_node" : "run_node";
        const childId = `${id}__sub__${nid}`;
        tasks.push(
          (async () => {
            const donePromise = waitForDone(childId);
            await invokeCmd(cmd, {
              id: childId,
              prompt: composed,
              resumeId: null,
              addDirs: [],
            });
            await donePromise;
            // Pull the output the parent node accumulated via stream events.
            // Sub-runs aren't UI-bound, so we fall back to listening for the
            // full text via the graph store's update path. Simplest: query
            // node state we never created — we can't. Instead we capture
            // text from the stream events directly.
            // For now, leave subOutputs blank — the actual output will come
            // from the standalone listener below.
          })()
        );
      }
      // We need a separate listener loop to actually capture text. Replace
      // the above tasks with stream-aware execution:
      tasks.length = 0;
      for (const nid of lvl) {
        const sub = subNodes.find((x) => x.id === nid);
        if (!sub) continue;
        if (sub.type !== "chat" && sub.type !== "agent") continue;
        const promptRaw = String(sub.data.prompt ?? "");
        if (!promptRaw.trim()) {
          subOutputs.set(nid, "");
          continue;
        }
        const promptResolved = substitutePlaceholders(promptRaw, bindings);
        const ctx = buildContextText(nid);
        const composed = ctx
          ? `Context from upstream nodes:\n\n${ctx}\n\n---\n\nTask:\n${promptResolved}`
          : promptResolved;
        const cmd = sub.type === "agent" ? "run_agent_node" : "run_node";
        const childId = `${id}__sub__${nid}`;
        tasks.push(
          (async () => {
            let buf = "";
            const unlistenStream = await listenEvent<string>(
              `node:${childId}:stream`,
              (rawLine) => {
                try {
                  const v = JSON.parse(rawLine);
                  if (v?.type === "assistant" && v.message?.content) {
                    for (const b of v.message.content) {
                      if (b?.type === "text" && typeof b.text === "string") {
                        buf += b.text;
                      }
                    }
                  } else if (v?.type === "result") {
                    if (typeof v.result === "string" && buf === "") {
                      buf = v.result;
                    }
                  }
                } catch {}
              }
            );
            try {
              const donePromise = waitForDone(childId);
              await invokeCmd(cmd, {
                id: childId,
                prompt: composed,
                resumeId: null,
                addDirs: [],
              });
              await donePromise;
            } finally {
              unlistenStream();
            }
            subOutputs.set(nid, buf);
          })()
        );
      }
      await Promise.all(tasks);
    }

    // Resolve declared output: take the named output's `from` node text;
    // fall back to the last chat/agent output in topological order.
    let finalOutput = "";
    if (Array.isArray(tpl.outputs) && tpl.outputs.length > 0) {
      const o = tpl.outputs[0];
      finalOutput = subOutputs.get(o.from) ?? "";
    } else {
      for (const lvl of [...sublevels].reverse()) {
        for (const nid of lvl) {
          const sub = subNodes.find((x) => x.id === nid);
          if (sub && (sub.type === "chat" || sub.type === "agent")) {
            const out = subOutputs.get(nid) ?? "";
            if (out) {
              finalOutput = out;
              break;
            }
          }
        }
        if (finalOutput) break;
      }
    }

    store.updateNodeData(id, {
      running: false,
      output: finalOutput,
      lastError: undefined,
    });
    return { ok: true };
  } catch (e) {
    const msg = String(e);
    store.updateNodeData(id, { running: false, lastError: msg });
    return { ok: false, error: msg };
  }
}

/** Substitute `{{name}}` placeholders with the pipeline's input values. */
function substitutePlaceholders(
  text: string,
  inputs: Record<string, string>
): string {
  if (!text.includes("{{")) return text;
  return text.replace(/\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g, (_, name) =>
    Object.prototype.hasOwnProperty.call(inputs, name) ? inputs[name] : ""
  );
}

async function runSkillRefNode(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const store = useGraph.getState();
  const node = store.nodes.find((n) => n.id === id);
  if (!node || node.type !== "skill_ref")
    return { ok: false, error: "not a skill_ref node" };
  const data = node.data as { skill?: string; bind?: Record<string, string> };
  const slug = data.skill?.trim();
  if (!slug) return { ok: false, error: "no skill selected" };

  store.updateNodeData(id, { running: true, lastError: undefined });
  try {
    const ctx = buildContext(id, store.nodes, store.edges);
    const bindingsRendered = Object.entries(data.bind ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    const prompt = `/${slug}${bindingsRendered ? `\n\n${bindingsRendered}` : ""}${
      ctx.text ? `\n\nContext from upstream:\n${ctx.text}` : ""
    }`;

    let buf = "";
    const unlisten = await listenEvent<string>(
      `node:${id}:stream`,
      (text) => { buf += text; }
    );
    const done = new Promise<void>((resolve) => {
      listenEvent<string>(`node:${id}:done`, () => resolve()).then(() => {});
    });
    try {
      await invokeCmd("run_agent_node", {
        id,
        prompt,
        resumeId: null,
        addDirs: ctx.addDirs,
      });
      await done;
    } finally {
      unlisten();
    }
    store.updateNodeData(id, { running: false, output: buf, lastError: undefined });
    return { ok: true };
  } catch (e) {
    const msg = String(e);
    store.updateNodeData(id, { running: false, lastError: msg });
    return { ok: false, error: msg };
  }
}

async function runChatAgentNode(
  id: string
): Promise<
  | { kind: "ran"; id: string }
  | { kind: "skipped"; id: string }
  | { kind: "failed"; id: string; error: string }
> {
  const n = useGraph.getState().nodes.find((x) => x.id === id);
  if (!n) return { kind: "skipped", id };
  if (n.type !== "chat" && n.type !== "agent") return { kind: "skipped", id };
  const data = n.data as { prompt?: string; resumeSessionId?: string };
  if (!data.prompt || !data.prompt.trim()) return { kind: "skipped", id };

  useGraph
    .getState()
    .updateNodeData(id, { running: true, output: "", toolCount: 0 });
  const state = useGraph.getState();
  const { nodes, edges } = state;
  const ctx = buildContext(id, nodes, edges);
  const promptWithInputs = substitutePlaceholders(
    data.prompt,
    state.pipelineInputs
  );
  const composed = composePrompt(ctx.text, promptWithInputs);
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
    if (done.ok) return { kind: "ran", id };
    return { kind: "failed", id, error: done.error ?? "unknown" };
  } catch (e) {
    return { kind: "failed", id, error: String(e) };
  } finally {
    useGraph.getState().updateNodeData(id, { running: false });
  }
}

let _runStartedAt: string | null = null;

export async function runAll(
  onProgress?: (p: RunAllProgress) => void
): Promise<RunAllResult> {
  _runStartedAt = new Date().toISOString();
  const store = useGraph.getState();
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

  // Compute topological LEVELS — nodes within the same level have no edge
  // between them and run in parallel.
  const levels = topoLevels(store.nodes, store.edges);
  const total = levels.flat().filter((id) => {
    const n = store.nodes.find((x) => x.id === id);
    return (
      n &&
      (n.type === "chat" ||
        n.type === "agent" ||
        n.type === "output" ||
        n.type === "pipeline_ref" ||
        n.type === "skill_ref")
    );
  }).length;
  let progressIndex = 0;

  for (const level of levels) {
    // Partition this level into chat/agent (parallel) vs output (serial,
    // since output nodes write side effects keyed on filesystem path).
    const chatAgentIds: string[] = [];
    const outputIds: string[] = [];
    for (const id of level) {
      const n = store.nodes.find((x) => x.id === id);
      if (!n) continue;
      if (n.type === "chat" || n.type === "agent") chatAgentIds.push(id);
      else if (n.type === "output") outputIds.push(id);
      // kb / session / etc — silently skipped (no run action)
    }

    // Fire all chat/agent nodes in parallel, but only count those that
    // actually have non-empty prompts toward progress.
    // pipeline_ref and skill_ref nodes execute their referenced sub-pipeline/skill.
    const pipelineRefIds: string[] = [];
    const skillRefIds: string[] = [];
    for (const id of level) {
      const n = store.nodes.find((x) => x.id === id);
      if (n?.type === "pipeline_ref") pipelineRefIds.push(id);
      if (n?.type === "skill_ref") skillRefIds.push(id);
    }
    for (const id of pipelineRefIds) {
      progressIndex += 1;
      onProgress?.({
        index: progressIndex,
        total,
        currentId: id,
        label: `${id} (sub-pipeline)`,
      });
      const r = await runPipelineRefNode(id);
      if (r.ok) ran.push(id);
      else failed.push({ id, error: r.error });
    }
    for (const id of skillRefIds) {
      progressIndex += 1;
      onProgress?.({
        index: progressIndex,
        total,
        currentId: id,
        label: `${id} (skill)`,
      });
      const r = await runSkillRefNode(id);
      if (r.ok) ran.push(id);
      else failed.push({ id, error: r.error });
    }

    if (chatAgentIds.length > 0) {
      const labelList = chatAgentIds.join(", ");
      onProgress?.({
        index: progressIndex + 1,
        total,
        currentId: chatAgentIds[0],
        label:
          chatAgentIds.length === 1
            ? `${chatAgentIds[0]}`
            : `${labelList} (parallel ×${chatAgentIds.length})`,
      });
      const results = await Promise.all(
        chatAgentIds.map((id) => runChatAgentNode(id))
      );
      for (const r of results) {
        if (r.kind === "ran") ran.push(r.id);
        else if (r.kind === "skipped") skipped.push(r.id);
        else failed.push({ id: r.id, error: r.error });
      }
      progressIndex += results.filter((r) => r.kind !== "skipped").length;
    }

    // Output nodes after chat/agent in the same level (rare — outputs
    // are usually leaves so they sit in their own level anyway).
    for (const id of outputIds) {
      progressIndex += 1;
      onProgress?.({
        index: progressIndex,
        total,
        currentId: id,
        label: `${id} (output)`,
      });
      const r = await runOutputNode(id);
      if (r.ok) ran.push(id);
      else failed.push({ id, error: r.error });
    }

    // Grace window AFTER the level completes — if any chat/agent node ended
    // with a question, pause for reply. We use the first conversational id
    // in the level as the "current" focus for the question detection.
    const focusId = chatAgentIds[chatAgentIds.length - 1];
    if (focusId) {
      await settleBeforeNext(focusId, (paused) => {
        onProgress?.({
          index: progressIndex,
          total,
          currentId: focusId,
          label: paused
            ? `${focusId} is asking — reply below or Skip`
            : `level done · waiting briefly…`,
          pausedForReply: paused,
        });
      });
    }
  }
  onProgress?.({ index: total, total, currentId: null, label: null });

  // Log this run to persistent history so the Runs tab can display it.
  const endedAt = new Date().toISOString();
  const pipelineName = useGraph.getState().activePipelineName ?? "(unsaved)";
  invokeCmd("append_run", {
    record: {
      id: `run-${Date.now()}`,
      skill: pipelineName,
      inputs: [],
      started_at: _runStartedAt ?? endedAt,
      ended_at: endedAt,
      duration_ms: _runStartedAt
        ? new Date(endedAt).getTime() - new Date(_runStartedAt).getTime()
        : undefined,
      status: failed.length > 0 ? "error" : "ok",
      trigger: "manual",
      error_message: failed.length > 0
        ? failed.map((f) => `${f.id}: ${f.error}`).join("; ")
        : undefined,
    },
  }).catch((e) => console.warn("append_run failed:", e));

  return { ran, skipped, failed };
}
