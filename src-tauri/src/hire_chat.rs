//! "Hire by chat" v2 — multi-turn skill-building conversation.
//!
//! The v1 flow was a single-sentence prompt → seeded runner. v2 turns
//! that into a real back-and-forth: Claude (acting as the
//! orka-skill-builder) asks follow-ups, drafts a SKILL.md, and lets
//! the user iterate before committing. Frontend parses SKILL.md
//! candidates out of the stream and surfaces a "Save as new skill"
//! action when one appears.
//!
//! Mechanically a thin wrapper over `claude -p --output-format
//! stream-json` — same family as `session_synthesis.rs`, with a
//! different system-prompt composition. Event prefix is "hire:*" so
//! listeners on the synth channel don't cross-talk.

use serde::Serialize;
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Clone, Serialize)]
struct HireChunk {
    text: String,
}

#[derive(Clone, Serialize)]
struct HireDone {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

#[derive(Clone, Serialize)]
struct HireErr {
    message: String,
}

fn emit_err(app: &AppHandle, stream_id: &str, msg: &str) {
    let _ = app.emit(
        &format!("hire:error:{stream_id}"),
        HireErr {
            message: msg.to_string(),
        },
    );
}

/// Start a new hire-by-chat conversation.
///
/// The first message composes:
///   1. A system-prompt preface telling Claude to act as the
///      orka-skill-builder agent, with the skill's SKILL.md body
///      inlined. Falls back to a minimal inline description if the
///      skill file is missing (fresh install prior to v3 seed).
///   2. The user's opening goal / sentence.
///
/// Subsequent turns should call `continue_hire_chat_stream` with the
/// captured `session_id` so Claude remembers context.
#[tauri::command]
pub async fn start_hire_chat_stream(
    app: AppHandle,
    stream_id: String,
    user_turn: String,
) -> Result<(), String> {
    if user_turn.trim().is_empty() {
        emit_err(&app, &stream_id, "empty user_turn");
        return Err("empty user_turn".into());
    }
    let system = load_skill_builder_preamble();
    let prompt = format!(
        "{system}\n\n---\n\nUser's request: {user_turn}\n\n\
Start by asking ONE clarifying question if you need it, then draft a SKILL.md. \
When you finish a draft, wrap it in a fenced `skill-md` code block so the UI \
can detect it — like:\n\n```skill-md\n---\nname: ...\ndescription: ...\n---\n\
# Title\n\nPrompt body here.\n```"
    );
    stream_claude(app, stream_id, prompt, None).await
}

/// Continue an existing hire-by-chat session. The session id comes
/// from the `hire:done` event captured by the first turn.
#[tauri::command]
pub async fn continue_hire_chat_stream(
    app: AppHandle,
    stream_id: String,
    session_id: String,
    user_turn: String,
) -> Result<(), String> {
    if user_turn.trim().is_empty() {
        emit_err(&app, &stream_id, "empty user_turn");
        return Err("empty user_turn".into());
    }
    stream_claude(app, stream_id, user_turn, Some(session_id)).await
}

fn load_skill_builder_preamble() -> String {
    // Try the real installed copy first so evolved versions are used;
    // fall back to the bundled seed so fresh installs still get the
    // correct system prompt.
    if let Some(home) = dirs::home_dir() {
        let path = home
            .join(".claude")
            .join("skills")
            .join("orka-skill-builder")
            .join("SKILL.md");
        if let Ok(content) = std::fs::read_to_string(&path) {
            if !content.trim().is_empty() {
                return format!(
                    "You are acting as the orka-skill-builder agent. \
Here is your role and operating guidelines — follow them for the \
conversation that follows:\n\n{content}"
                );
            }
        }
    }
    // Minimal fallback — matches the seed skill's intent.
    "You are the orka-skill-builder agent. Help the user design a new Orka \
skill by asking about triggers, inputs, outputs and destinations, then \
produce a SKILL.md file they can save."
        .to_string()
}

async fn stream_claude(
    app: AppHandle,
    stream_id: String,
    prompt: String,
    resume_id: Option<String>,
) -> Result<(), String> {
    let model = crate::model_config::model_for_synthesis();
    let _permit = crate::claude_gate::acquire().await;
    let mut cmd = tokio::process::Command::new("claude");
    cmd.arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose");
    if !model.trim().is_empty() {
        cmd.arg("--model").arg(&model);
    }
    if let Some(sid) = &resume_id {
        cmd.arg("--resume").arg(sid).arg("--fork-session");
    }
    cmd.arg(&prompt);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("spawn claude: {e}");
            emit_err(&app, &stream_id, &msg);
            return Err(msg);
        }
    };

    let stdout = child.stdout.take().ok_or("stdout pipe missing")?;
    let stderr = child.stderr.take().ok_or("stderr pipe missing")?;

    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    });

    let mut reader = BufReader::new(stdout).lines();
    let mut final_session_id: Option<String> = resume_id.clone();
    let mut seen_any_text = false;

    while let Ok(Some(line)) = reader.next_line().await {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "assistant" => {
                if let Some(content) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for block in content {
                        let bt = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        if bt == "text" {
                            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                if !text.is_empty() {
                                    seen_any_text = true;
                                    let _ = app.emit(
                                        &format!("hire:chunk:{stream_id}"),
                                        HireChunk {
                                            text: text.to_string(),
                                        },
                                    );
                                }
                            }
                        }
                    }
                }
            }
            "result" => {
                if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                    final_session_id = Some(sid.to_string());
                }
                if !seen_any_text {
                    if let Some(text) = v.get("result").and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            let _ = app.emit(
                                &format!("hire:chunk:{stream_id}"),
                                HireChunk {
                                    text: text.to_string(),
                                },
                            );
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr_text = stderr_task.await.unwrap_or_default();

    if !status.success() {
        let msg = format!(
            "claude -p exited {}: {}",
            status.code().unwrap_or(-1),
            stderr_text.trim()
        );
        emit_err(&app, &stream_id, &msg);
        return Err(msg);
    }

    let _ = app.emit(
        &format!("hire:done:{stream_id}"),
        HireDone {
            session_id: final_session_id,
        },
    );
    Ok(())
}

