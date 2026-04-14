import type { OrkaNode } from "../lib/graph-store";

type RunningNode = Extract<OrkaNode, { type: "chat" | "agent" }>;

type Props = {
  node: RunningNode;
  onOpen: () => void;
};

function truncate(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  return t.slice(0, n) + "…";
}

export default function PipelineNodeCard({ node, onOpen }: Props) {
  const label = node.type === "agent" ? "AGENT" : "CHAT";
  const goal = node.data.prompt?.trim() || "(empty prompt)";
  const out = node.data.output?.trim() || "";
  const toolCount = node.data.toolCount ?? 0;
  const cost = node.data.costUsd ?? 0;

  return (
    <div
      className="session-card session-card--generating session-card--pipeline"
      onClick={onOpen}
    >
      <div className="session-card__head">
        <span className="session-card__status">
          <span className="session-card__status-icon">●</span>
          PIPELINE · {label}
        </span>
        <span className="session-card__project">{node.id}</span>
        <span className="session-card__ago">running</span>
      </div>

      <div className="session-card__ask" title={goal}>
        <span className="session-card__label">💬</span>
        <span className="session-card__ask-text">{truncate(goal, 200)}</span>
      </div>

      {out && (
        <div className="session-card__now" title={out}>
          <span className="session-card__label session-card__label--live">⋯</span>
          <span className="session-card__now-text">{truncate(out, 180)}</span>
        </div>
      )}

      <div className="session-card__footer">
        <span className="session-card__metrics">
          {toolCount > 0 ? `🔧 ${toolCount}` : "no tools yet"}
          {cost > 0 ? ` · $${cost.toFixed(4)}` : ""}
        </span>
        <span className="session-card__id">node {node.id}</span>
      </div>

      <div className="session-card__actions">
        <button
          className="session-card__primary"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          Open in Studio
        </button>
      </div>
    </div>
  );
}
