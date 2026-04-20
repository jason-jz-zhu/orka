//! Per-skill user-configurable output folders.
//!
//! A skill run's working directory used to always be
//! `~/OrkaCanvas/<ws>/nodes/<run_id>/` — opaque to users and invisible
//! to their normal file tooling. With a configured folder, runs land
//! in `<user_folder>/<timestamped_subfolder>/` so they're visible in
//! Finder, Spotlight, iCloud sync, git, etc.
//!
//! Storage: ~/.orka/skill-outputs.json. Per-user, per-machine.
//! Deliberately separate from SKILL.md — absolute home-directory paths
//! shouldn't travel with shared skills (a downloaded skill from another
//! user would embed their path). This config is user preference, not
//! skill metadata.
//!
//! Layout when configured:
//!
//!   <user_folder>/
//!     2026-04-19_2258_gstack/         ← manual run (slug from first input)
//!       summary.md                    ← user-facing artifacts
//!       .orka/                        ← system files (hidden)
//!         prompt.txt
//!     daily-0900/                     ← schedule label
//!       2026-04-20_0900/
//!         summary.md
//!
//! When unconfigured, the resolver falls back to the legacy per-workspace
//! node dir so existing installs keep working.

use crate::workspace;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SkillOutputConfig {
    pub output_folder: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subfolder_template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_subfolder_template: Option<String>,
}

type ConfigMap = BTreeMap<String, SkillOutputConfig>;

fn config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".orka").join("skill-outputs.json"))
}

fn load_all() -> ConfigMap {
    let Some(path) = config_path() else {
        return ConfigMap::new();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return ConfigMap::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_all(map: &ConfigMap) -> Result<(), String> {
    let Some(path) = config_path() else {
        return Err("no home dir".into());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))
}

/// Read a single skill's config, if any.
pub fn get_config(slug: &str) -> Option<SkillOutputConfig> {
    load_all().remove(slug)
}

/// Default subfolder naming templates. Manual runs include the first
/// input's slugified form so the folder name carries the "what" of the
/// run; scheduled runs drop that because they're already grouped by
/// label and tend to share inputs across fires.
const DEFAULT_MANUAL_TEMPLATE: &str = "{date}_{time}_{input:0}";
const DEFAULT_SCHEDULED_TEMPLATE: &str = "{date}_{time}";

/// Tilde expansion + absolute-path check. Relative paths are rejected
/// — a configured folder should be unambiguous, and silently relativizing
/// to cwd would cause surprise behavior when Orka restarts with a
/// different cwd.
pub fn expand_folder(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("folder path is empty".into());
    }
    let expanded = if let Some(rest) = trimmed.strip_prefix("~/") {
        dirs::home_dir()
            .ok_or_else(|| "no home dir for tilde expansion".to_string())?
            .join(rest)
    } else if trimmed == "~" {
        dirs::home_dir().ok_or_else(|| "no home dir for tilde expansion".to_string())?
    } else {
        PathBuf::from(trimmed)
    };
    if !expanded.is_absolute() {
        return Err(format!(
            "output_folder must be absolute or start with ~: {raw}"
        ));
    }
    Ok(expanded)
}

/// Slugify a free-form string into a filesystem-safe fragment. Keeps
/// ASCII alphanumerics, collapses runs of other chars into a single
/// dash, and strips leading/trailing dashes. Multi-byte chars (CJK,
/// emoji) get dropped — safer than transliterating, and the user can
/// always see the full input in the run record.
pub fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_dash = true; // suppresses leading dash
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        out.push_str("run");
    }
    // Cap length — long URLs as inputs would produce unwieldy folder names.
    if out.len() > 60 {
        out.truncate(60);
        while out.ends_with('-') {
            out.pop();
        }
    }
    out
}

