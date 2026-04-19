//! Skill evolution — suggest SKILL.md updates based on how the user
//! actually uses a skill. Reads:
//!
//!   - every annotation thread the user has attached to this skill's runs
//!   - the tail of the skill's SKILL.md
//!
//! …and asks Haiku to propose a patched version that bakes in the
//! consistent patterns the user has been expressing (via notes and
//! follow-up questions).
//!
//! Output is a JSON object with { summary, suggestedMarkdown, rationale }
//! so the frontend can show a diff + accept/reject flow.
//!
//! No session persistence on the claude call (same rule as session
//! briefs). Uses Haiku for speed.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::workspace;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvolutionSuggestion {
    pub slug: String,
    pub summary: String,
    #[serde(rename = "suggestedMarkdown")]
    pub suggested_markdown: String,
    pub rationale: String,
    #[serde(rename = "annotationCount")]
    pub annotation_count: u32,
    #[serde(rename = "runCount")]
    pub run_count: u32,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
}

/// Scan the annotations directory for all files whose first annotation
/// references a run produced by this skill. Returns (run_ids, thread_texts).
fn collect_annotation_threads(slug: &str) -> Vec<(String, String)> {
    let dir = workspace::workspace_root().join("annotations");
    let Ok(entries) = std::fs::read_dir(&dir) else { return vec![]; };
    let mut out: Vec<(String, String)> = vec![];
    let prefix = format!("skill-{slug}-");
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_stem().and_then(|n| n.to_str()) else { continue };
        if !name.starts_with(&prefix) { continue; }

        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let Some(annotations) = v.get("annotations").and_then(|a| a.as_array()) else {
            continue;
        };
        if annotations.is_empty() { continue; }

        let mut rendered = String::new();
        for ann in annotations {
            let bt = ann.get("blockType").and_then(|b| b.as_str()).unwrap_or("");
            let bc = ann.get("blockContent").and_then(|b| b.as_str()).unwrap_or("");
            rendered.push_str(&format!("[{bt} block:] {}\n", truncate(bc, 200)));
            if let Some(thread) = ann.get("thread").and_then(|t| t.as_array()) {
                for msg in thread {
                    let author = msg.get("author").and_then(|a| a.as_str()).unwrap_or("?");
                    let msg_text = msg.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    rendered.push_str(&format!(
                        "  [{}] {}\n",
                        author,
                        truncate(msg_text, 400)
                    ));
                }
            }
            rendered.push('\n');
        }
        out.push((name.to_string(), rendered));
    }
    out
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max { return s.to_string(); }
    let safe = s.char_indices().nth(max).map(|(i, _)| i).unwrap_or(max);
    format!("{}…", &s[..safe])
}

/// Look up a skill's SKILL.md path from the scanner.
fn skill_md_path(slug: &str) -> Option<PathBuf> {
    for meta in crate::skills::scan_skills_dirs() {
        if meta.slug == slug {
            let p = PathBuf::from(meta.path).join("SKILL.md");
            if p.is_file() { return Some(p); }
        }
    }
    None
}

