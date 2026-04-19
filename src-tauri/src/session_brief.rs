//! Session brief — "what was I doing in this session?"
//!
//! Reads the tail of a Claude Code session's JSONL, sends it to `claude -p`
//! with a structured-JSON prompt, and caches the result keyed by session id
//! + mtime. Subsequent reads of an unchanged session return instantly from
//! cache.
//!
//! Storage: `~/.orka/session-briefs.json`. No workspace scoping — briefs
//! summarize the user's Claude Code sessions, which live under
//! `~/.claude/projects/` and aren't per-workspace.
//!
//! Cost: each regeneration is one `claude -p` call. Free for Max
//! subscribers; billed for API users. Cache invalidation is strict
//! (mtime-based) to avoid accidental regeneration on trivial reads.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// What the user sees — three lines, one sentence each.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionBrief {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// "You were: …" — what the session was about.
    #[serde(rename = "youWere")]
    pub you_were: String,
    /// "Progress: …" — what's been done so far.
    pub progress: String,
    /// "Next likely: …" — best guess at where the user will pick up.
    #[serde(rename = "nextLikely")]
    pub next_likely: String,
    /// JSONL mtime (ms since epoch) at generation time. Used to decide
    /// whether the cached brief is still fresh.
    #[serde(rename = "sourceMtimeMs")]
    pub source_mtime_ms: u64,
    /// When this brief was generated (ISO-8601 UTC).
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BriefStore {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub briefs: HashMap<String, SessionBrief>,
}

fn default_version() -> u32 {
    1
}

fn briefs_file() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".orka").join("session-briefs.json"))
}

async fn load_store() -> BriefStore {
    let Some(path) = briefs_file() else { return BriefStore::default(); };
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => BriefStore::default(),
    }
}

async fn save_store(store: &BriefStore) -> Result<(), String> {
    let Some(path) = briefs_file() else { return Err("no home dir".into()) };
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| format!("serialize: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, json)
        .await
        .map_err(|e| format!("write tmp: {e}"))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| format!("rename: {e}"))
}

fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Return the cached brief if it exists AND the underlying JSONL hasn't
/// changed since it was generated. Returns None when no cache or the
/// source file has moved on — caller should then call generate.
#[tauri::command]
pub async fn get_session_brief(
    session_id: String,
    session_path: String,
) -> Result<Option<SessionBrief>, String> {
    let store = load_store().await;
    let Some(brief) = store.briefs.get(&session_id) else { return Ok(None) };
    let current = mtime_ms(Path::new(&session_path));
    if current == 0 || current != brief.source_mtime_ms {
        return Ok(None);
    }
    Ok(Some(brief.clone()))
}

/// Produce a fresh brief by sending the session tail to `claude -p` with
/// a structured-JSON prompt. Cached on success.
///
/// Strategy:
///   - Read the last N JSONL lines (plenty of context without bloating
///     the prompt; the caller's `--output-format json` keeps our read
///     deterministic).
///   - Extract human-readable transcript text (user asks + assistant
///     final text) and collapse tool calls to one-liners.
///   - Send to `claude -p` with instructions to return a single JSON
///     object with three fields.
///   - Parse, cache, return.
#[tauri::command]
pub async fn generate_session_brief(
    session_id: String,
    session_path: String,
) -> Result<SessionBrief, String> {
    let path = Path::new(&session_path);
    let current_mtime = mtime_ms(path);
    if current_mtime == 0 {
        return Err(format!("session file missing: {}", session_path));
    }

    let transcript = extract_transcript(path, 60)?;
    if transcript.trim().is_empty() {
        return Err("session transcript is empty".into());
    }

    let prompt = build_brief_prompt(&transcript);
    let raw = call_claude_print(&prompt).await?;
    let parsed = parse_brief_json(&raw)?;

    let brief = SessionBrief {
        session_id: session_id.clone(),
        you_were: parsed.you_were,
        progress: parsed.progress,
        next_likely: parsed.next_likely,
        source_mtime_ms: current_mtime,
        generated_at: chrono::Utc::now().to_rfc3339(),
    };

    let mut store = load_store().await;
    store.briefs.insert(session_id, brief.clone());
    save_store(&store).await?;
    Ok(brief)
}

/// Remove a stale cached brief. Useful when the user explicitly wants to
/// regenerate or when cleaning up after a deleted session.
#[tauri::command]
pub async fn clear_session_brief(session_id: String) -> Result<(), String> {
    let mut store = load_store().await;
    store.briefs.remove(&session_id);
    save_store(&store).await
}

// ───────── internals ──────────────────────────────────────────────────

