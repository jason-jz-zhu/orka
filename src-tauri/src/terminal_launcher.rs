//! User-configurable terminal launcher. Opens a native terminal window
//! (or spawns VS Code with clipboard fallback) running
//! `cd <workdir> && claude --resume <session_id>` so the user can
//! continue a scheduled/background run interactively.
//!
//! Storage: ~/.orka/terminal-config.json (sibling of model-config.json).
//! Per-user, per-machine. Safe to delete — defaults restore next read.
//!
//! Preset preferences:
//!   - "auto"         → detect at launch time (Warp > iTerm > Terminal on macOS)
//!   - "terminal-app" → macOS Terminal.app via AppleScript do-script
//!   - "iterm"        → iTerm2 via AppleScript create-window
//!   - "warp"         → Warp.app via its warp://action/new_tab URL scheme
//!   - "vscode"       → `code <workdir>` + copy command to clipboard
//!   - "custom"       → user-supplied template with {cwd} {cmd} {sid} vars
//!
//! Platform: macOS-first. Linux/Windows land with the same shape later —
//! custom template works today on any platform that has `sh -c`.
//!
//! Security: session_id must match [a-f0-9-]+ (UUID shape). cwd is shell-
//! escaped. Custom template only substitutes whitelisted vars — anything
//! else is left literal, so `{evil}` in a template stays `{evil}` rather
//! than being interpreted. Users supply their own templates to run on
//! their own machine, so we don't sandbox the shell itself.

use crate::workspace;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalConfig {
    pub preference: String,
    #[serde(default)]
    pub custom_template: Option<String>,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            preference: "auto".into(),
            custom_template: None,
        }
    }
}

fn config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".orka").join("terminal-config.json"))
}

fn load() -> TerminalConfig {
    let Some(path) = config_path() else {
        return TerminalConfig::default();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return TerminalConfig::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save(cfg: &TerminalConfig) -> Result<(), String> {
    let Some(path) = config_path() else {
        return Err("no home dir".into());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))
}

/// Detect installed terminals on the current platform. Ordered
/// best-to-worst — caller can pick the first match as the "auto"
/// default. Checks standard install paths; doesn't shell out.
pub fn detect_terminals() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        let apps = [
            ("warp", "/Applications/Warp.app"),
            ("iterm", "/Applications/iTerm.app"),
            ("terminal-app", "/System/Applications/Utilities/Terminal.app"),
        ];
        for (slug, path) in apps.iter() {
            if std::path::Path::new(path).exists() {
                out.push((*slug).to_string());
            }
        }
        // Terminal.app is guaranteed on macOS even if path check missed it
        // (varies by OS version). Always list it as a final fallback.
        if !out.iter().any(|s| s == "terminal-app") {
            out.push("terminal-app".into());
        }
        // VS Code family — only show if `code` CLI present.
        if which_cli("code").is_some() || which_cli("cursor").is_some() {
            out.push("vscode".into());
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Keep parity-of-shape for non-mac so the frontend can always
        // render "Custom" as a working option.
        out.push("custom".into());
    }
    out
}

fn which_cli(name: &str) -> Option<PathBuf> {
    let Ok(path) = std::env::var("PATH") else { return None; };
    for dir in path.split(':') {
        let p = PathBuf::from(dir).join(name);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// Resolve "auto" to a concrete preset at launch time. Non-auto
/// values pass through. Kept pure so harness tests can hit it
/// without touching disk.
pub fn resolve_preference(pref: &str, available: &[String]) -> String {
    if pref != "auto" {
        return pref.to_string();
    }
    for candidate in ["warp", "iterm", "terminal-app"] {
        if available.iter().any(|s| s == candidate) {
            return candidate.into();
        }
    }
    // Last-ditch: if nothing detected, "terminal-app" is the macOS
    // universal fallback. On Linux/Windows the caller's dispatcher
    // will reject unsupported presets cleanly.
    "terminal-app".into()
}

/// POSIX single-quote shell escape. Wraps input in single quotes and
/// replaces any embedded single quote with `'\''`. Safe for passing
/// into `sh -c '...'` or `osascript 'do script "..."'` after additional
/// AppleScript escaping (see escape_applescript below).
pub fn shell_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// AppleScript double-quoted-string escape. Used when we embed a
/// shell command inside an `osascript` `do script "..."` payload.
/// Escapes backslashes and double quotes; leaves everything else.
pub fn escape_applescript(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(c),
        }
    }
    out
}

