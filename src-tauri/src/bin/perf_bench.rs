//! Standalone perf benchmark — runs the same hot paths the running Tauri
//! app exercises, but from a command line so we can compare before/after
//! numbers without needing the UI loaded.
//!
//! Usage:
//!     cargo run --release --bin orka-perf -- 20
//!
//! The positional arg is iteration count (default: 10, clamped to [3, 100]).
//! Reads ~/.claude/projects and ~/.claude/skills exactly as the app would.

use orka_lib::perf_smoke;

fn main() {
    let iters: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);

    let report = perf_smoke::perf_smoke_test(Some(iters));
    println!(
        "\n=== orka perf smoke ({} iterations) ===\n",
        report.iterations
    );
    println!(
        "{:<40} {:>12} {:>12} {:>12}",
        "path", "median", "p95", "max"
    );
    println!("{}", "-".repeat(82));
    for r in &report.results {
        println!(
            "{:<40} {:>10.1}ms {:>10.1}ms {:>10.1}ms",
            r.name, r.median_ms, r.p95_ms, r.max_ms
        );
        if let Some(note) = &r.note {
            println!("  └─ {}", note);
        }
    }
    println!();
    if let Ok(json) = serde_json::to_string_pretty(&report) {
        // Also emit a machine-readable copy at the end — handy for diffing
        // before/after runs.
        eprintln!("--- JSON ---\n{}", json);
    }
}
