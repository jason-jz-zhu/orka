import { useEffect, useMemo, useState } from "react";
import type { ProjectInfo, SessionInfo } from "../lib/session-types";
import { invokeCmd, listenEvent } from "../lib/tauri";
import { useRuns } from "../lib/runs";
import { useGraph } from "../lib/graph-store";
import { bucketForToday } from "../lib/today-buckets";

type Props = {
  onJumpToSessions: () => void;
  onJumpToRuns: () => void;
};

/**
 * Always-visible "morning standup" strip across the top of the app.
 *
 * Operator narrative: Claude is the employee, Orka is the manager —
 * the ribbon is the manager's morning glance at the workforce. Four
 * chips summarise overnight runs, work awaiting review, pinned tasks,
 * and weekly throughput. Clicking a chip jumps to the relevant tab.
 *
 * Replaces the dedicated Today tab, which duplicated content already
 * surfaced in Sessions / Runs; the ribbon keeps the same awareness
 * without burning a navigation slot.
 */
export function MorningRibbon({ onJumpToSessions, onJumpToRuns }: Props) {
  const { runs, refresh: refreshRuns } = useRuns();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  // Subscribe to the stable nodes array; deriving the pinned Set
  // inside the zustand selector would return a fresh reference each
  // call and crash the app with an infinite-render loop
  // (same pitfall we fixed in TodayDashboard).
  const nodes = useGraph((s) => s.nodes);
  const pinned = useMemo(() => {
    const out = new Set<string>();
    for (const n of nodes) {
      if (n.type === "session") {
        const sid = (n.data as { sessionId?: string }).sessionId;
        if (sid) out.add(sid);
      }
    }
    return out;
  }, [nodes]);

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
        console.warn("[ribbon] load failed:", e);
      }
    }
    void load();
    void refreshRuns();
    const unlisten = listenEvent("sessions:changed", () => {
      void load();
      void refreshRuns();
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, [refreshRuns]);

  const buckets = useMemo(
    () =>
      bucketForToday({
        sessions,
        runs,
        pinned,
        now: Date.now(),
      }),
    [sessions, runs, pinned],
  );

  return (
    <div className="morning-ribbon" role="status">
      <Chip
        icon="🌙"
        count={buckets.overnight.length}
        label="overnight"
        onClick={onJumpToRuns}
        title={`${buckets.overnight.length} run(s) in the last 18 hours — click to open the Logbook`}
      />
      <Chip
        icon="✅"
        count={buckets.awaitingReview.length}
        label="awaiting"
        onClick={onJumpToSessions}
        title={`${buckets.awaitingReview.length} session(s) need your review — click to open the Workforce`}
      />
      <Chip
        icon="🔔"
        count={buckets.pinned.length}
        label="pinned"
        onClick={onJumpToSessions}
        title={`${buckets.pinned.length} pinned session(s) — click to open the Workforce`}
      />
      {/* Weekly stats live as an ambient, non-clickable trailing label.
          Earlier iteration had this as a 4th chip that jumped to Runs,
          but "overnight" already owned that destination — two chips with
          the same click target is a UX bug. Keep the number visible;
          drop the click. */}
      {buckets.weekly.totalRuns > 0 && (
        <span
          className="morning-ribbon__stats"
          title={
            buckets.weekly.topSkill
              ? `Top skill this week: ${buckets.weekly.topSkill.skill} (${buckets.weekly.topSkill.count}×)`
              : `${buckets.weekly.totalRuns} runs in the last 7 days`
          }
        >
          <span className="morning-ribbon__stats-value">
            {buckets.weekly.totalRuns}
          </span>
          <span className="morning-ribbon__stats-label">
            runs this week
            {buckets.weekly.topSkill
              ? ` · top ${buckets.weekly.topSkill.skill}`
              : ""}
          </span>
        </span>
      )}
    </div>
  );
}

function Chip({
  icon,
  count,
  label,
  onClick,
  title,
}: {
  icon: string;
  count: number;
  label: string;
  onClick: () => void;
  title: string;
}) {
  const dim = count === 0;
  return (
    <button
      type="button"
      className={`morning-ribbon__chip${dim ? " morning-ribbon__chip--dim" : ""}`}
      onClick={onClick}
      title={title}
    >
      <span className="morning-ribbon__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="morning-ribbon__count">{count}</span>
      <span className="morning-ribbon__label">{label}</span>
    </button>
  );
}
