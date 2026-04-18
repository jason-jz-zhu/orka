//! Output-node destinations beyond local disk:
//!   - iCloud Drive folder (auto-syncs to iPhone Files.app)
//!   - Apple Notes (AppleScript append to a named note)
//!   - Arbitrary HTTP webhook (for Zapier / IFTTT / Make / n8n / self-hosted)
//!   - Shell command with $CONTENT placeholder (escape hatch for any target
//!     the user can script — `shortcuts run`, `curl`, `osascript`, claude -p
//!     with a skill, etc.)

use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::PathBuf;

use crate::workspace;

/// Hash a shell command template for trust-store lookup. SHA-256 hex digest.
fn hash_shell_template(template: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(template.trim().as_bytes());
    format!("{:x}", hasher.finalize())
}

fn trust_file() -> PathBuf {
    workspace::workspace_root().join(".trusted-shell-commands.json")
}

fn load_trusted() -> HashSet<String> {
    let path = trust_file();
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str::<Vec<String>>(&s)
            .map(|v| v.into_iter().collect())
            .unwrap_or_default(),
        Err(_) => HashSet::new(),
    }
}

fn save_trusted(set: &HashSet<String>) -> Result<(), String> {
    let path = trust_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let list: Vec<&String> = set.iter().collect();
    let json = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Approve a shell command template for execution. Idempotent — adding an
/// already-trusted template is a no-op. Call this from the UI after the user
/// explicitly confirms the command.
#[tauri::command]
pub fn approve_shell_command(command_template: String) -> Result<String, String> {
    let hash = hash_shell_template(&command_template);
    let mut set = load_trusted();
    set.insert(hash.clone());
    save_trusted(&set)?;
    Ok(hash)
}

/// Check whether a shell template is currently trusted without running it.
#[tauri::command]
pub fn is_shell_command_trusted(command_template: String) -> Result<bool, String> {
    let hash = hash_shell_template(&command_template);
    Ok(load_trusted().contains(&hash))
}

/// `~/Library/Mobile Documents/com~apple~CloudDocs/Orka/` — auto-syncs to
/// iPhone Files.app under iCloud Drive. Lazy-creates the directory.
fn icloud_orka_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let dir = home
        .join("Library")
        .join("Mobile Documents")
        .join("com~apple~CloudDocs")
        .join("Orka");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

#[tauri::command]
pub fn icloud_orka_path() -> Result<String, String> {
    Ok(icloud_orka_dir()?.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn write_to_icloud(filename: String, content: String) -> Result<String, String> {
    let dir = icloud_orka_dir()?;
    let name = filename.trim();
    if name.is_empty() {
        return Err("empty filename".into());
    }
    // Refuse path separators — keep the write inside the Orka folder.
    if name.contains('/') || name.contains('\\') {
        return Err("filename must not contain path separators".into());
    }
    let path = dir.join(name);
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

/// Convert markdown to HTML using comrak with GFM extensions
/// (tables, strikethrough, autolink, task lists). Used for Apple Notes
/// and any other HTML-target destination.
#[tauri::command]
pub fn markdown_to_html(markdown: String) -> String {
    let mut opts = comrak::ComrakOptions::default();
    opts.extension.table = true;
    opts.extension.strikethrough = true;
    opts.extension.autolink = true;
    opts.extension.tasklist = true;
    opts.extension.tagfilter = false; // allow HTML through (Notes is a trusted sink)
    opts.render.unsafe_ = true;
    comrak::markdown_to_html(&markdown, &opts)
}

/// Append to a named Apple Note (create if missing). The body is inserted as
/// HTML so basic markdown headings / bold / lists / code / tables render
/// correctly — callers should convert their markdown to HTML first (use the
/// `markdown_to_html` Tauri command).
#[tauri::command]
pub async fn append_to_apple_note(
    title: String,
    html_body: String,
) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (title, html_body);
        return Err("Apple Notes is macOS only".into());
    }
    #[cfg(target_os = "macos")]
    {
        let t = title.trim();
        if t.is_empty() {
            return Err("empty note title".into());
        }
        // Use JSON encoding for safe JS string literals — handles newlines,
        // unicode, control chars, quotes, backslashes uniformly. Plain
        // string-replace escaping breaks the moment markdown contains a
        // literal newline (it always does).
        let safe_title = serde_json::to_string(t).map_err(|e| e.to_string())?;
        let safe_body = serde_json::to_string(&html_body).map_err(|e| e.to_string())?;
        let script = format!(
            r#"
(() => {{
  const Notes = Application("Notes");
  Notes.includeStandardAdditions = true;
  const account = Notes.accounts[0];
  const folder = account.defaultFolder();
  const title = {title};
  const htmlBody = {body};
  let note = null;
  for (const n of folder.notes()) {{
    if (n.name() === title) {{ note = n; break; }}
  }}
  if (!note) {{
    note = Notes.Note({{ name: title, body: "<h1>" + title + "</h1>" + htmlBody }});
    folder.notes.push(note);
    return "created:" + note.id();
  }} else {{
    const cur = note.body();
    note.body = cur + "<hr>" + htmlBody;
    return "appended:" + note.id();
  }}
}})()
            "#,
            title = safe_title,
            body = safe_body
        );
        let out = std::process::Command::new("osascript")
            .args(["-l", "JavaScript", "-e", &script])
            .output()
            .map_err(|e| format!("osascript spawn: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "osascript failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
        // raw is "created:<id>" or "appended:<id>" — translate to a user-
        // friendly summary. Frontend uses `notes://` to deep-link to the
        // note, but most users just need to know "go to Notes.app, look for
        // 'Orka Inbox'".
        let summary = if raw.starts_with("created:") {
            format!("Created note \"{t}\" in Notes.app")
        } else if raw.starts_with("appended:") {
            format!("Appended to note \"{t}\" in Notes.app")
        } else {
            raw
        };
        Ok(summary)
    }
}

/// POST arbitrary text body to a user-provided URL with optional headers.
/// Headers come in as `Key: value\nKey: value`.
#[tauri::command]
pub async fn post_to_webhook(
    url: String,
    headers: Option<String>,
    body: String,
) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("empty webhook URL".into());
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("webhook URL must start with http:// or https://".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client
        .post(url)
        .header("Content-Type", "text/markdown; charset=utf-8")
        .body(body);
    if let Some(h) = headers {
        for line in h.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Some((k, v)) = line.split_once(':') {
                req = req.header(k.trim(), v.trim());
            }
        }
    }
    let resp = req.send().await.map_err(|e| format!("POST: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status.as_u16(), text));
    }
    Ok(format!("HTTP {} · POST to {}", status.as_u16(), url))
}

/// Run a shell command with `$CONTENT` replaced by the report text. Runs
/// via `/bin/sh -c` so the user can pipe, redirect, use env vars, etc.
///
/// Example command templates:
///   shortcuts run "Send to Notes" <<< "$CONTENT"
///   curl -X POST -d "$CONTENT" https://example.com/hook
///   echo "$CONTENT" | pbcopy && osascript -e 'tell app "Messages" to ...'
#[tauri::command]
pub async fn run_shell_destination(
    command_template: String,
    content: String,
) -> Result<String, String> {
    let cmd = command_template.trim();
    if cmd.is_empty() {
        return Err("empty shell command".into());
    }
    // Trust gate: shell templates must be explicitly approved by the user via
    // `approve_shell_command` before they can run. Defends against: malicious
    // SKILL.md imports, scheduled cron on unknown templates, pasted pipelines
    // from untrusted sources. Hash-based so editing the template revokes trust.
    let hash = hash_shell_template(cmd);
    if !load_trusted().contains(&hash) {
        return Err(format!(
            "shell command not approved (hash {}…). \
             Approve it in the Output node settings before running.",
            &hash[..12]
        ));
    }
    let mut child = tokio::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(cmd)
        .env("CONTENT", &content)
        // Also pipe content via stdin so scripts can `cat` / `<<<` it.
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn sh: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(content.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| format!("wait sh: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "exit {}: {}",
            out.status.code().unwrap_or(-1),
            stderr
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if stdout.is_empty() {
        "command ok (no stdout)".into()
    } else {
        format!("ok: {stdout}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_deterministic_and_whitespace_insensitive() {
        let a = hash_shell_template("echo hi");
        let b = hash_shell_template("  echo hi  ");
        let c = hash_shell_template("echo hi ");
        assert_eq!(a, b, "leading/trailing whitespace must not change hash");
        assert_eq!(a, c);
    }

    #[test]
    fn hash_changes_when_template_changes() {
        let a = hash_shell_template("echo hi");
        let b = hash_shell_template("echo bye");
        let c = hash_shell_template("echo 'hi'");
        assert_ne!(a, b, "different content must produce different hash");
        assert_ne!(a, c, "quote changes must revoke trust");
    }
}
