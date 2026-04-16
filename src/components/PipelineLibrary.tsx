import { useEffect, useState } from "react";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { invokeCmd, listenEvent } from "../lib/tauri";
import { useGraph } from "../lib/graph-store";
import { alertDialog, confirmDialog, promptDialog } from "../lib/dialogs";
import SkillExportModal from "./SkillExportModal";

type Props = {
  onLoad: (name: string) => void;
  onSaveCurrent: () => void;
  onNew: () => void;
  onGenerate: () => void;
  onSchedule: (name: string) => void;
  scheduledNames: Set<string>;
};

export default function PipelineLibrary({
  onLoad,
  onSaveCurrent,
  onNew,
  onGenerate,
  onSchedule,
  scheduledNames,
}: Props) {
  const activeName = useGraph((s) => s.activePipelineName);
  const setActivePipelineName = useGraph((s) => s.setActivePipelineName);
  const [templates, setTemplates] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [skillExportFor, setSkillExportFor] = useState<string | null>(null);

  async function importFromFile() {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Pipeline JSON", extensions: ["json"] }],
      title: "Import pipeline JSON",
    });
    if (typeof picked !== "string") return;
    try {
      const text = await invokeCmd<string>("read_file_text", { path: picked });
      await importJsonText(text);
    } catch (e) {
      await alertDialog(`Import failed: ${e}`);
    }
  }

  async function importFromUrl() {
    const url = await promptDialog(
      "URL to a pipeline JSON (e.g. raw GitHub gist)",
      { title: "Import from URL" }
    );
    if (!url) return;
    try {
      const text = await invokeCmd<string>("fetch_text_url", { url });
      await importJsonText(text);
    } catch (e) {
      await alertDialog(`Fetch failed: ${e}`);
    }
  }

  async function importJsonText(text: string) {
    let parsed: { name?: string; nodes?: unknown; edges?: unknown };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("not valid JSON");
    }
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      throw new Error("missing 'nodes' or 'edges' array");
    }
    let name =
      typeof parsed.name === "string" && parsed.name.trim()
        ? parsed.name.trim()
        : null;
    if (!name) {
      name =
        (await promptDialog("Save imported pipeline as:", {
          title: "Imported pipeline name",
        })) ?? null;
      if (!name) return;
    }
    await invokeCmd("save_template", { name, content: text });
    await refresh();
  }

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
      <div className="pipeline-lib__actions">
        <button
          className="pipeline-lib__new"
          onClick={onNew}
          title="Start a new blank pipeline"
        >
          + New
        </button>
        <button
          className="pipeline-lib__save"
          onClick={onSaveCurrent}
          title="Save current graph as a new template"
        >
          + Save
        </button>
      </div>
      <div className="pipeline-lib__generate-row">
        <button
          className="pipeline-lib__generate"
          onClick={onGenerate}
          title="Describe what you want — Claude designs the pipeline"
        >
          ✨ Generate from prompt
        </button>
      </div>
      <div className="pipeline-lib__io-row">
        <button
          className="pipeline-lib__io-btn"
          onClick={importFromFile}
          title="Import a pipeline JSON from disk"
        >
          ⬆ Import
        </button>
        <button
          className="pipeline-lib__io-btn"
          onClick={importFromUrl}
          title="Import a pipeline from a public URL (e.g. raw GitHub gist)"
        >
          🌐 URL
        </button>
      </div>
      {loading && <div className="sidebar__status">loading…</div>}
      {!loading && templates.length === 0 && (
        <div className="sidebar__status">(no templates yet)</div>
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
