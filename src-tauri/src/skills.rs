use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Instant, UNIX_EPOCH};

use crate::skill_md;

#[derive(Debug, Clone, Serialize)]
pub struct SkillMeta {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: SkillSource,
    pub has_graph: bool,
    pub inputs: Vec<SkillInputMeta>,
    /// Natural-language example prompts, surfaced in the SkillRunner as
    /// clickable chips. Skill authors write 1-3 concrete examples to
    /// guide first-time users on what to type.
    pub examples: Vec<String>,
    /// True when this skill is visible to the plain `claude` CLI — i.e.
    /// either it lives directly in `~/.claude/skills/` (Global source)
    /// or there's a symlink at `~/.claude/skills/<slug>` pointing into
    /// our Orka root. The UI shows a chain-link icon for exposed Orka
    /// skills so users know which ones leak into global CLI space.
    pub exposed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillInputMeta {
    pub name: String,
    #[serde(rename = "type")]
    pub input_type: String,
    pub default: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillSource {
    /// Canonical Orka-managed skills under `~/.orka/skills/`. These
    /// live outside `~/.claude/skills/` by default so Orka doesn't
    /// pollute the user's global Claude Code skill list. Exposing a
    /// skill to the `claude` CLI is opt-in via a symlink.
    Orka,
    /// Hand-authored or tap-installed skills in `~/.claude/skills/`.
    /// These show up in any `claude` session; Orka scans but doesn't
    /// own them.
    Global,
    /// Project-scoped skills under `<workspace>/.claude/skills/`.
    Workspace,
    #[allow(dead_code)] // reserved; for sibling-repo skill discovery (future)
    Sibling,
}

/// Cache for scan_skills_dirs. Keyed on root-dir mtimes + a 2s freshness
/// window — the root mtime alone misses edits to existing SKILL.md files,
/// so the TTL catches those. Typical list_available_skills calls during
/// a session are clustered (tab switch, palette open, etc.), so even a
/// 2s cache eliminates most redundant filesystem work.
///
/// Fingerprint is (orka, global, workspace) root mtimes.
struct SkillsCache {
    fingerprint: (u64, u64, u64),
    cached_at: Instant,
    data: Vec<SkillMeta>,
}

static SKILLS_CACHE: LazyLock<Mutex<Option<SkillsCache>>> =
    LazyLock::new(|| Mutex::new(None));

const SKILLS_CACHE_TTL_MS: u128 = 2000;

/// Per-SKILL.md parse cache, keyed on (path, mtime_ms, size_bytes).
/// When the top-level scan cache busts but individual SKILL.md files
/// haven't changed, we reuse the parsed result instead of re-reading
/// and re-parsing. Matters for workflows that touch the skills dir
/// often (installing, renaming) but only change one file — previous
/// implementation re-parsed every skill on every scan.
#[derive(Clone)]
struct CachedSkillParse {
    mtime_ms: u64,
    size: u64,
    meta: SkillMeta,
}

static PER_SKILL_CACHE: LazyLock<
    Mutex<std::collections::HashMap<PathBuf, CachedSkillParse>>,
> = LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

fn dir_mtime_ms(p: Option<&Path>) -> u64 {
    p.and_then(|path| std::fs::metadata(path).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Canonical Orka skills root: `~/.orka/skills/`. This is where the
/// skill-builder writes new skills, where imports land, and where
/// Orka-authored content lives long-term. Separate from
/// `~/.claude/skills/` so Orka doesn't clutter the user's global
/// Claude Code skill list.
pub fn orka_skills_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".orka").join("skills"))
}

/// Clear the skills cache. Call from watcher events or after install/uninstall.
pub fn invalidate_skills_cache() {
    let mut guard = SKILLS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

pub fn scan_skills_dirs() -> Vec<SkillMeta> {
    let orka = orka_skills_dir();
    let global = global_skills_dir();
    let workspace = workspace_skills_dir();
    // Fingerprint the 3 scan roots. Changes to any of them bust the
    // cache. A more granular cache would track per-skill SKILL.md
    // mtimes, but the 2s TTL already handles the common case.
    let fingerprint = (
        dir_mtime_ms(orka.as_deref()),
        dir_mtime_ms(global.as_deref()),
        dir_mtime_ms(workspace.as_deref()),
    );

    {
        let guard = SKILLS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(c) = guard.as_ref() {
            if c.fingerprint == fingerprint
                && c.cached_at.elapsed().as_millis() < SKILLS_CACHE_TTL_MS
            {
                return c.data.clone();
            }
        }
    }

    let mut results = Vec::new();
    let mut seen_slugs = std::collections::HashSet::new();

    // Scan order = dedup priority. Orka root wins — if a symlink at
    // ~/.claude/skills/<slug> points back to ~/.orka/skills/<slug>,
    // we want the canonical Orka entry, not the shadow.
    if let Some(o) = orka.as_ref() {
        scan_dir(o, SkillSource::Orka, &mut results, &mut seen_slugs);
    }
    if let Some(g) = global.as_ref() {
        scan_dir(g, SkillSource::Global, &mut results, &mut seen_slugs);
    }
    if let Some(ws) = workspace.as_ref() {
        scan_dir(ws, SkillSource::Workspace, &mut results, &mut seen_slugs);
    }

    let mut guard = SKILLS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(SkillsCache {
        fingerprint,
        cached_at: Instant::now(),
        data: results.clone(),
    });
    results
}

fn global_skills_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("skills"))
}