/// Save a drafted SKILL.md to `~/.claude/skills/<slug>/SKILL.md`.
///
/// Sanitises the slug (lowercase, alnum + `-_`, no leading dot) and
/// refuses to overwrite an existing directory so a chat draft can
/// never silently clobber a skill the user already has. Returns the
/// absolute path so the frontend can offer "reveal in Finder".
#[tauri::command]
pub async fn save_drafted_skill(slug: String, content: String) -> Result<String, String> {
    let clean = sanitise_slug(&slug);
    if clean.is_empty() {
        return Err("slug is empty after sanitisation".into());
    }
    let body = content.trim();
    if body.is_empty() {
        return Err("SKILL.md content is empty".into());
    }
    let home = dirs::home_dir().ok_or("no home dir")?;
    let dir = home.join(".claude").join("skills").join(&clean);
    if dir.exists() {
        return Err(format!(
            "a skill named \"{clean}\" already exists at {}",
            dir.display()
        ));
    }
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let path = dir.join("SKILL.md");
    tokio::fs::write(&path, body)
        .await
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

/// Allow only lowercase letters, digits, `-` and `_`. Collapse
/// everything else to `-`. The slug becomes a directory name under
/// `~/.claude/skills/`, so we keep it conservative.
fn sanitise_slug(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_was_dash = true; // drop leading dashes
    for ch in raw.trim().chars() {
        let c = ch.to_ascii_lowercase();
        let ok = c.is_ascii_alphanumeric() || c == '_';
        if ok {
            out.push(c);
            last_was_dash = false;
        } else if !last_was_dash {
            out.push('-');
            last_was_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitise_strips_non_alnum_and_collapses_dashes() {
        assert_eq!(sanitise_slug("Hello World!!"), "hello-world");
        assert_eq!(sanitise_slug("  foo  bar  "), "foo-bar");
        assert_eq!(sanitise_slug("foo__bar-123"), "foo__bar-123");
        assert_eq!(sanitise_slug("...leading.dots..."), "leading-dots");
    }

    #[test]
    fn sanitise_empty_for_all_punct() {
        assert_eq!(sanitise_slug("!!!"), "");
    }
}
