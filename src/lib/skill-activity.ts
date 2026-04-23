import type { RunRecord } from "./runs";

/**
 * For each skill slug, find the timestamp of its MOST RECENT run.
 *
 * Used to render a "last delivered" badge on the sidebar so three
 * rows of the same skill don't feel interchangeable. Runs list is
 * expected newest-first (RunsDashboard convention); the function is
 * order-robust though — it only checks max.
 *
 * Returns a Map<skill-slug, last-run-ms>. Skills that never ran are
 * simply absent from the map; the caller renders a separate label.
 */
export function lastDeliveredBySkill(runs: RunRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of runs) {
    const t = Date.parse(r.started_at);
    if (!Number.isFinite(t)) continue;
    const prev = out.get(r.skill);
    if (prev == null || t > prev) out.set(r.skill, t);
  }
  return out;
}

/**
 * Human-friendly "N{s,m,h,d} ago" for the skill-card badge. Mirrors
 * the fmtAgo pattern used elsewhere but defined once so tests can
 * pin the exact thresholds.
 */
export function fmtLastDelivered(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms)) return "never";
  const delta = Math.max(0, Math.floor((now - ms) / 1000));
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86_400)}d ago`;
}
