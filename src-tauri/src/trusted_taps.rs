//! Trusted Taps — bundled authoritative skill sources.
//!
//! Mental model (Homebrew-inspired):
//!   - A "tap" is a git repo containing skills.
//!   - Installing a tap clones it into `~/.orka/taps/<id>/` and symlinks
//!     each skill directory into `~/.claude/skills/<id>-<skill>/`.
//!   - Claude Code sees each skill under its prefixed slug (e.g.
//!     `gstack-ship`) at the flat layout it expects. No collisions with
//!     user-authored skills.
//!   - Uninstall removes the symlinks and the cloned tap directory;
//!     user-authored skills are never touched.
//!
//! File layout:
//!
//! ~/.orka/
//!   trusted-taps.json              # user-added custom taps (not builtins)
//!   taps/
//!     gstack/                      # git clone of a tap
//!       ship/
//!         SKILL.md
//!       review/
//!         SKILL.md
//!
//! ~/.claude/skills/
//!   gstack-ship/   -> symlink to ~/.orka/taps/gstack/ship/
//!   gstack-review/ -> symlink to ~/.orka/taps/gstack/review/
//!   my-own-skill/  # user-authored, untouched

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tap {
    /// Stable short id — used as directory name and slug prefix.
    pub id: String,
    /// Display name.
    pub name: String,
    pub description: String,
    /// Git URL (https or git+ssh).
    pub url: String,
    /// True if this tap ships with Orka; custom taps are user-added.
    #[serde(rename = "isBuiltin")]
    pub is_builtin: bool,
    /// Whether the tap is currently installed (derived at list time).
    #[serde(skip_deserializing, default)]
    pub installed: bool,
    /// Number of SKILL.md files detected when listed (0 if uninstalled).
    #[serde(skip_deserializing, default)]
    pub skill_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CustomTapsFile {
    #[serde(default)]
    taps: Vec<Tap>,
}

fn builtin_taps() -> Vec<Tap> {
    vec![
        Tap {
            id: "gstack".into(),
            name: "gstack".into(),
            description:
                "Garry Tan's opinionated Claude Code skill stack — /ship, /review, /cso, /office-hours, etc."
                    .into(),
            url: "https://github.com/garrytan/gstack".into(),
            is_builtin: true,
            installed: false,
            skill_count: 0,
        },
    ]
}

fn orka_home() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".orka"))
}

fn taps_root() -> Option<PathBuf> {
    orka_home().map(|d| d.join("taps"))
}

fn claude_skills_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("skills"))
}

fn custom_taps_file() -> Option<PathBuf> {
    orka_home().map(|d| d.join("trusted-taps.json"))
}

fn load_custom_taps() -> Vec<Tap> {
    let Some(path) = custom_taps_file() else { return vec![] };
    let Ok(s) = std::fs::read_to_string(&path) else { return vec![] };
    serde_json::from_str::<CustomTapsFile>(&s)
        .map(|f| f.taps)
        .unwrap_or_default()
}

fn save_custom_taps(taps: &[Tap]) -> Result<(), String> {
    let Some(path) = custom_taps_file() else { return Err("no home dir".into()) };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let file = CustomTapsFile { taps: taps.to_vec() };
    let json = serde_json::to_string_pretty(&file).map_err(|e| format!("serialize: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))
}

fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn tap_clone_dir(id: &str) -> Option<PathBuf> {
    if !is_valid_id(id) {
        return None;
    }
    taps_root().map(|r| r.join(id))
}

/// Count SKILL.md files in the cloned directory (one-level deep).
fn count_skills_in(dir: &Path) -> u32 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut count = 0u32;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.join("SKILL.md").is_file() {
            count += 1;
        }
    }
    count
}

