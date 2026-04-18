use crate::workspace;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct GraphSnapshot {
    pub nodes: serde_json::Value,
    pub edges: serde_json::Value,
}

pub async fn save(snapshot: &GraphSnapshot) -> std::io::Result<()> {
    let path = workspace::graph_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let json = serde_json::to_string_pretty(snapshot)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    // Atomic write: write to tmp then rename. Prevents truncated JSON on crash or
    // concurrent writes (e.g., GUI + CLI, or rapid debounce flushes).
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, json).await?;
    tokio::fs::rename(&tmp, &path).await
}

pub async fn load() -> std::io::Result<Option<GraphSnapshot>> {
    let path = workspace::graph_path();
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => {
            let snap: GraphSnapshot = serde_json::from_str(&s)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            Ok(Some(snap))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
