import { useEffect, useState } from "react";
import { invokeCmd, listenEvent } from "../lib/tauri";
import { useGraph } from "../lib/graph-store";
import { alertDialog, confirmDialog } from "../lib/dialogs";

type Props = {
  onLoad: (name: string) => void;
  onSaveCurrent: () => void;
  onNew: () => void;
};

export default function PipelineLibrary({ onLoad, onSaveCurrent, onNew }: Props) {
  const activeName = useGraph((s) => s.activePipelineName);
  const setActivePipelineName = useGraph((s) => s.setActivePipelineName);
  const [templates, setTemplates] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);

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
  );
}
