import { useEffect, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invokeCmd } from "../lib/tauri";
import { useGraph, type OrkaNode } from "../lib/graph-store";
import { alertDialog } from "../lib/dialogs";

type Props = NodeProps<Extract<OrkaNode, { type: "output" }>>;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString();
}

export default function OutputNode({ id, data }: Props) {
  const update = useGraph((s) => s.updateNodeData);
  const [defaultDir, setDefaultDir] = useState<string>("");

  // Resolve default outputs dir once for the placeholder so the user knows
  // where things land if they leave `dir` blank.
  useEffect(() => {
    invokeCmd<string>("outputs_dir")
      .then((d) => setDefaultDir(d))
      .catch(() => {});
  }, []);

  async function pickDir() {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Select output directory",
    });
    if (typeof picked === "string") update(id, { dir: picked });
  }

  async function reveal() {
    if (!data.lastWrittenPath) return;
    try {
      await revealItemInDir(data.lastWrittenPath);
    } catch (e) {
      console.warn("revealItemInDir failed:", e);
    }
  }

  async function openFile() {
    if (!data.lastWrittenPath) return;
    try {
      await openPath(data.lastWrittenPath);
    } catch (e) {
      await alertDialog(`Open failed: ${e}`);
    }
  }

  return (
    <div className="output-node">
      <Handle type="target" position={Position.Left} />
      <div className="output-node__header">
        OUTPUT · {id}
      </div>

      <div className="output-node__row">
        <label className="output-node__label">filename</label>
        <input
          className="output-node__input nodrag"
          value={data.filename}
          onChange={(e) => update(id, { filename: e.target.value })}
          placeholder="report.md"
        />
      </div>

      <div className="output-node__row">
        <label className="output-node__label">dir</label>
        <input
          className="output-node__input nodrag"
          value={data.dir}
          onChange={(e) => update(id, { dir: e.target.value })}
          placeholder={defaultDir || "~/OrkaCanvas/<project>/outputs/"}
          title={data.dir || defaultDir}
        />
        <button className="output-node__pick" onClick={pickDir}>
          …
        </button>
      </div>

      <div className="output-node__row">
        <label className="output-node__label">format</label>
        <select
          className="output-node__input nodrag"
          value={data.format}
          onChange={(e) => update(id, { format: e.target.value })}
        >
          <option value="markdown">markdown</option>
          <option value="json">json</option>
          <option value="text">text</option>
        </select>
        <label className="output-node__label">merge</label>
        <select
          className="output-node__input nodrag"
          value={data.mergeMode}
          onChange={(e) => update(id, { mergeMode: e.target.value })}
        >
          <option value="concat">concat</option>
          <option value="list">list</option>
          <option value="json">json</option>
        </select>
      </div>

      <div className="output-node__row">
        <label className="output-node__check">
          <input
            type="checkbox"
            checked={data.overwrite}
            onChange={(e) => update(id, { overwrite: e.target.checked })}
          />
          overwrite (off = append timestamp)
        </label>
      </div>

      {data.running && (
        <div className="output-node__status output-node__status--running">
          ⋯ writing…
        </div>
      )}
      {data.lastError && (
        <div className="output-node__status output-node__status--err">
          ✗ {data.lastError}
        </div>
      )}
      {data.lastWrittenPath && !data.lastError && (
        <div className="output-node__written">
          <div className="output-node__written-row">
            <span className="output-node__written-icon">✓</span>
            <span
              className="output-node__written-path"
              title={data.lastWrittenPath}
            >
              {data.lastWrittenPath}
            </span>
          </div>
          <div className="output-node__written-meta">
            written {data.lastWrittenAt ? fmtTime(data.lastWrittenAt) : ""}
          </div>
          <div className="output-node__written-actions">
            <button onClick={reveal}>Reveal in Finder</button>
            <button onClick={openFile}>Open</button>
          </div>
        </div>
      )}
    </div>
  );
}
