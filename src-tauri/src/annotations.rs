//! Per-output annotations — thread-shaped model.
//!
//! An annotation is a **conversation thread** attached to a markdown block.
//! The thread mixes the user's own notes and Claude's replies, so the
//! unified UI ("comment on a block + optionally ask Claude about it")
//! reduces to one data type and one persistence file.
//!
//! File: `<workspace>/annotations/<output_id>.json`, atomic tmp+rename
//! write, path-traversal guarded on `output_id`.
//!
//! Backward-compatible load: older files used a `text: String` field on
//! each annotation. `migrate_legacy_text_to_thread` reads those and
//! projects them into a thread of length 1 with `author="you"`.

use crate::workspace;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// One turn in an annotation thread.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    /// "you" or "claude". Kept as a free string to avoid breaking
    /// migrations if we introduce new authors (e.g. "system").
    pub author: String,
    pub text: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// Legacy shape support. When deserializing, we accept either the new
/// `thread` field or an old `text` string; the normalized form written
/// back is always `thread`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub block_idx: usize,
    pub block_hash: String,
    pub block_type: String,
    pub block_content: String,
    /// Conversation thread: user notes + Claude replies, in order.
    #[serde(default)]
    pub thread: Vec<Message>,
    /// When true, the thread is mirrored to Apple Notes on every change.
    #[serde(default)]
    pub saved_to_notes: bool,
    pub created_at: String,
    pub updated_at: String,
    /// Accepted only during deserialization of legacy files; never serialized.
    #[serde(default, skip_serializing)]
    text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RunAnnotations {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub annotations: Vec<Annotation>,
}

fn default_version() -> u32 {
    2 // bumped from 1 when thread became the canonical shape
}

fn annotations_dir() -> PathBuf {
    workspace::workspace_root().join("annotations")
}

