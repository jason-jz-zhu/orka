import { useEffect, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { invokeCmd } from "../lib/tauri";
import { useGraph, type OrkaNode } from "../lib/graph-store";

type Props = NodeProps<Extract<OrkaNode, { type: "pipeline_ref" }>>;

type PipelineSummary = {
  name: string;
  inputs: { name: string; default?: string; description?: string }[];
};

export default function PipelineRefNode({ id, data }: Props) {
  const update = useGraph((s) => s.updateNodeData);
  const [available, setAvailable] = useState<string[]>([]);
  const [picked, setPicked] = useState<PipelineSummary | null>(null);

  // List of saved pipelines.
  useEffect(() => {
    invokeCmd<string[]>("list_templates")
      .then(setAvailable)
      .catch(() => {});
  }, []);

  // Load the picked pipeline's metadata to know its declared inputs.
  useEffect(() => {
    if (!data.pipelineName) {
      setPicked(null);
      return;
    }
    invokeCmd<string>("load_template", { name: data.pipelineName })
      .then((raw) => {
        try {
          const parsed = JSON.parse(raw);
          setPicked({
            name: data.pipelineName,
            inputs: Array.isArray(parsed.inputs) ? parsed.inputs : [],
          });
        } catch {
          setPicked({ name: data.pipelineName, inputs: [] });
        }
      })
      .catch(() => setPicked({ name: data.pipelineName, inputs: [] }));
  }, [data.pipelineName]);

  function setBinding(name: string, value: string) {
    update(id, {
      inputBindings: { ...(data.inputBindings ?? {}), [name]: value },
    });
  }

  return (
    <div className="pipe-ref-node">
      <Handle type="target" position={Position.Left} />
      <div className="pipe-ref-node__header">
        PIPELINE · {id}
        {data.running && (
          <span className="pipe-ref-node__badge">⋯ running</span>
        )}
      </div>

      <div className="pipe-ref-node__row">
        <label className="pipe-ref-node__label">pipeline</label>
        <select
          className="pipe-ref-node__input nodrag"
          value={data.pipelineName}
          onChange={(e) => update(id, { pipelineName: e.target.value })}
        >
          <option value="">— pick a saved pipeline —</option>
          {available.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>

      {picked && picked.inputs.length > 0 && (
        <div className="pipe-ref-node__inputs">
          <div className="pipe-ref-node__inputs-title">inputs</div>
          {picked.inputs.map((inp) => (
            <div key={inp.name} className="pipe-ref-node__row">
              <label
                className="pipe-ref-node__label"
                title={inp.description ?? ""}
              >
                {inp.name}
              </label>
              <input
                className="pipe-ref-node__input nodrag"
                value={
                  data.inputBindings?.[inp.name] ?? inp.default ?? ""
                }
                onChange={(e) => setBinding(inp.name, e.target.value)}
              />
            </div>
          ))}
        </div>
      )}

      {data.lastError && (
        <div className="pipe-ref-node__err">✗ {data.lastError}</div>
      )}
      {data.output && !data.running && (
        <div className="pipe-ref-node__output">
          <div className="pipe-ref-node__output-label">last output</div>
          <pre className="nowheel">{data.output.slice(0, 600)}{data.output.length > 600 ? "…" : ""}</pre>
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
