import { useEffect, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useGraph, type OrkaNode } from "../lib/graph-store";
import { useSkills, type SkillMeta } from "../lib/skills";
import { invokeCmd } from "../lib/tauri";

type Props = NodeProps<Extract<OrkaNode, { type: "skill_ref" }>>;

export default function SkillRefNode({ id, data }: Props) {
  const update = useGraph((s) => s.updateNodeData);
  const skills = useSkills((s) => s.skills);
  const [picked, setPicked] = useState<SkillMeta | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [sourceContent, setSourceContent] = useState("");

  useEffect(() => {
    if (!data.skill) {
      setPicked(null);
      return;
    }
    const found = skills.find((s) => s.slug === data.skill);
    setPicked(found ?? null);
  }, [data.skill, skills]);

  function setBind(name: string, value: string) {
    update(id, { bind: { ...(data.bind ?? {}), [name]: value } });
  }

  return (
    <div className="skill-ref-node">
      <Handle type="target" position={Position.Left} />
      <div className="skill-ref-node__header">
        SKILL · {id}
        {data.running && (
          <span className="skill-ref-node__badge">⋯ running</span>
        )}
        {data.output && !data.running && !data.lastError && (
          <span className="skill-ref-node__badge skill-ref-node__badge--done">
            ✓ done
          </span>
        )}
        {data.lastError && (
          <span className="skill-ref-node__badge skill-ref-node__badge--err">
            ✗ error
          </span>
        )}
      </div>

      <div className="skill-ref-node__row">
        <label className="skill-ref-node__label">skill</label>
        <select
          className="skill-ref-node__input nodrag"
          value={data.skill}
          onChange={(e) => update(id, { skill: e.target.value })}
        >
          <option value="">— pick a skill —</option>
          {data.skill && !skills.find((s) => s.slug === data.skill) && (
            <option key={data.skill} value={data.skill}>
              {data.skill} (local)
            </option>
          )}
          {skills.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.slug}
            </option>
          ))}
        </select>
      </div>

      {!picked && data.skill && (
        <div className="skill-ref-node__desc">
          Sub-skill: <strong>{data.skill}</strong>
          {data.bind && Object.keys(data.bind).length > 0 && (
            <div className="skill-ref-node__bindings">
              <div className="skill-ref-node__bindings-title">bindings</div>
              {Object.entries(data.bind).map(([k, v]) => (
                <div key={k} className="skill-ref-node__row">
                  <label className="skill-ref-node__label">{k}</label>
                  <input
                    className="skill-ref-node__input nodrag"
                    value={v}
                    onChange={(e) => setBind(k, e.target.value)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {picked && (
        <div className="skill-ref-node__desc">
          {picked.description}
          <button
            className="skill-ref-node__view-btn nodrag"
            onClick={async () => {
              try {
                const text = await invokeCmd<string>("read_file_text", {
                  path: picked.path,
                });
                setSourceContent(text);
                setShowSource(true);
              } catch (e) {
                setSourceContent(`Failed to read: ${e}`);
                setShowSource(true);
              }
            }}
          >
            View SKILL.md
          </button>
        </div>
      )}

      {showSource && (
        <div className="skill-ref-node__source nodrag nowheel">
          <div className="skill-ref-node__source-header">
            <span>SKILL.md</span>
            <button onClick={() => setShowSource(false)}>Close</button>
          </div>
          <pre className="skill-ref-node__source-code nowheel">
            {sourceContent}
          </pre>
        </div>
      )}

      {picked && picked.inputs.length > 0 && (
        <div className="skill-ref-node__bindings">
          <div className="skill-ref-node__bindings-title">inputs</div>
          {picked.inputs.map((inp) => (
            <div key={inp.name} className="skill-ref-node__row">
              <label
                className="skill-ref-node__label"
                title={inp.description ?? ""}
              >
                {inp.name}
              </label>
              <input
                className="skill-ref-node__input nodrag"
                placeholder={inp.default ?? ""}
                value={data.bind?.[inp.name] ?? ""}
                onChange={(e) => setBind(inp.name, e.target.value)}
              />
            </div>
          ))}
        </div>
      )}

      {data.lastError && (
        <div className="skill-ref-node__err">✗ {data.lastError}</div>
      )}
      {data.output && !data.running && (
        <div className="skill-ref-node__output">
          <div className="skill-ref-node__output-label">last output</div>
          <pre className="nowheel">
            {data.output.slice(0, 600)}
            {data.output.length > 600 ? "…" : ""}
          </pre>
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
