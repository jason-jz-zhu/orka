import { invokeCmd } from "./tauri";

export type ScheduleKind = "interval" | "daily" | "weekly" | "once";

export type ScheduleSpec =
  | { minutes: number }                                   // interval
  | { hour: number; minute: number }                      // daily
  | { weekday: number; hour: number; minute: number }     // weekly
  | { atMs: number };                                     // once

export type HistoryEntry = {
  ran_at: number;
  ok: boolean;
  duration_ms: number;
  error: string | null;
  output_path: string | null;
};

export type Schedule = {
  pipeline_name: string;
  kind: ScheduleKind;
  spec: ScheduleSpec;
  enabled: boolean;
  notify: boolean;
  sound: boolean;
  /** Natural-language prompt baked into the schedule. Only meaningful
   *  for `skill:<slug>` schedules; ignored for legacy canvas pipelines.
   *  When present, fires with `/<slug>\n\n<prompt>` at run time. */
  prompt?: string | null;
  /** Declared-input overrides. Object shape: `{ [name]: string }`.
   *  Omitted keys fall back to SKILL.md defaults. */
  inputs?: Record<string, string> | null;
  /** Human-readable subfolder name under the skill's configured output
   *  folder. E.g. `daily-0900`. When absent, the backend computes a
   *  default from `kind` + `spec` at fire time. */
  label?: string | null;
  last_run_at: number | null;
  next_run_at: number | null;
  history: HistoryEntry[];
};

export async function listSchedules(): Promise<Schedule[]> {
  return invokeCmd<Schedule[]>("list_schedules");
}

export async function listSchedulesForSkill(
  slug: string,
): Promise<Schedule[]> {
  return invokeCmd<Schedule[]>("list_schedules_for_skill", { slug });
}

export async function getSchedule(
  name: string,
  label: string | null = null,
): Promise<Schedule | null> {
  const r = await invokeCmd<Schedule | null>("get_schedule", {
    pipelineName: name,
    label,
  });
  return r ?? null;
}

/**
 * Save a schedule.
 * @param s          The schedule to persist (must include `label` for
 *                   multi-schedule-per-skill to work correctly).
 * @param previousLabel  When editing, the label the schedule had when
 *                       the editor opened. Null for a brand-new schedule.
 *                       Used by the backend to clean up a renamed-from
 *                       file so we don't leak stale ghosts.
 */
export async function saveSchedule(
  s: Schedule,
  previousLabel: string | null = null,
): Promise<void> {
  await invokeCmd<void>("save_schedule", {
    schedule: s,
    previousLabel,
  });
}

export async function deleteSchedule(
  name: string,
  label: string | null = null,
): Promise<void> {
  await invokeCmd<void>("delete_schedule", { pipelineName: name, label });
}

export async function osNotify(title: string, body: string): Promise<void> {
  try {
    await invokeCmd<void>("os_notify", { title, body });
  } catch {
    /* ignore */
  }
}

/** Ask the backend for a default schedule label based on kind/spec. */
export async function computeDefaultLabel(
  kind: ScheduleKind,
  spec: ScheduleSpec,
): Promise<string> {
  return invokeCmd<string>("compute_default_schedule_label", { kind, spec });
}

/**
 * Returns the next run-at timestamp given the schedule kind/spec and the
 * "from" reference time (usually `Date.now()` or the previous `last_run_at`).
 * Returns null when there is no next run (one-shot already fired).
 */
export function computeNextRunAt(
  kind: ScheduleKind,
  spec: ScheduleSpec,
  fromMs: number,
  lastRunAtMs: number | null
): number | null {
  switch (kind) {
    case "interval": {
      const minutes = (spec as { minutes: number }).minutes;
      if (!minutes || minutes <= 0) return null;
      // Anchor on lastRunAt when present so we don't drift across reloads.
      const base = lastRunAtMs ?? fromMs;
      let next = base + minutes * 60_000;
      // Catch up: if we slept past several intervals, jump forward.
      while (next <= fromMs) next += minutes * 60_000;
      return next;
    }
    case "daily": {
      const { hour, minute } = spec as { hour: number; minute: number };
      const d = new Date(fromMs);
      d.setSeconds(0, 0);
      d.setHours(hour, minute);
      if (d.getTime() <= fromMs) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    case "weekly": {
      const { weekday, hour, minute } = spec as {
        weekday: number;
        hour: number;
        minute: number;
      };
      const d = new Date(fromMs);
      d.setSeconds(0, 0);
      d.setHours(hour, minute);
      const cur = d.getDay();
      let delta = (weekday - cur + 7) % 7;
      if (delta === 0 && d.getTime() <= fromMs) delta = 7;
      d.setDate(d.getDate() + delta);
      return d.getTime();
    }
    case "once": {
      const { atMs } = spec as { atMs: number };
      if (lastRunAtMs && lastRunAtMs >= atMs) return null;
      return atMs;
    }
  }
}

/**
 * Given a possibly out-of-date schedule, return a copy with `next_run_at`
 * recomputed for "now". Idempotent — pass it through whenever you read or
 * touch a schedule.
 */
export function refreshNextRun(s: Schedule, nowMs = Date.now()): Schedule {
  const next = computeNextRunAt(s.kind, s.spec, nowMs, s.last_run_at);
  return { ...s, next_run_at: next };
}

/** Human-friendly text describing a schedule. Includes a `(paused)`
 *  suffix when the schedule is disabled so users can see at a glance
 *  that a schedule exists but isn't firing — the most common way
 *  "my schedule didn't run" turns out to be "I never turned it on". */
export function describeSchedule(s: Schedule): string {
  const sp = s.spec as Record<string, number>;
  const suffix = s.enabled === false ? " (paused)" : "";
  switch (s.kind) {
    case "interval":
      return `every ${sp.minutes}m${suffix}`;
    case "daily":
      return `daily ${pad(sp.hour)}:${pad(sp.minute)}${suffix}`;
    case "weekly":
      return `weekly ${WD[sp.weekday] ?? "?"} ${pad(sp.hour)}:${pad(sp.minute)}${suffix}`;
    case "once":
      return `once @ ${new Date(sp.atMs).toLocaleString()}${suffix}`;
  }
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "in 3h 12m" / "in 45s" / "now" / "X overdue" */
export function relativeTime(ms: number, now = Date.now()): string {
  const delta = ms - now;
  if (Math.abs(delta) < 30_000) return "now";
  const past = delta < 0;
  const s = Math.abs(delta) / 1000;
  const m = s / 60;
  const h = m / 60;
  const d = h / 24;
  let out: string;
  if (d >= 2) out = `${Math.round(d)}d`;
  else if (h >= 2) out = `${Math.round(h)}h`;
  else if (m >= 2) out = `${Math.round(m)}m`;
  else out = `${Math.round(s)}s`;
  return past ? `${out} overdue` : `in ${out}`;
}
