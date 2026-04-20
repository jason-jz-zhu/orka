use super::parse::compute_prose_hash;

const GRAPH_TAG_PREFIX: &str = "<!-- orka:graph v";
const GRAPH_TAG_SUFFIX: &str = "-->";

/// Replace (or append) the `<!-- orka:graph v1 ... -->` block in a SKILL.md
/// body. Prose is untouched. Returns the full new file content (frontmatter +
/// body with updated block).
pub fn write_graph_block(
    full_content: &str,
    graph_json: &serde_json::Value,
) -> Result<String, String> {
    let (before_body, body) = split_at_body(full_content)?;

    let new_hash = compute_prose_hash(&body);

    let mut graph_with_hash = graph_json.clone();
    if let Some(obj) = graph_with_hash.as_object_mut() {
        obj.insert(
            "proseHash".to_string(),
            serde_json::Value::String(new_hash),
        );
    }

    let pretty = serde_json::to_string_pretty(&graph_with_hash)
        .map_err(|e| format!("serialize graph: {e}"))?;

    let new_block = format!("<!-- orka:graph v1\n{pretty}\n-->");

    let new_body = if let Some(start) = body.find(GRAPH_TAG_PREFIX) {
        let end_search = &body[start..];
        if let Some(end_offset) = end_search.find(GRAPH_TAG_SUFFIX) {
            let end = start + end_offset + GRAPH_TAG_SUFFIX.len();
            let mut result = body[..start].to_string();
            result.push_str(&new_block);
            result.push_str(&body[end..]);
            result
        } else {
            let mut result = body.clone();
            result.push_str("\n\n");
            result.push_str(&new_block);
            result.push('\n');
            result
        }
    } else {
        let mut result = body.trim_end().to_string();
        result.push_str("\n\n");
        result.push_str(&new_block);
        result.push('\n');
        result
    };

    Ok(format!("{}{}", before_body, new_body))
}

/// Replace (or insert) the top-level `examples:` array in a SKILL.md
/// frontmatter. Prose body and all other frontmatter keys are preserved.
/// Returns the full new file content.
///
/// Used by `suggest_skill_examples` so an LLM-generated example set can
/// be persisted without the skill author having to edit YAML by hand.
/// Idempotent: passing an empty slice removes the block entirely.
pub fn write_examples(
    full_content: &str,
    examples: &[String],
) -> Result<String, String> {
    let (before_body, body) = split_at_body(full_content)?;

    // `before_body` is `---\n<yaml>\n---` (possibly with trailing newline).
    // Peel the delimiters off so we can edit just the YAML slice.
    let fm_end = before_body
        .rfind("\n---")
        .ok_or("malformed frontmatter: no closing ---")?;
    let leading_newlines_after_close = &before_body[fm_end + 4..];
    let fm_raw = &before_body[3..fm_end];
    let fm_body = fm_raw.strip_prefix('\n').unwrap_or(fm_raw);

    let cleaned = strip_top_level_key(fm_body, "examples");
    let composed = if examples.is_empty() {
        cleaned.trim_end().to_string()
    } else {
        let block = render_examples_block(examples);
        if cleaned.trim().is_empty() {
            block
        } else {
            format!("{}\n{}", cleaned.trim_end(), block)
        }
    };

    Ok(format!(
        "---\n{}\n---{}{}",
        composed, leading_newlines_after_close, body
    ))
}

/// Remove a top-level YAML key's block from `fm` (including any
/// indented/list continuation lines). Returns the remaining YAML text.
/// Intentionally simple — we don't need a full parser for this; just
/// "lines starting at column 0 with `<key>:` plus subsequent indented
/// continuation lines".
fn strip_top_level_key(fm: &str, key: &str) -> String {
    let mut out = String::new();
    let lines: Vec<&str> = fm.lines().collect();
    let mut i = 0;
    let prefix = format!("{key}:");
    while i < lines.len() {
        let line = lines[i];
        if line.starts_with(&prefix) {
            // Skip the key line + every continuation (indented / list
            // marker / blank). Stops at the next top-level key.
            i += 1;
            while i < lines.len() {
                let next = lines[i];
                let is_cont = next.is_empty()
                    || next.starts_with(' ')
                    || next.starts_with('\t')
                    || next.starts_with("- ");
                if !is_cont {
                    break;
                }
                i += 1;
            }
        } else {
            out.push_str(line);
            out.push('\n');
            i += 1;
        }
    }
    out
}