/// Render a subfolder template with {date}, {time}, {input:N}, {input:first}.
/// Unknown placeholders are replaced with "unknown" so they never leak
/// into an actual filesystem name unescaped. All outputs are fed through
/// slugify so the final path component is safe.
pub fn render_subfolder(
    template: &str,
    now: chrono::DateTime<chrono::Local>,
    inputs: &[String],
) -> String {
    let date_str = now.format("%Y-%m-%d").to_string();
    let time_str = now.format("%H%M").to_string();

    let mut out = String::with_capacity(template.len() + 32);
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = template[i..].find('}') {
                let key = &template[i + 1..i + end];
                let replacement = resolve_template_var(key, &date_str, &time_str, inputs);
                out.push_str(&replacement);
                i += end + 1;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }

    // The template may have produced a name with slashes, spaces, etc.
    // Funnel it all through slugify so we can never produce a path with
    // separators in the "subfolder" component.
    slugify(&out)
}

fn resolve_template_var(
    key: &str,
    date: &str,
    time: &str,
    inputs: &[String],
) -> String {
    match key {
        "date" => date.to_string(),
        "time" => time.to_string(),
        "input:first" | "input:0" => inputs
            .first()
            .map(|s| slugify(s))
            .unwrap_or_default(),
        _ => {
            if let Some(idx_str) = key.strip_prefix("input:") {
                if let Ok(idx) = idx_str.parse::<usize>() {
                    return inputs
                        .get(idx)
                        .map(|s| slugify(s))
                        .unwrap_or_default();
                }
            }
            // Unknown var → empty (not literal {foo}), so it can't produce
            // a filesystem path fragment. slugify at the end will drop it.
            String::new()
        }
    }
}

/// Hidden sub-sub-folder holding Orka's internal per-run files
/// (prompt, stream dump, etc). Kept separate from the user-facing
/// folder so a directory listing only shows the artifacts the user
/// cares about.
pub fn internal_dir(workdir: &Path) -> PathBuf {
    workdir.join(".orka")
}

/// Pure resolver that takes an explicit config. Kept separate so tests
/// can exercise the logic without touching shared on-disk storage.
pub fn resolve_run_workdir_from_config(
    config: Option<&SkillOutputConfig>,
    schedule_label: Option<&str>,
    run_id: &str,
    inputs: &[String],
    now: chrono::DateTime<chrono::Local>,
) -> PathBuf {
    let Some(cfg) = config else {
        return workspace::node_dir(run_id);
    };
    let Ok(base) = expand_folder(&cfg.output_folder) else {
        return workspace::node_dir(run_id);
    };

    // Pick the template. Scheduled runs default to a different layout
    // that omits the input slug (which tends to be identical across fires).
    let (template, is_scheduled) = if schedule_label.is_some() {
        (
            cfg.scheduled_subfolder_template
                .as_deref()
                .unwrap_or(DEFAULT_SCHEDULED_TEMPLATE),
            true,
        )
    } else {
        (
            cfg.subfolder_template
                .as_deref()
                .unwrap_or(DEFAULT_MANUAL_TEMPLATE),
            false,
        )
    };

    let subfolder_name = render_subfolder(template, now, inputs);

    // Assemble the final path. Each component goes through slugify for
    // schedule labels too — otherwise user could put `../etc/passwd` in
    // a label and escape the configured base.
    let mut p = base;
    if is_scheduled {
        if let Some(label) = schedule_label {
            let label_slug = slugify(label);
            if !label_slug.is_empty() {
                p = p.join(label_slug);
            }
        }
    }
    p = p.join(subfolder_name);
    p
}

/// Resolve the working directory a skill run should use. Reads the
/// per-skill config from disk; falls back to the legacy node dir when
/// no slug is given or no config exists.
pub fn resolve_run_workdir(
    skill_slug: Option<&str>,
    schedule_label: Option<&str>,
    run_id: &str,
    inputs: &[String],
    now: chrono::DateTime<chrono::Local>,
) -> PathBuf {
    let cfg = skill_slug.and_then(get_config);
    resolve_run_workdir_from_config(
        cfg.as_ref(),
        schedule_label,
        run_id,
        inputs,
        now,
    )
}

// ---- Tauri commands ----

