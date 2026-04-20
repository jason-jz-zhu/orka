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
    /// Natural-language prompt to send along with the skill invocation.
    /// For `skill:<slug>` schedules, this gets prepended as a free-text
    /// section in the composed prompt (same layout as SkillRunner's
    /// textarea). Ignored for legacy canvas-pipeline schedules since
    /// those run via the DAG, not a single prompt.
    #[serde(default)]
    pub prompt: Option<String>,
    /// Declared-input overrides for skill schedules. `key: value` map
    /// that overrides SKILL.md `inputs:` defaults at fire time. Empty
    /// or missing → defaults only.
    #[serde(default)]
    pub inputs: Option<serde_json::Value>,
    /// Human-friendly subfolder name used under the skill's configured
    /// output folder (if any). E.g. a "daily at 09:00" schedule might
    /// use `daily-0900`. When absent, a default is computed from `kind`
    /// + `spec` at fire time. Old schedule files parse without — the
    /// default generator kicks in transparently.
    #[serde(default)]
    pub label: Option<String>,
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

/// Separator between the pipeline_name segment and the label segment
/// in a schedule filename. Two underscores is distinctive enough that
/// it won't collide with sanitised user input (single underscores are
/// common in sanitised names, but `__` basically never appears there).
const LABEL_SEP: &str = "__";

/// Compute the on-disk path for a (pipeline_name, label) pair. Labels
/// are how we allow the same skill to have multiple schedules — each
/// gets its own file.
fn path_for(name: &str, label: Option<&str>) -> PathBuf {
    let base = sanitise(name);
    match label {
        Some(l) if !l.is_empty() => {
            let label_slug = sanitise(l);
            schedules_dir().join(format!("{base}{LABEL_SEP}{label_slug}.json"))
        }
        _ => schedules_dir().join(format!("{base}.json")),
    }
}

/// Legacy-aware path lookup. Returns the first existing file that could
/// contain the schedule for (name, label):
///   1. The new composite-key file (with label)
///   2. The legacy file (without __label suffix), but only if label is
///      None or matches the default-computed label of the stored schedule
///
/// Centralising this prevents old single-schedule-per-skill files from
/// becoming invisible after the upgrade.
fn resolve_existing_path(name: &str, label: Option<&str>) -> Option<PathBuf> {
    let composite = path_for(name, label);
    if composite.exists() {
        return Some(composite);
    }
    // Fall back to the label-less legacy filename. Only meaningful when
    // the caller didn't specify a label (or the stored legacy schedule
    // has no label — indistinguishable from the filesystem alone).
    let legacy = path_for(name, None);
    if legacy.exists() {
        return Some(legacy);
    }
    None
}

#[tauri::command]
pub fn list_schedules() -> Vec<Schedule> {
    // Cache with dir-mtime fingerprint + 2s TTL. Called on every
    // schedule-ticker tick (~30s) AND on every SkillsTab mount AND
    // from `list_schedules_for_skill`, so an uncached version was
    // paying 50+ full-file-read+deserialize round-trips per tab
    // switch on power users. Invalidated externally when the
    // frontend dispatches the `orka:schedule-changed` event after
    // save/delete — that re-fires the ticker which re-enters here
    // with a freshly-modified dir mtime, busting the cache naturally.
    const TTL_MS: u128 = 2_000;
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<Option<(std::time::Instant, Option<std::time::SystemTime>, Vec<Schedule>)>>,
    > = std::sync::OnceLock::new();
    let cell = CACHE.get_or_init(|| std::sync::Mutex::new(None));

    let dir = schedules_dir();
    let dir_mtime = std::fs::metadata(&dir).and_then(|m| m.modified()).ok();

    if let Ok(guard) = cell.lock() {
        if let Some((cached_at, cached_mtime, list)) = guard.as_ref() {
            let fresh =
                cached_at.elapsed().as_millis() < TTL_MS && *cached_mtime == dir_mtime;
            if fresh {
                return list.clone();
            }
        }
    }

    let Ok(rd) = std::fs::read_dir(&dir) else {
        if let Ok(mut g) = cell.lock() {
            *g = Some((std::time::Instant::now(), dir_mtime, vec![]));
        }
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
    if let Ok(mut g) = cell.lock() {
        *g = Some((std::time::Instant::now(), dir_mtime, out.clone()));
    }
    out
}

#[tauri::command]
pub fn get_schedule(
    pipeline_name: String,
    label: Option<String>,
) -> Option<Schedule> {
    let p = resolve_existing_path(&pipeline_name, label.as_deref())?;
    let text = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&text).ok()
}

