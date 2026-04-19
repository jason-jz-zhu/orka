//! Per-output annotations — Day 2 of Output Annotator.
//!
//! Each "output" (a ChatNode output or a Runs-tab run) is a stream of
//! markdown blocks the user can mark up with their own notes. Annotations
//! are persisted to `<workspace>/annotations/<output_id>.json` so they
//! survive restarts and can be surfaced in Run history later.
//!
//! File format is deliberately simple and stable: a single JSON object with
//! a `version: 1` field and an `annotations: []` array sorted by blockIdx.
//! Write is atomic (tmp + rename) to prevent corruption on crash.

use crate::workspace;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Annotation {
    /// 0-based index within the parsed-block list.
    #[serde(rename = "blockIdx")]
    pub block_idx: usize,
    /// djb2 hash of the block content so we can detect drift when the
    /// underlying output is regenerated.
    #[serde(rename = "blockHash")]
    pub block_hash: String,
    /// Snapshot of the block's type ("paragraph", "bullet", "code", …).
    #[serde(rename = "blockType")]
    pub block_type: String,
    /// Snapshot of the block's content at annotation time. Lets us show
    /// "the block was: …" if the output later changes.
    #[serde(rename = "blockContent")]
    pub block_content: String,
    /// User's note — plain text (may contain markdown, we don't render it
    /// in the picker).
    pub text: String,
    /// ISO-8601 UTC.
    #[serde(rename = "createdAt")]
    pub created_at: String,
    /// ISO-8601 UTC. Equals createdAt on first save.
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RunAnnotations {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub annotations: Vec<Annotation>,
}

fn default_version() -> u32 {
    1
}

fn annotations_dir() -> PathBuf {
    workspace::workspace_root().join("annotations")
}

fn file_for(output_id: &str) -> Result<PathBuf, String> {
    // Prevent path traversal: the output_id must be a simple slug/id,
    // not contain separators or relative-path markers.
    if output_id.is_empty()
        || output_id.contains('/')
        || output_id.contains('\\')
        || output_id.contains("..")
        || output_id.contains('\0')
    {
        return Err(format!("invalid output_id: {output_id}"));
    }
    Ok(annotations_dir().join(format!("{output_id}.json")))
}

/// Read annotations for a given output id. Returns an empty (default)
/// structure if the file doesn't exist yet — callers never have to handle
/// "missing file" separately.
#[tauri::command]
pub async fn load_annotations(output_id: String) -> Result<RunAnnotations, String> {
    let path = file_for(&output_id)?;
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => {
            let data: RunAnnotations = serde_json::from_str(&s)
                .map_err(|e| format!("parse {}: {e}", path.display()))?;
            Ok(data)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(RunAnnotations::default()),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

/// Upsert a single annotation — add if its blockIdx is new, replace if
/// an annotation for that block already exists. Updates `updated_at` to
/// current time; preserves `created_at` on replace.
///
/// Returns the full updated annotations list so the frontend can sync
/// without a separate load.
#[tauri::command]
pub async fn save_annotation(
    output_id: String,
    annotation: Annotation,
) -> Result<RunAnnotations, String> {
    let path = file_for(&output_id)?;
    let mut data = load_annotations(output_id.clone()).await?;

    let now = chrono::Utc::now().to_rfc3339();
    let mut incoming = annotation;
    incoming.updated_at = now.clone();

    if let Some(existing) = data
        .annotations
        .iter_mut()
        .find(|a| a.block_idx == incoming.block_idx)
    {
        // Preserve original creation time.
        incoming.created_at = existing.created_at.clone();
        *existing = incoming;
    } else {
        if incoming.created_at.is_empty() {
            incoming.created_at = now;
        }
        data.annotations.push(incoming);
        data.annotations.sort_by_key(|a| a.block_idx);
    }

    write_atomic(&path, &data).await?;
    Ok(data)
}

/// Remove the annotation for the given block. No-op if one doesn't exist.
/// Returns the full updated list.
#[tauri::command]
pub async fn delete_annotation(
    output_id: String,
    block_idx: usize,
) -> Result<RunAnnotations, String> {
    let path = file_for(&output_id)?;
    let mut data = load_annotations(output_id).await?;
    data.annotations.retain(|a| a.block_idx != block_idx);
    write_atomic(&path, &data).await?;
    Ok(data)
}

async fn write_atomic(path: &PathBuf, data: &RunAnnotations) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(data).map_err(|e| format!("serialize: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, json)
        .await
        .map_err(|e| format!("write tmp {}: {e}", tmp.display()))?;
    tokio::fs::rename(&tmp, path)
        .await
        .map_err(|e| format!("rename {}: {e}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_for_rejects_traversal() {
        assert!(file_for("").is_err());
        assert!(file_for("..").is_err());
        assert!(file_for("../evil").is_err());
        assert!(file_for("a/b").is_err());
        assert!(file_for("with\0null").is_err());
        assert!(file_for("legit-node-123").is_ok());
        assert!(file_for("run_abc_456").is_ok());
    }

    #[test]
    fn annotations_roundtrip_json() {
        let data = RunAnnotations {
            version: 1,
            annotations: vec![Annotation {
                block_idx: 2,
                block_hash: "deadbeef".into(),
                block_type: "bullet".into(),
                block_content: "- do the thing".into(),
                text: "but we already did it".into(),
                created_at: "2026-04-18T10:00:00Z".into(),
                updated_at: "2026-04-18T10:00:00Z".into(),
            }],
        };
        let s = serde_json::to_string(&data).unwrap();
        let back: RunAnnotations = serde_json::from_str(&s).unwrap();
        assert_eq!(back.version, 1);
        assert_eq!(back.annotations.len(), 1);
        assert_eq!(back.annotations[0].block_idx, 2);
        assert_eq!(back.annotations[0].text, "but we already did it");
    }
}