/// Render a YAML array block in the simplest shape that the SKILL.md
/// parser accepts: `examples:` followed by `  - "…"` lines with double
/// quotes escaped. Multi-line strings get folded into one line — each
/// example is meant to be a short prompt, not a paragraph.
fn render_examples_block(examples: &[String]) -> String {
    let mut out = String::from("examples:\n");
    for ex in examples {
        let single_line = ex.replace('\n', " ").trim().to_string();
        let escaped = single_line.replace('\\', "\\\\").replace('"', "\\\"");
        out.push_str(&format!("  - \"{}\"\n", escaped));
    }
    out.trim_end().to_string()
}

fn split_at_body(content: &str) -> Result<(String, String), String> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return Err("SKILL.md must start with --- frontmatter".into());
    }
    let after_first = &trimmed[3..];
    let end = after_first
        .find("\n---")
        .ok_or("frontmatter not closed")?;
    let body_start = 3 + end + 4;
    let before = trimmed[..body_start].to_string();
    let body = if body_start < trimmed.len() {
        trimmed[body_start..].to_string()
    } else {
        String::new()
    };
    Ok((before, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_append_graph_block() {
        let content = "---\nname: test\n---\n\n# Test\n\nSome prose.\n";
        let graph: serde_json::Value = serde_json::json!({
            "nodes": [],
            "edges": [],
            "stepMap": {}
        });
        let result = write_graph_block(content, &graph).unwrap();
        assert!(result.contains("<!-- orka:graph v1"));
        assert!(result.contains("\"proseHash\": \"sha256:"));
        assert!(result.contains("# Test"));
        assert!(result.contains("Some prose."));
    }

    #[test]
    fn test_replace_existing_block() {
        let content = "---\nname: test\n---\n\n# Test\n\n<!-- orka:graph v1\n{\"nodes\":[],\"edges\":[]}\n-->\n";
        let graph: serde_json::Value = serde_json::json!({
            "nodes": [{"id":"n1","type":"chat","pos":[0,0],"data":{}}],
            "edges": [],
            "stepMap": {"n1": 1}
        });
        let result = write_graph_block(content, &graph).unwrap();
        assert!(result.contains("\"n1\""));
        // Should only have ONE graph block
        assert_eq!(result.matches("<!-- orka:graph v1").count(), 1);
    }

    #[test]
    fn test_write_examples_inserts_when_absent() {
        let content = "---\nname: foo\ndescription: bar\n---\n\n# Body\n";
        let result = write_examples(
            content,
            &["do thing A".into(), "do thing B".into()],
        )
        .unwrap();
        assert!(result.contains("examples:"));
        assert!(result.contains("\"do thing A\""));
        assert!(result.contains("\"do thing B\""));
        assert!(result.contains("# Body"));
        assert!(result.contains("name: foo"));
    }

    #[test]
    fn test_write_examples_replaces_existing() {
        let content = "---\nname: foo\nexamples:\n  - \"old one\"\n  - \"old two\"\ndescription: bar\n---\n\n# Body\n";
        let result = write_examples(content, &["new only".into()]).unwrap();
        assert!(result.contains("\"new only\""));
        assert!(!result.contains("old one"));
        assert!(!result.contains("old two"));
        assert!(result.contains("description: bar"));
    }

    #[test]
    fn test_write_examples_empty_removes_block() {
        let content = "---\nname: foo\nexamples:\n  - \"x\"\n---\n\n# Body\n";
        let result = write_examples(content, &[]).unwrap();
        assert!(!result.contains("examples:"));
        assert!(result.contains("name: foo"));
        assert!(result.contains("# Body"));
    }

    #[test]
    fn test_write_examples_escapes_quotes() {
        let content = "---\nname: foo\n---\n\nbody\n";
        let result =
            write_examples(content, &["he said \"hi\" to me".into()]).unwrap();
        assert!(result.contains(r#""he said \"hi\" to me""#));
    }

    #[test]
    fn test_round_trip_preserves_prose() {
        let content = "---\nname: test\n---\n\n# My Skill\n\nDo the thing.\n\n## Steps\n\n1. First step\n2. Second step\n";
        let graph: serde_json::Value = serde_json::json!({
            "nodes": [],
            "edges": [],
            "stepMap": {}
        });
        let result = write_graph_block(content, &graph).unwrap();
        assert!(result.contains("# My Skill"));
        assert!(result.contains("Do the thing."));
        assert!(result.contains("1. First step"));
        assert!(result.contains("2. Second step"));
    }
}
