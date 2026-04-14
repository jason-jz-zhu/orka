//! Natural-language → pipeline JSON generator. The user types a requirement
//! (e.g. "draft 5 tweets and pick the best 2"); we hand it to `claude -p`
//! with a strict system prompt and receive a node/edge graph we can drop
//! straight into the canvas.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

const GENERATOR_PROMPT: &str = include_str!("pipeline_gen_prompt.md");

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GenNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub position: GenPosition,
    pub data: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GenPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GenEdge {
    pub source: String,
    pub target: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GeneratedPipeline {
    pub nodes: Vec<GenNode>,
    pub edges: Vec<GenEdge>,
}

#[derive(Serialize)]
pub struct GenerateResult {
    pub pipeline: GeneratedPipeline,
    /// Raw claude output (for debugging / "try again" context)
    pub raw: String,
}

/// Strip ```json ... ``` or ``` ... ``` fences if claude wrapped its output
/// in markdown. Also trims.
fn strip_code_fences(s: &str) -> String {
    let t = s.trim();
    // Strict: only strip when the FIRST non-empty line is ``` or ```json
    if let Some(stripped) = t.strip_prefix("```json") {
        let body = stripped.trim_start_matches('\n');
        if let Some(end) = body.rfind("```") {
            return body[..end].trim().to_string();
        }
    }
    if let Some(stripped) = t.strip_prefix("```") {
        let body = stripped.trim_start_matches('\n');
        if let Some(end) = body.rfind("```") {
            return body[..end].trim().to_string();
        }
    }
    t.to_string()
}

/// Validate the generated graph — rejects malformed JSON before it hits the
/// frontend `setGraph`.
fn validate(p: &GeneratedPipeline) -> Result<(), String> {
    if p.nodes.is_empty() {
        return Err("generator returned zero nodes".into());
    }
    if p.nodes.len() > 8 {
        return Err(format!("too many nodes ({}), max 8", p.nodes.len()));
    }
    let ids: HashSet<&str> = p.nodes.iter().map(|n| n.id.as_str()).collect();
    if ids.len() != p.nodes.len() {
        return Err("duplicate node id".into());
    }
    for n in &p.nodes {
        match n.node_type.as_str() {
            "chat" | "agent" => {
                let prompt = n
                    .data
                    .get("prompt")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .trim();
                if prompt.is_empty() {
                    return Err(format!("node {} ({}) has empty prompt", n.id, n.node_type));
                }
            }
            "kb" => {}
            other => return Err(format!("node {}: unsupported type '{}'", n.id, other)),
        }
    }
    for e in &p.edges {
        if !ids.contains(e.source.as_str()) {
            return Err(format!("edge source '{}' not in nodes", e.source));
        }
        if !ids.contains(e.target.as_str()) {
            return Err(format!("edge target '{}' not in nodes", e.target));
        }
        if e.source == e.target {
            return Err(format!("self-loop on node '{}'", e.source));
        }
    }
    // DAG check via Kahn's algorithm.
    let mut indeg: HashMap<&str, usize> = p.nodes.iter().map(|n| (n.id.as_str(), 0)).collect();
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for e in &p.edges {
        *indeg.entry(e.target.as_str()).or_insert(0) += 1;
        adj.entry(e.source.as_str())
            .or_default()
            .push(e.target.as_str());
    }
    let mut q: Vec<&str> = indeg
        .iter()
        .filter(|(_, d)| **d == 0)
        .map(|(k, _)| *k)
        .collect();
    let mut visited = 0usize;
    while let Some(u) = q.pop() {
        visited += 1;
        if let Some(children) = adj.get(u) {
            for v in children {
                let d = indeg.get_mut(v).unwrap();
                *d -= 1;
                if *d == 0 {
                    q.push(v);
                }
            }
        }
    }
    if visited != p.nodes.len() {
        return Err("edges form a cycle — pipeline must be a DAG".into());
    }
    Ok(())
}

async fn run_claude_capturing(prompt: &str) -> Result<String, String> {
    let mut child = Command::new("claude")
        .args(["-p", prompt])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn claude failed: {e} (is `claude` on PATH?)"))?;
    let mut stdout = child.stdout.take().ok_or("no stdout handle")?;
    let mut stderr = child.stderr.take().ok_or("no stderr handle")?;
    let mut out = String::new();
    let mut err = String::new();
    let (r1, r2, r3) = tokio::join!(
        stdout.read_to_string(&mut out),
        stderr.read_to_string(&mut err),
        child.wait(),
    );
    r1.map_err(|e| format!("read stdout: {e}"))?;
    r2.map_err(|e| format!("read stderr: {e}"))?;
    let status = r3.map_err(|e| format!("wait claude: {e}"))?;
    if !status.success() {
        return Err(format!(
            "claude exited {}: {}",
            status.code().unwrap_or(-1),
            err.trim()
        ));
    }
    Ok(out)
}

pub async fn generate_pipeline(requirement: &str) -> Result<GenerateResult, String> {
    let req = requirement.trim();
    if req.is_empty() {
        return Err("empty requirement".into());
    }
    let full_prompt = format!("{GENERATOR_PROMPT}\n\nUser requirement:\n{req}");

    // First attempt.
    let raw1 = run_claude_capturing(&full_prompt).await?;
    let cleaned1 = strip_code_fences(&raw1);
    match serde_json::from_str::<GeneratedPipeline>(&cleaned1) {
        Ok(p) => {
            validate(&p)?;
            return Ok(GenerateResult { pipeline: p, raw: raw1 });
        }
        Err(e1) => {
            // Retry once with a reminder about the JSON contract.
            let retry_prompt = format!(
                "{GENERATOR_PROMPT}\n\nUser requirement:\n{req}\n\n\
                IMPORTANT: Your previous response could not be parsed as JSON. \
                Error: {e1}. Output ONLY raw JSON matching the schema. \
                No markdown fences, no prose before or after.",
            );
            let raw2 = run_claude_capturing(&retry_prompt).await?;
            let cleaned2 = strip_code_fences(&raw2);
            match serde_json::from_str::<GeneratedPipeline>(&cleaned2) {
                Ok(p) => {
                    validate(&p)?;
                    Ok(GenerateResult { pipeline: p, raw: raw2 })
                }
                Err(e2) => Err(format!(
                    "generator returned invalid JSON twice. first error: {e1}; \
                     second error: {e2}. First output:\n{raw1}"
                )),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_json_fence() {
        let s = "```json\n{\"nodes\":[],\"edges\":[]}\n```";
        assert_eq!(strip_code_fences(s), "{\"nodes\":[],\"edges\":[]}");
    }

    #[test]
    fn strips_bare_fence() {
        let s = "```\n{\"a\":1}\n```";
        assert_eq!(strip_code_fences(s), "{\"a\":1}");
    }

    #[test]
    fn leaves_plain_json_alone() {
        let s = "{\"nodes\":[]}";
        assert_eq!(strip_code_fences(s), "{\"nodes\":[]}");
    }

    fn p(node_type: &str, id: &str, prompt: &str) -> GenNode {
        GenNode {
            id: id.into(),
            node_type: node_type.into(),
            position: GenPosition { x: 60.0, y: 60.0 },
            data: serde_json::json!({ "prompt": prompt }),
        }
    }

    #[test]
    fn validate_ok_simple_chain() {
        let g = GeneratedPipeline {
            nodes: vec![p("chat", "n1", "a"), p("chat", "n2", "b")],
            edges: vec![GenEdge { source: "n1".into(), target: "n2".into() }],
        };
        assert!(validate(&g).is_ok());
    }

    #[test]
    fn validate_rejects_empty_prompt() {
        let g = GeneratedPipeline {
            nodes: vec![p("chat", "n1", "  ")],
            edges: vec![],
        };
        assert!(validate(&g).is_err());
    }

    #[test]
    fn validate_rejects_cycle() {
        let g = GeneratedPipeline {
            nodes: vec![p("chat", "n1", "a"), p("chat", "n2", "b")],
            edges: vec![
                GenEdge { source: "n1".into(), target: "n2".into() },
                GenEdge { source: "n2".into(), target: "n1".into() },
            ],
        };
        assert!(validate(&g).is_err());
    }

    #[test]
    fn validate_rejects_unknown_target() {
        let g = GeneratedPipeline {
            nodes: vec![p("chat", "n1", "a")],
            edges: vec![GenEdge { source: "n1".into(), target: "n42".into() }],
        };
        assert!(validate(&g).is_err());
    }

    #[test]
    fn validate_rejects_duplicate_ids() {
        let g = GeneratedPipeline {
            nodes: vec![p("chat", "n1", "a"), p("chat", "n1", "b")],
            edges: vec![],
        };
        assert!(validate(&g).is_err());
    }
}
