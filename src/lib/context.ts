import type { Edge } from "@xyflow/react";
import type { OrkaNode } from "./graph-store";

/** Context prefix text + directories the downstream node should be granted tool access to. */
export type BuiltContext = { text: string; addDirs: string[] };

export function buildContext(
  targetId: string,
  nodes: OrkaNode[],
  edges: Edge[]
): BuiltContext {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push(e.source);
  }

  const visited = new Set<string>();
  const chunks: string[] = [];
  const addDirs: string[] = [];

  function walk(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const parents = incoming.get(id) ?? [];
    // Depth-first: collect from deepest ancestor forward.
    for (const p of parents) walk(p);
    if (id === targetId) return;
    const node = byId.get(id);
    if (!node) return;
    if (node.type === "chat" || node.type === "agent") {
      const out = (node.data as any).output;
      if (out && out.trim()) {
        chunks.push(`[from ${node.type} node ${id}]\n${out.trim()}`);
      }
    } else if (node.type === "pipeline_ref") {
      const out = (node.data as any).output;
      const subName = (node.data as any).pipelineName ?? "?";
      if (out && out.trim()) {
        chunks.push(`[from sub-pipeline ${subName} (node ${id})]\n${out.trim()}`);
      }
    } else if (node.type === "kb") {
      const source: string = (node.data as any).source ?? "folder";
      if (source === "folder") {
        const files: string[] = (node.data as any).files ?? [];
        const dir: string = (node.data as any).dir ?? "";
        if (dir && !addDirs.includes(dir)) addDirs.push(dir);
        if (files.length > 0) {
          chunks.push(
            `[input node ${id} — folder]\nFiles available at ${dir}:\n${files
              .map((f) => `- ${f}`)
              .join("\n")}`
          );
        }
      } else if (source === "url") {
        const fetched: string = (node.data as any).fetchedContent ?? "";
        if (fetched.trim()) {
          chunks.push(`[input node ${id} — url]\n${fetched.trim()}`);
        }
      } else if (source === "clipboard") {
        chunks.push(`[input node ${id} — clipboard]\n(clipboard content will be injected at runtime)`);
      } else if (source === "text") {
        const text: string = (node.data as any).manualText ?? "";
        if (text.trim()) {
          chunks.push(`[input node ${id} — text]\n${text.trim()}`);
        }
      }
    }
  }

  walk(targetId);
  return { text: chunks.join("\n\n---\n\n"), addDirs };
}

export function composePrompt(context: string, prompt: string): string {
  if (!context.trim()) return prompt;
  return `Context from upstream nodes:\n\n${context}\n\n---\n\nTask:\n${prompt}`;
}
