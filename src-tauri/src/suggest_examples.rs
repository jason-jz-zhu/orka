//! Auto-generate example prompts for a skill.
//!
//! When a user opens a skill whose author didn't write an `examples:`
//! block, the SkillRunner shows a generic "Tell Claude what you want"
//! placeholder — useless. This command lets the user click a button,
//! spends ~2 seconds + a penny of Sonnet, and gets 3 concrete examples
//! saved back to the SKILL.md frontmatter. Every future visitor sees
//! clickable chips instead of the generic placeholder.
//!
//! Why Sonnet (default) and not Haiku:
//!   Examples need to reference the skill's actual domain, not produce
//!   template-y "create a demo" filler. Sonnet reads prose well enough
//!   to generate examples that name specific features and inputs.
//!   The cost is a one-shot ~$0.01 per skill, persisted forever.

use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Emitter};

use crate::skill_md;
use crate::skill_trust;

#[derive(Debug, Clone, Serialize)]
pub struct SuggestedExamples {
    pub slug: String,
    pub examples: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrewarmSummary {
    pub total: u32,
    pub succeeded: u32,
    pub failed: u32,
    pub skipped: u32,
    /// Per-skill outcomes — ordered by iteration so the frontend can
    /// replay progress if needed.
    pub results: Vec<PrewarmResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrewarmResult {
    pub slug: String,
    pub status: String, // "ok" | "err" | "skipped"
    pub error: Option<String>,
    pub examples: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
struct PrewarmProgress {
    current: u32,
    total: u32,
    slug: String,
    status: String, // "start" | "ok" | "err" | "skipped"
    error: Option<String>,
}

/// Retroactively generate example prompts for every installed skill
/// that ships without them. One-shot batch operation — expensive if the
/// user has many skills (each call spawns Sonnet), so we emit progress
/// events per-skill so the UI can show a live counter.
///
/// Events emitted on `app`:
///   - "skill-examples:prewarm:progress" — fires before each skill
///     (status="start") and after (status="ok"/"err"), with running
///     {current, total, slug} counts.
///   - No "done" event; the return value IS the final summary.
///
/// Errors are recorded per-skill in the result list but do not abort
/// the batch — one broken SKILL.md shouldn't block the rest.
#[tauri::command]
pub async fn suggest_examples_for_all_skills(
    app: AppHandle,
) -> Result<PrewarmSummary, String> {
    const EVENT: &str = "skill-examples:prewarm:progress";

    // Snapshot the list ONCE so we're not racing with the live cache.
    let all = crate::skills::scan_skills_dirs();
    let targets: Vec<String> = all
        .into_iter()
        .filter(|s| s.examples.is_empty())
        .map(|s| s.slug)
        .collect();

    let total = targets.len() as u32;
    let mut results: Vec<PrewarmResult> = Vec::with_capacity(targets.len());
    let mut succeeded = 0u32;
    let mut failed = 0u32;

    for (idx, slug) in targets.iter().enumerate() {
        let current = idx as u32 + 1;
        let _ = app.emit(
            EVENT,
            PrewarmProgress {
                current,
                total,
                slug: slug.clone(),
                status: "start".into(),
                error: None,
            },
        );

        match suggest_one(slug).await {
            Ok(r) => {
                succeeded += 1;
                let _ = app.emit(
                    EVENT,
                    PrewarmProgress {
                        current,
                        total,
                        slug: slug.clone(),
                        status: "ok".into(),
                        error: None,
                    },
                );
                results.push(PrewarmResult {
                    slug: slug.clone(),
                    status: "ok".into(),
                    error: None,
                    examples: Some(r.examples),
                });
            }
            Err(e) => {
                failed += 1;
                let msg = e.to_string();
                let _ = app.emit(
                    EVENT,
                    PrewarmProgress {
                        current,
                        total,
                        slug: slug.clone(),
                        status: "err".into(),
                        error: Some(msg.clone()),
                    },
                );
                results.push(PrewarmResult {
                    slug: slug.clone(),
                    status: "err".into(),
                    error: Some(msg),
                    examples: None,
                });
            }
        }
    }

    Ok(PrewarmSummary {
        total,
        succeeded,
        failed,
        skipped: 0,
        results,
    })
}

#[tauri::command]
pub async fn suggest_skill_examples(
    slug: String,
) -> Result<SuggestedExamples, String> {
    suggest_one(&slug).await
}

/// Per-skill generation — shared between the single-slug Tauri command
/// and the batch prewarm. Idempotent: if a skill already has examples,
/// returns them without making a Claude call.
pub(crate) async fn suggest_one(slug: &str) -> Result<SuggestedExamples, String> {
    let md_path = skill_trust::resolve_skill_md(slug)
        .ok_or_else(|| format!("skill '{slug}' not found"))?;

    let parsed = skill_md::parse_skill_md(&md_path)
        .map_err(|e| format!("parse SKILL.md: {e}"))?;

    // Short-circuit: if the skill already has examples, return them
    // rather than burning a Claude call. UI should gate the button on
    // examples.length === 0 but double-check server-side.
    if !parsed.examples.is_empty() {
        return Ok(SuggestedExamples {
            slug: slug.to_string(),
            examples: parsed.examples,
        });
    }

    let prompt = build_prompt(&parsed.name, &parsed.description, &parsed.raw_body);
    let raw = call_claude_json(&prompt).await?;
    let mut examples = parse_examples_response(&raw)?;

    // Clamp to 3 — keeps the UI chip bar compact and matches what we
    // ask for in the prompt. If the model decides to give 5 anyway,
    // we silently drop the extras rather than surfacing noise.
    examples.truncate(3);
    if examples.is_empty() {
        return Err("model produced no usable examples".into());
    }

    // Persist back to SKILL.md. Atomic write via tmp+rename.
    let content = tokio::fs::read_to_string(&md_path)
        .await
        .map_err(|e| format!("read {}: {e}", md_path.display()))?;
    let new_content = skill_md::write::write_examples(&content, &examples)
        .map_err(|e| format!("write examples: {e}"))?;
    write_atomic(&md_path, &new_content).await?;

    crate::skills::invalidate_skills_cache();
    Ok(SuggestedExamples {
        slug: slug.to_string(),
        examples,
    })
}

fn build_prompt(name: &str, description: &str, body: &str) -> String {
    // Clip the body so we don't bloat context for huge composite skills.
    let body_excerpt = if body.len() > 4000 {
        format!("{}\n\n…(body truncated, ~{} more chars)", &body[..4000], body.len() - 4000)
    } else {
        body.to_string()
    };
    format!(
        "You are generating example prompts for a Claude Code \"skill\" — \
a prose-authored task the user invokes by saying what they want.\n\
\n\
Given the skill below, write exactly 3 concrete example prompts a user \
might type to run it. The examples must:\n\
- Be short (6-20 words each)\n\
- Reference specific, realistic domain details (not generic placeholders)\n\
- Sound like something a real user would actually say\n\
- Cover different shapes of input the skill accepts (don't just reword one example 3 times)\n\
\n\
Return ONLY a JSON array of 3 strings. No prose, no markdown, no code fence. \
Example output format: [\"first example\", \"second example\", \"third example\"]\n\
\n\
--- SKILL ---\n\
Name: {name}\n\
Description: {description}\n\
\n\
Body:\n\
{body_excerpt}\n\
--- END SKILL ---"
    )
}

async fn call_claude_json(prompt: &str) -> Result<String, String> {
    let model = crate::model_config::model_for_suggest_examples();
    let _permit = crate::claude_gate::acquire().await;
    let output = tokio::process::Command::new("claude")
        .arg("-p")
        .arg("--no-session-persistence")
        .arg("--output-format")
        .arg("json")
        .arg("--model")
        .arg(&model)
        .arg(prompt)
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
    let v: serde_json::Value =
        serde_json::from_str(raw.trim()).map_err(|e| format!("parse claude json: {e}"))?;
    v.get("result")
        .and_then(|r| r.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "no `result` field in claude output".into())
}

/// Parse the model's JSON array response. Tolerates common model quirks:
///   - wrapping the array in a markdown code fence
///   - leading/trailing prose before/after the array
///   - using smart quotes instead of `"`
fn parse_examples_response(raw: &str) -> Result<Vec<String>, String> {
    let cleaned = extract_json_array(raw);
    let parsed: Vec<serde_json::Value> = serde_json::from_str(&cleaned)
        .map_err(|e| format!("parse examples array: {e}\nraw: {raw}"))?;
    Ok(parsed
        .into_iter()
        .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .collect())
}

fn extract_json_array(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    // Strip code fences the model sometimes adds despite being asked not to.
    if s.starts_with("```") {
        if let Some(newline) = s.find('\n') {
            s = s[newline + 1..].to_string();
        }
        if let Some(end) = s.rfind("```") {
            s.truncate(end);
        }
    }
    // Find the first '[' and the matching last ']'. Drops any trailing prose.
    let start = s.find('[');
    let end = s.rfind(']');
    match (start, end) {
        (Some(a), Some(b)) if b > a => s[a..=b].to_string(),
        _ => s,
    }
}

async fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("md.tmp");
    tokio::fs::write(&tmp, content)
        .await
        .map_err(|e| format!("write tmp: {e}"))?;
    tokio::fs::rename(&tmp, path)
        .await
        .map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_json_array_strips_fences() {
        let raw = "```json\n[\"a\", \"b\", \"c\"]\n```";
        assert_eq!(extract_json_array(raw), "[\"a\", \"b\", \"c\"]");
    }

    #[test]
    fn extract_json_array_strips_prose() {
        let raw = "Here are three examples:\n[\"one\", \"two\", \"three\"]\n\nLet me know.";
        assert_eq!(extract_json_array(raw), "[\"one\", \"two\", \"three\"]");
    }

    #[test]
    fn parse_examples_response_happy_path() {
        let raw = r#"["make a demo for Orka", "record a pitch for my CLI", "build a walkthrough of the trust flow"]"#;
        let parsed = parse_examples_response(raw).unwrap();
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0], "make a demo for Orka");
    }

    #[test]
    fn parse_examples_response_filters_empty_strings() {
        let raw = r#"["valid", "", "   ", "also valid"]"#;
        let parsed = parse_examples_response(raw).unwrap();
        assert_eq!(parsed.len(), 2);
    }
}
