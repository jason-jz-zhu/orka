use serde::Serialize;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

const DEFAULT_NAME: &str = "default-workspace";

static ACTIVE: LazyLock<Mutex<String>> =
    LazyLock::new(|| Mutex::new(load_active().unwrap_or_else(|| DEFAULT_NAME.to_string())));

fn root_dir() -> PathBuf {
    if let Ok(p) = std::env::var("ORKA_WORKSPACE_DIR") {
        let pb = PathBuf::from(p);
        // If ORKA_WORKSPACE_DIR is set (tests), use it directly as the workspace folder
        // and pretend the parent is the root.
        return pb.parent().map(|p| p.to_path_buf()).unwrap_or(pb);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("OrkaCanvas")
}

fn active_pointer_file() -> PathBuf {
    root_dir().join(".active")
}

fn load_active() -> Option<String> {
    std::fs::read_to_string(active_pointer_file())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn save_active(name: &str) {
    let p = active_pointer_file();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(p, name);
}

pub fn workspace_root() -> PathBuf {
    if let Ok(p) = std::env::var("ORKA_WORKSPACE_DIR") {
        return PathBuf::from(p);
    }
    let name = ACTIVE.lock().unwrap().clone();
    root_dir().join(&name)
}

pub fn node_dir(id: &str) -> PathBuf {
    workspace_root().join("nodes").join(id)
}

pub async fn ensure_node_dir(id: &str) -> std::io::Result<PathBuf> {
    let dir = node_dir(id);
    tokio::fs::create_dir_all(&dir).await?;
    Ok(dir)
}

pub fn graph_path() -> PathBuf {
    workspace_root().join("graph.json")
}

pub fn templates_dir() -> PathBuf {
    workspace_root().join("templates")
}

/// Legacy global templates dir (before templates were scoped per-workspace).
/// Kept only to support one-time migration at startup.
fn legacy_global_templates_dir() -> PathBuf {
    root_dir().join("templates")
}

/// If a legacy `<root>/templates/` directory exists from before templates
/// became per-workspace, move its contents into the currently active
/// workspace's templates dir. Idempotent and best-effort.
pub fn migrate_legacy_templates() {
    let legacy = legacy_global_templates_dir();
    if !legacy.exists() {
        return;
    }
    let target = templates_dir();
    if let Err(e) = std::fs::create_dir_all(&target) {
        eprintln!("[orka] migrate_legacy_templates: mkdir failed: {e}");
        return;
    }
    let rd = match std::fs::read_dir(&legacy) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[orka] migrate_legacy_templates: read_dir failed: {e}");
            return;
        }
    };
    let mut moved = 0usize;
    for entry in rd.flatten() {
        let from = entry.path();
        let Some(name) = from.file_name() else { continue };
        let to = target.join(name);
        if to.exists() {
            // Don't overwrite — keep existing per-workspace copy.
            continue;
        }
        if std::fs::rename(&from, &to).is_ok() {
            moved += 1;
        }
    }
    // If legacy dir is now empty, remove it. Ignore errors.
    if let Ok(mut rd) = std::fs::read_dir(&legacy) {
        if rd.next().is_none() {
            let _ = std::fs::remove_dir(&legacy);
        }
    }
    if moved > 0 {
        eprintln!(
            "[orka] migrated {moved} legacy template(s) to workspace '{}'",
            active_name()
        );
    }
}

// ---- workspace CRUD ----

#[derive(Serialize)]
pub struct WorkspaceInfo {
    pub name: String,
    pub active: bool,
    pub modified_ms: u64,
}

pub fn active_name() -> String {
    ACTIVE.lock().unwrap().clone()
}

pub fn list_workspaces() -> Vec<WorkspaceInfo> {
    let root = root_dir();
    let Ok(rd) = std::fs::read_dir(&root) else {
        return vec![];
    };
    let current = active_name();
    let mut out: Vec<WorkspaceInfo> = vec![];
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let mtime_ms = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(WorkspaceInfo {
            name: name.to_string(),
            active: name == current,
            modified_ms: mtime_ms,
        });
    }
    // Ensure the active one exists in the list even if its folder hasn't been created yet.
    if !out.iter().any(|w| w.active) {
        out.push(WorkspaceInfo {
            name: current.clone(),
            active: true,
            modified_ms: 0,
        });
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    out
}

fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('.')
        && !s.contains('/')
        && !s.contains('\\')
        && s.len() <= 64
}

pub fn create_workspace(name: &str) -> Result<(), String> {
    if !valid_name(name) {
        return Err("invalid workspace name".into());
    }
    let path = root_dir().join(name);
    if path.exists() {
        return Err(format!("workspace '{name}' already exists"));
    }
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn switch_workspace(name: &str) -> Result<(), String> {
    if !valid_name(name) {
        return Err("invalid workspace name".into());
    }
    let path = root_dir().join(name);
    if !path.exists() {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    *ACTIVE.lock().unwrap() = name.to_string();
    save_active(name);
    Ok(())
}

pub fn rename_workspace(from: &str, to: &str) -> Result<(), String> {
    if !valid_name(to) {
        return Err("invalid target name".into());
    }
    let src = root_dir().join(from);
    let dst = root_dir().join(to);
    if dst.exists() {
        return Err(format!("workspace '{to}' already exists"));
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    let mut active = ACTIVE.lock().unwrap();
    if *active == from {
        *active = to.to_string();
        save_active(to);
    }
    Ok(())
}

pub fn duplicate_workspace(from: &str, to: &str) -> Result<(), String> {
    if !valid_name(to) {
        return Err("invalid target name".into());
    }
    let src = root_dir().join(from);
    let dst = root_dir().join(to);
    if dst.exists() {
        return Err(format!("workspace '{to}' already exists"));
    }
    copy_dir_recursive(&src, &dst).map_err(|e| e.to_string())
}

pub fn delete_workspace(name: &str) -> Result<(), String> {
    if !valid_name(name) {
        return Err("invalid workspace name".into());
    }
    let path = root_dir().join(name);
    if path.exists() {
        std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    }
    let mut active = ACTIVE.lock().unwrap();
    if *active == name {
        *active = DEFAULT_NAME.to_string();
        save_active(DEFAULT_NAME);
    }
    Ok(())
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}