#[tauri::command]
pub fn list_schedules_for_skill(slug: String) -> Vec<Schedule> {
    let target = format!("skill:{slug}");
    list_schedules()
        .into_iter()
        .filter(|s| s.pipeline_name == target)
        .collect()
}

#[tauri::command]
pub fn save_schedule(
    schedule: Schedule,
    previous_label: Option<String>,
) -> Result<(), String> {
    if let Some(ref label) = schedule.label {
        validate_label(label)?;
    }
    let dir = schedules_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // If the user renamed the schedule (label changed), the old file at
    // the previous path must be cleaned up or we end up with a ghost
    // schedule at the old name. Similarly, when saving a labeled
    // schedule for a skill that had a legacy label-less file, remove
    // the legacy file — this completes the one-shot migration from
    // single-schedule-per-skill to composite-key.
    let new_path = path_for(&schedule.pipeline_name, schedule.label.as_deref());
    let mut prev_paths: Vec<PathBuf> = Vec::new();
    if let Some(prev) = previous_label.as_deref() {
        prev_paths.push(path_for(&schedule.pipeline_name, Some(prev)));
    }
    if schedule.label.is_some() {
        prev_paths.push(path_for(&schedule.pipeline_name, None));
    }
    for prev in prev_paths {
        if prev != new_path && prev.exists() {
            let _ = std::fs::remove_file(&prev);
        }
    }

    // Duplicate guard: for brand-new schedules (no previous_label) we
    // refuse to overwrite an existing file with a live history. Prevents
    // two `+ Add` clicks with the same auto-label from silently stomping
    // the first one.
    if previous_label.is_none() && new_path.exists() {
        if let Some(ex) = std::fs::read_to_string(&new_path)
            .ok()
            .and_then(|t| serde_json::from_str::<Schedule>(&t).ok())
        {
            if schedule.last_run_at.is_none() && ex.last_run_at.is_some() {
                return Err(format!(
                    "a schedule labeled {:?} already exists for {} — rename before saving",
                    schedule.label.as_deref().unwrap_or(""),
                    schedule.pipeline_name
                ));
            }
        }
    }

    let text = serde_json::to_string_pretty(&schedule).map_err(|e| e.to_string())?;
    std::fs::write(&new_path, text).map_err(|e| e.to_string())?;
    Ok(())
}

/// Labels become subfolder names under the skill's output folder, so
/// they must be path-component safe. We require a short, visibly sane
/// string — nothing exotic, nothing that could escape a path.
fn validate_label(label: &str) -> Result<(), String> {
    if label.is_empty() {
        return Err("schedule label cannot be empty".into());
    }
    if label.len() > 64 {
        return Err("schedule label too long (max 64 chars)".into());
    }
    if label.contains('/') || label.contains('\\') || label == ".." || label == "." {
        return Err(format!(
            "schedule label cannot contain slashes or be . / ..: {label:?}"
        ));
    }
    // Also reject dots: filenames preserve them (sanitise keeps `.`),
    // but output-folder subfolder names strip them (slugify replaces
    // non-alnum with `-`). Allowing dots here means two labels like
    // `v.2.0` and `v-2-0` write to different schedule files but the
    // same output subfolder, silently overwriting each other's runs.
    // Force `-`-only labels so the two encodings always agree.
    if label.contains('.') {
        return Err(format!(
            "schedule label cannot contain '.' — use '-' instead: {label:?}"
        ));
    }
    Ok(())
}

/// Derive a reasonable default label from a Schedule's kind + spec.
/// Used when a schedule has no explicit label — keeps older schedule
/// files working without a migration pass.
pub fn default_label(kind: &str, spec: &serde_json::Value) -> String {
    match kind {
        "daily" => {
            let h = spec.get("hourLocal").and_then(|v| v.as_u64()).unwrap_or(0);
            let m = spec.get("minuteLocal").and_then(|v| v.as_u64()).unwrap_or(0);
            format!("daily-{:02}{:02}", h, m)
        }
        "weekly" => {
            let wd = spec.get("weekday").and_then(|v| v.as_u64()).unwrap_or(0);
            let h = spec.get("hourLocal").and_then(|v| v.as_u64()).unwrap_or(0);
            let m = spec.get("minuteLocal").and_then(|v| v.as_u64()).unwrap_or(0);
            let dow = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
                .get(wd as usize)
                .copied()
                .unwrap_or("?");
            format!("weekly-{}-{:02}{:02}", dow, h, m)
        }
        "interval" => {
            let mins = spec
                .get("minutes")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            if mins % 60 == 0 && mins > 0 {
                format!("every-{}h", mins / 60)
            } else {
                format!("every-{}m", mins)
            }
        }
        "once" => "once".into(),
        _ => "run".into(),
    }
}