#[tauri::command]
pub fn get_skill_output_config(slug: String) -> Option<SkillOutputConfig> {
    get_config(&slug)
}

#[tauri::command]
pub fn list_skill_output_configs() -> ConfigMap {
    load_all()
}

#[tauri::command]
pub fn set_skill_output_folder(
    slug: String,
    folder: String,
    subfolder_template: Option<String>,
    scheduled_subfolder_template: Option<String>,
) -> Result<(), String> {
    if slug.is_empty() {
        return Err("slug required".into());
    }
    // Validate the folder now so the UI gets immediate feedback instead
    // of a cryptic error at run time.
    expand_folder(&folder)?;

    let mut all = load_all();
    all.insert(
        slug,
        SkillOutputConfig {
            output_folder: folder,
            subfolder_template,
            scheduled_subfolder_template,
        },
    );
    save_all(&all)
}

#[tauri::command]
pub fn clear_skill_output_folder(slug: String) -> Result<(), String> {
    let mut all = load_all();
    all.remove(&slug);
    save_all(&all)
}

/// Resolve the folder a run WOULD use, without actually mkdir'ing it.
/// Surfaced so the UI can show "Runs will land in …" previews in
/// ScheduleModal and SkillRunner.
#[tauri::command]
pub fn preview_run_workdir(
    skill_slug: Option<String>,
    schedule_label: Option<String>,
    run_id: String,
    inputs: Vec<String>,
) -> String {
    let now = chrono::Local::now();
    resolve_run_workdir(
        skill_slug.as_deref(),
        schedule_label.as_deref(),
        &run_id,
        &inputs,
        now,
    )
    .to_string_lossy()
    .to_string()
}

#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        // User-facing wording — "does not exist" sounds like a bug.
        // "folder was removed" tells the user what probably happened
        // (they deleted it, or a skill with user-configured output
        // folder pointed somewhere they've since cleaned up).
        return Err(format!(
            "folder was removed — nothing to reveal at {}",
            path
        ));
    }
    // Canonicalize to resolve any symlinks in the path, then verify the
    // result stays under a safe root. Without this a symlink inside a
    // legitimate workdir could point at `~/.ssh/` or `/etc/` and we'd
    // reveal sensitive files in Finder. We allow anything under the
    // user's home or `/tmp` (for test workflows); anything else is
    // refused.
    let canonical = p.canonicalize().map_err(|e| format!("canonicalize: {e}"))?;
    let home = dirs::home_dir().ok_or("no home dir")?;
    let under_home = canonical.starts_with(&home);
    let under_tmp = canonical.starts_with("/tmp") || canonical.starts_with("/private/tmp");
    if !under_home && !under_tmp {
        return Err(format!(
            "refusing to reveal {} — path escaped safe roots (~ or /tmp)",
            canonical.display()
        ));
    }
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg("-R")
            .arg(&p)
            .status()
            .map_err(|e| format!("spawn open: {e}"))?;
        if !status.success() {
            return Err(format!("open -R exit {:?}", status.code()));
        }
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        let status = std::process::Command::new("xdg-open")
            .arg(&p)
            .status()
            .map_err(|e| format!("spawn xdg-open: {e}"))?;
        if !status.success() {
            return Err(format!("xdg-open exit {:?}", status.code()));
        }
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        let status = std::process::Command::new("explorer")
            .arg(format!("/select,{}", p.display()))
            .status()
            .map_err(|e| format!("spawn explorer: {e}"))?;
        if !status.success() {
            return Err(format!("explorer exit {:?}", status.code()));
        }
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = p;
        Err("reveal_in_finder not supported on this platform".into())
    }
}

