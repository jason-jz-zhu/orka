use sha2::{Digest, Sha256};
use std::path::Path;

use super::SCHEMA_VERSION;

#[derive(Debug, Clone)]
pub struct ParsedSkill {
    pub name: String,
    pub description: String,
    pub allowed_tools: Option<String>,
    pub schema: u32,
    pub inputs: Vec<SkillInput>,
    pub outputs: Vec<SkillOutput>,
    pub viewport: Option<serde_json::Value>,
    pub graph: Option<GraphBlock>,
    pub drift: DriftStatus,
    pub raw_frontmatter: String,
    pub raw_body: String,
}

#[derive(Debug, Clone)]
pub struct SkillInput {
    pub name: String,
    pub input_type: String,
    pub default: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SkillOutput {
    pub name: String,
    pub from: String,
}

#[derive(Debug, Clone)]
pub struct GraphBlock {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<(String, String)>,
    pub step_map: std::collections::HashMap<String, u32>,
    pub prose_hash: String,
    pub raw_json: String,
}

#[derive(Debug, Clone)]
pub struct GraphNode {
    pub id: String,
    pub node_type: String,
    pub pos: (f64, f64),
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DriftStatus {
    NoDrift,
    Drifted,
    NoGraph,
}

pub fn parse_skill_md(path: &Path) -> Result<ParsedSkill, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    parse_skill_md_str(&content)
}

pub fn parse_skill_md_str(content: &str) -> Result<ParsedSkill, String> {
    let (frontmatter_str, body) = split_frontmatter(content)?;
    let fm: serde_json::Value = parse_yaml_frontmatter(&frontmatter_str)?;

    let name = fm.get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let description = fm.get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let allowed_tools = fm.get("allowed-tools")
        .and_then(|v| v.as_str())
        .map(String::from);

    let orka = fm.get("orka");
    let schema = orka
        .and_then(|o| o.get("schema"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    if schema > SCHEMA_VERSION {
        return Err(format!(
            "unsupported schema version {schema} (this build supports up to {SCHEMA_VERSION}). Upgrade Orka."
        ));
    }

    let inputs = parse_inputs(orka);
    let outputs = parse_outputs(orka);
    let viewport = orka
        .and_then(|o| o.get("viewport"))
        .cloned();

    let (graph_block, drift) = parse_graph_and_drift(&body);

    Ok(ParsedSkill {
        name,
        description,
        allowed_tools,
        schema,
        inputs,
        outputs,
        viewport,
        graph: graph_block,
        drift,
        raw_frontmatter: frontmatter_str,
        raw_body: body,
    })
}

fn split_frontmatter(content: &str) -> Result<(String, String), String> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return Err("SKILL.md must start with --- frontmatter".into());
    }
    let after_first = &trimmed[3..];
    let end = after_first
        .find("\n---")
        .ok_or("frontmatter not closed (missing second ---)")?;
    let fm = after_first[..end].trim().to_string();
    let body_start = 3 + end + 4; // skip "---\n" + content + "\n---"
    let body = if body_start < trimmed.len() {
        trimmed[body_start..].to_string()
    } else {
        String::new()
    };
    Ok((fm, body))
}

fn parse_yaml_frontmatter(yaml_str: &str) -> Result<serde_json::Value, String> {
    // Simple YAML parser: convert key: value lines to JSON.
    // For nested structures (orka:), we do a minimal parse.
    // This avoids a full YAML dependency — Orka frontmatter is simple.
    let mut root = serde_json::Map::new();
    let mut current_section: Option<String> = None;
    let mut section_map = serde_json::Map::new();
    let mut in_array: Option<(String, Vec<serde_json::Value>)> = None;
    let mut array_item = serde_json::Map::new();

    for line in yaml_str.lines() {
        let trimmed = line.trim_end();

        // Blank lines
        if trimmed.trim().is_empty() {
            continue;
        }

        // Continuation of multi-line description (>)
        if current_section.is_none() && !trimmed.contains(':') && !trimmed.starts_with('-') {
            if let Some(existing) = root.get_mut("description") {
                if let Some(s) = existing.as_str() {
                    let merged = format!("{} {}", s.trim(), trimmed.trim());
                    *existing = serde_json::Value::String(merged);
                }
            }
            continue;
        }

        let indent = line.len() - line.trim_start().len();

        // Top-level key
        if indent == 0 && trimmed.contains(':') {
            // Flush previous section
            if let Some(ref sec) = current_section {
                if let Some((arr_key, mut arr)) = in_array.take() {
                    if !array_item.is_empty() {
                        arr.push(serde_json::Value::Object(array_item.clone()));
                        array_item.clear();
                    }
                    section_map.insert(arr_key, serde_json::Value::Array(arr));
                }
                root.insert(sec.clone(), serde_json::Value::Object(section_map.clone()));
                section_map.clear();
                current_section = None;
            }

            let (key, val) = split_kv(trimmed);
            if val.is_empty() || val == ">" {
                if key == "orka" {
                    current_section = Some(key);
                } else {
                    root.insert(key, serde_json::Value::String(String::new()));
                }
            } else {
                root.insert(key, parse_yaml_value(&val));
            }
            continue;
        }

        // Inside a section (orka:)
        if current_section.is_some() {
            let content = trimmed.trim();

            // Array item start: "- name: foo" or "- { ... }"
            if content.starts_with("- ") {
                if let Some((ref arr_key, ref mut arr)) = in_array {
                    if !array_item.is_empty() {
                        arr.push(serde_json::Value::Object(array_item.clone()));
                        array_item.clear();
                    }
                    let item_content = &content[2..].trim();
                    // Inline object: - { name: foo, type: string }
                    if item_content.starts_with('{') && item_content.ends_with('}') {
                        let inner = &item_content[1..item_content.len()-1];
                        let mut obj = serde_json::Map::new();
                        for part in inner.split(',') {
                            let part = part.trim();
                            if part.contains(':') {
                                let (k, v) = split_kv(part);
                                obj.insert(k, parse_yaml_value(&v));
                            }
                        }
                        arr.push(serde_json::Value::Object(obj));
                    } else if item_content.contains(':') {
                        let (k, v) = split_kv(item_content);
                        array_item.insert(k, parse_yaml_value(&v));
                    }
                    let _ = arr_key; // suppress unused warning
                } else {
                    // Not in an array yet — shouldn't happen with valid YAML
                }
                continue;
            }

            // Array item continuation (indented key: value under a - item)
            if in_array.is_some() && indent >= 6 && content.contains(':') {
                let (k, v) = split_kv(content);
                array_item.insert(k, parse_yaml_value(&v));
                continue;
            }

            // Section-level key
            if content.contains(':') {
                let (key, val) = split_kv(content);
                if val.is_empty() {
                    // Start of an array or nested object
                    in_array = Some((key, Vec::new()));
                } else if val.starts_with('{') {
                    // Inline object: viewport: { x: 0, y: 0, zoom: 0.85 }
                    section_map.insert(key, parse_inline_object(&val));
                } else {
                    section_map.insert(key, parse_yaml_value(&val));
                }
            }
        }
    }

    // Flush final section
    if let Some(ref sec) = current_section {
        if let Some((arr_key, mut arr)) = in_array.take() {
            if !array_item.is_empty() {
                arr.push(serde_json::Value::Object(array_item));
            }
            section_map.insert(arr_key, serde_json::Value::Array(arr));
        }
        root.insert(sec.clone(), serde_json::Value::Object(section_map));
    }

    Ok(serde_json::Value::Object(root))
}

fn split_kv(s: &str) -> (String, String) {
    if let Some(pos) = s.find(':') {
        let key = s[..pos].trim().to_string();
        let val = s[pos + 1..].trim().to_string();
        (key, val)
    } else {
        (s.trim().to_string(), String::new())
    }
}

fn parse_yaml_value(s: &str) -> serde_json::Value {
    let s = s.trim();
    // Remove surrounding quotes
    if (s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')) {
        return serde_json::Value::String(s[1..s.len()-1].to_string());
    }
    if s == "true" { return serde_json::Value::Bool(true); }
    if s == "false" { return serde_json::Value::Bool(false); }
    if s == ">" { return serde_json::Value::String(String::new()); }
    if let Ok(n) = s.parse::<i64>() { return serde_json::Value::Number(n.into()); }
    if let Ok(n) = s.parse::<f64>() {
        if let Some(n) = serde_json::Number::from_f64(n) {
            return serde_json::Value::Number(n);
        }
    }
    serde_json::Value::String(s.to_string())
}

fn parse_inline_object(s: &str) -> serde_json::Value {
    let s = s.trim();
    if !(s.starts_with('{') && s.ends_with('}')) {
        return serde_json::Value::String(s.to_string());
    }
    let inner = &s[1..s.len()-1];
    let mut obj = serde_json::Map::new();
    for part in inner.split(',') {
        let part = part.trim();
        if part.contains(':') {
            let (k, v) = split_kv(part);
            obj.insert(k, parse_yaml_value(&v));
        }
    }
    serde_json::Value::Object(obj)
}

fn parse_inputs(orka: Option<&serde_json::Value>) -> Vec<SkillInput> {
    let arr = orka
        .and_then(|o| o.get("inputs"))
        .and_then(|v| v.as_array());
    let Some(arr) = arr else { return Vec::new() };
    arr.iter().filter_map(|item| {
        let name = item.get("name")?.as_str()?.to_string();
        let input_type = item.get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("string")
            .to_string();
        let default = item.get("default").and_then(|v| v.as_str()).map(String::from);
        let description = item.get("description").and_then(|v| v.as_str()).map(String::from);
        Some(SkillInput { name, input_type, default, description })
    }).collect()
}

fn parse_outputs(orka: Option<&serde_json::Value>) -> Vec<SkillOutput> {
    let arr = orka
        .and_then(|o| o.get("outputs"))
        .and_then(|v| v.as_array());
    let Some(arr) = arr else { return Vec::new() };
    arr.iter().filter_map(|item| {
        let name = item.get("name")?.as_str()?.to_string();
        let from = item.get("from")?.as_str()?.to_string();
        Some(SkillOutput { name, from })
    }).collect()
}

const GRAPH_TAG_PREFIX: &str = "<!-- orka:graph v";
const GRAPH_TAG_SUFFIX: &str = "-->";

fn parse_graph_and_drift(body: &str) -> (Option<GraphBlock>, DriftStatus) {
    let Some(start) = body.find(GRAPH_TAG_PREFIX) else {
        return (None, DriftStatus::NoGraph);
    };
    let Some(end) = body[start..].find(GRAPH_TAG_SUFFIX) else {
        return (None, DriftStatus::NoGraph);
    };

    let block_content = &body[start..start + end + GRAPH_TAG_SUFFIX.len()];

    // Extract version from tag line
    let tag_line_end = block_content.find('\n').unwrap_or(block_content.len());
    let tag_line = &block_content[..tag_line_end];
    let version_str = tag_line
        .strip_prefix(GRAPH_TAG_PREFIX)
        .unwrap_or("1")
        .trim();
    let _version: u32 = version_str.parse().unwrap_or(1);

    // Extract JSON between first { and last }
    let json_start = block_content.find('{');
    let json_end = block_content.rfind('}');
    let (json_start, json_end) = match (json_start, json_end) {
        (Some(s), Some(e)) if s < e => (s, e),
        _ => return (None, DriftStatus::NoGraph),
    };
    let json_str = &block_content[json_start..=json_end];

    let parsed: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("orka:graph JSON parse error: {e}");
            return (None, DriftStatus::NoGraph);
        }
    };

    let nodes = parse_graph_nodes(&parsed);
    let edges = parse_graph_edges(&parsed);
    let step_map = parse_step_map(&parsed);
    let stored_hash = parsed.get("proseHash")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let current_hash = compute_prose_hash(body);
    let drift = if stored_hash.is_empty() || stored_hash == current_hash {
        DriftStatus::NoDrift
    } else {
        DriftStatus::Drifted
    };

    let graph = GraphBlock {
        nodes,
        edges,
        step_map,
        prose_hash: stored_hash,
        raw_json: json_str.to_string(),
    };

    (Some(graph), drift)
}

