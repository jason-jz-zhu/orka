import { useState } from "react";
import { invokeCmd } from "../lib/tauri";
import { confirmDialog } from "../lib/dialogs";
import { useGraph, type OrkaNode } from "../lib/graph-store";
import type { Edge } from "@xyflow/react";

type GenNode = {
  id: string;
  type: "chat" | "agent" | "kb";
  position: { x: number; y: number };
  data: Record<string, unknown>;
};

type GenEdge = { source: string; target: string };

type GenerateResult = {
  pipeline: { nodes: GenNode[]; edges: GenEdge[] };
  raw: string;
};

type Stage = "input" | "generating" | "preview" | "error";

type Props = {
  onClose: () => void;
  onApplied: () => void;
};

const EXAMPLES = [
  "Draft 5 tweets announcing my product and pick the best 2",
  "Research top 3 open-source vector databases and write a blog post",
  "Summarize my ~/Documents/notes folder into 10 bullet points",
  "Review my latest PR and suggest 3 improvements",
];

export default function GeneratePipelineModal({ onClose, onApplied }: Props) {
  const [stage, setStage] = useState<Stage>("input");
  const [requirement, setRequirement] = useState("");
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setGraph = useGraph((s) => s.setGraph);
  const setActivePipelineName = useGraph((s) => s.setActivePipelineName);
  const currentNodeCount = useGraph((s) => s.nodes.length);

  async function generate() {
    const req = requirement.trim();
    if (!req) return;
    setStage("generating");
    setError(null);
    try {
      const r = await invokeCmd<GenerateResult>("generate_pipeline", {
        requirement: req,
      });
      setResult(r);
      setStage("preview");
    } catch (e) {
      setError(String(e));
      setStage("error");
    }
  }

  async function apply() {
    if (!result) return;
    if (currentNodeCount > 0) {
      const ok = await confirmDialog(
        `Replace the current canvas with ${result.pipeline.nodes.length} generated nodes?`,
        { title: "Apply pipeline", okLabel: "Replace", cancelLabel: "Cancel" }
      );
      if (!ok) return;
    }
    // Hydrate generated nodes with runtime-default fields so the canvas
    // renders them correctly.
    const hydrated: OrkaNode[] = result.pipeline.nodes.map((n) => {
      if (n.type === "chat" || n.type === "agent") {
        const prompt = (n.data.prompt as string) ?? "";
        return {
          id: n.id,
          type: n.type,
          position: n.position,
          data: { prompt, output: "", running: false },
        } as OrkaNode;
      }
      // kb
      const files = Array.isArray(n.data.files) ? (n.data.files as string[]) : [];
      const dir = typeof n.data.dir === "string" ? n.data.dir : "";
      return {
        id: n.id,
        type: "kb",
        position: n.position,
        data: { files, dir },
      } as OrkaNode;
    });
    const edges: Edge[] = result.pipeline.edges.map((e) => ({
      id: `e-${e.source}-${e.target}`,
      source: e.source,
      target: e.target,
    }));
    setGraph(hydrated, edges);
    setActivePipelineName(null);
    onApplied();
  }

  return (
    <div className="gen__overlay">
      <div className="gen__box">
        <div className="gen__title">✨ Generate Pipeline</div>

        {stage === "input" && (
          <>
            <div className="gen__hint">
              Describe what you want to automate. Orka will design a pipeline of
              Chat / Agent / Knowledge-Base nodes and drop it onto the canvas.
            </div>
            <textarea
              className="gen__textarea"
              placeholder="e.g. Research my top 3 competitors and write a sales pitch"
              value={requirement}
              onChange={(e) => setRequirement(e.target.value)}
              rows={4}
              autoFocus
            />
            <div className="gen__examples-label">💡 Try one of these:</div>
            <div className="gen__examples">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  className="gen__example"
                  onClick={() => setRequirement(ex)}
                >
                  {ex}
                </button>
              ))}
            </div>
          </>
        )}

        {stage === "generating" && (
          <div className="gen__status">
            <div className="gen__spinner">⋯</div>
            <div>Designing your pipeline with Claude…</div>
            <div className="gen__status-hint">This takes 10–30 seconds.</div>
          </div>
        )}

        {stage === "preview" && result && (
          <>
            <div className="gen__summary">
              Generated {result.pipeline.nodes.length} node
              {result.pipeline.nodes.length === 1 ? "" : "s"},{" "}
              {result.pipeline.edges.length} edge
              {result.pipeline.edges.length === 1 ? "" : "s"}.
            </div>
            <div className="gen__preview">
              {result.pipeline.nodes.map((n, i) => (
                <div key={n.id} className="gen__preview-row">
                  <span className="gen__preview-idx">{i + 1}.</span>
                  <span className={`gen__preview-type gen__preview-type--${n.type}`}>
                    {n.type}
                  </span>
                  <span className="gen__preview-desc">
                    {n.type === "kb"
                      ? String(n.data.dir ?? "(no dir)")
                      : String(n.data.prompt ?? "")}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {stage === "error" && error && (
          <>
            <div className="gen__error-title">Generation failed</div>
            <pre className="gen__error">{error}</pre>
          </>
        )}

        <div className="gen__actions">
          <button
            className="gen__btn gen__btn--secondary"
            onClick={onClose}
            disabled={stage === "generating"}
          >
            Cancel
          </button>
          {stage === "input" && (
            <button
              className="gen__btn gen__btn--primary"
              onClick={generate}
              disabled={!requirement.trim()}
            >
              ✨ Generate
            </button>
          )}
          {stage === "preview" && (
            <>
              <button
                className="gen__btn gen__btn--secondary"
                onClick={() => {
                  setResult(null);
                  setStage("input");
                }}
              >
                Try again
              </button>
              <button className="gen__btn gen__btn--primary" onClick={apply}>
                Use this
              </button>
            </>
          )}
          {stage === "error" && (
            <button
              className="gen__btn gen__btn--primary"
              onClick={() => setStage("input")}
            >
              Back
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
