// Lightweight render-count instrumentation.
// Enable from the devtools console:  window.__ORKA_PERF__ = true
// Disable: delete window.__ORKA_PERF__
//
// Components opt in via `usePerfCount("SessionCard")`. The counter is
// flushed every 2s as a single console.table so we don't drown the log.

const counts = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

declare global {
  interface Window {
    __ORKA_PERF__?: boolean;
    __ORKA_PERF_COUNTS__?: Record<string, number>;
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
