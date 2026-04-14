import { useGraph } from "../lib/graph-store";

export default function StatusBar() {
  const nodes = useGraph((s) => s.nodes);
  const edges = useGraph((s) => s.edges);

  let running = 0;
  let totalCost = 0;
  for (const n of nodes) {
    const d = n.data as { running?: boolean; costUsd?: number };
    if (d.running) running += 1;
    if (typeof d.costUsd === "number") totalCost += d.costUsd;
  }

  return (
    <div className="status-bar">
      <span
        className={
          "status-bar__dot" +
          (running > 0 ? " status-bar__dot--live" : "")
        }
      />
      <span className="status-bar__item">
        <strong>{running}</strong> running
      </span>
      <span className="status-bar__sep">·</span>
      <span className="status-bar__item">
        <strong>{nodes.length}</strong> nodes
      </span>
      <span className="status-bar__sep">·</span>
      <span className="status-bar__item">
        <strong>{edges.length}</strong> edges
      </span>
      <span className="status-bar__sep">·</span>
      <span className="status-bar__item">
        pipeline ${totalCost.toFixed(4)}
      </span>
      <span className="status-bar__fill" />
      <span className="status-bar__item status-bar__hint">CLI: claude</span>
    </div>
  );
}
