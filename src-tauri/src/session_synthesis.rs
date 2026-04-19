//! Cross-session synthesis — ask a question that spans multiple past
//! sessions. Honest implementation: not a magical "multi-session
//! context merge" (Claude CLI doesn't support that), but a practical
//! "read the tails of N session transcripts, compose them into one
//! briefing prompt, ship to claude -p, stream the answer back".
//!
//! The user's experience IS "merged brain across sessions" — just
//! without pretending the underlying sessions got fused.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// One source — a past Claude Code session the user selected.
#[derive(Debug, Clone, Deserialize)]
pub struct SynthSource {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "sessionPath")]
    pub session_path: String,
    /// Optional short label (project / first message) shown in the prompt
    /// as a header so Claude can distinguish the sources.
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SynthResult {
    pub answer: String,
    /// How many source transcripts actually contributed content (empty
    /// files or unreadable ones are silently skipped).
    #[serde(rename = "sourcesUsed")]
    pub sources_used: u32,
    /// Claude session id from the stream. Capture once; the frontend
    /// passes it back on subsequent questions so the conversation
    /// continues in the same session (Claude sees full history).
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
}

/// Ask a question across multiple sessions' transcripts.
///
/// Strategy: for each source, read the tail (~128KB window), render as
/// a compact USER/ASSISTANT dialog, prepend a header with the label,
/// then stitch them together under the question. Claude sees one
/// structured prompt, not N independent contexts.
#[tauri::command]
pub async fn synthesize_sessions(
    question: String,
    sources: Vec<SynthSource>,
) -> Result<SynthResult, String> {
    if question.trim().is_empty() {
        return Err("question is empty".into());
    }
    if sources.is_empty() {
        return Err("no sources selected".into());
    }

    let mut rendered_sources = String::new();
    let mut used = 0u32;
    for (i, src) in sources.iter().enumerate() {
        let Some(transcript) = read_tail_transcript(Path::new(&src.session_path), 40) else {
            continue;
        };
        if transcript.trim().is_empty() { continue; }
        used += 1;
        let label = src
            .label
            .clone()
            .unwrap_or_else(|| format!("session {}", &src.session_id[..8.min(src.session_id.len())]));
        rendered_sources.push_str(&format!(
            "## Source {} — {label} (id: {})\n\n{transcript}\n\n---\n\n",
            i + 1,
            &src.session_id[..8.min(src.session_id.len())],
        ));
    }

    if used == 0 {
        return Err("all selected sources were empty or unreadable".into());
    }

    // Cap total source material at ~30KB — well under Claude's context
    // but enough to hold 40-turn tails across 5 sessions.
    const MAX_SRC_CHARS: usize = 30_000;
    if rendered_sources.len() > MAX_SRC_CHARS {
        let safe = rendered_sources
            .char_indices()
            .rfind(|(i, _)| *i <= MAX_SRC_CHARS)
            .map(|(i, _)| i)
            .unwrap_or(MAX_SRC_CHARS);
        rendered_sources.truncate(safe);
        rendered_sources.push_str("\n\n…(older source material elided to fit context)…\n");
    }

    let prompt = format!(
        "You are answering a question across {used} past Claude Code session{} the user has selected. \
Read the source transcripts below carefully, look for connections and contradictions between them, \
and answer the user's question. Cite source numbers ('Source 2 shows …') where it helps.\n\
\n\
If the sources don't contain enough to answer, say so plainly instead of guessing.\n\
\n\
--- SOURCES ---\n\
{rendered_sources}\n\
--- END SOURCES ---\n\
\n\
QUESTION: {question}",
        if used == 1 { "" } else { "s" }
    );

    // The first turn seeds a real session (no --no-session-persistence)
    // so subsequent follow-up questions can --resume and keep context.
    // This means a synthesis conversation appears in ~/.claude/projects/
    // as a normal session, which the user can also revisit in the
    // Sessions tab later — feature, not bug.
    let (answer, session_id) = call_claude_print_json(&prompt, None).await?;
    Ok(SynthResult {
        answer: answer.trim().to_string(),
        sources_used: used,
        session_id,
    })
}

/// Continue a synthesis conversation. Subsequent turns just carry the
/// user's new question — Claude already has the source transcripts
/// from turn 1 in its session history.
#[tauri::command]
pub async fn continue_synthesis(
    session_id: String,
    question: String,
) -> Result<SynthResult, String> {
    if question.trim().is_empty() {
        return Err("question is empty".into());
    }
    let (answer, new_sid) = call_claude_print_json(&question, Some(&session_id)).await?;
    Ok(SynthResult {
        answer: answer.trim().to_string(),
        sources_used: 0, // sources were baked into the first turn
        session_id: new_sid.or(Some(session_id)),
    })
}

/// Tail-only read + render USER/ASSISTANT lines, same shape as
/// session_brief::extract_transcript but slightly larger window.
fn read_tail_transcript(path: &Path, max_lines: usize) -> Option<String> {
    const TAIL_WINDOW: u64 = 128 * 1024;
    use std::io::{Read, Seek, SeekFrom};

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
                    let text = extract_text(content);
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
                            if bt == "text" {
                                let t = block.get("text").and_then(|t| t.as_str()).unwrap_or("");
                                if !t.trim().is_empty() {
                                    out.push_str("ASSISTANT: ");
                                    out.push_str(t.trim());
                                    out.push('\n');
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Some(out)
}

fn extract_text(v: &serde_json::Value) -> String {
    if let Some(s) = v.as_str() { return s.to_string(); }
    if let Some(arr) = v.as_array() {
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

/// Run claude -p with JSON output format so we can extract both the
/// result text AND the session id for later --resume calls. If
/// `resume_id` is provided, we chain onto that session; otherwise
/// a new one is created.
async fn call_claude_print_json(
    prompt: &str,
    resume_id: Option<&str>,
) -> Result<(String, Option<String>), String> {
    let mut cmd = tokio::process::Command::new("claude");
    cmd.arg("-p").arg("--output-format").arg("json");
    if let Some(sid) = resume_id {
        cmd.arg("--resume").arg(sid).arg("--fork-session");
    }
    cmd.arg(prompt);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("spawn claude: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "claude -p exited {}: {}",
            output.status.code().unwrap_or(-1),
            err.trim()
        ));
    }
    let raw = String::from_utf8_lossy(&output.stdout).to_string();
    // claude -p --output-format json returns {result, session_id, cost_usd, ...}
    let v: serde_json::Value =
        serde_json::from_str(raw.trim()).map_err(|e| format!("parse claude json: {e}"))?;
    let result = v
        .get("result")
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .to_string();
    let sid = v
        .get("session_id")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    if result.is_empty() {
        return Err(format!("claude returned no result text; raw: {raw}"));
    }
    Ok((result, sid))
}