fn workspace_skills_dir() -> Option<PathBuf> {
    let ws = crate::workspace::templates_dir();
    let ws_root = ws.parent()?;
    Some(ws_root.join(".claude").join("skills"))
}

fn scan_dir(
    dir: &Path,
    source: SkillSource,
    results: &mut Vec<SkillMeta>,
    seen: &mut std::collections::HashSet<String>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        let skill_md_path = path.join("SKILL.md");
        let Ok(md_meta) = std::fs::metadata(&skill_md_path) else { continue };

        let slug = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if slug.is_empty() || slug.starts_with('.') { continue; }
        if seen.contains(&slug) { continue; }

        // Per-skill cache lookup. Keyed on mtime+size so a `touch` alone
        // doesn't bust the cache if the content is unchanged — and a
        // real edit (size change OR mtime change) always does.
        let mtime_ms = md_meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let size = md_meta.len();

        let cached: Option<SkillMeta> = {
            let cache = PER_SKILL_CACHE
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            cache.get(&skill_md_path).and_then(|c| {
                if c.mtime_ms == mtime_ms && c.size == size {
                    Some(c.meta.clone())
                } else {
                    None
                }
            })
        };

        let meta = if let Some(m) = cached {
            m
        } else {
            // Parse and insert into the per-skill cache.
            let Ok(parsed) = skill_md::parse_skill_md(&skill_md_path) else {
                continue;
            };
            let inputs = parsed.inputs.iter().map(|i| SkillInputMeta {
                name: i.name.clone(),
                input_type: i.input_type.clone(),
                default: i.default.clone(),
                description: i.description.clone(),
            }).collect();
            // Exposed = visible to the plain `claude` CLI. True if the
            // skill lives directly in ~/.claude/skills/ (Global), or if
            // there's a same-slug symlink in ~/.claude/skills/ pointing
            // into our Orka root (user has explicitly opted in).
            let exposed = is_exposed_to_claude(&slug, &source);
            let meta = SkillMeta {
                slug: slug.clone(),
                name: parsed.name,
                description: parsed.description,
                path: skill_md_path.to_string_lossy().to_string(),
                source: source.clone(),
                has_graph: parsed.graph.is_some(),
                inputs,
                examples: parsed.examples,
                exposed,
            };
            let mut cache = PER_SKILL_CACHE
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            cache.insert(
                skill_md_path.clone(),
                CachedSkillParse { mtime_ms, size, meta: meta.clone() },
            );
            meta
        };

        seen.insert(slug);
        results.push(meta);
    }
}

/// True when a skill of this slug would be picked up by a bare `claude`
/// invocation. Always true for Global (it lives there) and Workspace
/// (it lives in the workspace's .claude/skills/). For Orka-canonical
/// skills, requires an explicit symlink in ~/.claude/skills/<slug>.
fn is_exposed_to_claude(slug: &str, source: &SkillSource) -> bool {
    match source {
        SkillSource::Global | SkillSource::Workspace => true,
        SkillSource::Sibling => false,
        SkillSource::Orka => {
            let Some(root) = global_skills_dir() else { return false };
            let link_path = root.join(slug);
            // `symlink_metadata` does NOT follow the link — we want to
            // detect the presence of the link entry itself, even if the
            // target is broken.
            std::fs::symlink_metadata(&link_path)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
        }
    }
}

