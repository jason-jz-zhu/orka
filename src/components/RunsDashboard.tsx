import { useEffect } from "react";
import { useRuns, type RunRecord } from "../lib/runs";

export default function RunsDashboard() {
  const { runs, loading, refresh } = useRuns();

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="runs-dash">
      <div className="runs-dash__header">
        <span className="runs-dash__title">Run History</span>
        <button className="sidebar__toggle" onClick={refresh} title="Refresh">
          ↻
        </button>
      </div>
      {loading && <div className="runs-dash__status">Loading...</div>}
      {!loading && runs.length === 0 && (
        <div className="runs-dash__status">
          No runs yet. Use <code>orka run &lt;skill&gt;</code> or Run All in the canvas.
        </div>
      )}
      {!loading && runs.length > 0 && (
        <table className="runs-dash__table">
          <thead>
            <tr>
              <th>Skill</th>
              <th>Time</th>
              <th>Status</th>
              <th>Trigger</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RunRow({ run }: { run: RunRecord }) {
  const time = (() => {
    try {
      return new Date(run.started_at).toLocaleString();
    } catch {
      return run.started_at;
    }
  })();
  const duration = run.duration_ms
    ? `${(run.duration_ms / 1000).toFixed(1)}s`
    : "—";

  return (
    <tr className={`runs-dash__row runs-dash__row--${run.status}`}>
      <td className="runs-dash__cell">{run.skill}</td>
      <td className="runs-dash__cell runs-dash__cell--time">{time}</td>
      <td className="runs-dash__cell">
        <span
          className={`runs-dash__status-badge runs-dash__status-badge--${run.status}`}
        >
          {run.status === "ok" ? "✓" : "✗"} {run.status}
        </span>
      </td>
      <td className="runs-dash__cell">{run.trigger}</td>
      <td className="runs-dash__cell">{duration}</td>
    </tr>
  );
}
