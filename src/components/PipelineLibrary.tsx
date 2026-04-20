import { useEffect, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invokeCmd, listenEvent } from "../lib/tauri";
import { useGraph } from "../lib/graph-store";
import { alertDialog, confirmDialog } from "../lib/dialogs";
import SkillExportModal from "./SkillExportModal";

type Props = {
  onLoad: (name: string) => void;
  onSchedule: (name: string) => void;
  scheduledNames: Set<string>;
};

export default function PipelineLibrary({
  onLoad,
  onSchedule,
  scheduledNames,
}: Props) {
  const activeName = useGraph((s) => s.activePipelineName);
  const setActivePipelineName = useGraph((s) => s.setActivePipelineName);
  const [templates, setTemplates] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [skillExportFor, setSkillExportFor] = useState<string | null>(null);

  async function exportToFile(name: string) {
    try {
      const raw = await invokeCmd<string>("load_template", { name });
      const dest = await saveDialog({
        defaultPath: `${name}.json`,
        filters: [{ name: "Pipeline JSON", extensions: ["json"] }],
        title: "Export pipeline as JSON",
      });
      if (!dest) return;
      await invokeCmd("write_output_file", { path: dest, content: raw });
    } catch (e) {
      await alertDialog(`Export failed: ${e}`);
    }
  }

  async function runSkillExport(name: string, targetDir: string) {
    try {
      const dir = await invokeCmd<string>("export_pipeline_as_skill", {
        name,
        targetDir,
      });
      const slug = dir.split("/").filter(Boolean).pop() ?? name;
      const isGlobalOrProject = /\/\.claude\/skills\//.test(dir + "/");
      const hint = isGlobalOrProject
        ? `Invoke with \`/${slug}\` in any Claude Code conversation${
            targetDir.includes("/.claude/skills") &&
            !targetDir.startsWith("~")
              ? ` run inside that project`
              : ``
          }.`
        : `Not in a .claude/skills dir, so Claude won't auto-discover it. Move the folder into \`~/.claude/skills/\` or a project's \`.claude/skills/\` to activate.`;
      await alertDialog(
        `✓ Exported as Claude skill\n\n${dir}\n\n${hint}`,
        "Skill exported"
      );
    } catch (e) {
      await alertDialog(`Skill export failed: ${e}`);
    }
  }

  async function refresh() {
    try {
      const list = await invokeCmd<string[]>("list_templates");
      setTemplates(list);
      // If the active pipeline name no longer exists in this project,
      // clear it so the toolbar pill doesn't show a stale name.
      const current = useGraph.getState().activePipelineName;
      if (current && !list.includes(current)) {
        setActivePipelineName(null);
      }
    } catch (e) {
      console.warn("list_templates failed:", e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | null = null;
    listenEvent("templates:changed", () => refresh()).then(
      (fn) => (unlisten = fn)
    );
    return () => unlisten?.();
  }, []);

  if (collapsed) {
    return (
      <div className="pipeline-lib pipeline-lib--collapsed">
        <button
          className="sidebar__toggle"
          onClick={() => setCollapsed(false)}
          title="Show pipelines"
        >
          »
        </button>
      </div>
    );
  }

  return (
    <>
    <div className="pipeline-lib">
      <div className="sidebar__header">
        <span className="sidebar__title">Pipelines</span>
        <div style={{ display: "flex", gap: 2 }}>
          <button
            className="sidebar__toggle"
            onClick={refresh}
            title="Refresh"
          >
            ↻
          </button>
          <button
            className="sidebar__toggle"
            onClick={() => setCollapsed(true)}
            title="Hide"
          >
            «
          </button>
        </div>
      </div>
      {loading && <div className="sidebar__status">loading…</div>}
      {!loading && templates.length === 0 && (
        <div className="sidebar__status">
          No saved pipelines. Composite skills now live in{" "}
          <code>~/.claude/skills/</code> as <code>SKILL.md</code>.
        </div>
      )}
      <div className="sidebar__list">
        {templates.map((name) => {
          const isActive = name === activeName;
          return (
            <div
              key={name}
              className={
                "pipeline-lib__item" +
                (isActive ? " pipeline-lib__item--active" : "")
              }
              onClick={() => onLoad(name)}
              title={`Load "${name}"`}
            >
              <span className="pipeline-lib__icon">{isActive ? "●" : "▸"}</span>
              <span className="pipeline-lib__name">{name}</span>
              <button
                className="pipeline-lib__schedule"
                title={`Export "${name}" as Claude Code skill`}
                onClick={(e) => {
                  e.stopPropagation();
                  setSkillExportFor(name);
                }}
              >
                🎯
              </button>
              <button
                className="pipeline-lib__schedule"
                title={`Export "${name}" to a JSON file`}
                onClick={(e) => {
                  e.stopPropagation();
                  exportToFile(name);
                }}
              >
                ⬇
              </button>
              <button
                className={
                  "pipeline-lib__schedule" +
                  (scheduledNames.has(name)
                    ? " pipeline-lib__schedule--on"
                    : "")
                }
                title={
                  scheduledNames.has(name)
                    ? `Edit schedule for "${name}"`
                    : `Add schedule for "${name}"`
                }
                onClick={(e) => {
                  e.stopPropagation();
                  onSchedule(name);
                }}
              >
                ⏰
              </button>
              <button
                className="pipeline-lib__delete"
                title={`Delete "${name}"`}
                onClick={async (e) => {
                  e.stopPropagation();
                  const ok = await confirmDialog(
                    `Delete pipeline "${name}"? This cannot be undone.`,
                    {
                      title: "Delete pipeline",
                      okLabel: "Delete",
                      cancelLabel: "Cancel",
                    }
                  );
                  if (!ok) return;
                  try {
                    await invokeCmd("delete_template", { name });
                    // Clear active pointer if we just deleted the active one.
                    if (useGraph.getState().activePipelineName === name) {
                      setActivePipelineName(null);
                    }
                    // templates:changed event will refresh the list.
                  } catch (err) {
                    await alertDialog(`Delete failed: ${err}`);
                  }
                }}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </div>
    {skillExportFor && (
      <SkillExportModal
        pipelineName={skillExportFor}
        onCancel={() => setSkillExportFor(null)}
        onConfirm={(targetDir) => {
          const n = skillExportFor;
          setSkillExportFor(null);
          if (n) runSkillExport(n, targetDir);
        }}
      />
    )}
    </>
  );
}