/// Expose an Orka-canonical skill to the plain `claude` CLI by creating
/// a symlink at `~/.claude/skills/<slug>` → `~/.orka/skills/<slug>`.
///
/// Safety: refuses if a non-symlink already exists at the target path,
/// which would mean the user has a hand-authored global skill by the
/// same name. We never clobber.
///
/// Idempotent: creating a link that already points to the right place
/// is a no-op. If a symlink exists pointing elsewhere, that's treated
/// as "another tool's property" and refused.
#[tauri::command]
pub fn expose_skill(slug: String) -> Result<(), String> {
    if slug.is_empty() || slug.contains('/') || slug.contains("..") {
        return Err(format!("invalid slug: {slug}"));
    }
    let orka_root = orka_skills_dir().ok_or("no home dir")?;
    let claude_root = global_skills_dir().ok_or("no home dir")?;
    let source = orka_root.join(&slug);
    let target = claude_root.join(&slug);

    if !source.join("SKILL.md").is_file() {
        return Err(format!(
            "'{slug}' not found under {} — only Orka-canonical skills can be exposed",
            orka_root.display()
        ));
    }

    // Ensure claude skills dir exists (first-ever expose on a fresh install).
    std::fs::create_dir_all(&claude_root)
        .map_err(|e| format!("mkdir {}: {e}", claude_root.display()))?;

    // Inspect the target; decide based on what's there.
    match std::fs::symlink_metadata(&target) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                // Already a symlink. If it already points where we want,
                // we're done. Otherwise refuse — another manager owns it.
                let existing = std::fs::read_link(&target).map_err(|e| e.to_string())?;
                if existing == source {
                    invalidate_skills_cache();
                    return Ok(());
                }
                return Err(format!(
                    "refusing to expose: a symlink at {} already points elsewhere ({}).",
                    target.display(),
                    existing.display()
                ));
            } else {
                return Err(format!(
                    "refusing to expose: {} already exists as a real file/dir. Rename it or pick a different slug.",
                    target.display()
                ));
            }
        }
        Err(_) => {
            // Nothing there — safe to create the symlink.
        }
    }

    #[cfg(unix)]
    std::os::unix::fs::symlink(&source, &target)
        .map_err(|e| format!("symlink: {e}"))?;
    #[cfg(not(unix))]
    return Err("expose_skill is unix-only for now".to_string());

    invalidate_skills_cache();
    Ok(())
}

/// Remove the `~/.claude/skills/<slug>` symlink created by expose_skill.
/// Refuses if the entry isn't a symlink (would risk deleting a real
/// hand-authored skill by the same name). No-op if nothing's there.
#[tauri::command]
pub fn unexpose_skill(slug: String) -> Result<(), String> {
    if slug.is_empty() || slug.contains('/') || slug.contains("..") {
        return Err(format!("invalid slug: {slug}"));
    }
    let claude_root = global_skills_dir().ok_or("no home dir")?;
    let target = claude_root.join(&slug);

    match std::fs::symlink_metadata(&target) {
        Ok(meta) => {
            if !meta.file_type().is_symlink() {
                return Err(format!(
                    "'{slug}' at {} is a real skill, not a symlink — refusing to remove. Use delete_skill instead if you meant to wipe it.",
                    target.display()
                ));
            }
            std::fs::remove_file(&target)
                .map_err(|e| format!("remove symlink: {e}"))?;
            invalidate_skills_cache();
            Ok(())
        }
        Err(_) => Ok(()), // Nothing to remove.
    }
}

pub fn get_skill(slug: &str) -> Result<SkillMeta, String> {
    let all = scan_skills_dirs();
    all.into_iter()
        .find(|s| s.slug == slug)
        .ok_or_else(|| format!("skill '{}' not found", slug))
}