fn enrich_with_status(tap: &mut Tap) {
    if let Some(clone_dir) = tap_clone_dir(&tap.id) {
        if clone_dir.is_dir() {
            tap.installed = true;
            tap.skill_count = count_skills_in(&clone_dir);
            return;
        }
    }
    tap.installed = false;
    tap.skill_count = 0;
}

#[tauri::command]
pub async fn list_trusted_taps() -> Result<Vec<Tap>, String> {
    let mut out: Vec<Tap> = builtin_taps();
    out.extend(load_custom_taps());
    for t in out.iter_mut() {
        enrich_with_status(t);
    }
    Ok(out)
}

/// Install a tap by id. For builtin ids we know the URL; for custom taps
/// the URL must be set by prior `add_custom_tap`. The clone lives under
/// `~/.orka/taps/<id>/`; each SKILL.md-bearing subdir is symlinked into
/// `~/.claude/skills/<id>-<slug>/` so Claude Code finds it at its flat
/// expected layout without colliding with user-authored skills.
#[tauri::command]
pub async fn install_tap(id: String) -> Result<u32, String> {
    if !is_valid_id(&id) {
        return Err(format!("invalid tap id: {id}"));
    }

    // Resolve URL from builtin or custom list.
    let all: Vec<Tap> = {
        let mut v = builtin_taps();
        v.extend(load_custom_taps());
        v
    };
    let tap = all
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("unknown tap: {id}"))?;

    let root = taps_root().ok_or("no home dir")?;
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|e| format!("mkdir taps/: {e}"))?;

    let clone_dir = root.join(&id);
    if clone_dir.exists() {
        return Err(format!(
            "tap '{id}' already installed at {} — uninstall first",
            clone_dir.display()
        ));
    }

    // Shallow clone for speed and disk usage.
    let output = tokio::process::Command::new("git")
        .args([
            "clone",
            "--depth",
            "1",
            "--single-branch",
            &tap.url,
            clone_dir.to_str().ok_or("bad path")?,
        ])
        .output()
        .await
        .map_err(|e| format!("spawn git: {e} (is git installed?)"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "git clone failed ({}): {}",
            output.status.code().unwrap_or(-1),
            err.trim()
        ));
    }

    // Link each SKILL.md-bearing subdirectory into ~/.claude/skills/.
    let skills_root = claude_skills_root().ok_or("no home dir")?;
    tokio::fs::create_dir_all(&skills_root)
        .await
        .map_err(|e| format!("mkdir claude skills: {e}"))?;

    let linked = link_tap_skills(&id, &clone_dir, &skills_root)?;
    Ok(linked)
}

/// Create the per-skill symlinks. On conflict (target already exists)
/// we skip that skill rather than overwrite user state; the returned
/// count reflects actually-linked skills.
fn link_tap_skills(
    id: &str,
    clone_dir: &Path,
    skills_root: &Path,
) -> Result<u32, String> {
    let mut linked = 0u32;
    let entries = std::fs::read_dir(clone_dir)
        .map_err(|e| format!("read {}: {e}", clone_dir.display()))?;
    for entry in entries.flatten() {
        let src = entry.path();
        if !src.is_dir() {
            continue;
        }
        if !src.join("SKILL.md").is_file() {
            continue;
        }
        let Some(slug) = src.file_name().and_then(|n| n.to_str()) else { continue };
        if slug.starts_with('.') {
            continue;
        }
        let target_name = format!("{id}-{slug}");
        let target = skills_root.join(&target_name);
        if target.exists() {
            // Don't clobber — most commonly it's a leftover link we should
            // also count as "installed" so the UI agrees. Skip and move on.
            continue;
        }
        #[cfg(unix)]
        {
            if let Err(e) = std::os::unix::fs::symlink(&src, &target) {
                eprintln!(
                    "[trusted_taps] symlink {} → {} failed: {e}",
                    target.display(),
                    src.display()
                );
                continue;
            }
        }
        #[cfg(not(unix))]
        {
            // Fallback: copy the directory. Windows support is best-effort.
            if let Err(e) = copy_dir_recursive(&src, &target) {
                eprintln!("[trusted_taps] copy fallback failed: {e}");
                continue;
            }
        }
        linked += 1;
    }
    Ok(linked)
}