fn file_for(output_id: &str) -> Result<PathBuf, String> {
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

/// Normalize legacy `text`-only annotations into a thread with one user
/// message. Idempotent — called on every load.
fn migrate_legacy_text_to_thread(data: &mut RunAnnotations) {
    for a in data.annotations.iter_mut() {
        if a.thread.is_empty() {
            if let Some(legacy) = a.text.take() {
                if !legacy.is_empty() {
                    a.thread.push(Message {
                        author: "you".to_string(),
                        text: legacy,
                        created_at: a.created_at.clone(),
                    });
                }
            }
        } else {
            // Drop the legacy field if it was present alongside a thread.
            a.text = None;
        }
    }
    if data.version < 2 {
        data.version = 2;
    }
}

#[tauri::command]
pub async fn load_annotations(output_id: String) -> Result<RunAnnotations, String> {
    let path = file_for(&output_id)?;
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => {
            let mut data: RunAnnotations = serde_json::from_str(&s)
                .map_err(|e| format!("parse {}: {e}", path.display()))?;
            migrate_legacy_text_to_thread(&mut data);
            Ok(data)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(RunAnnotations::default()),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

/// Full-annotation upsert. Frontend sends the complete annotation (block
/// fields + full thread); backend replaces or inserts by blockIdx.
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
    incoming.text = None;

    if let Some(existing) = data
        .annotations
        .iter_mut()
        .find(|a| a.block_idx == incoming.block_idx)
    {
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

/// Append a single message to an existing thread, or create the
/// annotation if none exists yet. Used by the "Ask Claude" reply path
/// so streaming replies don't require rewriting the whole thread.
#[tauri::command]
pub async fn append_message(
    output_id: String,
    block_idx: usize,
    block_hash: String,
    block_type: String,
    block_content: String,
    author: String,
    text: String,
) -> Result<RunAnnotations, String> {
    let path = file_for(&output_id)?;
    let mut data = load_annotations(output_id.clone()).await?;

    let now = chrono::Utc::now().to_rfc3339();
    let message = Message {
        author,
        text,
        created_at: now.clone(),
    };

    // Match by block_hash (content fingerprint) — NOT block_idx.
    // Index shifts between live streaming and post-hoc reconstruction
    // (partial code fences resolve, extra blocks may appear/disappear)
    // would otherwise leak into "lost" annotations. Hash is derived
    // from block content so stays stable across re-parses.
    if let Some(existing) = data
        .annotations
        .iter_mut()
        .find(|a| a.block_hash == block_hash)
    {
        existing.thread.push(message);
        existing.updated_at = now;
        // Keep the stored block_idx current for display ordering —
        // downstream consumers that render annotations in document
        // order still benefit from an up-to-date index, even though
        // it's no longer the primary key.
        existing.block_idx = block_idx;
    } else {
        data.annotations.push(Annotation {
            block_idx,
            block_hash,
            block_type,
            block_content,
            thread: vec![message],
            saved_to_notes: false,
            created_at: now.clone(),
            updated_at: now,
            text: None,
        });
        data.annotations.sort_by_key(|a| a.block_idx);
    }

    write_atomic(&path, &data).await?;
    Ok(data)
}

#[tauri::command]
pub async fn delete_annotation(
    output_id: String,
    block_idx: Option<usize>,
    block_hash: Option<String>,
) -> Result<RunAnnotations, String> {
    // Prefer block_hash (content-stable key). Fall back to block_idx
    // for callers still on the old API — but for annotations written
    // after this change, hash is the source of truth.
    let path = file_for(&output_id)?;
    let mut data = load_annotations(output_id).await?;
    if let Some(h) = block_hash.as_deref() {
        data.annotations.retain(|a| a.block_hash != h);
    } else if let Some(idx) = block_idx {
        data.annotations.retain(|a| a.block_idx != idx);
    } else {
        return Err("delete_annotation requires block_hash or block_idx".into());
    }
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
    }

    #[test]
    fn thread_roundtrip() {
        let data = RunAnnotations {
            version: 2,
            annotations: vec![Annotation {
                block_idx: 2,
                block_hash: "deadbeef".into(),
                block_type: "bullet".into(),
                block_content: "- do the thing".into(),
                thread: vec![
                    Message {
                        author: "you".into(),
                        text: "is this right?".into(),
                        created_at: "2026-04-19T10:00:00Z".into(),
                    },
                    Message {
                        author: "claude".into(),
                        text: "yes, per RFC xyz".into(),
                        created_at: "2026-04-19T10:00:05Z".into(),
                    },
                ],
                saved_to_notes: true,
                created_at: "2026-04-19T10:00:00Z".into(),
                updated_at: "2026-04-19T10:00:05Z".into(),
                text: None,
            }],
        };
        let s = serde_json::to_string(&data).unwrap();
        let back: RunAnnotations = serde_json::from_str(&s).unwrap();
        assert_eq!(back.version, 2);
        assert_eq!(back.annotations[0].thread.len(), 2);
        assert_eq!(back.annotations[0].thread[1].author, "claude");
        assert!(back.annotations[0].saved_to_notes);
    }

    #[test]
    fn legacy_text_migrates_to_thread() {
        // Old format — single `text` field, no `thread`.
        let legacy = r#"{
            "version": 1,
            "annotations": [{
                "blockIdx": 0,
                "blockHash": "abc",
                "blockType": "paragraph",
                "blockContent": "hi",
                "text": "my old note",
                "createdAt": "2026-04-18T00:00:00Z",
                "updatedAt": "2026-04-18T00:00:00Z"
            }]
        }"#;
        let mut data: RunAnnotations = serde_json::from_str(legacy).unwrap();
        migrate_legacy_text_to_thread(&mut data);
        assert_eq!(data.version, 2);
        assert_eq!(data.annotations[0].thread.len(), 1);
        assert_eq!(data.annotations[0].thread[0].author, "you");
        assert_eq!(data.annotations[0].thread[0].text, "my old note");
    }

    #[test]
    fn legacy_empty_text_does_not_add_phantom_message() {
        let legacy = r#"{
            "version": 1,
            "annotations": [{
                "blockIdx": 0,
                "blockHash": "abc",
                "blockType": "paragraph",
                "blockContent": "hi",
                "text": "",
                "createdAt": "2026-04-18T00:00:00Z",
                "updatedAt": "2026-04-18T00:00:00Z"
            }]
        }"#;
        let mut data: RunAnnotations = serde_json::from_str(legacy).unwrap();
        migrate_legacy_text_to_thread(&mut data);
        assert!(data.annotations[0].thread.is_empty());
    }
}