fn parse_graph_nodes(parsed: &serde_json::Value) -> Vec<GraphNode> {
    let Some(arr) = parsed.get("nodes").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter().filter_map(|n| {
        let id = n.get("id")?.as_str()?.to_string();
        let node_type = n.get("type")?.as_str()?.to_string();
        let pos = n.get("pos").and_then(|p| p.as_array()).map(|a| {
            let x = a.first().and_then(|v| v.as_f64()).unwrap_or(0.0);
            let y = a.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0);
            (x, y)
        }).unwrap_or((0.0, 0.0));
        let data = n.get("data").cloned().unwrap_or(serde_json::Value::Null);
        Some(GraphNode { id, node_type, pos, data })
    }).collect()
}

fn parse_graph_edges(parsed: &serde_json::Value) -> Vec<(String, String)> {
    let Some(arr) = parsed.get("edges").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter().filter_map(|e| {
        let a = e.as_array()?;
        let source = a.first()?.as_str()?.to_string();
        let target = a.get(1)?.as_str()?.to_string();
        Some((source, target))
    }).collect()
}

fn parse_step_map(parsed: &serde_json::Value) -> std::collections::HashMap<String, u32> {
    let Some(obj) = parsed.get("stepMap").and_then(|v| v.as_object()) else {
        return std::collections::HashMap::new();
    };
    obj.iter().filter_map(|(k, v)| {
        Some((k.clone(), v.as_u64()? as u32))
    }).collect()
}