/// Read the last `max_lines` non-blank JSONL lines and render them as a
/// compact human transcript. Keeps user messages verbatim, shortens
/// assistant tool_use lines to `[tool: name]`, keeps assistant text.
fn extract_transcript(path: &Path, max_lines: usize) -> Result<String, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
    let slice = if lines.len() > max_lines {
        &lines[lines.len() - max_lines..]
    } else {
        &lines[..]
    };

    let mut out = String::new();
    for line in slice {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "user" => {
                if let Some(content) = v.get("message").and_then(|m| m.get("content")) {
                    let text = extract_text_from_content(content);
                    if !text.trim().is_empty() {
                        out.push_str("USER: ");
                        out.push_str(text.trim());
                        out.push('\n');
                    }
                }
            }
            "assistant" => {
                if let Some(content) = v.get("message").and_then(|m| m.get("content")) {
                    if let Some(arr) = content.as_array() {
                        for block in arr {
                            let bt = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                            match bt {
                                "text" => {
                                    let t = block.get("text").and_then(|t| t.as_str()).unwrap_or("");
                                    if !t.trim().is_empty() {
                                        out.push_str("ASSISTANT: ");
                                        out.push_str(t.trim());
                                        out.push('\n');
                                    }
                                }
                                "tool_use" => {
                                    let name = block
                                        .get("name")
                                        .and_then(|n| n.as_str())
                                        .unwrap_or("?");
                                    out.push_str(&format!("ASSISTANT: [tool: {name}]\n"));
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

/// Content can be a string (older format) or an array of blocks (current
/// format). Flatten text from either.
fn extract_text_from_content(content: &serde_json::Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        let mut out = String::new();
        for b in arr {
            if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                out.push_str(t);
                out.push(' ');
            }
        }
        return out;
    }
    String::new()
}

fn build_brief_prompt(transcript: &str) -> String {
    let truncated = if transcript.len() > 12000 {
        // Keep the tail — most recent work matters most.
        let start = transcript.len() - 12000;
        // Don't slice mid-codepoint.
        let safe = transcript
            .char_indices()
            .rfind(|(i, _)| *i <= start)
            .map(|(i, _)| i)
            .unwrap_or(0);
        format!("…(earlier context elided)…\n{}", &transcript[safe..])
    } else {
        transcript.to_string()
    };

    format!(
        "You are summarizing a Claude Code session the user may return to. \
Output ONE JSON object and nothing else, matching this exact schema:\n\
\n\
{{\n\
  \"youWere\": \"<one short sentence — what the session was about>\",\n\
  \"progress\": \"<one short sentence — what's been done so far>\",\n\
  \"nextLikely\": \"<one short sentence — where the user will pick up>\"\n\
}}\n\
\n\
No markdown. No code fences. No preamble. Just the JSON.\n\
Keep each value under 100 characters. Use second-person phrasing (\"You were debugging X\").\n\
\n\
--- SESSION TRANSCRIPT ---\n\
{truncated}\n\
--- END TRANSCRIPT ---"
    )
}

async fn call_claude_print(prompt: &str) -> Result<String, String> {
    let output = tokio::process::Command::new("claude")
        .arg("-p")
        .arg(prompt)
        .output()
        .await
        .map_err(|e| format!("spawn claude: {e} (is the claude CLI on PATH?)"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "claude -p exited {}: {}",
            output.status.code().unwrap_or(-1),
            err.trim()
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(text)
}

#[derive(Deserialize)]
struct ParsedBrief {
    #[serde(rename = "youWere")]
    you_were: String,
    progress: String,
    #[serde(rename = "nextLikely")]
    next_likely: String,
}

/// Extract the JSON object from Claude's response. Handles occasional
/// fencing or leading whitespace gracefully.
fn parse_brief_json(raw: &str) -> Result<ParsedBrief, String> {
    let trimmed = raw.trim();
    // If wrapped in ```json ... ```, strip the fence.
    let without_fence = if let Some(rest) = trimmed.strip_prefix("```json") {
        rest.trim_start().trim_end_matches("```").trim()
    } else if let Some(rest) = trimmed.strip_prefix("```") {
        rest.trim_start().trim_end_matches("```").trim()
    } else {
        trimmed
    };
    // Find the first '{' and the last '}' — covers prefixes/suffixes
    // Claude sometimes adds even with strict instructions.
    let start = without_fence.find('{').ok_or("no JSON object in response")?;
    let end = without_fence.rfind('}').ok_or("unclosed JSON object")?;
    if end < start {
        return Err("invalid JSON bounds".into());
    }
    let json = &without_fence[start..=end];
    serde_json::from_str::<ParsedBrief>(json).map_err(|e| format!("parse brief json: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_json() {
        let raw = r#"{"youWere":"debugging A","progress":"fixed","nextLikely":"test"}"#;
        let p = parse_brief_json(raw).unwrap();
        assert_eq!(p.you_were, "debugging A");
        assert_eq!(p.progress, "fixed");
        assert_eq!(p.next_likely, "test");
    }

    #[test]
    fn parses_fenced_json() {
        let raw = "```json\n{\"youWere\":\"x\",\"progress\":\"y\",\"nextLikely\":\"z\"}\n```";
        let p = parse_brief_json(raw).unwrap();
        assert_eq!(p.you_were, "x");
    }

    #[test]
    fn parses_json_with_preamble() {
        let raw = "Here you go:\n{\"youWere\":\"a\",\"progress\":\"b\",\"nextLikely\":\"c\"}\nLet me know.";
        let p = parse_brief_json(raw).unwrap();
        assert_eq!(p.progress, "b");
    }

    #[test]
    fn rejects_non_json() {
        assert!(parse_brief_json("just prose").is_err());
    }

    #[test]
    fn extract_text_flattens_array() {
        let v = serde_json::json!([
            { "type": "text", "text": "hello " },
            { "type": "text", "text": "world" }
        ]);
        assert_eq!(extract_text_from_content(&v).trim(), "hello  world");
    }
}
