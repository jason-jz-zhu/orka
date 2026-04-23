import { useEffect, useRef, useState } from "react";
import { invokeCmd } from "../lib/tauri";
import { alertDialog, confirmDialog, promptDialog } from "../lib/dialogs";

type WorkspaceInfo = {
  name: string;
  active: boolean;
  modified_ms: number;
};

export default function WorkspaceSwitcher() {
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [active, setActive] = useState<string>("default");
  const ref = useRef<HTMLDivElement>(null);

  async function refresh() {
    try {
      const list = await invokeCmd<WorkspaceInfo[]>("list_workspaces");
      setWorkspaces(list);
      const a = list.find((w) => w.active);
      if (a) setActive(a.name);
    } catch (e) {
      console.warn("list_workspaces failed:", e);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    if (open) window.addEventListener("mousedown", onClickOutside);
    return () => window.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  async function pick(name: string) {
    if (name === active) {
      setOpen(false);
      return;
    }
    await invokeCmd("switch_workspace", { name });
    setOpen(false);
    // Full reload so persistence layer reads the newly-active workspace's graph.json.
    window.location.reload();
  }

  async function createNew() {
    const name = await promptDialog("New project name:", { title: "New project" });
    if (!name) return;
    try {
      await invokeCmd("create_workspace", { name });
      await invokeCmd("switch_workspace", { name });
      window.location.reload();
    } catch (e) {
      await alertDialog(`Create failed: ${e}`);
    }
  }

  async function renameThis() {
    const to = await promptDialog(`Rename project "${active}" to:`, {
      default: active,
      title: "Rename project",
    });
    if (!to || to === active) return;
    try {
      await invokeCmd("rename_workspace", { from: active, to });
      window.location.reload();
    } catch (e) {
      await alertDialog(`Rename failed: ${e}`);
    }
  }

  async function duplicateThis() {
    const to = await promptDialog(`Duplicate project "${active}" as:`, {
      default: `${active}-copy`,
      title: "Duplicate project",
    });
    if (!to) return;
    try {
      await invokeCmd("duplicate_workspace", { from: active, to });
      await invokeCmd("switch_workspace", { name: to });
      window.location.reload();
    } catch (e) {
      await alertDialog(`Duplicate failed: ${e}`);
    }
  }

  async function deleteThis() {
    const ok = await confirmDialog(
      `Delete project "${active}" and all its nodes, pipelines, and KB? This cannot be undone.`,
      { title: "Delete project", okLabel: "Delete", cancelLabel: "Cancel" }
    );
    if (!ok) return;
    try {
      await invokeCmd("delete_workspace", { name: active });
      window.location.reload();
    } catch (e) {
      await alertDialog(`Delete failed: ${e}`);
    }
  }

  // Single-workspace users get no value from the switcher chrome — the
  // menu's only useful action then is "+ New project", which belongs in
  // Settings anyway. Render nothing on the solo case; re-appears the
  // instant a second workspace exists. Includes its own trailing
  // toolbar divider so the App-level layout doesn't leave an orphaned
  // separator when this component returns null.
  if (workspaces.length < 2) {
    return null;
  }

  return (
    <>
    <div className="ws" ref={ref}>
      <button className="ws__button" onClick={() => setOpen((v) => !v)}>
        <span className="ws__name">{active}</span> ▾
      </button>
      {open && (
        <div className="ws__menu">
          <div className="ws__menu-section-label">Switch project</div>
          {workspaces.map((w) => (
            <button
              key={w.name}
              className={
                "ws__menu-item" + (w.active ? " ws__menu-item--active" : "")
              }
              onClick={() => pick(w.name)}
            >
              {w.active ? "● " : "  "}
              {w.name}
            </button>
          ))}
          <div className="ws__menu-divider" />
          <button className="ws__menu-item" onClick={createNew}>
            + New project
          </button>
          <button className="ws__menu-item" onClick={duplicateThis}>
            Duplicate "{active}"
          </button>
          <button className="ws__menu-item" onClick={renameThis}>
            Rename "{active}"
          </button>
          <button
            className="ws__menu-item ws__menu-item--danger"
            onClick={deleteThis}
          >
            Delete "{active}"
          </button>
        </div>
      )}
    </div>
    <div className="toolbar__divider" />
    </>
  );
}