#[tauri::command]
pub async fn suggest_skill_evolution(slug: String) -> Result<EvolutionSuggestion, String> {
    let threads = collect_annotation_threads(&slug);
    if threads.is_empty() {
        return Err(
            "No annotations yet for this skill. Run it, comment on some blocks, ask Claude a follow-up — come back when there's data to learn from.".into(),
        );
    }

    let md_path = skill_md_path(&slug).ok_or_else(|| format!("skill '{slug}' not found on disk"))?;
    let current_md = std::fs::read_to_string(&md_path)
        .map_err(|e| format!("read SKILL.md: {e}"))?;

    let run_count = threads.len() as u32;
    let annotation_count = threads
        .iter()
        .map(|(_, t)| t.matches("[you]").count() + t.matches("[claude]").count())
        .sum::<usize>() as u32;

    let mut annotations_section = String::new();
    for (i, (run_id, thread_text)) in threads.iter().enumerate() {
        annotations_section.push_str(&format!("## Run {} (id: {run_id})\n\n", i + 1));
        annotations_section.push_str(thread_text);
        annotations_section.push('\n');
    }
    // Cap annotations at ~20KB so the prompt stays manageable.
    if annotations_section.len() > 20_000 {
        let safe = annotations_section
            .char_indices()
            .rfind(|(i, _)| *i <= 20_000)
            .map(|(i, _)| i)
            .unwrap_or(20_000);
        annotations_section.truncate(safe);
        annotations_section.push_str("\n\n…(older annotations elided)…");
    }

    let prompt = format!(
        "You are evolving a Claude Code skill based on how the user actually uses it. \
Return ONE JSON object and nothing else, matching this schema:\n\
\n\
{{\n\
  \"summary\": \"<one short sentence — what you changed and why>\",\n\
  \"suggestedMarkdown\": \"<the full new SKILL.md content, including frontmatter>\",\n\
  \"rationale\": \"<2-4 sentences citing the specific patterns you observed>\"\n\
}}\n\
\n\
Rules:\n\
- Preserve the skill's existing name, slug, and intent. Don't rename it.\n\
- Bake in patterns the user CONSISTENTLY expresses across multiple runs.\n\
- Don't add speculative features — only codify what's already in the annotations.\n\
- Keep the SKILL.md tight. A skill that rambles won't be used.\n\
- No markdown around the JSON. No code fences. Just the object.\n\
\n\
--- CURRENT SKILL.md ---\n\
{current_md}\n\
--- END SKILL.md ---\n\
\n\
--- USAGE ANNOTATIONS ({run_count} runs) ---\n\
{annotations_section}\n\
--- END ANNOTATIONS ---"
    );

    let raw = call_claude_print(&prompt).await?;
    let parsed = parse_suggestion_json(&raw).map_err(|e| {
        eprintln!("[evolve] parse failed: {e}\n--raw--\n{raw}\n--end--");
        e
    })?;

    Ok(EvolutionSuggestion {
        slug,
        summary: parsed.summary,
        suggested_markdown: parsed.suggested_markdown,
        rationale: parsed.rationale,
        annotation_count,
        run_count,
        generated_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// Persist a user-approved evolution. Writes the new SKILL.md atomically
/// (tmp + rename) and snapshots the old one to `SKILL.md.backup-<ts>`
/// so accidents are recoverable.
#[tauri::command]
pub async fn apply_skill_evolution(
    slug: String,
    new_markdown: String,
) -> Result<String, String> {
    let path = skill_md_path(&slug).ok_or_else(|| format!("skill '{slug}' not found"))?;
    let parent = path.parent().ok_or("skill path has no parent")?.to_path_buf();

    // Back up the current SKILL.md alongside it.
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let backup = parent.join(format!("SKILL.md.backup-{ts}"));
    if path.is_file() {
        tokio::fs::copy(&path, &backup)
            .await
            .map_err(|e| format!("backup: {e}"))?;
    }

    let tmp = path.with_extension("md.tmp");
    tokio::fs::write(&tmp, new_markdown)
        .await
        .map_err(|e| format!("write tmp: {e}"))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| format!("rename: {e}"))?;
    Ok(backup.to_string_lossy().into_owned())
}

// ───────── internals ──────────────────────────────────────────────────

async fn call_claude_print(prompt: &str) -> Result<String, String> {
    let output = tokio::process::Command::new("claude")
        .arg("-p")
        .arg("--no-session-persistence")
        .arg("--model")
        .arg("haiku")
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
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[derive(Deserialize)]
struct ParsedSuggestion {
    summary: String,
    #[serde(rename = "suggestedMarkdown")]
    suggested_markdown: String,
    rationale: String,
}

fn parse_suggestion_json(raw: &str) -> Result<ParsedSuggestion, String> {
    let trimmed = raw.trim();
    let no_fence = if let Some(rest) = trimmed.strip_prefix("```json") {
        rest.trim_start().trim_end_matches("```").trim()
    } else if let Some(rest) = trimmed.strip_prefix("```") {
        rest.trim_start().trim_end_matches("```").trim()
    } else {
        trimmed
    };
    let start = no_fence.find('{').ok_or("no JSON object in response")?;
    let end = no_fence.rfind('}').ok_or("unclosed JSON object")?;
    if end < start { return Err("invalid JSON bounds".into()); }
    serde_json::from_str::<ParsedSuggestion>(&no_fence[start..=end])
        .map_err(|e| format!("parse: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain() {
        let raw = r#"{"summary":"x","suggestedMarkdown":"md","rationale":"r"}"#;
        let p = parse_suggestion_json(raw).unwrap();
        assert_eq!(p.summary, "x");
        assert_eq!(p.suggested_markdown, "md");
    }

    #[test]
    fn parses_fenced() {
        let raw = "```json\n{\"summary\":\"x\",\"suggestedMarkdown\":\"md\",\"rationale\":\"r\"}\n```";
        let p = parse_suggestion_json(raw).unwrap();
        assert_eq!(p.rationale, "r");
    }

    #[test]
    fn truncate_preserves_char_boundaries() {
        let s = "hello 世界 world hello 世界 world";
        let t = truncate(s, 10);
        assert!(t.len() <= s.len());
        assert!(t.ends_with('…'));
    }
}
