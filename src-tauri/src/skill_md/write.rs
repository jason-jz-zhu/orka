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
