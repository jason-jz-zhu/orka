mod graph;
mod kb;
mod node_runner;
mod onboarding;
mod sessions;
mod workspace;

use node_runner::NodeMode;
use tauri::AppHandle;

#[tauri::command]
fn log_from_js(level: String, message: String) {
    eprintln!("[webview:{}] {}", level, message);
}

#[tauri::command]
async fn run_node(
    app: AppHandle,
    id: String,
    prompt: String,
    resume_id: Option<String>,
    add_dirs: Option<Vec<String>>,
) -> Result<(), String> {
    node_runner::run_claude(
        app,
        id,
        prompt,
        NodeMode::Chat,
        resume_id,
        add_dirs.unwrap_or_default(),
    )
    .await
}

#[tauri::command]
fn cancel_node(node_id: String) -> bool {
    node_runner::cancel_node(&node_id)
}

#[tauri::command]
async fn run_agent_node(
    app: AppHandle,
    id: String,
    prompt: String,
    resume_id: Option<String>,
    add_dirs: Option<Vec<String>>,
) -> Result<(), String> {
    node_runner::run_claude(
        app,
        id,
        prompt,
        NodeMode::Agent,
        resume_id,
        add_dirs.unwrap_or_default(),
    )
    .await
}

#[tauri::command]
async fn save_graph(snapshot: graph::GraphSnapshot) -> Result<(), String> {
    graph::save(&snapshot).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_graph() -> Result<Option<graph::GraphSnapshot>, String> {
    graph::load().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn kb_ingest(id: String, src: String) -> Result<String, String> {
    kb::ingest_file(&id, &src).await
}

#[tauri::command]
async fn kb_ingest_dir(id: String, src: String) -> Result<Vec<String>, String> {
    kb::ingest_dir(&id, &src).await
}

#[tauri::command]
async fn kb_list(id: String) -> Result<Vec<String>, String> {
    kb::list_sources(&id).await
}

#[tauri::command]
async fn kb_dir(id: String) -> Result<String, String> {
    kb::sources_dir(&id).await
}

#[tauri::command]
fn list_projects() -> Vec<sessions::ProjectInfo> {
    sessions::list_projects()
}

#[tauri::command]
fn list_sessions(project_key: String) -> Vec<sessions::SessionInfo> {
    sessions::list_sessions(&project_key)
}

#[tauri::command]
fn read_session(path: String) -> Vec<sessions::SessionLine> {
    sessions::read_session(&path)
}

#[tauri::command]
fn watch_session(app: AppHandle, node_id: String, path: String) {
    sessions::watch_session(app, node_id, path);
}

#[tauri::command]
fn unwatch_session(node_id: String) {
    sessions::unwatch_session(&node_id);
}

#[tauri::command]
fn start_projects_watcher(app: AppHandle) {
    sessions::start_projects_watcher(app);
}

#[tauri::command]
fn debug_session(path: String) -> sessions::SessionDebug {
    sessions::debug_session(&path)
}

#[tauri::command]
fn focus_session_terminal(path: String) -> Result<String, String> {
    sessions::focus_session_terminal(&path)
}

#[tauri::command]
fn onboarding_status() -> onboarding::OnboardingStatus {
    onboarding::onboarding_status()
}

#[tauri::command]
async fn open_in_vscode(path: String) -> Result<(), String> {
    // Strategy 1: `code` on PATH (also works for `cursor`, `code-insiders` if
    // the user has those shell commands installed).
    for cli in ["code", "cursor", "code-insiders"] {
        let status = tokio::process::Command::new(cli)
            .arg(&path)
            .status()
            .await;
        if let Ok(s) = status {
            if s.success() {
                return Ok(());
            }
        }
    }
    // Strategy 2: macOS `open -a` against a set of known VSCode-family apps.
    #[cfg(target_os = "macos")]
    {
        for app in [
            "Visual Studio Code",
            "Visual Studio Code - Insiders",
            "VSCodium",
            "Cursor",
            "Windsurf",
        ] {
            let s = tokio::process::Command::new("open")
                .args(["-a", app, &path])
                .status()
                .await;
            if let Ok(s) = s {
                if s.success() {
                    return Ok(());
                }
            }
        }
    }
    Err(
        "Could not launch a VSCode-family editor. Install the `code` shell command \
         (VSCode → Command Palette → 'Shell Command: Install code command in PATH') \
         or install Visual Studio Code / Cursor."
            .into(),
    )
}

#[tauri::command]
async fn open_in_terminal(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let s = tokio::process::Command::new("open")
            .args(["-a", "Terminal", &path])
            .status()
            .await
            .map_err(|e| e.to_string())?;
        if s.success() {
            return Ok(());
        }
        return Err("open failed".into());
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("terminal open only supported on macOS currently".into())
    }
}

// ---- workspaces ----

#[tauri::command]
fn list_workspaces() -> Vec<workspace::WorkspaceInfo> {
    workspace::list_workspaces()
}

#[tauri::command]
fn active_workspace() -> String {
    workspace::active_name()
}

#[tauri::command]
fn create_workspace(name: String) -> Result<(), String> {
    workspace::create_workspace(&name)
}

#[tauri::command]
fn switch_workspace(name: String) -> Result<(), String> {
    workspace::switch_workspace(&name)
}

#[tauri::command]
fn rename_workspace(from: String, to: String) -> Result<(), String> {
    workspace::rename_workspace(&from, &to)
}

#[tauri::command]
fn duplicate_workspace(from: String, to: String) -> Result<(), String> {
    workspace::duplicate_workspace(&from, &to)
}

#[tauri::command]
fn delete_workspace(name: String) -> Result<(), String> {
    workspace::delete_workspace(&name)
}

// ---- templates ----

#[tauri::command]
async fn list_templates() -> Result<Vec<String>, String> {
    let dir = workspace::templates_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out: Vec<String> = vec![];
    let mut rd = tokio::fs::read_dir(&dir).await.map_err(|e| e.to_string())?;
    while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".json") {
            out.push(name.trim_end_matches(".json").to_string());
        }
    }
    out.sort();
    Ok(out)
}

