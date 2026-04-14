import { useEffect, useRef } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { open } from "@tauri-apps/plugin-dialog";
import { invokeCmd, inTauri } from "../lib/tauri";
import { useGraph, type OrkaNode } from "../lib/graph-store";

type Props = NodeProps<Extract<OrkaNode, { type: "kb" }>>;

export default function KnowledgeBaseNode({ id, data }: Props) {
  const update = useGraph((s) => s.updateNodeData);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const dir = await invokeCmd<string>("kb_dir", { id });
        const files = await invokeCmd<string[]>("kb_list", { id });
        update(id, { dir, files });
      } catch (e) {
        console.warn("kb init failed:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function mergeFiles(names: string[]) {
    if (!names.length) return;
    const merged = Array.from(new Set([...(data.files ?? []), ...names]));
    update(id, { files: merged });
  }

  async function addFiles() {
    if (inTauri) {
      const sel = await open({ multiple: true, directory: false });
      if (!sel) return;
      const picked = Array.isArray(sel) ? sel : [sel];
      const added: string[] = [];
      for (const src of picked) {
        try {
          const name = await invokeCmd<string>("kb_ingest", { id, src });
          added.push(name);
        } catch (e) {
          console.warn("kb_ingest failed:", e);
        }
      }
      mergeFiles(added);
    } else {
      fileInputRef.current?.click();
    }
  }

  async function addFolder() {
    if (inTauri) {
      const sel = await open({ multiple: false, directory: true });
      if (!sel) return;
      const src = Array.isArray(sel) ? sel[0] : sel;
      try {
        const added = await invokeCmd<string[]>("kb_ingest_dir", { id, src });
        mergeFiles(added);
      } catch (e) {
        console.warn("kb_ingest_dir failed:", e);
      }
    } else {
      folderInputRef.current?.click();
    }
  }

  function onBrowserFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    // For folder input, include the relative webkitRelativePath if present.
    const names = files.map(
      (f) => (f as any).webkitRelativePath || f.name
    );
    mergeFiles(names);
    e.target.value = "";
  }

  return (
    <div className="kb-node">
      <Handle type="target" position={Position.Left} />
      <div className="chat-node__header">KB · {id}</div>
      <div className="kb-node__dir" title={data.dir}>
        {data.dir || "(initializing…)"}
      </div>
      <div className="kb-node__actions">
        <button className="chat-node__run" onClick={addFiles}>
          + Files
        </button>
        <button className="chat-node__run" onClick={addFolder}>
          + Folder
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={onBrowserFilesPicked}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        {...({ webkitdirectory: "", directory: "" } as any)}
        style={{ display: "none" }}
        onChange={onBrowserFilesPicked}
      />
      <div className="kb-node__files">
        {data.files.length === 0 && <em>no sources yet</em>}
        {data.files.map((f) => (
          <div key={f} className="kb-node__file" title={f}>
            · {f}
          </div>
        ))}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