// ---- Harness tests ----

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn fixed_time() -> chrono::DateTime<chrono::Local> {
        chrono::Local
            .with_ymd_and_hms(2026, 4, 19, 22, 58, 22)
            .unwrap()
    }

    #[test]
    fn harness_slugify_ascii_alnum() {
        assert_eq!(slugify("Hello World"), "hello-world");
        assert_eq!(slugify("https://github.com/foo/bar"), "https-github-com-foo-bar");
        assert_eq!(slugify("a!!!b"), "a-b");
        assert_eq!(slugify("  spaces  "), "spaces");
    }

    #[test]
    fn harness_slugify_handles_unicode_by_dropping() {
        // CJK and emoji become dashes (dropped) — safer than transliteration,
        // which can produce nonsense folder names.
        assert_eq!(slugify("你好 world"), "world");
        assert_eq!(slugify("🔥 fire"), "fire");
        // If input is entirely non-ASCII, fall back to "run" so we never
        // produce an empty folder name.
        assert_eq!(slugify("你好"), "run");
        assert_eq!(slugify(""), "run");
    }

    #[test]
    fn harness_slugify_length_capped() {
        let long = "a".repeat(200);
        let out = slugify(&long);
        assert!(out.len() <= 60, "slug should be capped: {}", out.len());
    }

    #[test]
    fn harness_render_subfolder_defaults() {
        // Default manual template with a URL input.
        let rendered = render_subfolder(
            DEFAULT_MANUAL_TEMPLATE,
            fixed_time(),
            &["https://github.com/foo/bar".into()],
        );
        assert_eq!(rendered, "2026-04-19-2258-https-github-com-foo-bar");

        // Default scheduled template drops the input slug.
        let rendered = render_subfolder(
            DEFAULT_SCHEDULED_TEMPLATE,
            fixed_time(),
            &["irrelevant".into()],
        );
        assert_eq!(rendered, "2026-04-19-2258");
    }

    #[test]
    fn harness_render_subfolder_indexed_inputs() {
        let rendered = render_subfolder(
            "{date}_{input:1}",
            fixed_time(),
            &["first".into(), "second".into()],
        );
        assert_eq!(rendered, "2026-04-19-second");
    }

    #[test]
    fn harness_render_subfolder_missing_input() {
        // {input:0} with no inputs just drops — doesn't crash.
        let rendered = render_subfolder("{date}_{input:0}", fixed_time(), &[]);
        assert_eq!(rendered, "2026-04-19");
    }

    #[test]
    fn harness_template_path_escape_blocked() {
        // Even with a malicious input, slugify prevents / and .. from
        // appearing in the final folder name — no way to break out of base.
        let rendered = render_subfolder(
            "{date}_{input:0}",
            fixed_time(),
            &["../../etc/passwd".into()],
        );
        assert!(
            !rendered.contains(".."),
            "template must not surface '..' into path: {rendered}"
        );
        assert!(
            !rendered.contains('/'),
            "template must not surface '/' into path: {rendered}"
        );
    }

    #[test]
    fn harness_expand_folder_tilde() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(expand_folder("~/Documents/x").unwrap(), home.join("Documents/x"));
        assert_eq!(expand_folder("~").unwrap(), home);
    }

    #[test]
    fn harness_expand_folder_rejects_relative() {
        assert!(expand_folder("relative/path").is_err());
        assert!(expand_folder("").is_err());
        assert!(expand_folder("   ").is_err());
    }

    #[test]
    fn harness_expand_folder_accepts_absolute() {
        let out = expand_folder("/tmp/work").unwrap();
        assert_eq!(out, PathBuf::from("/tmp/work"));
    }

    #[test]
    fn harness_resolve_fallback_no_config() {
        // No config → fallback to legacy node dir.
        let out = resolve_run_workdir_from_config(
            None,
            None,
            "run-abc",
            &[],
            fixed_time(),
        );
        let s = out.to_string_lossy();
        assert!(s.contains("nodes"), "expected node_dir fallback: {s}");
        assert!(s.ends_with("run-abc"), "expected run-id suffix: {s}");
    }

    #[test]
    fn harness_resolve_with_config_manual() {
        let cfg = SkillOutputConfig {
            output_folder: "/tmp/orka-test".into(),
            subfolder_template: None,
            scheduled_subfolder_template: None,
        };
        let out = resolve_run_workdir_from_config(
            Some(&cfg),
            None,
            "ignored",
            &["github.com/x".into()],
            fixed_time(),
        );
        assert_eq!(
            out,
            PathBuf::from("/tmp/orka-test").join("2026-04-19-2258-github-com-x")
        );
    }

    #[test]
    fn harness_resolve_with_config_scheduled() {
        let cfg = SkillOutputConfig {
            output_folder: "/tmp/orka-test".into(),
            subfolder_template: None,
            scheduled_subfolder_template: None,
        };
        let out = resolve_run_workdir_from_config(
            Some(&cfg),
            Some("daily 09:00"),
            "ignored",
            &["ignored".into()],
            fixed_time(),
        );
        assert_eq!(
            out,
            PathBuf::from("/tmp/orka-test")
                .join("daily-09-00")
                .join("2026-04-19-2258")
        );
    }

    #[test]
    fn harness_schedule_label_cannot_escape() {
        let cfg = SkillOutputConfig {
            output_folder: "/tmp/orka-test".into(),
            subfolder_template: None,
            scheduled_subfolder_template: None,
        };
        let out = resolve_run_workdir_from_config(
            Some(&cfg),
            Some("../../etc"),
            "x",
            &[],
            fixed_time(),
        );
        let s = out.to_string_lossy();
        assert!(s.starts_with("/tmp/orka-test"), "escaped base: {s}");
        assert!(!s.contains(".."), "path must not contain ..: {s}");
    }

    #[test]
    fn harness_resolve_custom_template_used() {
        let cfg = SkillOutputConfig {
            output_folder: "/tmp/orka-test".into(),
            subfolder_template: Some("{date}".into()),
            scheduled_subfolder_template: Some("{time}".into()),
        };
        // Manual → subfolder_template
        let out = resolve_run_workdir_from_config(
            Some(&cfg), None, "x", &[], fixed_time(),
        );
        assert_eq!(out, PathBuf::from("/tmp/orka-test/2026-04-19"));
        // Scheduled → scheduled_subfolder_template
        let out = resolve_run_workdir_from_config(
            Some(&cfg), Some("daily"), "x", &[], fixed_time(),
        );
        assert_eq!(out, PathBuf::from("/tmp/orka-test/daily/2258"));
    }

    #[test]
    fn harness_internal_dir_layout() {
        let workdir = PathBuf::from("/tmp/work");
        let internal = internal_dir(&workdir);
        assert_eq!(internal, PathBuf::from("/tmp/work/.orka"));
    }

    #[test]
    fn harness_config_serde_roundtrip() {
        // Serde round-trip without touching shared disk — proves the
        // on-disk shape is what we expect. Uses serde directly instead
        // of load_all/save_all so tests don't race on the user's config.
        let mut map = ConfigMap::new();
        map.insert(
            "repo-tldr".into(),
            SkillOutputConfig {
                output_folder: "~/Documents/repo-tldr".into(),
                subfolder_template: Some("{date}_{input:0}".into()),
                scheduled_subfolder_template: None,
            },
        );
        let json = serde_json::to_string_pretty(&map).unwrap();
        // scheduled_subfolder_template is None → should be omitted.
        assert!(!json.contains("scheduled_subfolder_template"));
        // subfolder_template is Some → should be present.
        assert!(json.contains("subfolder_template"));

        let parsed: ConfigMap = serde_json::from_str(&json).unwrap();
        let cfg = parsed.get("repo-tldr").unwrap();
        assert_eq!(cfg.output_folder, "~/Documents/repo-tldr");
        assert_eq!(cfg.subfolder_template.as_deref(), Some("{date}_{input:0}"));
        assert!(cfg.scheduled_subfolder_template.is_none());
    }

    #[test]
    fn harness_set_rejects_bad_folder() {
        // Relative paths must be rejected at write time.
        let slug = format!("bad-{}", std::process::id());
        let err = set_skill_output_folder(
            slug,
            "relative/bad".into(),
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("absolute"), "unexpected error: {err}");
    }
}
