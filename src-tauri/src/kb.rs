use crate::workspace;
use std::path::{Path, PathBuf};

/// Copy a source file into the KB node's workdir under `sources/`.
/// Returns the destination filename (relative to workdir).
pub async fn ingest_file(id: &str, src: &str) -> Result<String, String> {
    let src_path = Path::new(src);
    if !src_path.is_file() {
        return Err(format!("not a file: {src}"));
    }
    let filename = src_path
        .file_name()
        .ok_or_else(|| "missing filename".to_string())?
        .to_string_lossy()
        .to_string();
    let dest_dir = workspace::ensure_node_dir(id)
        .await
        .map_err(|e| e.to_string())?
        .join("sources");
    tokio::fs::create_dir_all(&dest_dir)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::copy(src_path, dest_dir.join(&filename))
        .await
        .map_err(|e| e.to_string())?;
    Ok(filename)
}

/// List ingested filenames for a node.
pub async fn list_sources(id: &str) -> Result<Vec<String>, String> {
    let dir = workspace::node_dir(id).join("sources");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    let mut rd = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| e.to_string())?;
    while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
        if let Some(name) = entry.file_name().to_str() {
            out.push(name.to_string());
        }
    }
    out.sort();
    Ok(out)
}

/// Recursively copy every file under `src` into the KB node's `sources/`, preserving
/// relative paths. Skips dotfiles + well-known junk dirs (node_modules, target, __pycache__, .git).
/// Returns the list of added relative paths.
pub async fn ingest_dir(id: &str, src: &str) -> Result<Vec<String>, String> {
    let src_path = Path::new(src);
    if !src_path.is_dir() {
        return Err(format!("not a directory: {src}"));
    }
    let dest_base = workspace::ensure_node_dir(id)
        .await
        .map_err(|e| e.to_string())?
        .join("sources");
    tokio::fs::create_dir_all(&dest_base)
        .await
        .map_err(|e| e.to_string())?;

    let skip = |n: &str| -> bool {
        n.starts_with('.')
            || matches!(
                n,
                "node_modules" | "target" | "__pycache__" | "dist" | "build" | ".git"
            )
    };

    let mut added: Vec<String> = vec![];
    let mut stack: Vec<PathBuf> = vec![src_path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut rd = tokio::fs::read_dir(&dir)
            .await
            .map_err(|e| e.to_string())?;
        while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
            let name_os = entry.file_name();
            let name = name_os.to_string_lossy();
            if skip(&name) {
                continue;
            }
            let path = entry.path();
            let ft = entry.file_type().await.map_err(|e| e.to_string())?;
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() {
                let rel = path
                    .strip_prefix(src_path)
                    .map_err(|e| e.to_string())?
                    .to_path_buf();
                let dest = dest_base.join(&rel);
                if let Some(parent) = dest.parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                tokio::fs::copy(&path, &dest)
                    .await
                    .map_err(|e| e.to_string())?;
                added.push(rel.to_string_lossy().to_string());
            }
        }
    }
    added.sort();
    Ok(added)
}

/// Return the absolute path string to a node's `sources/` directory, creating if needed.
pub async fn sources_dir(id: &str) -> Result<String, String> {
    let dir = workspace::ensure_node_dir(id)
        .await
        .map_err(|e| e.to_string())?
        .join("sources");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}
