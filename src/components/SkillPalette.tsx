import { useEffect, useState } from "react";
import { useSkills, initSkillsWatcher, type SkillMeta } from "../lib/skills";
import { useGraph, type OrkaNode } from "../lib/graph-store";
import { invokeCmd } from "../lib/tauri";
import { confirmDialog } from "../lib/dialogs";
import type { Edge } from "@xyflow/react";

export default function SkillPalette() {
  const skills = useSkills((s) => s.skills);
  const loading = useSkills((s) => s.loading);
  const refresh = useSkills((s) => s.refresh);
  const [filter, setFilter] = useState("");
  const addSkillRefNode = useGraph((s) => s.addSkillRefNode);
  const setGraph = useGraph((s) => s.setGraph);

  useEffect(() => {
    initSkillsWatcher();
  }, []);

  async function handleClick(s: SkillMeta) {
    if (!s.has_graph) {
      addSkillRefNode(s.slug);
      return;
    }

    // Composite skill expansion replaces the entire canvas. If there are any
    // unsaved nodes, require explicit confirmation so a misclick doesn't
    // destroy work.
    const existing = useGraph.getState().nodes;
    if (existing.length > 0) {
      const ok = await confirmDialog(
        `Loading "${s.slug}" will replace your current canvas (${existing.length} node${existing.length === 1 ? "" : "s"}). Continue?`,
        { title: "Replace canvas?" }
      );
      if (!ok) return;
    }

    // Composite skill — load graph and expand onto canvas
    try {
      const raw = await invokeCmd<string>("load_skill_md", { path: s.path });
      const parsed = JSON.parse(raw);
      const graphData = parsed.graph;
      if (!graphData || !graphData.nodes) {
        addSkillRefNode(s.slug);
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
            data: {
              skill: n.data?.skill ?? "",
              bind: n.data?.bind ?? {},
            },
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
        if (n.type === "output") {
          return {
            id: n.id,
            type: "output" as const,
            position: pos,
            data: {
              destination: n.data?.destination ?? "local",
              filename: n.data?.filename ?? "output.md",
              dir: n.data?.dir ?? "",
              format: n.data?.format ?? "markdown",
              mergeMode: n.data?.mergeMode ?? "concat",
              template: n.data?.template ?? "",
              overwrite: n.data?.overwrite ?? false,
              notesTitle: n.data?.notesTitle,
              webhookUrl: n.data?.webhookUrl,
              shellCommand: n.data?.shellCommand,
            },
          };
        }
        if (n.type === "kb") {
          return {
            id: n.id,
            type: "kb" as const,
            position: pos,
            data: {
              source: n.data?.source ?? "folder",
              files: n.data?.files ?? [],
              dir: n.data?.dir ?? "",
            },
          };
        }
        // Fallback: treat as agent
        return {
          id: n.id,
          type: "agent" as const,
          position: pos,
          data: {
            prompt: n.data?.prompt ?? "",
            output: "",
            running: false,
          },
        };
      });

      const edges: Edge[] = (graphData.edges ?? []).map(
        (e: [string, string]) => ({
          id: `e-${e[0]}-${e[1]}`,
          source: e[0],
          target: e[1],
        })
      );

      setGraph(nodes, edges);
    } catch (e) {
      console.warn("Failed to load composite skill:", e);
      addSkillRefNode(s.slug);
    }
  }

  const filtered = filter.trim()
    ? skills.filter(
        (s) =>
          s.slug.includes(filter.toLowerCase()) ||
          s.description.toLowerCase().includes(filter.toLowerCase())
      )
    : skills;

  return (
    <div className="skill-palette">
      <div className="sidebar__header">
        <span className="sidebar__title">Skills</span>
        <button className="sidebar__toggle" onClick={refresh} title="Refresh">
          ↻
        </button>
      </div>
      <div className="skill-palette__search">
        <input
          className="skill-palette__search-input"
          placeholder="Filter skills…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {loading && <div className="sidebar__status">loading…</div>}
      {!loading && filtered.length === 0 && (
        <div className="sidebar__status">
          {skills.length === 0
            ? "No skills found in ~/.claude/skills/"
            : "No matches"}
        </div>
      )}
      <div className="sidebar__list">
        {filtered.map((s) => (
          <div
            key={s.slug}
            className="skill-palette__item"
            title={
              s.has_graph
                ? `Click to load "${s.slug}" as pipeline`
                : s.description
            }
            onClick={() => handleClick(s)}
          >
            <span className="skill-palette__icon">
              {s.has_graph ? "◆" : "◇"}
            </span>
            <div className="skill-palette__info">
              <div className="skill-palette__slug">
                {s.slug}
                {s.has_graph && (
                  <span className="skill-palette__composite-tag">pipeline</span>
                )}
              </div>
              <div className="skill-palette__desc">
                {s.description.slice(0, 80)}
                {s.description.length > 80 ? "…" : ""}
              </div>
            </div>
            <span className="skill-palette__source">{s.source}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
