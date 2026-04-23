import type { SessionInfo } from "./session-types";
import type { RunRecord } from "./runs";

/**
 * Morning-digest bucketing for the Today tab ("the operator layer for
 * your digital workforce"). Pure function so the bucketing logic can be
 * exercised without React / jsdom.
 *
 * Inputs:
 *   - sessions: full session list (status can be any)
 *   - runs:     run history ordered newest-first (RunsDashboard convention)
 *   - pinned:   session ids the user has pinned as SessionNodes
 *   - now:      "current time" in ms; explicit for testability
 *   - overnightWindowMs: how far back counts as "overnight". Defaults to
 *                       18h — covers both "I came back after dinner" and
 *                       "I opened Orka first thing at 9am".
 */
export type TodayBuckets = {
  overnight: RunRecord[];
  awaitingReview: SessionInfo[];
  pinned: SessionInfo[];
  weekly: {
    totalRuns: number;
    distinctSkills: number;
    topSkill: { skill: string; count: number } | null;
  };
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function bucketForToday(input: {
  sessions: SessionInfo[];
  runs: RunRecord[];
  pinned: Set<string>;
  now: number;
  overnightWindowMs?: number;
}): TodayBuckets {
  const windowMs = input.overnightWindowMs ?? 18 * 60 * 60 * 1000;
  const overnightCutoff = input.now - windowMs;
  const weekCutoff = input.now - WEEK_MS;

  // Overnight: runs that started within the overnight window.
  // `runs` is already newest-first so the sort is just a safety net
  // for legacy rows with out-of-order started_at.
  const overnight = input.runs
    .filter((r) => {
      const t = Date.parse(r.started_at);
      return Number.isFinite(t) && t >= overnightCutoff;
    })
    .slice(0, 8);

  // Awaiting review: live sessions where Claude has finished its turn
  // AND settled sessions (status=done) from the last 48h. The 48h cap
  // keeps the list relevant — older done sessions belong in the Runs
  // archive, not the morning digest.
  const twoDaysAgo = input.now - 48 * 60 * 60 * 1000;
  const awaitingReview = input.sessions
    .filter((s) => {
      if (s.status === "live" && s.awaiting_user) return true;
      if (s.status === "done" && s.modified_ms >= twoDaysAgo) return true;
      return false;
    })
    .sort((a, b) => b.modified_ms - a.modified_ms)
    .slice(0, 8);

  // Pinned: whatever the user explicitly marked.
  const pinned = input.sessions
    .filter((s) => input.pinned.has(s.id))
    .sort((a, b) => b.modified_ms - a.modified_ms);

  // Weekly numbers: drive the "performance review" vibe.
  const weekRuns = input.runs.filter((r) => {
    const t = Date.parse(r.started_at);
    return Number.isFinite(t) && t >= weekCutoff;
  });
  const perSkill = new Map<string, number>();
  for (const r of weekRuns) {
    perSkill.set(r.skill, (perSkill.get(r.skill) ?? 0) + 1);
  }
  let topSkill: { skill: string; count: number } | null = null;
  for (const [skill, count] of perSkill) {
    if (!topSkill || count > topSkill.count) topSkill = { skill, count };
  }

  return {
    overnight,
    awaitingReview,
    pinned,
    weekly: {
      totalRuns: weekRuns.length,
      distinctSkills: perSkill.size,
      topSkill,
    },
  };
}
