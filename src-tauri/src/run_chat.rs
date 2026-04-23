//! Per-run chat panel storage. Separate from block annotations
//! (src/annotations.rs) because the two have different lifecycles
//! and mental models:
//!
//!   - Block annotations: markups ON specific paragraphs/bullets of
//!     the output. Scoped, targeted, stable across re-parses.
//!   - Run chat: a free-form conversation ABOUT the whole run.
//!     Unscoped follow-ups, generic questions, iterative refinement.
//!
//! Keeping them separate lets users annotate freely without
//! polluting the chat, and chat freely without stomping annotations.
//! Both co-exist in the same RunDetailDrawer via a toggle that
//! optionally includes annotation text as context in chat messages.
//!
//! Storage: `~/OrkaCanvas/<ws>/annotations/<run_id>_chat.json`.
//! Shares a directory with block annotations so `clear_runs` wipes
//! them together (same run_id -> same cleanup).

use crate::workspace;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunChatMessage {
    pub author: String, // "you" | "claude"
    pub text: String,
    pub created_at: String,
    /// Which block hashes (if any) the user had selected / included
    /// as annotation context when they sent this message. Lets the
    /// UI re-render those as chips next to the message later.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub referenced_block_hashes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunChat {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub messages: Vec<RunChatMessage>,
}

fn default_version() -> u32 {
    1
}

// Custom Default so a freshly-constructed RunChat matches the shape
// we'd persist (version = 1, not 0). Keeps serde round-trips stable.
impl Default for RunChat {
    fn default() -> Self {
        Self { version: 1, messages: Vec::new() }
    }
}

fn chat_dir() -> PathBuf {
    workspace::workspace_root().join("annotations")
}

fn file_for(run_id: &str) -> Result<PathBuf, String> {
    if run_id.is_empty()
        || run_id.contains('/')
        || run_id.contains('\\')
        || run_id.contains("..")
        || run_id.contains('\0')
    {
        return Err(format!("invalid run_id: {run_id}"));
    }
    Ok(chat_dir().join(format!("{run_id}_chat.json")))
}

#[tauri::command]
pub async fn load_run_chat(run_id: String) -> Result<RunChat, String> {
    let path = file_for(&run_id)?;
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => serde_json::from_str::<RunChat>(&s)
            .map_err(|e| format!("parse {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(RunChat::default()),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

/// Persist a user-message + assistant-reply exchange. Two entries
/// added to the thread in one call so the UI sees them as an atomic
/// unit and there's no window where the user message is saved but
/// the assistant's isn't (or vice-versa after a crash mid-stream).
#[tauri::command]
pub async fn save_run_chat_exchange(
    run_id: String,
    user_text: String,
    assistant_text: String,
    referenced_block_hashes: Option<Vec<String>>,
) -> Result<RunChat, String> {
    let path = file_for(&run_id)?;
    let mut chat = load_run_chat(run_id.clone()).await?;
    let now = chrono::Utc::now().to_rfc3339();
    chat.messages.push(RunChatMessage {
        author: "you".into(),
        text: user_text,
        created_at: now.clone(),
        referenced_block_hashes: referenced_block_hashes.unwrap_or_default(),
    });
    chat.messages.push(RunChatMessage {
        author: "claude".into(),
        text: assistant_text,
        created_at: now,
        referenced_block_hashes: vec![],
    });
    write_atomic(&path, &chat).await?;
    Ok(chat)
}

#[tauri::command]
pub async fn clear_run_chat(run_id: String) -> Result<(), String> {
    let path = file_for(&run_id)?;
    match tokio::fs::remove_file(&path).await {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove {}: {e}", path.display())),
    }
}

async fn write_atomic(path: &PathBuf, data: &RunChat) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, json)
        .await
        .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    tokio::fs::rename(&tmp, path)
        .await
        .map_err(|e| format!("rename {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harness_file_for_rejects_traversal() {
        assert!(file_for("").is_err());
        assert!(file_for("../etc").is_err());
        assert!(file_for("a/b").is_err());
        assert!(file_for("a\\b").is_err());
        assert!(file_for("a\0b").is_err());
    }

    #[test]
    fn harness_default_chat_is_empty() {
        let c = RunChat::default();
        assert_eq!(c.version, 1);
        assert!(c.messages.is_empty());
    }

    #[test]
    fn harness_chat_roundtrip_via_serde() {
        let mut c = RunChat::default();
        c.messages.push(RunChatMessage {
            author: "you".into(),
            text: "is this right?".into(),
            created_at: "2026-04-20T00:00:00Z".into(),
            referenced_block_hashes: vec!["h1".into(), "h2".into()],
        });
        c.messages.push(RunChatMessage {
            author: "claude".into(),
            text: "yes, looks good".into(),
            created_at: "2026-04-20T00:00:01Z".into(),
            referenced_block_hashes: vec![],
        });
        let json = serde_json::to_string(&c).unwrap();
        // Empty vec should be skipped (skip_serializing_if).
        assert!(!json.contains("\"referenced_block_hashes\":[]"));
        let parsed: RunChat = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.messages.len(), 2);
        assert_eq!(parsed.messages[0].referenced_block_hashes.len(), 2);
    }
}