pub fn compute_prose_hash(body: &str) -> String {
    let stripped = strip_graph_block(body);
    let normalized = stripped
        .lines()
        .map(|l| l.trim_end())
        .collect::<Vec<_>>()
        .join("\n");
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let result = hasher.finalize();
    format!("sha256:{:x}", result)
}

fn strip_graph_block(body: &str) -> String {
    let Some(start) = body.find(GRAPH_TAG_PREFIX) else {
        return body.to_string();
    };
    let Some(end_offset) = body[start..].find(GRAPH_TAG_SUFFIX) else {
        return body.to_string();
    };
    let end = start + end_offset + GRAPH_TAG_SUFFIX.len();
    let mut result = body[..start].to_string();
    result.push_str(&body[end..]);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const ATOMIC_SKILL: &str = r#"---
name: summarize-folder
description: Summarize all markdown files in a folder into 10 bullet points.
allowed-tools: Read
orka:
  schema: 1
  inputs:
    - { name: folder, type: string, default: "~/Documents/notes" }
---

# Summarize Folder

Read all markdown files under `{{folder}}`. Produce exactly 10 bullet points.
"#;

    const COMPOSITE_SKILL: &str = r#"---
name: morning-briefing
description: Build a daily briefing from calendar and inbox.
allowed-tools: Read, Write, Bash
orka:
  schema: 1
  inputs:
    - { name: focus, default: "deep work", description: "Today's theme" }
---

# Morning Briefing

## Steps

1. **Calendar** — call the `calendar-today` skill
2. **Inbox** — call the `inbox-triage` skill
3. **Compose** — combine into a briefing

<!-- orka:graph v1
{
  "nodes": [
    {"id":"n1","type":"skill_ref","pos":[60,80],"data":{"skill":"calendar-today","bind":{"focus":"{{focus}}"}}},
    {"id":"n2","type":"skill_ref","pos":[60,340],"data":{"skill":"inbox-triage","bind":{}}},
    {"id":"n3","type":"agent","pos":[360,200],"data":{"prompt":"Compose briefing from:\n{{n1}}\n{{n2}}"}}
  ],
  "edges": [["n1","n3"],["n2","n3"]],
  "stepMap": {"n1":1,"n2":2,"n3":3},
  "proseHash": ""
}
-->
"#;

    #[test]
    fn test_atomic_skill() {
        let skill = parse_skill_md_str(ATOMIC_SKILL).unwrap();
        assert_eq!(skill.name, "summarize-folder");
        assert_eq!(skill.schema, 1);
        assert_eq!(skill.inputs.len(), 1);
        assert_eq!(skill.inputs[0].name, "folder");
        assert_eq!(skill.inputs[0].default.as_deref(), Some("~/Documents/notes"));
        assert!(skill.graph.is_none());
        assert_eq!(skill.drift, DriftStatus::NoGraph);
    }

    #[test]
    fn test_composite_skill() {
        let skill = parse_skill_md_str(COMPOSITE_SKILL).unwrap();
        assert_eq!(skill.name, "morning-briefing");
        assert_eq!(skill.schema, 1);
        assert_eq!(skill.inputs.len(), 1);
        assert_eq!(skill.inputs[0].name, "focus");
        let graph = skill.graph.as_ref().unwrap();
        assert_eq!(graph.nodes.len(), 3);
        assert_eq!(graph.edges.len(), 2);
        assert_eq!(graph.edges[0], ("n1".into(), "n3".into()));
        assert_eq!(graph.nodes[0].node_type, "skill_ref");
        assert_eq!(graph.nodes[2].node_type, "agent");
        assert_eq!(graph.step_map.get("n1"), Some(&1));
        // proseHash is empty → NoDrift
        assert_eq!(skill.drift, DriftStatus::NoDrift);
    }

    #[test]
    fn test_drift_detection() {
        // Inject a proseHash that doesn't match the actual body
        let skill_with_stale_hash = COMPOSITE_SKILL.replace(
            "\"proseHash\": \"\"",
            "\"proseHash\": \"sha256:0000000000000000000000000000000000000000000000000000000000000000\""
        );
        let skill = parse_skill_md_str(&skill_with_stale_hash).unwrap();
        assert_eq!(skill.drift, DriftStatus::Drifted);
    }

    #[test]
    fn test_multiline_description() {
        let content = r#"---
name: orka-skill-builder
description: >
  Create new Orka-compatible skills from a description or from the current
  conversation. Handles both simple and complex requests automatically.
allowed-tools: Read, Write, Bash
orka:
  schema: 1
---

# Orka Skill Builder

Body text.
"#;
        let skill = parse_skill_md_str(content).unwrap();
        assert_eq!(skill.name, "orka-skill-builder");
        assert!(
            skill.description.contains("Create new"),
            "description was: {:?}",
            skill.description
        );
        assert!(
            skill.description.contains("complex requests"),
            "description was: {:?}",
            skill.description
        );
        assert_eq!(skill.allowed_tools.as_deref(), Some("Read, Write, Bash"));
        assert_eq!(skill.schema, 1);
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    #[test]
    fn test_parse_real_meta_skill() {
        let path = std::path::Path::new(env!("HOME"))
            .join(".claude/skills/orka-skill-builder/SKILL.md");
        if !path.exists() {
            eprintln!("skip: {:?} not found", path);
            return;
        }
        match parse_skill_md(&path) {
            Ok(s) => {
                eprintln!("name: {:?}", s.name);
                eprintln!("desc: {:?}", s.description);
                eprintln!("schema: {}", s.schema);
                assert_eq!(s.name, "orka-skill-builder");
                assert!(s.description.len() > 10, "desc too short: {:?}", s.description);
            }
            Err(e) => panic!("parse failed: {e}"),
        }
    }
}
