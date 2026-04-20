//! Import an existing skill folder from anywhere on disk into
//! `~/.claude/skills/`.
//!
//! Intended flow: the user has a folder (e.g. a skill they shared via
//! zip, a snapshot from another machine, a one-off SKILL.md they wrote
//! in a scratch dir) and wants Orka to start managing it. We copy
//! (don't move — leave the original in peace) the folder under the
//! global skills root and let the watcher pick it up.
//!
//! Safety rules (fail closed):
//!   - Source must exist, be a dir, and contain a parseable SKILL.md
//!   - Destination slug must be a safe file-system name (no `/`, no
//!     `..`, no leading dot)
//!   - Collisions refused — caller must pass a different `desired_slug`
//!     OR remove the existing skill first. We never silently overwrite
//!     because SKILL.md is executable content.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct ImportOutcome {
    pub slug: String,
    #[serde(rename = "destPath")]
    pub dest_path: String,
}

#[tauri::command]
pub fn import_skill_folder(
    src_path: String,
    desired_slug: Option<String>,
) -> Result<ImportOutcome, String> {
    let src = PathBuf::from(&src_path);
    if !src.is_dir() {
        return Err(format!("source is not a directory: {}", src.display()));
    }
    let skill_md = src.join("SKILL.md");
    if !skill_md.is_file() {
        return Err(format!(
            "no SKILL.md in {} — that's the minimum we need to call this a skill",
            src.display()
        ));
    }

    // Parse frontmatter so we can (a) validate it's well-formed and
    // (b) fall back to the declared name if the caller didn't provide
    // a slug and the folder name is unsuitable.
    let parsed = crate::skill_md::parse_skill_md(&skill_md)
        .map_err(|e| format!("SKILL.md parse failed: {e}"))?;

    // Slug resolution order: explicit override → source folder name →
    // frontmatter `name`. Whichever we pick must pass the safe-slug
    // check below.
    let fallback_folder = src
        .file_name()
        .and_then(|n| n.to_str())
        .map(String::from)
        .unwrap_or_default();
    let candidate = desired_slug
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or_else(|| {
            if is_safe_slug(&fallback_folder) {
                Some(fallback_folder.clone())
            } else {
                None
            }
        })
        .or_else(|| {
            let n = parsed.name.trim();
            if is_safe_slug(n) {
                Some(n.to_string())
            } else {
                None
            }
        })
        .ok_or_else(|| {
            "couldn't derive a slug — folder name is unsuitable and frontmatter `name` is missing or invalid. Pass an explicit slug.".to_string()
        })?;

    if !is_safe_slug(&candidate) {
        return Err(format!(
            "slug '{candidate}' is invalid: use lowercase letters, digits, and hyphens only"
        ));
    }

    // Canonical destination: ~/.orka/skills/. Keeps ~/.claude/skills/
    // clean by default. User can later toggle "Expose to Claude CLI"
    // per skill to make it visible globally via a symlink.
    let dest_root = crate::skills::orka_skills_dir()
        .ok_or_else(|| "no home dir".to_string())?;
    std::fs::create_dir_all(&dest_root)
        .map_err(|e| format!("mkdir {}: {e}", dest_root.display()))?;

    let dest = dest_root.join(&candidate);
    if dest.exists() {
        return Err(format!(
            "'{candidate}' already exists at {}. Pick a different slug or delete the existing skill first.",
            dest.display()
        ));
    }
    // Also check the global claude dir — collision there is less
    // disastrous (we won't write to it) but we don't want two skills
    // with the same slug fighting for discovery.
    if let Some(claude) = dirs::home_dir().map(|h| h.join(".claude").join("skills").join(&candidate)) {
        if claude.exists() {
            return Err(format!(
                "'{candidate}' is already present in ~/.claude/skills/. Rename, delete that one first, or pick a different slug."
            ));
        }
    }

    // Refuse if the source IS the destination or would copy into itself.
    // Extremely rare but makes recursion-detection cheap.
    if let (Ok(src_canon), Ok(dest_canon)) = (src.canonicalize(), dest_root.canonicalize()) {
        if src_canon.starts_with(&dest_canon) {
            return Err(format!(
                "source is already inside {}. If you want a copy, move it out first.",
                dest_root.display()
            ));
        }
    }

    copy_dir_recursive(&src, &dest).map_err(|e| {
        // Best-effort cleanup so a half-copied skill doesn't linger.
        let _ = std::fs::remove_dir_all(&dest);
        format!("copy failed: {e}")
    })?;

    crate::skills::invalidate_skills_cache();

    Ok(ImportOutcome {
        slug: candidate,
        dest_path: dest.to_string_lossy().into_owned(),
    })
}

/// Stricter than a filesystem name check — matches the convention the
/// rest of the app uses for skill slugs (lowercase, digits, hyphens).
/// Rejecting underscores and mixed case keeps `/<slug>` invocations
/// predictable across platforms.
fn is_safe_slug(s: &str) -> bool {
    if s.is_empty() || s.len() > 80 {
        return false;
    }
    if s.starts_with('.') || s.starts_with('-') {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        // Reject every symlink — both file and directory. A malicious
        // skill archive with `link → /etc/passwd` used to copy that
        // file's content into the installed skill dir, exfiltrating
        // data from outside the archive's intended tree. We now
        // refuse all symlinks at import time and surface a clear
        // error so the user knows the archive is untrustworthy.
        if file_type.is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "skill import refuses symlinks — remove the link at {} before importing",
                    from.display()
                ),
            ));
        }
        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_slug_accepts_normal_shapes() {
        assert!(is_safe_slug("demo-maker"));
        assert!(is_safe_slug("a"));
        assert!(is_safe_slug("skill-42"));
        assert!(is_safe_slug("orka-pipeline-1776220876"));
    }

    #[test]
    fn safe_slug_rejects_bad_shapes() {
        assert!(!is_safe_slug(""));
        assert!(!is_safe_slug("UPPER"));
        assert!(!is_safe_slug("has space"));
        assert!(!is_safe_slug("has/slash"));
        assert!(!is_safe_slug(".hidden"));
        assert!(!is_safe_slug("-leading"));
        assert!(!is_safe_slug("under_score"));
        assert!(!is_safe_slug("dots.ok"));
        assert!(!is_safe_slug("path/../traversal"));
    }

    #[test]
    fn copy_dir_recursive_copies_nested_files() {
        let tmp = std::env::temp_dir()
            .join(format!("orka-import-test-{}", std::process::id()));
        let src = tmp.join("src");
        let dest = tmp.join("dest");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("SKILL.md"), "---\nname: x\n---\n\nbody\n").unwrap();
        std::fs::write(src.join("sub/data.txt"), "hi").unwrap();

        copy_dir_recursive(&src, &dest).unwrap();

        assert!(dest.join("SKILL.md").is_file());
        assert!(dest.join("sub/data.txt").is_file());
        assert_eq!(std::fs::read_to_string(dest.join("sub/data.txt")).unwrap(), "hi");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