#[cfg(not(unix))]
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Uninstall: remove all `<id>-*` entries from ~/.claude/skills/ that
/// point into our tap clone, then remove the clone itself. Only removes
/// entries that are symlinks pointing inside the tap — never touches
/// user-authored skills that happen to share the prefix.
#[tauri::command]
pub async fn uninstall_tap(id: String) -> Result<u32, String> {
    if !is_valid_id(&id) {
        return Err(format!("invalid tap id: {id}"));
    }
    let skills_root = claude_skills_root().ok_or("no home dir")?;
    let clone_dir = tap_clone_dir(&id).ok_or("bad id")?;
    let prefix = format!("{id}-");

    let mut removed = 0u32;
    if skills_root.is_dir() {
        let entries = std::fs::read_dir(&skills_root)
            .map_err(|e| format!("read skills dir: {e}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !name.starts_with(&prefix) {
                continue;
            }
            // Only remove if it's a symlink into our clone dir (don't
            // touch anything the user may have set up manually).
            let is_ours = match std::fs::read_link(&path) {
                Ok(target) => target.starts_with(&clone_dir),
                Err(_) => {
                    // Not a symlink; only our fallback (copy) would have
                    // made it. We conservatively skip — user can remove
                    // manually if they installed via the Windows path.
                    false
                }
            };
            if !is_ours {
                continue;
            }
            if std::fs::remove_file(&path).is_ok() || std::fs::remove_dir_all(&path).is_ok() {
                removed += 1;
            }
        }
    }

    if clone_dir.is_dir() {
        std::fs::remove_dir_all(&clone_dir)
            .map_err(|e| format!("remove clone: {e}"))?;
    }

    Ok(removed)
}

/// Register a user-supplied tap. Doesn't clone — the user must call
/// install_tap afterwards. Rejects duplicates (by id) and builtin-id
/// collisions.
#[tauri::command]
pub async fn add_custom_tap(
    id: String,
    name: String,
    description: String,
    url: String,
) -> Result<(), String> {
    if !is_valid_id(&id) {
        return Err("id must be alphanumeric/dash/underscore, ≤32 chars".into());
    }
    if builtin_taps().iter().any(|t| t.id == id) {
        return Err(format!("'{id}' is a reserved builtin id"));
    }
    let mut current = load_custom_taps();
    if current.iter().any(|t| t.id == id) {
        return Err(format!("tap '{id}' already added"));
    }
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("git@")) {
        return Err("url must start with https://, http:// or git@".into());
    }
    current.push(Tap {
        id,
        name,
        description,
        url,
        is_builtin: false,
        installed: false,
        skill_count: 0,
    });
    save_custom_taps(&current)
}

#[tauri::command]
pub async fn remove_custom_tap(id: String) -> Result<(), String> {
    let mut current = load_custom_taps();
    let before = current.len();
    current.retain(|t| t.id != id);
    if current.len() == before {
        return Err(format!("custom tap '{id}' not found"));
    }
    save_custom_taps(&current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_id_accepts_safe() {
        assert!(is_valid_id("gstack"));
        assert!(is_valid_id("my-tap-1"));
        assert!(is_valid_id("foo_bar"));
    }

    #[test]
    fn valid_id_rejects_unsafe() {
        assert!(!is_valid_id(""));
        assert!(!is_valid_id("has/slash"));
        assert!(!is_valid_id("has space"));
        assert!(!is_valid_id("has.dot"));
        assert!(!is_valid_id("a".repeat(40).as_str()));
    }

    #[test]
    fn builtin_gstack_present() {
        let taps = builtin_taps();
        assert!(taps.iter().any(|t| t.id == "gstack"));
    }
}