#[tauri::command]
async fn save_template(app: AppHandle, name: String, content: String) -> Result<(), String> {
    let dir = workspace::templates_dir();
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let path = dir.join(format!("{name}.json"));
    tokio::fs::write(path, content)
        .await
        .map_err(|e| e.to_string())?;
    // Let the frontend Pipeline Library auto-refresh without needing a manual click.
    use tauri::Emitter;
    let _ = app.emit("templates:changed", ());
    Ok(())
}

#[tauri::command]
async fn load_template(name: String) -> Result<String, String> {
    let path = workspace::templates_dir().join(format!("{name}.json"));
    tokio::fs::read_to_string(path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_template(app: AppHandle, name: String) -> Result<(), String> {
    // Guard against path traversal — only a simple filename is accepted.
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid pipeline name".into());
    }
    let path = workspace::templates_dir().join(format!("{name}.json"));
    if !path.exists() {
        return Err(format!("pipeline '{name}' not found"));
    }
    tokio::fs::remove_file(&path)
        .await
        .map_err(|e| e.to_string())?;
    use tauri::Emitter;
    let _ = app.emit("templates:changed", ());
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // One-time migration of templates from the global legacy dir into the
            // current workspace's templates dir. Safe to call on every boot.
            workspace::migrate_legacy_templates();
            // Start the fs watcher on ~/.claude/projects at app boot, not on-demand
            // from the frontend — so sessions auto-refresh even after Rust-side rebuilds.
            sessions::start_projects_watcher(app.handle().clone());
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            log_from_js,
            run_node,
            run_agent_node,
            cancel_node,
            save_graph,
            load_graph,
            kb_ingest,
            kb_ingest_dir,
            kb_list,
            kb_dir,
            list_projects,
            list_sessions,
            read_session,
            watch_session,
            unwatch_session,
            start_projects_watcher,
            debug_session,
            focus_session_terminal,
            onboarding_status,
            open_in_vscode,
            open_in_terminal,
            list_workspaces,
            active_workspace,
            create_workspace,
            switch_workspace,
            rename_workspace,
            duplicate_workspace,
            delete_workspace,
            list_templates,
            save_template,
            load_template,
            delete_template,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_test_workspace<F: FnOnce(&std::path::Path) -> R, R>(f: F) -> R {
        let tmp = std::env::temp_dir().join(format!(
            "orka-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("ORKA_WORKSPACE_DIR", &tmp);
        let out = f(&tmp);
        std::env::remove_var("ORKA_WORKSPACE_DIR");
        let _ = std::fs::remove_dir_all(&tmp);
        out
    }

    #[tokio::test(flavor = "current_thread")]
    async fn workspace_paths_respect_env_override() {
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = workspace::workspace_root();
        // In real runs without the override, lives under home.
        if std::env::var("ORKA_WORKSPACE_DIR").is_err() {
            assert!(root.ends_with("OrkaCanvas/default-workspace"));
        }
        let node = workspace::node_dir("abc");
        assert!(node.ends_with("nodes/abc"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ensure_node_dir_creates_it() {
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!(
            "orka-ensure-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::env::set_var("ORKA_WORKSPACE_DIR", &tmp);
        let dir = workspace::ensure_node_dir("abc").await.unwrap();
        assert!(dir.exists());
        std::env::remove_var("ORKA_WORKSPACE_DIR");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn graph_save_and_load_roundtrip() {
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!(
            "orka-graph-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::env::set_var("ORKA_WORKSPACE_DIR", &tmp);
        let snap = graph::GraphSnapshot {
            nodes: serde_json::json!([{"id": "n1", "position": {"x": 0, "y": 0}}]),
            edges: serde_json::json!([]),
        };
        graph::save(&snap).await.unwrap();
        let loaded = graph::load().await.unwrap().unwrap();
        assert_eq!(loaded.nodes, snap.nodes);
        std::env::remove_var("ORKA_WORKSPACE_DIR");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn kb_ingest_copies_file() {
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!(
            "orka-kb-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::env::set_var("ORKA_WORKSPACE_DIR", &tmp);
        let src = std::env::temp_dir().join(format!("orka-src-{}.txt", std::process::id()));
        tokio::fs::write(&src, "hello kb").await.unwrap();
        let name = kb::ingest_file("k1", src.to_str().unwrap()).await.unwrap();
        let list = kb::list_sources("k1").await.unwrap();
        assert!(list.contains(&name));
        std::env::remove_var("ORKA_WORKSPACE_DIR");
        let _ = tokio::fs::remove_file(&src).await;
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
