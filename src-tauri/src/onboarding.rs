//! First-run readiness checks. Each field is independent so the UI can show a
//! per-row ✓/✗ checklist without a single failure masking the others.

use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct OnboardingStatus {
    /// `claude` CLI is invokable — either on `$PATH` or via a known install
    /// location. Reports the version string when detected.
    pub claude_installed: bool,
    pub claude_version: Option<String>,
    /// A `~/.claude/.credentials.json` (or equivalent auth artefact) exists,
    /// indicating the user has logged in at least once.
    pub claude_logged_in: bool,
    /// The project transcripts directory Orka reads from exists.
    pub projects_dir_exists: bool,
    /// Orka's own workspace root exists and is writable.
    pub workspace_initialized: bool,
    /// Platform label (for frontend conditional rendering).
    pub platform: String,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn detect_claude_cli() -> (bool, Option<String>) {
    // Cache the `claude --version` result for the lifetime of the
    // process. Spawning 3 subprocesses every time OnboardingModal
    // mounts is wasteful — claude doesn't uninstall itself mid-session.
    // Falls back to a new probe if the first probe failed (so users
    // who install claude mid-session get picked up on next check).
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<Option<(bool, Option<String>)>>,
    > = std::sync::OnceLock::new();
    let cell = CACHE.get_or_init(|| std::sync::Mutex::new(None));

    if let Ok(guard) = cell.lock() {
        if let Some(cached) = guard.as_ref() {
            if cached.0 {
                // Only cache positive results. Negative cache would
                // permanently block the "install claude then retry" flow.
                return cached.clone();
            }
        }
    }

    // Probe order:
    //   1. `claude` on PATH — catches standard installs and anything the
    //      user's shell config resolves (Homebrew, apt, system-wide, etc.)
    //   2. Walk the env $PATH ourselves to catch shells that didn't inherit
    //      PATH into Orka's process (launchd quirks on macOS)
    //   3. Common per-user install locations that aren't usually on PATH
    //      at app launch time — nvm, Volta, asdf, Anthropic's own installer
    //   4. Well-known Homebrew prefixes (x86 + Apple Silicon)
    let mut candidates: Vec<String> = vec!["claude".into()];
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            let p = std::path::PathBuf::from(dir).join("claude");
            if p.exists() {
                candidates.push(p.to_string_lossy().into_owned());
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        for rel in [
            ".claude/local/bin/claude",
            ".local/bin/claude",
            "bin/claude",
            ".volta/bin/claude",
            ".asdf/shims/claude",
        ] {
            let p = home.join(rel);
            if p.exists() {
                candidates.push(p.to_string_lossy().into_owned());
            }
        }
    }
    for path in [
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
        "/usr/bin/claude",
        "/opt/local/bin/claude", // MacPorts
    ] {
        candidates.push(path.into());
    }

    let mut result = (false, None);
    for cli in candidates {
        if let Ok(out) = std::process::Command::new(&cli).arg("--version").output() {
            if out.status.success() {
                let ver = String::from_utf8_lossy(&out.stdout).trim().to_string();
                result = (true, Some(ver));
                break;
            }
        }
    }
    if let Ok(mut guard) = cell.lock() {
        *guard = Some(result.clone());
    }
    result
}

fn detect_claude_logged_in() -> bool {
    // Claude CLI stores auth in ~/.claude/.credentials.json (or similar). We
    // only check for file presence — never read contents, never expose tokens.
    let candidates = [
        ".credentials.json",
        ".claude.json",
        "config.json",
    ];
    let claude_dir = home().join(".claude");
    if !claude_dir.exists() {
        return false;
    }
    for name in candidates {
        if claude_dir.join(name).exists() {
            return true;
        }
    }
    // Fallback: if ~/.claude/projects has any session at all, the user has
    // used claude before, so they must have been logged in at some point.
    let projects = claude_dir.join("projects");
    if let Ok(rd) = std::fs::read_dir(&projects) {
        return rd.flatten().any(|e| e.path().is_dir());
    }
    false
}

fn detect_projects_dir() -> bool {
    home().join(".claude").join("projects").exists()
}

fn detect_workspace_writable() -> bool {
    let root = home().join("OrkaCanvas");
    // Creating is harmless on fresh machines — that's exactly what we want on
    // first run. We treat "can create" as "initialized".
    if root.exists() {
        return true;
    }
    std::fs::create_dir_all(&root).is_ok()
}

pub fn onboarding_status() -> OnboardingStatus {
    let (claude_installed, claude_version) = detect_claude_cli();
    OnboardingStatus {
        claude_installed,
        claude_version,
        claude_logged_in: detect_claude_logged_in(),
        projects_dir_exists: detect_projects_dir(),
        workspace_initialized: detect_workspace_writable(),
        platform: std::env::consts::OS.to_string(),
    }
}