/// Validate session id shape. Claude session ids are UUIDs plus dashes,
/// so hex + dash + "any case" is the safe whitelist. Rejects shell
/// metacharacters at the boundary as defense-in-depth.
pub fn valid_session_id(sid: &str) -> bool {
    !sid.is_empty()
        && sid.len() <= 128
        && sid
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Substitute {cwd} {cmd} {sid} in a user-supplied template. Unknown
/// placeholders stay literal. Deliberately NOT a regex engine — simple
/// scan keeps behavior predictable. The returned string is what we'll
/// hand to `sh -c`; each substituted value is shell-escaped first so
/// template-authors can write `{cmd}` without wrapping it themselves.
pub fn apply_template(template: &str, cwd: &str, cmd: &str, sid: &str) -> String {
    let cwd_esc = shell_escape(cwd);
    let cmd_esc = shell_escape(cmd);
    let sid_esc = shell_escape(sid);
    let mut out = String::with_capacity(template.len() + 32);
    let mut i = 0;
    let bytes = template.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'{' {
            // Look for matching `}`.
            if let Some(end) = template[i..].find('}') {
                let key = &template[i + 1..i + end];
                let replacement = match key {
                    "cwd" => Some(cwd_esc.as_str()),
                    "cmd" => Some(cmd_esc.as_str()),
                    "sid" => Some(sid_esc.as_str()),
                    _ => None,
                };
                if let Some(r) = replacement {
                    out.push_str(r);
                    i += end + 1;
                    continue;
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

#[derive(Debug, Serialize)]
pub struct LaunchResult {
    /// The preset we actually dispatched to after resolving "auto".
    pub resolved: String,
    /// Command that was attempted — useful for error reporting / logs.
    pub command: String,
    /// For the VS Code preset (and fallbacks), the raw shell command
    /// the user should paste into the integrated terminal.
    pub clipboard_payload: Option<String>,
}

fn build_inner_command(cwd: &str, sid: &str) -> (String, String) {
    // `cmd` is the naked claude-resume invocation; `full` is what we cd
    // into and then run. Both get shell-escaped at the boundary. We
    // separate them so the VS Code path can copy just the naked cmd
    // (the user already has the folder open).
    let cmd = format!("claude --resume {}", shell_escape(sid));
    let full = format!("cd {} && {}", shell_escape(cwd), cmd);
    (cmd, full)
}

/// Wrap the inner command with visible breadcrumbs so the user can tell
/// what's happening — a previous iteration opened a blank-looking window
/// when the shell didn't render anything (either claude wasn't on PATH
/// or the window closed immediately on error). Printing both steps
/// surfaces `command not found` errors instead of swallowing them.
fn build_announced_command(cwd: &str, sid: &str) -> String {
    format!(
        "clear; printf '\\033[1;36m▶\\033[0m Orka: resuming session \\033[1m%s\\033[0m\\n' {sid_q}; printf '\\033[1;36m▶\\033[0m cwd: %s\\n' {cwd_q}; cd {cwd_q} || exit; claude --resume {sid_q}",
        sid_q = shell_escape(sid),
        cwd_q = shell_escape(cwd),
    )
}

/// macOS: run a `do script` against Terminal.app. AppleScript is the
/// only first-party way to pre-fill a terminal command.
///
/// Uses the canonical `tell ... activate ... do script ... end tell`
/// block — an earlier one-line `tell ... to do script ...` pattern
/// was opening a blank secondary window on some profiles (well-known
/// Terminal.app quirk when the app isn't already running).
#[cfg(target_os = "macos")]
async fn launch_terminal_app(cwd: &str, sid: &str) -> Result<LaunchResult, String> {
    let announced = build_announced_command(cwd, sid);
    let script = format!(
        "tell application \"Terminal\"\n\
           activate\n\
           do script \"{}\"\n\
         end tell",
        escape_applescript(&announced)
    );
    run_osascript(&script).await.map_err(|e| tcc_hint(&e, "Terminal"))?;
    Ok(LaunchResult {
        resolved: "terminal-app".into(),
        command: announced,
        clipboard_payload: None,
    })
}

#[cfg(target_os = "macos")]
async fn launch_iterm(cwd: &str, sid: &str) -> Result<LaunchResult, String> {
    let announced = build_announced_command(cwd, sid);
    // iTerm2's `command` parameter on `create window` is treated as an
    // executable path (exec), not a shell expression — passing a shell
    // pipeline produces `## exec failed ## Program: clear;`. The correct
    // pattern is to spawn a normal shell session, then `write text` the
    // command into it. This also inherits the user's login shell, so
    // nvm-managed `claude` binaries end up on PATH.
    let script = format!(
        "tell application \"iTerm\"\n\
           activate\n\
           set newWindow to (create window with default profile)\n\
           tell current session of newWindow\n\
             write text \"{}\"\n\
           end tell\n\
         end tell",
        escape_applescript(&announced)
    );
    run_osascript(&script).await.map_err(|e| tcc_hint(&e, "iTerm"))?;
    Ok(LaunchResult {
        resolved: "iterm".into(),
        command: announced,
        clipboard_payload: None,
    })
}

/// Translate raw osascript failures into actionable text. The most
/// common first-run failure is macOS blocking Automation access to the
/// target terminal app — users won't know to look at System Settings
/// without being told.
fn tcc_hint(err: &str, target_app: &str) -> String {
    let low = err.to_lowercase();
    if low.contains("not allowed") || low.contains("-1743") || low.contains("-600") {
        return format!(
            "macOS blocked automation access to {target_app}. Grant permission in \
             System Settings → Privacy & Security → Automation → Orka → {target_app}, \
             then try again. (original: {err})"
        );
    }
    err.to_string()
}

#[cfg(target_os = "macos")]
async fn launch_warp(cwd: &str, sid: &str) -> Result<LaunchResult, String> {
    let (cmd, _full) = build_inner_command(cwd, sid);
    // Warp's URL scheme: warp://action/new_tab?path=...&command=...
    // Both components need percent-encoding. We pass `cmd` raw (unquoted)
    // because Warp will execute it in the new tab's shell directly.
    let url = format!(
        "warp://action/new_tab?path={}&command={}",
        percent_encode(cwd),
        percent_encode(&cmd)
    );
    let status = tokio::process::Command::new("open")
        .arg(&url)
        .status()
        .await
        .map_err(|e| format!("spawn open: {e}"))?;
    if !status.success() {
        return Err(format!("open {} failed (exit {:?})", url, status.code()));
    }
    Ok(LaunchResult {
        resolved: "warp".into(),
        command: cmd,
        clipboard_payload: None,
    })
}

/// VS Code: open the folder, copy the resume command to the clipboard.
/// VS Code's CLI deliberately doesn't expose "spawn integrated terminal
/// with pre-filled command" — the pattern is: open folder, user presses
/// ``Ctrl+` ``, pastes. We surface that as clipboard_payload so the UI
/// can toast about it.
async fn launch_vscode(cwd: &str, sid: &str) -> Result<LaunchResult, String> {
    let (cmd, _full) = build_inner_command(cwd, sid);
    // Try `code` on PATH first, then the mac `open -a` family.
    let mut opened = false;
    for cli in ["code", "cursor", "code-insiders"] {
        let res = tokio::process::Command::new(cli).arg(cwd).status().await;
        if let Ok(s) = res {
            if s.success() {
                opened = true;
                break;
            }
        }
    }
    #[cfg(target_os = "macos")]
    if !opened {
        for app in ["Visual Studio Code", "Cursor", "VSCodium"] {
            let res = tokio::process::Command::new("open")
                .args(["-a", app, cwd])
                .status()
                .await;
            if let Ok(s) = res {
                if s.success() {
                    opened = true;
                    break;
                }
            }
        }
    }
    if !opened {
        return Err("VS Code CLI not found. Install the `code` shell command \
            (Command Palette → 'Shell Command: Install code command in PATH')."
            .into());
    }
    Ok(LaunchResult {
        resolved: "vscode".into(),
        command: cmd.clone(),
        clipboard_payload: Some(cmd),
    })
}

/// Scan a custom template for command-substitution syntax OUTSIDE our
/// whitelisted `{placeholder}` regions. We substitute shell-escaped
/// values for {cwd} {cmd} {sid}, but a template author writing
/// `$(whoami)` or backticks in the raw body would bypass escaping
/// entirely — the output of those subshells gets spliced into the
/// command before `sh -c` parses it.
///
/// We deliberately ALLOW `&&`, `|`, and `;` since those are standard
/// terminal-launch idioms (chaining `cd && exec shell`, pipelines
/// like `{cmd} | less`). Blocking those would break legitimate
/// custom templates like `alacritty -e bash -c 'cd {cwd} && {cmd}'`.
///
/// The remaining risk (`&&; rm -rf ~`) is technically possible but
/// the user's config file writing their own template is their own
/// machine — this is defense-in-depth against config-import vectors,
/// not against the user typing a bad template directly.
fn validate_custom_template(template: &str) -> Result<(), String> {
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = template[i..].find('}') {
                i += end + 1;
                continue;
            }
        }
        // `$(` — command substitution
        if bytes[i] == b'$'
            && i + 1 < bytes.len()
            && bytes[i + 1] == b'('
        {
            return Err(
                "custom terminal template cannot contain $() command substitution — use {cmd} instead".into(),
            );
        }
        // Backtick — legacy command substitution
        if bytes[i] == b'`' {
            return Err(
                "custom terminal template cannot contain backticks — use {cmd} instead".into(),
            );
        }
        i += 1;
    }
    Ok(())
}

async fn launch_custom(
    template: &str,
    cwd: &str,
    sid: &str,
) -> Result<LaunchResult, String> {
    validate_custom_template(template)?;
    let (cmd, _full) = build_inner_command(cwd, sid);
    let rendered = apply_template(template, cwd, &cmd, sid);
    // Run via sh -c so users can write shell pipelines / flags freely.
    let status = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&rendered)
        .status()
        .await
        .map_err(|e| format!("spawn sh: {e}"))?;
    if !status.success() {
        return Err(format!("custom template exited with {:?}: {}", status.code(), rendered));
    }
    Ok(LaunchResult {
        resolved: "custom".into(),
        command: rendered,
        clipboard_payload: None,
    })
}

#[cfg(target_os = "macos")]
async fn run_osascript(script: &str) -> Result<(), String> {
    let status = tokio::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .status()
        .await
        .map_err(|e| format!("spawn osascript: {e}"))?;
    if !status.success() {
        return Err(format!("osascript exit {:?}", status.code()));
    }
    Ok(())
}

fn percent_encode(s: &str) -> String {
    // Minimal encoder — encode everything that isn't unreserved.
    // Good enough for file paths + shell commands sent through a URL.
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        let keep = b.is_ascii_alphanumeric()
            || matches!(b, b'-' | b'_' | b'.' | b'~' | b'/');
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

// ---- Tauri commands ----

#[tauri::command]
pub fn get_terminal_config() -> TerminalConfig {
    load()
}

#[tauri::command]
pub fn set_terminal_config(config: TerminalConfig) -> Result<(), String> {
    save(&config)
}

#[tauri::command]
pub fn detect_available_terminals() -> Vec<String> {
    detect_terminals()
}

/// Launch `claude --resume <session>` in the user's terminal.
///
/// `terminal_preset` is an optional per-call override for the terminal
/// preset. When provided (and valid), bypasses the saved preference so
/// the frontend split button can launch a specific terminal this click
/// without changing the user's default. Accepts the same slugs as the
/// config: `"auto"`, `"terminal-app"`, `"iterm"`, `"warp"`, `"vscode"`,
/// `"custom"`.
#[tauri::command]
pub async fn open_session_in_terminal(
    run_id: String,
    session_id: String,
    workdir: Option<String>,
    terminal_preset: Option<String>,
) -> Result<LaunchResult, String> {
    if !valid_session_id(&session_id) {
        return Err(format!("invalid session_id shape: {session_id:?}"));
    }
    // Resolution order:
    //   1. Explicit `workdir` from the caller — the ONLY correct path
    //      for scheduled runs with a user-configured output folder,
    //      since those sessions are hashed by that folder's cwd not by
    //      the per-node dir.
    //   2. `workspace::node_dir(run_id)` — legacy runs and internal
    //      workdirs still live here.
    //   3. `$HOME` as a last resort so claude-resume can at least
    //      try to match by session_id alone (rarely works but better
    //      than erroring out).
    //
    // Earlier versions only used (2), which silently broke "Terminal"
    // for every scheduled run with a configured output folder — the
    // cwd was the internal node dir but the session was stored under
    // the user folder's project hash.
    let cwd: PathBuf = match workdir.as_deref() {
        Some(w) if !w.is_empty() => {
            let p = PathBuf::from(w);
            if p.is_dir() {
                p
            } else {
                // Stored workdir was deleted; fall back rather than fail.
                let node = workspace::node_dir(&run_id);
                if node.is_dir() {
                    node
                } else {
                    dirs::home_dir().ok_or("no home dir")?
                }
            }
        }
        _ => {
            let node = workspace::node_dir(&run_id);
            if node.is_dir() {
                node
            } else {
                dirs::home_dir().ok_or("no home dir")?
            }
        }
    };
    let cwd_str = cwd
        .to_str()
        .ok_or_else(|| format!("non-UTF8 cwd: {cwd:?}"))?;

    let cfg = load();
    let available = detect_terminals();
    // Per-call override takes priority over the saved preference. Only
    // accept known slugs so the caller can't smuggle a custom template
    // through this path (those require the explicit "custom" preset +
    // validated template on the config).
    let pref_source = match terminal_preset.as_deref() {
        Some(p)
            if matches!(
                p,
                "auto" | "terminal-app" | "iterm" | "warp" | "vscode" | "custom"
            ) =>
        {
            p
        }
        _ => cfg.preference.as_str(),
    };
    let resolved = resolve_preference(pref_source, &available);

    match resolved.as_str() {
        "terminal-app" => {
            #[cfg(target_os = "macos")]
            {
                return launch_terminal_app(cwd_str, &session_id).await;
            }
            #[cfg(not(target_os = "macos"))]
            {
                return Err("terminal-app preset is macOS-only".into());
            }
        }
        "iterm" => {
            #[cfg(target_os = "macos")]
            {
                return launch_iterm(cwd_str, &session_id).await;
            }
            #[cfg(not(target_os = "macos"))]
            {
                return Err("iterm preset is macOS-only".into());
            }
        }
        "warp" => {
            #[cfg(target_os = "macos")]
            {
                return launch_warp(cwd_str, &session_id).await;
            }
            #[cfg(not(target_os = "macos"))]
            {
                return Err("warp preset is macOS-only".into());
            }
        }
        "vscode" => launch_vscode(cwd_str, &session_id).await,
        "custom" => {
            let Some(template) = cfg.custom_template.as_deref() else {
                return Err("custom template is empty — set one in Settings".into());
            };
            let t = template.trim();
            if t.is_empty() {
                return Err("custom template is empty — set one in Settings".into());
            }
            launch_custom(t, cwd_str, &session_id).await
        }
        other => Err(format!("unknown terminal preference: {other}")),
    }
}

// ---- Harness tests ----

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harness_shell_escape_handles_hostile_inputs() {
        assert_eq!(shell_escape("hello"), "'hello'");
        assert_eq!(shell_escape("a b"), "'a b'");
        assert_eq!(shell_escape("it's"), "'it'\\''s'");
        assert_eq!(shell_escape("$HOME"), "'$HOME'");
        assert_eq!(shell_escape("`rm -rf /`"), "'`rm -rf /`'");
        // Path with a single quote (legal on macOS, scary in shells).
        assert_eq!(
            shell_escape("/Users/jane's projects/x"),
            "'/Users/jane'\\''s projects/x'"
        );
    }

    #[test]
    fn harness_applescript_escape() {
        assert_eq!(escape_applescript("hello"), "hello");
        assert_eq!(escape_applescript("a \"b\""), "a \\\"b\\\"");
        assert_eq!(escape_applescript("a \\ b"), "a \\\\ b");
    }

    #[test]
    fn harness_custom_template_substitution() {
        let rendered = apply_template(
            "alacritty -e bash -c 'cd {cwd} && {cmd}'",
            "/tmp/work",
            "claude --resume abc",
            "abc",
        );
        assert!(
            rendered.contains("'/tmp/work'"),
            "cwd should be single-quoted: {rendered}"
        );
        assert!(
            rendered.contains("'claude --resume abc'"),
            "cmd should be single-quoted: {rendered}"
        );
    }

    #[test]
    fn harness_template_rejects_unknown_vars() {
        // Unknown placeholders stay literal — crucial because otherwise a
        // rogue template could cause silent misinterpretation.
        let rendered = apply_template("echo {evil} {cwd}", "/x", "cmd", "sid");
        assert!(rendered.contains("{evil}"), "unknown var must stay literal: {rendered}");
        assert!(rendered.contains("'/x'"));
    }

    #[test]
    fn harness_sid_validation() {
        assert!(valid_session_id("abc-123-def-456"));
        assert!(valid_session_id("f0bc19a5-1e2d-4f3c-8a9b-1234567890ab"));
        // Must reject shell metacharacters.
        assert!(!valid_session_id(""));
        assert!(!valid_session_id("abc; rm -rf /"));
        assert!(!valid_session_id("$(whoami)"));
        assert!(!valid_session_id("../../../etc/passwd"));
        // Too long.
        assert!(!valid_session_id(&"a".repeat(200)));
    }

    #[test]
    fn harness_resolve_preference_auto() {
        // Auto picks best available.
        assert_eq!(
            resolve_preference("auto", &vec!["warp".into(), "iterm".into(), "terminal-app".into()]),
            "warp"
        );
        assert_eq!(
            resolve_preference("auto", &vec!["iterm".into(), "terminal-app".into()]),
            "iterm"
        );
        assert_eq!(
            resolve_preference("auto", &vec!["terminal-app".into()]),
            "terminal-app"
        );
        // Empty available: fall back to terminal-app.
        assert_eq!(resolve_preference("auto", &[]), "terminal-app");
        // Non-auto passes through unchanged.
        assert_eq!(resolve_preference("warp", &[]), "warp");
        assert_eq!(resolve_preference("custom", &[]), "custom");
    }

    #[test]
    fn harness_build_inner_command_escapes_sid() {
        let (cmd, full) = build_inner_command("/tmp/w s", "sess-1");
        assert_eq!(cmd, "claude --resume 'sess-1'");
        assert_eq!(full, "cd '/tmp/w s' && claude --resume 'sess-1'");
    }

    #[test]
    fn harness_terminal_config_roundtrip_defaults() {
        let d = TerminalConfig::default();
        assert_eq!(d.preference, "auto");
        assert!(d.custom_template.is_none());
        // Missing fields → serde(default) fills in.
        let partial: TerminalConfig = serde_json::from_str(r#"{"preference":"warp"}"#).unwrap();
        assert_eq!(partial.preference, "warp");
        assert!(partial.custom_template.is_none());
    }

    #[test]
    fn harness_percent_encode() {
        assert_eq!(percent_encode("hello"), "hello");
        assert_eq!(percent_encode("a b"), "a%20b");
        assert_eq!(percent_encode("/tmp/work"), "/tmp/work");
        assert_eq!(percent_encode("it's"), "it%27s");
        assert_eq!(percent_encode("claude --resume abc"), "claude%20--resume%20abc");
    }

    #[test]
    fn harness_announced_command_is_valid_shell() {
        // `sh -n` does a syntax check without executing. Catches bugs
        // in the announced-command template (missing quotes, unbalanced
        // parentheses, etc). If this ever breaks, manual terminal
        // launches will open a window that instantly errors out.
        let announced = build_announced_command(
            "/Users/jane/work with spaces",
            "f0bc19a5-1e2d-4f3c-8a9b",
        );
        let status = std::process::Command::new("sh")
            .arg("-n")
            .arg("-c")
            .arg(&announced)
            .status()
            .expect("spawn sh");
        assert!(status.success(), "announced command has bad shell syntax: {announced}");
    }

    #[test]
    fn harness_announced_command_survives_single_quote_in_path() {
        // Single quotes in filesystem paths are legal on macOS and are
        // historically the #1 reason "open in terminal" features break.
        let announced = build_announced_command("/Users/jane's/work", "abc-123");
        let status = std::process::Command::new("sh")
            .arg("-n")
            .arg("-c")
            .arg(&announced)
            .status()
            .expect("spawn sh");
        assert!(status.success(), "single-quote in path broke shell syntax: {announced}");
    }

    #[test]
    fn harness_tcc_hint_maps_known_errors() {
        // Automation-denied errors on macOS surface as -1743 (not allowed
        // to send to process) or -600. We map those to actionable text.
        let hint = tcc_hint("execution error: Not allowed to send (-1743)", "Terminal");
        assert!(hint.contains("Privacy & Security"), "hint missing guidance: {hint}");
        assert!(hint.contains("Terminal"), "hint should name the target app: {hint}");
        // Unrelated errors pass through untouched.
        let pass = tcc_hint("random osascript failure", "Terminal");
        assert_eq!(pass, "random osascript failure");
    }
}