/// Delete a skill's directory (the folder that contains SKILL.md). The
/// whole directory is removed because skills may ship supporting files
/// (graph.json, sub-skills, templates) alongside their SKILL.md —
/// leaving those behind would corrupt the workspace.
///
/// Safety guards (fail-closed):
///   - Refuse to operate outside the global or workspace skills roots.
///     This prevents a malformed slug from deleting random directories.
///   - Refuse to delete if the resolved path is NOT the direct child of
///     one of those roots (no path traversal via `../`).
///   - Refuse to delete tap-managed skills (symlinks into ~/.orka/taps/).
///     Users should uninstall the tap instead.
///
/// Returns Ok(()) on success. Invalidates the skills cache so the next
/// refresh picks up the removal.
#[tauri::command]
pub fn delete_skill(slug: String) -> Result<(), String> {
    if slug.is_empty() || slug.contains('/') || slug.contains("..") {
        return Err(format!("invalid skill slug: {slug}"));
    }

    // Build the allow-list of root directories. Only descendants of
    // these may be touched. Orka root goes first — if a skill lives
    // canonically there AND is exposed via a symlink in the global
    // root, we want to remove both (the canonical target AND the link).
    let mut allowed_roots: Vec<PathBuf> = Vec::new();
    if let Some(o) = orka_skills_dir() {
        allowed_roots.push(o);
    }
    if let Some(g) = global_skills_dir() {
        allowed_roots.push(g);
    }
    if let Some(w) = workspace_skills_dir() {
        allowed_roots.push(w);
    }

    // Find the canonical directory (orka > global > workspace).
    let target = allowed_roots.iter().find_map(|root| {
        let candidate = root.join(&slug);
        if candidate.join("SKILL.md").is_file() {
            Some(candidate)
        } else {
            None
        }
    });

    let Some(path) = target else {
        return Err(format!("skill '{slug}' not found"));
    };

    // Reject tap-installed skills — they're symlinks we don't own.
    if let Ok(meta) = std::fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "'{slug}' is a tap-managed skill. Uninstall the tap instead of deleting the symlink."
            ));
        }
    }

    // Double-check the resolved path is a direct child of an allowed
    // root. Defends against a skill dir containing its own symlink.
    let parent = path
        .parent()
        .ok_or_else(|| "skill path has no parent".to_string())?;
    let is_under_root = allowed_roots.iter().any(|r| parent == r);
    if !is_under_root {
        return Err(format!(
            "refusing to delete — '{}' is not directly under a recognized skills dir",
            path.display()
        ));
    }

    std::fs::remove_dir_all(&path)
        .map_err(|e| format!("remove {}: {e}", path.display()))?;

    // If we just deleted an Orka-canonical skill, also clean up any
    // exposure symlink in ~/.claude/skills/ so we don't leave a
    // dangling link behind. Best-effort — a missing or mis-targeted
    // link is not an error.
    if let (Some(orka_root), Some(claude_root)) =
        (orka_skills_dir(), global_skills_dir())
    {
        if path.starts_with(&orka_root) {
            let link = claude_root.join(&slug);
            if let Ok(meta) = std::fs::symlink_metadata(&link) {
                if meta.file_type().is_symlink() {
                    let _ = std::fs::remove_file(&link);
                }
            }
        }
    }

    invalidate_skills_cache();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_scan_empty_dir() {
        let dir = std::env::temp_dir().join("orka_test_skills_empty");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut results = Vec::new();
        let mut seen = std::collections::HashSet::new();
        scan_dir(&dir, SkillSource::Global, &mut results, &mut seen);
        assert!(results.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_scan_with_skill() {
        let dir = std::env::temp_dir().join("orka_test_skills_one");
        let _ = fs::remove_dir_all(&dir);
        let skill_dir = dir.join("test-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "---\nname: test-skill\ndescription: A test skill.\norka:\n  schema: 1\n---\n\n# Test\n\nDo stuff.\n").unwrap();

        let mut results = Vec::new();
        let mut seen = std::collections::HashSet::new();
        scan_dir(&dir, SkillSource::Global, &mut results, &mut seen);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].slug, "test-skill");
        assert_eq!(results[0].description, "A test skill.");
        assert!(!results[0].has_graph);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_scan_deduplicates() {
        let dir = std::env::temp_dir().join("orka_test_skills_dedup");
        let _ = fs::remove_dir_all(&dir);
        let skill_dir = dir.join("my-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "---\nname: my-skill\ndescription: dedup test\norka:\n  schema: 1\n---\n\nBody.\n").unwrap();

        let mut results = Vec::new();
        let mut seen = std::collections::HashSet::new();
        scan_dir(&dir, SkillSource::Global, &mut results, &mut seen);
        scan_dir(&dir, SkillSource::Workspace, &mut results, &mut seen);
        assert_eq!(results.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
