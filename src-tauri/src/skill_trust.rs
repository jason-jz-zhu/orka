//! Skill TOFU trust store.
//!
//! Threat: a tap repo gets rewritten upstream, or a teammate's git-sync
//! silently modifies ~/.claude/skills/<slug>/SKILL.md to do something the
//! user didn't approve. Since skills run `claude -p "/<slug>"` with the
//! same permissions as Claude Code, the blast radius is whatever Claude
//! can reach from that working directory — file reads, edits, curl, etc.
//!
//! Mitigation: snapshot SHA-256 of SKILL.md on first run (TOFU). On
//! subsequent runs, re-hash and refuse execution if it doesn't match,
//! until the user explicitly approves the new hash after reviewing.
//!
//! This module is shared by:
//!   - the Tauri app (first-run consent modal + hash-change gate)
//!   - orka-cli (--trust flag to accept hash changes)
//!
//! Storage format (`~/OrkaCanvas/.trusted-skills.json`):
//!   { "<slug>": "<sha256 hex>", ... }
//!
//! We intentionally keep this a tiny JSON file rather than a DB so a user
//! can `cat` it, edit it, or nuke it without ceremony.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub fn trust_store_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join("OrkaCanvas").join(".trusted-skills.json"))
}

pub fn load_trust_store() -> HashMap<String, String> {
    let Some(path) = trust_store_path() else {
        return HashMap::new();
    };
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

pub fn save_trust_store(store: &HashMap<String, String>) {
    let Some(path) = trust_store_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(store) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

pub fn hash_skill_md(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Some(format!("{:x}", hasher.finalize()))
}

/// Resolve a skill slug to its SKILL.md path. Walks global + workspace
/// skill dirs via the existing scanner, so it sees the same skills the
/// rest of the app does.
pub fn resolve_skill_md(slug: &str) -> Option<PathBuf> {
    for meta in crate::skills::scan_skills_dirs() {
        if meta.slug == slug {
            return Some(PathBuf::from(meta.path));
        }
    }
    None
}

/// Trust state for a single skill — returned to the UI so it can decide
/// between "run straight away", "show first-run consent", or "show
/// hash-changed consent".
#[derive(Debug, Clone, Serialize)]
pub struct SkillTrustState {
    pub slug: String,
    /// None when the skill isn't installed yet.
    #[serde(rename = "currentHash")]
    pub current_hash: Option<String>,
    /// None when the skill has never been run (first-run).
    #[serde(rename = "storedHash")]
    pub stored_hash: Option<String>,
    /// current_hash matches stored_hash. When true, the caller can run
    /// without any prompt.
    pub trusted: bool,
    /// Absolute filesystem path to SKILL.md. Included so the modal can
    /// render a "reveal in Finder" link without re-resolving.
    #[serde(rename = "skillMdPath")]
    pub skill_md_path: Option<String>,
}

/// Check a skill against the trust store WITHOUT mutating it. The caller
/// (UI or CLI) decides how to react — typically by prompting the user and
/// then calling `trust_skill` to persist approval.
#[tauri::command]
pub fn check_skill_trust(slug: String) -> SkillTrustState {
    let md_path = resolve_skill_md(&slug);
    let current_hash = md_path.as_deref().and_then(hash_skill_md);
    let stored_hash = load_trust_store().get(&slug).cloned();
    let trusted = match (&current_hash, &stored_hash) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    };
    SkillTrustState {
        slug,
        current_hash,
        stored_hash,
        trusted,
        skill_md_path: md_path.map(|p| p.to_string_lossy().into_owned()),
    }
}

/// Persist the current hash of a skill's SKILL.md as trusted. Call this
/// after the user has reviewed the skill in a consent modal and clicked
/// "Trust & run". Safe to call repeatedly; overwrites the stored hash.
#[tauri::command]
pub fn trust_skill(slug: String) -> Result<SkillTrustState, String> {
    let md_path = resolve_skill_md(&slug)
        .ok_or_else(|| format!("skill '{slug}' not found in ~/.claude/skills/"))?;
    let current_hash =
        hash_skill_md(&md_path).ok_or_else(|| format!("could not read {}", md_path.display()))?;
    let mut store = load_trust_store();
    store.insert(slug.clone(), current_hash.clone());
    save_trust_store(&store);
    Ok(SkillTrustState {
        slug,
        current_hash: Some(current_hash.clone()),
        stored_hash: Some(current_hash),
        trusted: true,
        skill_md_path: Some(md_path.to_string_lossy().into_owned()),
    })
}

/// Remove a skill's entry from the trust store — forces a first-run
/// consent prompt next time. Useful for users who want to re-review a
/// skill without running it yet.
#[tauri::command]
pub fn forget_skill_trust(slug: String) -> Result<(), String> {
    let mut store = load_trust_store();
    store.remove(&slug);
    save_trust_store(&store);
    Ok(())
}

// ───────── Permission surface ──────────────────────────────────────────
//
// Skills are prose — they don't have a formal capability manifest the way
// a Chrome extension does. Best we can do is surface what the SKILL.md
// DECLARES (its frontmatter) and what it LIKELY DOES (heuristic scan of
// the body for risky patterns). We show both so the user sees the gap
// between "author explicitly said they need X" and "the prose tells
// Claude to do X anyway".
//
// Defaults matter: `allowed-tools` being absent means the run falls back
// to `--dangerously-skip-permissions`, i.e. full Claude Code access. We
// flag that loudly in the response.

#[derive(Debug, Clone, Serialize)]
pub struct SkillPermissions {
    pub slug: String,
    /// Parsed from frontmatter `allowed-tools:`. When None, the skill
    /// runs with the unrestricted `--dangerously-skip-permissions` flag.
    #[serde(rename = "declaredTools")]
    pub declared_tools: Option<Vec<String>>,
    /// True when `declared_tools` is None AND the skill body clearly
    /// uses tools (bash blocks, etc.) — i.e., the common case: the
    /// skill *will* use tools but didn't declare which ones.
    #[serde(rename = "runsUnrestricted")]
    pub runs_unrestricted: bool,
    /// Frontmatter-declared inputs the skill expects. Users see these
    /// as the form fields SkillRunner already renders.
    pub inputs: Vec<PermInput>,
    /// Heuristic findings from the body prose — things like "contains
    /// curl", "contains rm -rf", "contains git push". Not authoritative.
    #[serde(rename = "detectedActions")]
    pub detected_actions: Vec<String>,
    /// Workspace directory the skill will execute in. For global skills
    /// this is wherever Orka launched from; for workspace skills it's
    /// the project root. Shown so the user knows the blast radius.
    #[serde(rename = "workingDir")]
    pub working_dir: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PermInput {
    pub name: String,
    #[serde(rename = "type")]
    pub input_type: String,
    pub default: Option<String>,
    pub description: Option<String>,
}

/// Scan the SKILL.md body for common "this skill is going to touch the
/// system" patterns. Output is human-readable and meant to be shown as a
/// bullet list — we do not pretend it's a security audit.
fn detect_risky_actions(body: &str) -> Vec<String> {
    let lower = body.to_lowercase();
    let mut out = Vec::new();
    let patterns: &[(&str, &[&str])] = &[
        ("runs shell commands (bash)", &["```bash", "```sh", "```zsh"]),
        ("reads or writes files", &["write(", "edit(", "read(", "write to", "writes to", "edits `", "modifies"]),
        ("runs arbitrary commands (Bash tool)", &["bash(", "bash tool", "use bash"]),
        ("makes network requests", &["curl ", "wget ", "fetch(", "http://", "https://", "webfetch"]),
        ("pushes to git / calls gh", &["git push", "gh pr", "gh issue", "gh api", "gh release"]),
        ("deletes files", &["rm -rf", "remove_dir_all", "unlink(", "delete(", "rmdir"]),
        ("installs packages", &["npm install", "pip install", "brew install", "cargo install"]),
        ("reads secrets/credentials", &[".env", "credentials.json", ".aws/", ".ssh/", "api_key", "token"]),
    ];
    for (label, needles) in patterns {
        if needles.iter().any(|n| lower.contains(n)) {
            out.push((*label).to_string());
        }
    }
    out
}

#[tauri::command]
pub fn get_skill_permissions(slug: String) -> Result<SkillPermissions, String> {
    let md_path =
        resolve_skill_md(&slug).ok_or_else(|| format!("skill '{slug}' not found"))?;
    let parsed = crate::skill_md::parse_skill_md(&md_path)
        .map_err(|e| format!("parse SKILL.md: {e}"))?;

    let declared_tools = parsed.allowed_tools.as_ref().map(|s| {
        s.split(',')
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
    });

    let detected = detect_risky_actions(&parsed.raw_body);
    // If the skill clearly uses tools (by our detection) but didn't declare
    // them in frontmatter, it's running unrestricted. This is the common
    // case for prose-authored skills — flag it.
    let runs_unrestricted = declared_tools.is_none() && !detected.is_empty();

    let inputs = parsed
        .inputs
        .into_iter()
        .map(|i| PermInput {
            name: i.name,
            input_type: i.input_type,
            default: i.default,
            description: i.description,
        })
        .collect();

    // Working dir: skill.md lives inside either ~/.claude/skills/<slug>/
    // (global) or <workspace>/.claude/skills/<slug>/ (workspace). Either
    // way, the parent-of-parent is the enclosing scope, which is what
    // the run's cwd defaults to.
    let working_dir = md_path
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "(unknown)".to_string());

    Ok(SkillPermissions {
        slug,
        declared_tools,
        runs_unrestricted,
        inputs,
        detected_actions: detected,
        working_dir,
    })
}

// ───────── CLI-shaped helper ─────────────────────────────────────────
// orka-cli's existing flow: auto-TOFU on first run, refuse on change
// unless --trust. Keep the same semantics in one place.

pub enum CliTrustOutcome {
    /// Safe to run — hash matched, or first-run TOFU just recorded, or
    /// user passed --trust to accept a change.
    Proceed,
    /// Refuse execution — hash changed and user didn't pass --trust.
    Refuse(String),
}

pub fn cli_check_and_record(slug: &str, accept_change: bool, quiet: bool) -> CliTrustOutcome {
    let md_path = match resolve_skill_md(slug) {
        Some(p) => p,
        None => {
            return CliTrustOutcome::Refuse(format!(
                "skill '{slug}' not found in ~/.claude/skills/"
            ))
        }
    };
    let current_hash = match hash_skill_md(&md_path) {
        Some(h) => h,
        None => {
            return CliTrustOutcome::Refuse(format!("could not read {}", md_path.display()))
        }
    };
    let mut store = load_trust_store();
    match store.get(slug) {
        Some(known) if *known == current_hash => CliTrustOutcome::Proceed,
        Some(_) if accept_change => {
            store.insert(slug.to_string(), current_hash);
            save_trust_store(&store);
            if !quiet {
                eprintln!("[orka] accepted new hash for skill '{slug}' and updated trust record");
            }
            CliTrustOutcome::Proceed
        }
        Some(_) => CliTrustOutcome::Refuse(format!(
            "SKILL.md for '{slug}' has changed since the last trusted run.\n\
             Review the changes, then re-run with --trust to approve:\n\
             \n    orka run {slug} --trust\n\
             \nSee {}",
            md_path.display()
        )),
        None => {
            store.insert(slug.to_string(), current_hash);
            save_trust_store(&store);
            if !quiet {
                eprintln!("[orka] trusting skill '{slug}' on first use (TOFU)");
            }
            CliTrustOutcome::Proceed
        }
    }
}
