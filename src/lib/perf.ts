// Lightweight render-count instrumentation + end-to-end smoke test.
// Enable from the devtools console:  window.__ORKA_PERF__ = true
// Disable: delete window.__ORKA_PERF__
//
// Components opt in via `bump("SessionCard")`. The counter is flushed
// every 2s as a single console.log so we don't drown the log.
//
// To run the full perf smoke test:
//   await window.__ORKA_PERF_SMOKE__()
// (also logs the result and returns it for programmatic use)

import { invokeCmd } from "./tauri";

const counts = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

type PerfEntry = {
  name: string;
  median_ms: number;
  p95_ms: number;
  max_ms: number;
  count: number;
  note: string | null;
};

type PerfReport = {
  iterations: number;
  results: PerfEntry[];
};

declare global {
  interface Window {
    __ORKA_PERF__?: boolean;
    __ORKA_PERF_COUNTS__?: Record<string, number>;
    __ORKA_PERF_SMOKE__?: (iterations?: number) => Promise<PerfReport>;
    __ORKA_PERF_TABSWITCH__?: (to: string) => void;
  }
}

export function isPerfOn(): boolean {
  return typeof window !== "undefined" && window.__ORKA_PERF__ === true;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!isPerfOn()) {
      counts.clear();
      return;
    }
    if (counts.size === 0) return;
    const obj = Object.fromEntries(counts);
    window.__ORKA_PERF_COUNTS__ = obj;
    // eslint-disable-next-line no-console
    console.log("[orka:perf] render counts in last 2s", obj);
    counts.clear();
  }, 2000);
}

/**
 * Bump the render counter for a named component.
 * Zero overhead when perf logging is off — no allocation, no lookup beyond a flag check.
 */
export function bump(name: string) {
  if (!isPerfOn()) return;
  counts.set(name, (counts.get(name) ?? 0) + 1);
  scheduleFlush();
}

/**
 * Wall-clock helper for one-shot async measurements.
 * Returns a stop fn that logs `[orka:perf] <label> Xms`.
 */
export function timeStart(label: string): () => void {
  if (!isPerfOn()) return () => {};
  const t0 = performance.now();
  return () => {
    // eslint-disable-next-line no-console
    console.log(`[orka:perf] ${label} ${(performance.now() - t0).toFixed(1)}ms`);
  };
}

/**
 * Run the end-to-end perf smoke test. Measures both the Rust hot paths
 * (list_projects, list_sessions, scan_skills_dirs) and frontend-side IPC
 * round-trip overhead. Safe to call from devtools at any time; does not
 * mutate state. Prints a formatted table and returns the raw report.
 */
export async function runPerfSmoke(iterations = 10): Promise<PerfReport> {
  // eslint-disable-next-line no-console
  console.log(`[orka:perf] smoke test starting (${iterations} iters)…`);
  const t0 = performance.now();

  // Rust-side measurements.
  const rust = await invokeCmd<PerfReport>("perf_smoke_test", { iterations });

  // Frontend-side IPC round trip — time `get_model_config` which is tiny
  // and doesn't hit disk heavily. The delta vs Rust-only is the Tauri
  // bridge overhead.
  const rttSamples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const s = performance.now();
    await invokeCmd("get_model_config");
    rttSamples.push(performance.now() - s);
  }
  rttSamples.sort((a, b) => a - b);
  const ipcEntry: PerfEntry = {
    name: "ipc_round_trip[get_model_config]",
    median_ms: Number(rttSamples[Math.floor(rttSamples.length / 2)].toFixed(1)),
    p95_ms: Number(
      rttSamples[Math.floor(rttSamples.length * 0.95) - 1 || 0]?.toFixed(1) ?? "0",
    ),
    max_ms: Number(rttSamples[rttSamples.length - 1].toFixed(1)),
    count: rttSamples.length,
    note: "measures Tauri bridge overhead on a trivial command",
  };

  const report: PerfReport = {
    iterations: rust.iterations,
    results: [...rust.results, ipcEntry],
  };

  const table = report.results.map((r) => ({
    name: r.name,
    median: `${r.median_ms}ms`,
    p95: `${r.p95_ms}ms`,
    max: `${r.max_ms}ms`,
    note: r.note ?? "",
  }));
  const elapsed = (performance.now() - t0).toFixed(0);
  // eslint-disable-next-line no-console
  console.log(`[orka:perf] smoke done in ${elapsed}ms`);
  // eslint-disable-next-line no-console
  console.table(table);
  return report;
}

/**
 * Install perf helpers on window for devtools use. Call once from App.
 */
export function installPerfGlobals() {
  if (typeof window === "undefined") return;
  window.__ORKA_PERF_SMOKE__ = runPerfSmoke;
  window.__ORKA_PERF_TABSWITCH__ = (to: string) => {
    const stop = timeStart(`tab-switch[${to}]`);
    // The caller clicks a tab; this helper just times the next paint.
    requestAnimationFrame(() => requestAnimationFrame(stop));
  };
}
