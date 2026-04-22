import { useEffect, useMemo, useState } from "react";
import type { ProjectInfo, SessionInfo } from "../lib/session-types";
import { invokeCmd, listenEvent } from "../lib/tauri";
import { useRuns } from "../lib/runs";
import { useGraph } from "../lib/graph-store";
import { bucketForToday, type TodayBuckets } from "../lib/today-buckets";

type Props = {
  /** Jump to Sessions tab and open the given session's drawer. */
  onOpenSession: (sessionId: string) => void;
  /** Switch to the Runs tab (for "see all" links). */
  onJumpToRuns: () => void;
};

function fmtAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${(s / 60).toFixed(1)}m`;
}

function projectName(cwd: string): string {
  return cwd.split("/").filter(Boolean).slice(-1)[0] || cwd;
}

/**
 * Today tab — the "morning standup" for your digital workforce.
 *
 * Positions Orka as the operator/manager layer: Claude does the work,
 * this is where you see what shipped overnight, what needs review, and
 * what's on the docket. Four sections mirror a real standup:
 *   🌙 Overnight — what ran while I was away
 *   ✅ Awaiting review — what's queued for my attention
 *   🔔 Pinned — what I'm actively tracking
 *   📊 This week — performance snapshot
 */
export function TodayDashboard({ onOpenSession, onJumpToRuns }: Props) {
  const { runs, refresh: refreshRuns } = useRuns();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  // Pinned session ids live in the graph store as SessionNodes.
  const pinned = useGraph((s) => {
    const out = new Set<string>();
    for (const n of s.nodes) {
      if (n.type === "session") {
        const sid = (n.data as { sessionId?: string }).sessionId;
        if (sid) out.add(sid);
      }
    }
    return out;
  });

  // Pull sessions the same way SessionDashboard does: list_projects →
  // list_sessions per project. Rust caches the tail scans so the
  // duplicate fetch between tabs is cheap.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const ps = await invokeCmd<ProjectInfo[]>("list_projects");
        if (cancelled) return;
        const chunks = await Promise.all(
          ps.map((p) =>
            invokeCmd<SessionInfo[]>("list_sessions", { projectKey: p.key }).catch(
              () => [] as SessionInfo[],
            ),
          ),
        );
        if (cancelled) return;
        setSessions(chunks.flat());
      } catch (e) {
        console.warn("[today] load failed:", e);
      }
    }
    void load();
    void refreshRuns();
    // Sessions changing mid-day should refresh this list too.
    const unlisten = listenEvent("sessions:changed", () => {
      void load();
      void refreshRuns();
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, [refreshRuns]);

  const buckets: TodayBuckets = useMemo(
    () =>
      bucketForToday({
        sessions,
        runs,
        pinned,
        now: Date.now(),
      }),
    [sessions, runs, pinned],
  );

  const empty =
    buckets.overnight.length === 0 &&
    buckets.awaitingReview.length === 0 &&
    buckets.pinned.length === 0 &&
    buckets.weekly.totalRuns === 0;

  return (
    <div className="today">
      <div className="today__header">
        <h2 className="today__title">Today</h2>
        <span className="today__subtitle">
          The operator layer for your digital workforce.
        </span>
      </div>

      {empty && (
        <div className="today__empty">
          Nothing to report yet. Run a skill or start a Claude Code session —
          it'll show up here tomorrow morning.
        </div>
      )}

      {buckets.weekly.totalRuns > 0 && (
        <div className="today__kpis">
          <KPI label="runs this week" value={String(buckets.weekly.totalRuns)} />
          <KPI
            label="distinct skills"
            value={String(buckets.weekly.distinctSkills)}
          />
          {buckets.weekly.topSkill && (
            <KPI
              label="top skill"
              value={`${buckets.weekly.topSkill.skill} · ${buckets.weekly.topSkill.count}×`}
            />
          )}
        </div>
      )}

      {buckets.overnight.length > 0 && (
        <section className="today__section">
          <div className="today__section-head">
            <span className="today__section-icon">🌙</span>
            <span className="today__section-label">Overnight</span>
            <span className="today__section-count">
              {buckets.overnight.length}
            </span>
            <button
              type="button"
              className="today__see-all"
              onClick={onJumpToRuns}
            >
              see all runs →
            </button>
          </div>
          <ul className="today__list">
            {buckets.overnight.map((r) => (
              <li
                key={r.id}
                className={`today__row today__row--run today__row--${r.status}`}
                onClick={() => r.session_id && onOpenSession(r.session_id)}
                title={r.session_id ? "open session" : "no session id"}
              >
                <span className="today__row-primary">{r.skill}</span>
                <span className="today__row-meta">
                  {r.status}
                  {" · "}
                  {fmtDuration(r.duration_ms)}
                  {" · "}
                  {fmtAgo(Date.parse(r.started_at))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {buckets.awaitingReview.length > 0 && (
        <section className="today__section">
          <div className="today__section-head">
            <span className="today__section-icon">✅</span>
            <span className="today__section-label">Awaiting review</span>
            <span className="today__section-count">
              {buckets.awaitingReview.length}
            </span>
          </div>
          <ul className="today__list">
            {buckets.awaitingReview.map((s) => (
              <li
                key={s.id}
                className="today__row today__row--session"
                onClick={() => onOpenSession(s.id)}
              >
                <span className="today__row-primary">
                  {projectName(s.project_cwd)}
                </span>
                <span className="today__row-snippet" title={s.last_user_preview ?? s.first_user_preview ?? ""}>
                  {s.last_user_preview ??
                    s.first_user_preview ??
                    s.spawn_label ??
                    "(empty)"}
                </span>
                <span className="today__row-meta">{fmtAgo(s.modified_ms)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {buckets.pinned.length > 0 && (
        <section className="today__section">
          <div className="today__section-head">
            <span className="today__section-icon">🔔</span>
            <span className="today__section-label">Pinned</span>
            <span className="today__section-count">
              {buckets.pinned.length}
            </span>
          </div>
          <ul className="today__list">
            {buckets.pinned.map((s) => (
              <li
                key={s.id}
                className="today__row today__row--session"
                onClick={() => onOpenSession(s.id)}
              >
                <span className="today__row-primary">
                  {projectName(s.project_cwd)}
                </span>
                <span className="today__row-snippet" title={s.last_user_preview ?? ""}>
                  {s.last_user_preview ??
                    s.first_user_preview ??
                    s.spawn_label ??
                    "(empty)"}
                </span>
                <span className="today__row-meta">{fmtAgo(s.modified_ms)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function KPI({ label, value }: { label: string; value: string }) {
  return (
    <div className="today__kpi">
      <div className="today__kpi-value">{value}</div>
      <div className="today__kpi-label">{label}</div>
    </div>
  );
}
