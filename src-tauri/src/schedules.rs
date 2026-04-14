//! Per-pipeline scheduler. Stores one JSON file per pipeline under
//! `<workspace>/schedules/<sanitised-name>.json`. The frontend ticks every 30s
//! to decide what to fire — Rust just persists.

use crate::workspace;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Schedule {
    pub pipeline_name: String,
    pub kind: String,
    /// Free-form per-kind:
    ///   interval → { "minutes": 30 }
    ///   daily    → { "hour": 9, "minute": 0 }
    ///   weekly   → { "weekday": 1, "hour": 9, "minute": 0 } (0=Sun, 1=Mon …)
    ///   once     → { "atMs": 1776000000000 }
    pub spec: serde_json::Value,
    pub enabled: bool,
    pub notify: bool,
    pub sound: bool,
    pub last_run_at: Option<u64>,
    pub next_run_at: Option<u64>,
    pub history: Vec<HistoryEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HistoryEntry {
    pub ran_at: u64,
    pub ok: bool,
    pub duration_ms: u64,
    pub error: Option<String>,
    /// Optional path to an output file produced by this run (best-effort).
    pub output_path: Option<String>,
}

fn sanitise(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn schedules_dir() -> PathBuf {
    workspace::workspace_root().join("schedules")
}

fn path_for(name: &str) -> PathBuf {
    schedules_dir().join(format!("{}.json", sanitise(name)))
}

#[tauri::command]
pub fn list_schedules() -> Vec<Schedule> {
    let dir = schedules_dir();
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return vec![];
    };
    let mut out: Vec<Schedule> = vec![];
    for entry in rd.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&p) {
            if let Ok(s) = serde_json::from_str::<Schedule>(&text) {
                out.push(s);
            }
        }
    }
    out
}

#[tauri::command]
pub fn get_schedule(pipeline_name: String) -> Option<Schedule> {
    let p = path_for(&pipeline_name);
    let text = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&text).ok()
}

#[tauri::command]
pub fn save_schedule(schedule: Schedule) -> Result<(), String> {
    let dir = schedules_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = path_for(&schedule.pipeline_name);
    let text = serde_json::to_string_pretty(&schedule).map_err(|e| e.to_string())?;
    std::fs::write(&p, text).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_schedule(pipeline_name: String) -> Result<(), String> {
    let p = path_for(&pipeline_name);
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Best-effort macOS native notification via `osascript`. Returns Ok even when
/// the user has notifications disabled — we don't want a missed banner to
/// mark the run as failed.
#[tauri::command]
pub fn os_notify(title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Escape double quotes in the user-supplied text.
        let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            r#"display notification "{}" with title "{}" sound name "Glass""#,
            esc(&body),
            esc(&title)
        );
        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .status();
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (title, body);
        Ok(())
    }
}

// (Re-export Path so tests can build paths if needed in future.)
#[allow(dead_code)]
fn _ensure_use(_p: &Path) {}
