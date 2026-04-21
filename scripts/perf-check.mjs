#!/usr/bin/env node
/**
 * Runs the `orka-perf` binary, parses the JSON report from stderr, and
 * checks each probe's p95 against the budgets in docs/perf-baselines.json.
 * Exits non-zero on any budget violation.
 *
 * Usage:
 *   npm run perf:check
 *   node scripts/perf-check.mjs 20        # custom iteration count
 *   node scripts/perf-check.mjs --help
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(repoRoot, "docs", "perf-baselines.json");

function die(msg, code = 1) {
  console.error(`perf-check: ${msg}`);
  process.exit(code);
}

const argIter = process.argv[2];
if (argIter === "--help" || argIter === "-h") {
  console.log(
    "usage: perf-check.mjs [iterations]\n" +
      "  iterations  How many samples per probe (default 10, clamped to [3,100]).",
  );
  process.exit(0);
}
const iters = argIter ? String(parseInt(argIter, 10) || 10) : "10";

let budgets;
try {
  budgets = JSON.parse(readFileSync(baselinePath, "utf8")).budgets;
} catch (e) {
  die(`failed to read ${baselinePath}: ${e.message}`);
}

console.log(`perf-check: building orka-perf in release mode…`);
const build = spawnSync(
  "cargo",
  ["build", "--release", "--bin", "orka-perf", "--quiet"],
  { cwd: join(repoRoot, "src-tauri"), stdio: "inherit" },
);
if (build.status !== 0) die("cargo build failed", build.status ?? 1);

console.log(`perf-check: running ${iters} iterations per probe…`);
const run = spawnSync(
  "cargo",
  ["run", "--release", "--bin", "orka-perf", "--quiet", "--", iters],
  { cwd: join(repoRoot, "src-tauri"), encoding: "utf8" },
);
if (run.status !== 0) {
  die(`orka-perf exited ${run.status}\nstderr:\n${run.stderr}`);
}

// perf_bench.rs emits `--- JSON ---\n<json>` on stderr after the table.
const marker = "--- JSON ---";
const idx = run.stderr.indexOf(marker);
if (idx === -1) die("could not find JSON marker in orka-perf stderr");
const jsonText = run.stderr.slice(idx + marker.length).trim();
let report;
try {
  report = JSON.parse(jsonText);
} catch (e) {
  die(`failed to parse JSON report: ${e.message}\n${jsonText.slice(0, 200)}`);
}

console.log(run.stdout); // replay the human-readable table

let violations = 0;
let unchecked = 0;
console.log(
  `\nperf-check: p95 vs budget (docs/perf-baselines.json)\n${"─".repeat(72)}`,
);
console.log(`${"probe".padEnd(32)}${"p95".padStart(10)}${"budget".padStart(12)}${" ".repeat(4)}status`);
console.log("─".repeat(72));
for (const entry of report.results) {
  const budget = budgets[entry.name];
  if (!budget) {
    console.log(
      `${entry.name.padEnd(32)}${(entry.p95_ms + "ms").padStart(10)}${"—".padStart(12)}    (no budget)`,
    );
    unchecked += 1;
    continue;
  }
  const p95 = entry.p95_ms;
  const cap = budget.p95_ms;
  const pass = p95 <= cap;
  if (!pass) violations += 1;
  const status = pass ? "✅ ok" : `🔴 over (+${(p95 - cap).toFixed(1)}ms)`;
  console.log(
    `${entry.name.padEnd(32)}${(p95 + "ms").padStart(10)}${(cap + "ms").padStart(12)}    ${status}`,
  );
}
console.log("─".repeat(72));

if (violations > 0) {
  console.error(`\nperf-check: FAIL — ${violations} probe(s) over budget.`);
  process.exit(1);
}
console.log(
  `\nperf-check: PASS — all budgeted probes under cap (${unchecked} unchecked).`,
);
