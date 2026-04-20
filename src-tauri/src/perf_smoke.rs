//! End-to-end perf smoke test. Runs the hot filesystem/IPC paths the
//! frontend actually calls during normal use and returns median/p95 timings
//! so we can compare before/after optimization.
//!
//! Invoke from the frontend:
//!   await invokeCmd("perf_smoke_test", { iterations: 10 })
//!
//! Or from the devtools console (via the exposed __ORKA_PERF_SMOKE__):
//!   await window.__ORKA_PERF_SMOKE__()
//!
//! The test intentionally exercises the cached paths — most calls the app
//! makes are cache hits, so that's what matters for felt responsiveness.

use serde::Serialize;
use std::time::Instant;

#[derive(Debug, Clone, Serialize)]
pub struct PerfReport {
    pub iterations: usize,
    pub results: Vec<PerfEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PerfEntry {
    pub name: String,
    pub median_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
    pub count: usize,
    pub note: Option<String>,
}

fn percentile(samples: &mut [f64], pct: f64) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((samples.len() as f64) * pct).ceil() as usize;
    samples[idx.saturating_sub(1).min(samples.len() - 1)]
}

fn bench<F: FnMut()>(name: &str, iters: usize, mut f: F) -> PerfEntry {
    let mut samples = Vec::with_capacity(iters);
    for _ in 0..iters {
        let t0 = Instant::now();
        f();
        samples.push(t0.elapsed().as_secs_f64() * 1000.0);
    }
    let mut sorted = samples.clone();
    let median = percentile(&mut sorted, 0.5);
    let p95 = percentile(&mut sorted, 0.95);
    let max = samples.iter().cloned().fold(0.0f64, f64::max);
    PerfEntry {
        name: name.to_string(),
        median_ms: round1(median),
        p95_ms: round1(p95),
        max_ms: round1(max),
        count: iters,
        note: None,
    }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

#[tauri::command]
pub fn perf_smoke_test(iterations: Option<usize>) -> PerfReport {
    let iters = iterations.unwrap_or(10).clamp(3, 100);
    let mut results = Vec::new();

    // 1. list_projects — cheap after first call (cached by lower layer).
    results.push(bench("list_projects", iters, || {
        let _ = crate::sessions::list_projects();
    }));

    // 2. list_sessions on the first project — exercises scan_session_tail.
    //    Baseline for the tail-seek fix (B1).
    let projects = crate::sessions::list_projects();
    let sample_project = projects.first().map(|p| p.key.clone());
    if let Some(key) = sample_project {
        let key_clone = key.clone();
        let mut entry = bench("list_sessions[first_project]", iters, || {
            let _ = crate::sessions::list_sessions(&key_clone);
        });
        entry.note = Some(format!("project={}", &key[..key.len().min(40)]));
        results.push(entry);
    }

    // 3. scan_skills_dirs — exercises skills cache (B2).
    results.push(bench("scan_skills_dirs", iters, || {
        let _ = crate::skills::scan_skills_dirs();
    }));

    // 4. Cold skills scan (bust cache each iter) — shows worst case.
    let mut cold = bench("scan_skills_dirs[cold]", iters.min(5), || {
        crate::skills::invalidate_skills_cache();
        let _ = crate::skills::scan_skills_dirs();
    });
    cold.note = Some("invalidates cache each iter — worst-case walk".into());
    results.push(cold);

    // 5. model_for_brief — reads ~/.orka/model-config.json each call.
    //    Sanity check; should be sub-ms.
    results.push(bench("model_for_brief", iters, || {
        let _ = crate::model_config::model_for_brief();
    }));

    PerfReport {
        iterations: iters,
        results,
    }
}
