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
  last_run_at: number | null;
  next_run_at: number | null;
  history: HistoryEntry[];
};

export async function listSchedules(): Promise<Schedule[]> {
  return invokeCmd<Schedule[]>("list_schedules");
}

export async function getSchedule(name: string): Promise<Schedule | null> {
  const r = await invokeCmd<Schedule | null>("get_schedule", {
    pipelineName: name,
  });
  return r ?? null;
}

export async function saveSchedule(s: Schedule): Promise<void> {
  await invokeCmd<void>("save_schedule", { schedule: s });
}

export async function deleteSchedule(name: string): Promise<void> {
  await invokeCmd<void>("delete_schedule", { pipelineName: name });
}

export async function osNotify(title: string, body: string): Promise<void> {
  try {
    await invokeCmd<void>("os_notify", { title, body });
  } catch {
    /* ignore */
  }
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

/** Human-friendly text describing a schedule. */
export function describeSchedule(s: Schedule): string {
  const sp = s.spec as Record<string, number>;
  switch (s.kind) {
    case "interval":
      return `every ${sp.minutes}m`;
    case "daily":
      return `daily ${pad(sp.hour)}:${pad(sp.minute)}`;
    case "weekly":
      return `weekly ${WD[sp.weekday] ?? "?"} ${pad(sp.hour)}:${pad(sp.minute)}`;
    case "once":
      return `once @ ${new Date(sp.atMs).toLocaleString()}`;
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
