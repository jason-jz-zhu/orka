mod annotations;
mod model_config;
mod session_brief;
mod session_synthesis;
mod skill_evolution;
mod trusted_taps;
mod dest_profiles;
mod destinations;
mod graph;
mod kb;
mod node_runner;
mod onboarding;
mod pipeline_gen;
mod run_log;
mod schedules;
mod sessions;
pub mod skill_md;
mod skills;
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
    allowed_tools: Option<Vec<String>>,
) -> Result<(), String> {
    node_runner::run_claude(
        app,
        id,
        prompt,
        NodeMode::Chat,
        resume_id,
        add_dirs.unwrap_or_default(),
        node_runner::ToolScope::from_allowed(allowed_tools),
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
    allowed_tools: Option<Vec<String>>,
) -> Result<(), String> {
    node_runner::run_claude(
        app,
        id,
        prompt,
        NodeMode::Agent,
        resume_id,
        add_dirs.unwrap_or_default(),
        node_runner::ToolScope::from_allowed(allowed_tools),
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

/// Escape a string for safe use as a YAML scalar in frontmatter. Always
/// emits a double-quoted form; escapes `"`, `\`, and control chars.
fn yaml_escape_scalar(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str(r#"\""#),
            '\\' => out.push_str(r"\\"),
            '\n' => out.push_str(r"\n"),
            '\r' => out.push_str(r"\r"),
            '\t' => out.push_str(r"\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[tauri::command]
async fn generate_pipeline(
    requirement: String,
) -> Result<pipeline_gen::GenerateResult, String> {
    pipeline_gen::generate_pipeline(&requirement).await
}

/// Write text to a file. Creates parent dirs as needed. Returns the resolved
/// absolute path so the UI can display + offer "reveal in Finder".
#[tauri::command]
async fn write_output_file(path: String, content: String) -> Result<String, String> {
    let p = std::path::PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
    }
    tokio::fs::write(&p, content)
        .await
        .map_err(|e| format!("write {}: {e}", p.display()))?;
    let abs = tokio::fs::canonicalize(&p)
        .await
        .unwrap_or(p)
        .to_string_lossy()
        .to_string();
    Ok(abs)
}

/// Read a UTF-8 text file. Used by PipelineLibrary "Import from file".
#[tauri::command]
async fn read_file_text(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("read {}: {e}", path))
}

/// Fetch a URL and return its body as text. Used by PipelineLibrary
/// "Import from URL" — typically a raw GitHub gist or repo file URL.
#[tauri::command]
async fn fetch_text_url(url: String) -> Result<String, String> {
    const MAX_BYTES: usize = 2 * 1024 * 1024; // 2 MB
    let url_str = url.trim();
    if !url_str.starts_with("http://") && !url_str.starts_with("https://") {
        return Err("URL must start with http:// or https://".into());
    }
    // Block private-range and loopback hosts to prevent SSRF against
    // internal services and cloud metadata endpoints.
    let parsed = reqwest::Url::parse(url_str).map_err(|e| format!("bad url: {e}"))?;
    if let Some(host) = parsed.host_str() {
        let lower = host.to_ascii_lowercase();
        let blocked_hosts = [
            "localhost", "127.0.0.1", "::1", "0.0.0.0",
            "169.254.169.254", "metadata.google.internal",
        ];
        if blocked_hosts.contains(&lower.as_str()) {
            return Err(format!("blocked host: {host}"));
        }
        if let Ok(ip) = lower.parse::<std::net::IpAddr>() {
            let is_private = match ip {
                std::net::IpAddr::V4(v4) => {
                    v4.is_loopback() || v4.is_private() || v4.is_link_local()
                        || v4.is_broadcast() || v4.is_unspecified()
                }
                std::net::IpAddr::V6(v6) => {
                    v6.is_loopback() || v6.is_unspecified()
                }
            };
            if is_private {
                return Err(format!("blocked private IP: {host}"));
            }
        }
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(parsed).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status().as_u16(), url_str));
    }
    // Pre-check content-length if advertised.
    if let Some(len) = resp.content_length() {
        if (len as usize) > MAX_BYTES {
            return Err(format!("response too large: {len} bytes (max {MAX_BYTES})"));
        }
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err(format!("response too large: {} bytes (max {MAX_BYTES})", bytes.len()));
    }
    String::from_utf8(bytes.to_vec()).map_err(|e| format!("not valid utf-8: {e}"))
}

/// Default output directory for the active workspace's pipelines.
/// Lazy-creates `~/OrkaCanvas/<workspace>/outputs/` and returns its absolute path.
#[tauri::command]
fn outputs_dir() -> Result<String, String> {
    let dir = workspace::workspace_root().join("outputs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// Activate (and launch if needed) a macOS app by display name via
/// LaunchServices. Used by output nodes for "Open Notes.app" etc — works
/// regardless of where the .app bundle physically lives.
#[tauri::command]
async fn open_app_by_name(name: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let s = tokio::process::Command::new("open")
            .args(["-a", &name])
            .status()
            .await
            .map_err(|e| e.to_string())?;
        if s.success() {
            return Ok(());
        }
        return Err(format!("open -a {name} failed (exit {:?})", s.code()));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = name;
        Err("open_app_by_name only supported on macOS".into())
    }
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

/// Generate a Claude Code skill at `<target_dir>/<sanitised>/` from a saved
/// Orka pipeline template. Creates SKILL.md (instructions for Claude) +
/// pipeline.json (the original template). Returns the absolute skill dir.
///
/// `target_dir` is the PARENT of the skill folder. Common choices:
///   - Global:        `~/.claude/skills`
///   - Project-local: `<project-root>/.claude/skills`
///   - Bundle:        any folder (not auto-discovered by Claude)
#[tauri::command]
async fn export_pipeline_as_skill(
    name: String,
    target_dir: String,
) -> Result<String, String> {
    // Claude skill names must be filesystem-safe ASCII. Non-ASCII titles
    // (Chinese, emoji, …) get a timestamped fallback so the export still
    // succeeds — the caller sees the final slug in the return value.
    let raw: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    let mut safe: String = raw
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if safe.is_empty() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        safe = format!("orka-pipeline-{ts}");
    }

    // Read template content from disk so we don't need to re-validate.
    let tpl_path = workspace::templates_dir().join(format!("{name}.json"));
    let content = tokio::fs::read_to_string(&tpl_path)
        .await
        .map_err(|e| format!("read template: {e}"))?;

    // Parse to extract description + node summary for the SKILL.md body.
    let parsed: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("parse: {e}"))?;
    let raw_description = parsed
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let inputs = parsed
        .get("inputs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let nodes = parsed
        .get("nodes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let edges = parsed
        .get("edges")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // Expand `~` at the start so callers can pass "~/.claude/skills".
    let target = if let Some(stripped) = target_dir.strip_prefix("~/") {
        dirs::home_dir()
            .ok_or("no home dir")?
            .join(stripped)
    } else if target_dir == "~" {
        dirs::home_dir().ok_or("no home dir")?
    } else {
        std::path::PathBuf::from(&target_dir)
    };
    let skill_dir = target.join(&safe);
    tokio::fs::create_dir_all(&skill_dir)
        .await
        .map_err(|e| format!("mkdir: {e}"))?;

    // Build quick lookup + topological order over (nodes, edges) so the
    // SKILL.md walks the DAG in execution order and each step can reference
    // its upstream steps by number.
    use std::collections::{HashMap, VecDeque};
    let node_ids: Vec<String> = nodes
        .iter()
        .filter_map(|n| n.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let by_id: HashMap<String, &serde_json::Value> = nodes
        .iter()
        .filter_map(|n| n.get("id").and_then(|v| v.as_str()).map(|id| (id.to_string(), n)))
        .collect();
    let mut parents: HashMap<String, Vec<String>> = HashMap::new();
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    let mut indeg: HashMap<String, usize> = HashMap::new();
    for id in &node_ids {
        indeg.insert(id.clone(), 0);
        parents.insert(id.clone(), Vec::new());
        children.insert(id.clone(), Vec::new());
    }
    for e in &edges {
        let s = e.get("source").and_then(|v| v.as_str()).unwrap_or("");
        let t = e.get("target").and_then(|v| v.as_str()).unwrap_or("");
        if s.is_empty() || t.is_empty() {
            continue;
        }
        parents.entry(t.to_string()).or_default().push(s.to_string());
        children.entry(s.to_string()).or_default().push(t.to_string());
        *indeg.entry(t.to_string()).or_insert(0) += 1;
    }
    let mut queue: VecDeque<String> = node_ids
        .iter()
        .filter(|id| indeg.get(*id).copied().unwrap_or(0) == 0)
        .cloned()
        .collect();
    let mut topo: Vec<String> = Vec::new();
    while let Some(id) = queue.pop_front() {
        topo.push(id.clone());
        if let Some(ch) = children.get(&id).cloned() {
            for c in ch {
                if let Some(d) = indeg.get_mut(&c) {
                    *d = d.saturating_sub(1);
                    if *d == 0 {
                        queue.push_back(c);
                    }
                }
            }
        }
    }
    // Append any leftover (e.g. cycles) in original order so nothing is lost.
    for id in &node_ids {
        if !topo.contains(id) {
            topo.push(id.clone());
        }
    }
    let step_of: HashMap<String, usize> = topo
        .iter()
        .enumerate()
        .map(|(i, id)| (id.clone(), i + 1))
        .collect();

    // Synthesize a useful description when the template didn't set one —
    // Claude's skill router uses this field to decide when to invoke.
    let first_prompt: Option<String> = topo
        .iter()
        .filter_map(|id| by_id.get(id).copied())
        .filter_map(|n| {
            let kind = n.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if kind == "chat" || kind == "agent" {
                n.get("data")
                    .and_then(|d| d.get("prompt"))
                    .and_then(|p| p.as_str())
                    .map(|s| s.trim().to_string())
            } else {
                None
            }
        })
        .find(|p| !p.is_empty());
    let description = if !raw_description.is_empty() {
        raw_description.clone()
    } else if let Some(p) = &first_prompt {
        let first_line = p.lines().next().unwrap_or("").trim();
        let truncated: String = if first_line.chars().count() > 140 {
            let cut: String = first_line.chars().take(140).collect();
            format!("{cut}…")
        } else {
            first_line.to_string()
        };
        format!("{truncated} (Use when the user wants to: {truncated})")
    } else {
        format!("Multi-step workflow \"{name}\". Use when the user asks to run \"{name}\".")
    };

    // Build SKILL.md.
    let mut md = String::new();
    md.push_str("---\n");
    md.push_str(&format!("name: {safe}\n"));
    // YAML-quote description to prevent injection via newlines, quotes, or
    // a stray `---` that would close the frontmatter block.
    md.push_str(&format!(
        "description: {}\n",
        yaml_escape_scalar(description.replace('\n', " ").trim())
    ));
    md.push_str("---\n\n");
    md.push_str(&format!("# {name}\n\n"));
    if !raw_description.is_empty() {
        md.push_str(&raw_description);
        md.push_str("\n\n");
    }
    md.push_str(
        "This skill executes a multi-step workflow. Follow the steps below in order. Each step lists which prior steps' outputs to include as context.\n\n",
    );

    if !inputs.is_empty() {
        md.push_str("## Inputs\n\nBefore starting, collect these values from the user (skip any they've already provided, use defaults where shown):\n\n");
        for inp in &inputs {
            let n = inp.get("name").and_then(|v| v.as_str()).unwrap_or("?");
            let d = inp
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let def = inp.get("default").and_then(|v| v.as_str()).unwrap_or("");
            md.push_str(&format!("- **`{{{{{n}}}}}`**"));
            if !d.is_empty() {
                md.push_str(&format!(" — {d}"));
            }
            if !def.is_empty() {
                md.push_str(&format!(" (default: `{def}`)"));
            }
            md.push('\n');
        }
        md.push_str("\nSubstitute each `{{name}}` placeholder in the prompts below with the user's value before executing that step.\n\n");
    }

    md.push_str("## Steps\n\n");
    let mut step_num = 0;
    let mut any_exec_step = false;
    for id in &topo {
        let Some(node) = by_id.get(id) else { continue };
        let kind = node.get("type").and_then(|v| v.as_str()).unwrap_or("?");
        let data = node.get("data").cloned().unwrap_or(serde_json::Value::Null);
        let parent_ids = parents.get(id).cloned().unwrap_or_default();
        let context_note = if parent_ids.is_empty() {
            "(this is an entry step — no prior context)".to_string()
        } else {
            let refs: Vec<String> = parent_ids
                .iter()
                .filter_map(|pid| step_of.get(pid).map(|n| format!("step {n}")))
                .collect();
            if refs.is_empty() {
                "(no prior context)".to_string()
            } else {
                format!("use the output(s) from {} as context", refs.join(", "))
            }
        };

        match kind {
            "chat" | "agent" => {
                let prompt = data
                    .get("prompt")
                    .and_then(|p| p.as_str())
                    .unwrap_or("")
                    .trim();
                if prompt.is_empty() {
                    continue;
                }
                step_num += 1;
                any_exec_step = true;
                let label = if kind == "agent" {
                    "agent (delegate with full tool access — file edits, shell, etc.)"
                } else {
                    "chat (reason and produce text; no side effects)"
                };
                md.push_str(&format!("### Step {step_num} — {label}\n\n"));
                md.push_str(&format!("**Context:** {context_note}.\n\n"));
                md.push_str("**Prompt:**\n\n```\n");
                md.push_str(prompt);
                md.push_str("\n```\n\n");
            }
            "kb" => {
                let dir = data.get("dir").and_then(|v| v.as_str()).unwrap_or("");
                let files: Vec<String> = data
                    .get("files")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|f| f.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                if dir.is_empty() && files.is_empty() {
                    continue;
                }
                step_num += 1;
                any_exec_step = true;
                md.push_str(&format!("### Step {step_num} — knowledge base\n\n"));
                md.push_str("**Context:** load these files and keep their contents available as context for the remaining steps.\n\n");
                if !dir.is_empty() {
                    md.push_str(&format!("Directory: `{dir}`\n\n"));
                }
                if !files.is_empty() {
                    md.push_str("Files:\n");
                    for f in &files {
                        md.push_str(&format!("- `{f}`\n"));
                    }
                    md.push('\n');
                }
            }
            "pipeline_ref" => {
                let sub = data
                    .get("pipelineName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                let bindings = data
                    .get("inputBindings")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                step_num += 1;
                any_exec_step = true;
                md.push_str(&format!(
                    "### Step {step_num} — run sub-pipeline `{sub}`\n\n"
                ));
                md.push_str(&format!("**Context:** {context_note}.\n\n"));
                if !bindings.is_empty() {
                    md.push_str("Inputs to pass:\n");
                    for (k, v) in &bindings {
                        let s = v.as_str().unwrap_or("");
                        md.push_str(&format!("- `{k}` = `{s}`\n"));
                    }
                    md.push('\n');
                }
                md.push_str(&format!(
                    "If the `{sub}` skill is available, invoke it. Otherwise execute its steps inline from its SKILL.md.\n\n"
                ));
            }
            "output" => {
                let dest = data
                    .get("destination")
                    .and_then(|v| v.as_str())
                    .unwrap_or("local");
                let fmt = data
                    .get("format")
                    .and_then(|v| v.as_str())
                    .unwrap_or("markdown");
                step_num += 1;
                any_exec_step = true;
                md.push_str(&format!("### Step {step_num} — write output\n\n"));
                md.push_str(&format!(
                    "**Context:** combine the output(s) from {} into a single {fmt} document.\n\n",
                    if parent_ids.is_empty() {
                        "the previous step".to_string()
                    } else {
                        parent_ids
                            .iter()
                            .filter_map(|pid| step_of.get(pid).map(|n| format!("step {n}")))
                            .collect::<Vec<_>>()
                            .join(", ")
                    }
                ));
                let detail = match dest {
                    "local" => {
                        let dir = data.get("dir").and_then(|v| v.as_str()).unwrap_or("");
                        let file = data
                            .get("filename")
                            .and_then(|v| v.as_str())
                            .unwrap_or("output");
                        if dir.is_empty() {
                            format!("Write to file `{file}` (ask the user where if unsure).")
                        } else {
                            format!("Write to `{dir}/{file}`.")
                        }
                    }
                    "icloud" => {
                        let file = data
                            .get("filename")
                            .and_then(|v| v.as_str())
                            .unwrap_or("output");
                        format!("Write to iCloud Drive: `~/Library/Mobile Documents/com~apple~CloudDocs/Orka/{file}`.")
                    }
                    "notes" => {
                        let title = data
                            .get("notesTitle")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Orka output");
                        format!("Append to Apple Notes note titled `{title}` (use AppleScript/JXA or tell the user to copy in).")
                    }
                    "webhook" => {
                        let url = data
                            .get("webhookUrl")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if url.is_empty() {
                            "POST the document to a user-provided webhook URL.".to_string()
                        } else {
                            format!("POST the document to `{url}`.")
                        }
                    }
                    "shell" => {
                        let cmd = data
                            .get("shellCommand")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        format!(
                            "Run shell command (replace `$CONTENT` with the document):\n\n```\n{cmd}\n```"
                        )
                    }
                    "profile" => {
                        let pid = data
                            .get("profileId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("?");
                        format!("Route through the destination profile `{pid}` (configured in Orka Settings).")
                    }
                    other => format!("Destination: `{other}`."),
                };
                md.push_str(&detail);
                md.push_str("\n\n");
            }
            _ => {}
        }
    }
    if !any_exec_step {
        md.push_str("_(This pipeline has no executable steps yet — add chat/agent nodes with prompts in Orka, then re-export.)_\n\n");
    }

    md.push_str("---\n\n");
    md.push_str("_Generated from an Orka pipeline. The sibling `pipeline.json` file is the original visual-canvas definition — you can ignore it when executing this skill._\n");

    let skill_md_path = skill_dir.join("SKILL.md");
    let pipeline_json_path = skill_dir.join("pipeline.json");
    tokio::fs::write(&skill_md_path, md)
        .await
        .map_err(|e| format!("write SKILL.md: {e}"))?;
    tokio::fs::write(&pipeline_json_path, content)
        .await
        .map_err(|e| format!("write pipeline.json: {e}"))?;
    Ok(skill_dir.to_string_lossy().to_string())
}

#[tauri::command]
fn list_available_skills() -> Vec<skills::SkillMeta> {
    skills::scan_skills_dirs()
}

#[tauri::command]
fn get_skill_detail(slug: String) -> Result<skills::SkillMeta, String> {
    skills::get_skill(&slug)
}

#[tauri::command]
fn list_runs(limit: Option<usize>) -> Vec<run_log::RunRecord> {
    run_log::list_runs(limit.unwrap_or(200))
}

#[tauri::command]
fn append_run(record: run_log::RunRecord) -> Result<(), String> {
    run_log::append_run(&record)
}

#[tauri::command]
fn get_run(id: String) -> Result<run_log::RunRecord, String> {
    run_log::get_run(&id).ok_or_else(|| format!("run '{id}' not found"))
}

/// Load a SKILL.md from any path and return parsed graph data as JSON for the canvas.
#[tauri::command]
async fn load_skill_md(path: String) -> Result<String, String> {
    let parsed = skill_md::parse_skill_md(std::path::Path::new(&path))
        .map_err(|e| format!("parse: {e}"))?;

    let mut result = serde_json::Map::new();
    result.insert("name".into(), serde_json::Value::String(parsed.name));
    result.insert("description".into(), serde_json::Value::String(parsed.description));

    let inputs_json: Vec<serde_json::Value> = parsed.inputs.iter().map(|i| {
        let mut m = serde_json::Map::new();
        m.insert("name".into(), serde_json::Value::String(i.name.clone()));
        m.insert("type".into(), serde_json::Value::String(i.input_type.clone()));
        if let Some(d) = &i.default { m.insert("default".into(), serde_json::Value::String(d.clone())); }
        if let Some(d) = &i.description { m.insert("description".into(), serde_json::Value::String(d.clone())); }
        serde_json::Value::Object(m)
    }).collect();
    result.insert("inputs".into(), serde_json::Value::Array(inputs_json));

    let drift = match parsed.drift {
        skill_md::DriftStatus::NoDrift => "none",
        skill_md::DriftStatus::Drifted => "drifted",
        skill_md::DriftStatus::NoGraph => "no_graph",
    };
    result.insert("drift".into(), serde_json::Value::String(drift.into()));

    if let Some(graph) = &parsed.graph {
        let graph_val: serde_json::Value = serde_json::from_str(&graph.raw_json)
            .unwrap_or(serde_json::Value::Null);
        result.insert("graph".into(), graph_val);
    }

    serde_json::to_string(&result).map_err(|e| format!("serialize: {e}"))
}

/// Save a single canvas node as a standalone atomic SKILL.md.
#[tauri::command]
async fn save_node_as_skill(
    node_json: String,
    name: String,
    target_dir: String,
) -> Result<String, String> {
    let node: serde_json::Value = serde_json::from_str(&node_json)
        .map_err(|e| format!("parse node: {e}"))?;
    let node_type = node.get("type").and_then(|v| v.as_str()).unwrap_or("agent");
    let prompt = node.get("data")
        .and_then(|d| d.get("prompt"))
        .and_then(|p| p.as_str())
        .unwrap_or("");

    if prompt.trim().is_empty() {
        return Err("node has no prompt to export".into());
    }

    let safe: String = name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .split('-').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("-");
    let safe = if safe.is_empty() {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        format!("orka-skill-{ts}")
    } else { safe };

    let target = if let Some(stripped) = target_dir.strip_prefix("~/") {
        dirs::home_dir().ok_or("no home dir")?.join(stripped)
    } else if target_dir == "~" {
        dirs::home_dir().ok_or("no home dir")?
    } else {
        std::path::PathBuf::from(&target_dir)
    };

    let skill_dir = target.join(&safe);
    tokio::fs::create_dir_all(&skill_dir).await.map_err(|e| format!("mkdir: {e}"))?;

    let allowed = if node_type == "agent" { "Read, Write, Bash" } else { "" };
    let mut md = String::new();
    md.push_str("---\n");
    md.push_str(&format!("name: {safe}\n"));
    let desc_head = prompt.lines().next().unwrap_or("").chars().take(80).collect::<String>();
    md.push_str(&format!(
        "description: {}\n",
        yaml_escape_scalar(&format!("Extracted from Orka node. {desc_head}"))
    ));
    if !allowed.is_empty() {
        md.push_str(&format!("allowed-tools: {allowed}\n"));
    }
    md.push_str("orka:\n  schema: 1\n");
    md.push_str("---\n\n");
    md.push_str(&format!("# {name}\n\n"));
    md.push_str(prompt.trim());
    md.push('\n');

    let skill_md_path = skill_dir.join("SKILL.md");
    tokio::fs::write(&skill_md_path, md).await.map_err(|e| format!("write: {e}"))?;
    Ok(skill_dir.to_string_lossy().to_string())
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
            generate_pipeline,
            write_output_file,
            outputs_dir,
            read_file_text,
            fetch_text_url,
            destinations::icloud_orka_path,
            destinations::write_to_icloud,
            destinations::append_to_apple_note,
            destinations::markdown_to_html,
            destinations::post_to_webhook,
            destinations::run_shell_destination,
            destinations::approve_shell_command,
            destinations::is_shell_command_trusted,
            annotations::load_annotations,
            annotations::save_annotation,
            annotations::append_message,
            annotations::delete_annotation,
            session_brief::get_session_brief,
            session_brief::generate_session_brief,
            session_brief::clear_session_brief,
            session_brief::cleanup_ghost_brief_sessions,
            trusted_taps::list_trusted_taps,
            trusted_taps::install_tap,
            trusted_taps::uninstall_tap,
            trusted_taps::add_custom_tap,
            trusted_taps::remove_custom_tap,
            skill_evolution::suggest_skill_evolution,
            skill_evolution::apply_skill_evolution,
            session_synthesis::synthesize_sessions,
            session_synthesis::continue_synthesis,
            model_config::get_model_config,
            model_config::set_model_config,
            dest_profiles::list_destination_profiles,
            dest_profiles::save_destination_profile,
            dest_profiles::delete_destination_profile,
            dest_profiles::get_destination_profile,
            dest_profiles::test_wework_webhook,
            dest_profiles::send_via_profile,
            schedules::list_schedules,
            schedules::get_schedule,
            schedules::save_schedule,
            schedules::delete_schedule,
            schedules::os_notify,
            open_in_vscode,
            open_in_terminal,
            open_app_by_name,
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
            export_pipeline_as_skill,
            list_available_skills,
            get_skill_detail,
            load_skill_md,
            save_node_as_skill,
            list_runs,
            get_run,
            append_run,
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
