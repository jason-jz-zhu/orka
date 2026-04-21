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
/// changed since it was generated. If no cache is available, tries to
/// derive a zero-cost brief from Claude Code's own `/recap` output
/// (v2.1.108+) embedded in the session JSONL — that path wins over an
/// LLM call because it's Claude's own authoritative summary, free, and
/// regeneratable anytime. Returns None only when neither source is
/// available; caller then falls back to `generate_session_brief`.
#[tauri::command]
pub async fn get_session_brief(
    session_id: String,
    session_path: String,
) -> Result<Option<SessionBrief>, String> {
    let store = load_store().await;
    let current = mtime_ms(Path::new(&session_path));
    if let Some(brief) = store.briefs.get(&session_id) {
        if current != 0 && current == brief.source_mtime_ms {
            return Ok(Some(brief.clone()));
        }
    }
    // No fresh cache — try Claude Code's native /recap output before
    // spending an LLM call. Not written to the cache: it's cheap to
    // re-extract and the JSONL is the source of truth.
    if current != 0 {
        if let Some(brief) = try_recap_brief(
            Path::new(&session_path),
            &session_id,
            current,
        ) {
            return Ok(Some(brief));
        }
    }
    Ok(None)
}

/// Try to build a SessionBrief from Claude Code's `/recap` output embedded
/// in the JSONL. Returns None if no recap line is present.
///
/// Claude Code v2.1.108+ writes `/recap` results back into the session
/// stream as `type:"user"` lines whose content string starts with
/// `※ recap:`. We detect that prefix, strip it, and split the remainder
/// on the literal `Next:` marker (recap format is consistently
/// `<summary>. Next: <follow-up>`).
fn try_recap_brief(
    path: &Path,
    session_id: &str,
    mtime: u64,
) -> Option<SessionBrief> {
    let raw = extract_latest_recap_text(path)?;
    let parsed = parse_recap_body(&raw)?;
    Some(SessionBrief {
        session_id: session_id.to_string(),
        you_were: parsed.you_were,
        progress: parsed.progress,
        next_likely: parsed.next_likely,
        source_mtime_ms: mtime,
        generated_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// Walk the JSONL from end to start looking for the most recent user
/// line whose content begins with `※ recap:`. Reads the tail window
/// only — same bounded I/O discipline as `extract_transcript`.
fn extract_latest_recap_text(path: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL_WINDOW: u64 = 256 * 1024;
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let content = if size > TAIL_WINDOW {
        let start = size - TAIL_WINDOW;
        f.seek(SeekFrom::Start(start)).ok()?;
        let mut buf = Vec::with_capacity(TAIL_WINDOW as usize);
        f.read_to_end(&mut buf).ok()?;
        let first_nl = buf.iter().position(|&b| b == b'\n').unwrap_or(0);
        String::from_utf8_lossy(&buf[first_nl + 1..]).into_owned()
    } else {
        let mut s = String::new();
        f.read_to_string(&mut s).ok()?;
        s
    };
    for raw in content.lines().rev().filter(|l| !l.trim().is_empty()) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        let Some(content) = v.get("message").and_then(|m| m.get("content")) else {
            continue;
        };
        let text = extract_text_from_content(content);
        let trimmed = text.trim_start();
        if let Some(body) = trimmed.strip_prefix("※ recap:") {
            let body = body.trim();
            if !body.is_empty() {
                return Some(body.to_string());
            }
        }
    }
    None
}

struct ParsedRecap {
    you_were: String,
    progress: String,
    next_likely: String,
}

/// Split a recap body (everything after `※ recap:`) into the three
/// SessionBrief fields.
///
/// Format observed in Claude Code 2.1.108+: `<summary sentences>. Next: <followup>`.
/// We treat the first clause (up to the first `;` or `.` or `。`) as the
/// headline, the rest of the summary as progress, and text after the last
/// `Next:` marker as the follow-up prediction.
fn parse_recap_body(body: &str) -> Option<ParsedRecap> {
    // Collapse whitespace — recap is line-wrapped in the terminal but
    // lives as a single-line JSON string with soft wraps already
    // preserved as literal newlines/spaces.
    let flat = body
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if flat.is_empty() {
        return None;
    }

    // Split off `Next: …` tail if present. Case-sensitive because
    // Claude Code always emits `Next:`; lowercase `next:` could match
    // incidental prose.
    let (before_next, next_likely) = match flat.rfind("Next:") {
        Some(i) => (flat[..i].trim_end_matches('.').trim(), flat[i + 5..].trim()),
        None => (flat.as_str(), ""),
    };

    // Headline: first clause of the "before_next" half.
    let split_idx = before_next
        .find(';')
        .or_else(|| before_next.find('.'))
        .or_else(|| before_next.find('。'));
    let (headline, rest) = match split_idx {
        Some(i) => (before_next[..i].trim().to_string(), before_next[i + 1..].trim().to_string()),
        None => (before_next.trim().to_string(), String::new()),
    };

    if headline.is_empty() {
        return None;
    }
    Some(ParsedRecap {
        you_were: headline,
        progress: rest,
        next_likely: next_likely.to_string(),
    })
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
    eprintln!("[brief] generating for {session_id}");
    let path = Path::new(&session_path);
    let current_mtime = mtime_ms(path);
    if current_mtime == 0 {
        return Err(format!("session file missing: {}", session_path));
    }

    let transcript = extract_transcript(path, 60)?;
    if transcript.trim().is_empty() {
        return Err("session transcript is empty".into());
    }
    eprintln!("[brief] transcript: {} chars", transcript.len());

    let prompt = build_brief_prompt(&transcript);
    eprintln!("[brief] prompt: {} chars, calling claude -p", prompt.len());
    let raw = call_claude_print(&prompt).await?;
    eprintln!("[brief] claude returned {} chars", raw.len());
    let parsed = parse_brief_json(&raw).map_err(|e| {
        eprintln!("[brief] parse failed: {e}\n--raw--\n{raw}\n--end--");
        e
    })?;
    eprintln!("[brief] parsed OK: youWere={:?}", parsed.you_were);

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

/// One-shot cleanup: delete any Claude Code session files in
/// `~/.claude/projects/*/` whose first user message starts with the
/// signature preamble Orka uses for brief-generation prompts. These are
/// ghost sessions created before `--no-session-persistence` was added.
///
/// Returns the number of files removed. Safe to call repeatedly; it
/// no-ops when clean.
#[tauri::command]
pub async fn cleanup_ghost_brief_sessions() -> Result<u32, String> {
    let Some(home) = dirs::home_dir() else { return Err("no home dir".into()) };
    let projects_root = home.join(".claude").join("projects");
    if !projects_root.is_dir() {
        return Ok(0);
    }

    const SIGNATURE: &str = "You are summarizing a Claude Code session";
    let mut removed = 0u32;

    let Ok(projects) = std::fs::read_dir(&projects_root) else { return Ok(0) };
    for project in projects.flatten() {
        let project_path = project.path();
        if !project_path.is_dir() { continue; }
        let Ok(sessions) = std::fs::read_dir(&project_path) else { continue };
        for session in sessions.flatten() {
            let path = session.path();
            if !path.is_file() { continue; }
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }

            if is_ghost_brief_session(&path, SIGNATURE) {
                if std::fs::remove_file(&path).is_ok() {
                    removed += 1;
                }
            }
        }
    }
    Ok(removed)
}

/// Check whether a JSONL session file is a ghost brief session by peeking
/// at its first user message. Only reads the first ~8KB so it's cheap
/// even if the file grew.
fn is_ghost_brief_session(path: &Path, signature: &str) -> bool {
    use std::io::{BufRead, BufReader, Read};
    let Ok(f) = std::fs::File::open(path) else { return false };
    // Cap at 8KB — ghost briefs put their preamble in line 1, so we don't
    // need to scan far.
    let reader = BufReader::new(f.take(8192));
    for line in reader.lines().map_while(Result::ok).take(50) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        let Some(content) = v.get("message").and_then(|m| m.get("content")) else {
            continue;
        };
        let text = extract_text_from_content(content);
        return text.contains(signature);
    }
    false
}

// ───────── internals ──────────────────────────────────────────────────

/// Read the last `max_lines` non-blank JSONL lines and render them as a
/// compact human transcript. Keeps user messages verbatim, shortens
/// assistant tool_use lines to `[tool: name]`, keeps assistant text.
///
/// For huge sessions (100+ MB JSONL are real — a 3000-turn agentic run
/// with lots of tool use easily hits that), we only read a trailing
/// window instead of loading the whole file. 256KB holds far more than
/// 60 full-content lines in practice, so the tail sample is intact.
fn extract_transcript(path: &Path, max_lines: usize) -> Result<String, String> {
    const TAIL_WINDOW: u64 = 256 * 1024;
    use std::io::{Read, Seek, SeekFrom};

    let mut f = std::fs::File::open(path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    let size = f
        .metadata()
        .map_err(|e| format!("stat {}: {e}", path.display()))?
        .len();

    let content = if size > TAIL_WINDOW {
        let start = size - TAIL_WINDOW;
        f.seek(SeekFrom::Start(start))
            .map_err(|e| format!("seek {}: {e}", path.display()))?;
        let mut buf = Vec::with_capacity(TAIL_WINDOW as usize);
        f.read_to_end(&mut buf)
            .map_err(|e| format!("read tail {}: {e}", path.display()))?;
        // Drop any partial line at the very start of the window — we
        // land mid-record almost always when seeking by byte offset.
        let first_nl = buf.iter().position(|&b| b == b'\n').unwrap_or(0);
        String::from_utf8_lossy(&buf[first_nl + 1..]).into_owned()
    } else {
        let mut s = String::new();
        f.read_to_string(&mut s)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        s
    };

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
    // Model is user-configurable; default is haiku (fast, cheap, plenty
    // for JSON extraction).
    //
    // `--no-session-persistence` is critical: without it, every brief
    // generation would itself be written to `~/.claude/projects/` as a
    // new session. Orka would then see those briefs as real sessions
    // and try to auto-brief THEM — infinite pollution.
    let model = crate::model_config::model_for_brief();
    let output = tokio::process::Command::new("claude")
        .arg("-p")
        .arg("--no-session-persistence")
        .arg("--model")
        .arg(&model)
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

    #[test]
    fn recap_parses_claude_code_canonical_shape() {
        // Verbatim shape from a real Claude Code 2.1.108+ `/recap` output.
        let body = "Built an iterative video-editing agent pipeline (Split → Compose loops) and integrated TrevorTWX taste-brain patterns; Phase B best score went from 6.7 to 7.8 on Sintel. Next: run it on a second video to validate the lift generalizes.";
        let p = parse_recap_body(body).unwrap();
        assert_eq!(p.you_were, "Built an iterative video-editing agent pipeline (Split → Compose loops) and integrated TrevorTWX taste-brain patterns");
        assert!(p.progress.contains("Phase B best score"));
        assert_eq!(p.next_likely, "run it on a second video to validate the lift generalizes.");
    }

    #[test]
    fn recap_collapses_soft_wraps() {
        // /recap output arrives line-wrapped in the terminal; we join on
        // whitespace so the fields don't contain preserved newlines.
        let body = "Fixed A\n  and B; did C.\n  Next: test D.";
        let p = parse_recap_body(body).unwrap();
        assert_eq!(p.you_were, "Fixed A and B");
        assert_eq!(p.next_likely, "test D.");
    }

    #[test]
    fn recap_without_next_leaves_field_empty() {
        let p = parse_recap_body("Did one thing. Did another.").unwrap();
        assert_eq!(p.you_were, "Did one thing");
        assert_eq!(p.next_likely, "");
    }

    #[test]
    fn recap_empty_body_rejected() {
        assert!(parse_recap_body("").is_none());
        assert!(parse_recap_body("   \n  ").is_none());
    }
}