#[tauri::command]
pub fn compute_default_schedule_label(
    kind: String,
    spec: serde_json::Value,
) -> String {
    default_label(&kind, &spec)
}

#[tauri::command]
pub fn delete_schedule(
    pipeline_name: String,
    label: Option<String>,
) -> Result<(), String> {
    if let Some(p) = resolve_existing_path(&pipeline_name, label.as_deref()) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harness_default_label_daily() {
        let spec = serde_json::json!({ "hourLocal": 9, "minuteLocal": 0 });
        assert_eq!(default_label("daily", &spec), "daily-0900");
        let spec = serde_json::json!({ "hourLocal": 14, "minuteLocal": 30 });
        assert_eq!(default_label("daily", &spec), "daily-1430");
    }

    #[test]
    fn harness_default_label_weekly() {
        let spec = serde_json::json!({
            "weekday": 1, "hourLocal": 10, "minuteLocal": 0
        });
        assert_eq!(default_label("weekly", &spec), "weekly-mon-1000");
        let spec = serde_json::json!({
            "weekday": 5, "hourLocal": 17, "minuteLocal": 45
        });
        assert_eq!(default_label("weekly", &spec), "weekly-fri-1745");
    }

    #[test]
    fn harness_default_label_interval() {
        assert_eq!(
            default_label("interval", &serde_json::json!({"minutes": 60})),
            "every-1h"
        );
        assert_eq!(
            default_label("interval", &serde_json::json!({"minutes": 120})),
            "every-2h"
        );
        assert_eq!(
            default_label("interval", &serde_json::json!({"minutes": 15})),
            "every-15m"
        );
    }

    #[test]
    fn harness_default_label_once() {
        assert_eq!(default_label("once", &serde_json::json!({})), "once");
    }

    #[test]
    fn harness_validate_label_rejects_unsafe() {
        assert!(validate_label("").is_err());
        assert!(validate_label("..").is_err());
        assert!(validate_label(".").is_err());
        assert!(validate_label("foo/bar").is_err());
        assert!(validate_label("foo\\bar").is_err());
        assert!(validate_label(&"a".repeat(100)).is_err());
    }

    #[test]
    fn harness_validate_label_accepts_safe() {
        assert!(validate_label("daily-0900").is_ok());
        assert!(validate_label("every-1h").is_ok());
        assert!(validate_label("weekly-mon-1000").is_ok());
        assert!(validate_label("my_custom_label_v2").is_ok());
    }

    #[test]
    fn harness_validate_label_rejects_dots() {
        // Dots cause sanitise/slugify to disagree → output folder
        // collisions. See M1 fix comment.
        assert!(validate_label("my.label.v2").is_err());
        assert!(validate_label("v.2").is_err());
    }

    #[test]
    fn harness_path_for_composite_key() {
        // No label → bare filename.
        let bare = path_for("skill:repo-tldr", None);
        assert_eq!(bare.file_name().unwrap(), "skill_repo-tldr.json");
        // With label → double-underscore suffix.
        let labeled = path_for("skill:repo-tldr", Some("daily-0900"));
        assert_eq!(
            labeled.file_name().unwrap(),
            "skill_repo-tldr__daily-0900.json"
        );
        // Empty label → treated as no-label.
        let empty = path_for("skill:repo-tldr", Some(""));
        assert_eq!(empty.file_name().unwrap(), "skill_repo-tldr.json");
    }

    #[test]
    fn harness_path_for_sanitises_unsafe_label() {
        // Slashes in labels were already rejected by validate_label,
        // but path_for sanitises defensively so a bad upstream path
        // can't produce a file outside the schedules dir.
        let p = path_for("skill:x", Some("a/b\\c"));
        let n = p.file_name().unwrap().to_string_lossy();
        assert!(!n.contains('/'));
        assert!(!n.contains('\\'));
    }

    #[test]
    fn harness_schedule_label_optional_deserialize() {
        // Old schedule files don't have a label field. Must still parse.
        let json = r#"{
            "pipeline_name": "skill:repo-tldr",
            "kind": "daily",
            "spec": { "hourLocal": 9, "minuteLocal": 0 },
            "enabled": true,
            "notify": true,
            "sound": true,
            "last_run_at": null,
            "next_run_at": null,
            "history": []
        }"#;
        let s: Schedule = serde_json::from_str(json).expect("old schedule must parse");
        assert!(s.label.is_none());
    }
}
