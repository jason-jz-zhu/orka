use crate::workspace;
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc::UnboundedSender;

static RUNNING: LazyLock<Mutex<HashMap<String, u32>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Acquire the RUNNING mutex, recovering from poison so a panic in one handler
/// doesn't brick every subsequent Tauri command that touches this map.
fn running_lock() -> MutexGuard<'static, HashMap<String, u32>> {
    RUNNING.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Clone, Copy, Debug)]
pub enum NodeMode {
    /// Plain chat — no tool use (safest).
    Chat,
    /// Full agent — tool use permitted (bash, edit, mcp).
    Agent,
}

/// Permission scope for Agent-mode runs. Chat mode ignores this.
#[derive(Clone, Debug, Default)]
pub enum ToolScope {
    /// No restriction — uses `--dangerously-skip-permissions`. Default for
    /// backwards compatibility; visible warning badge in the UI.
    #[default]
    Full,
    /// Explicit whitelist passed to `--allowed-tools`. Empty list is treated
    /// as "no tools at all" (pointless for Agent, but legal).
    AllowList(Vec<String>),
}

impl ToolScope {
    /// Parse an optional comma-separated list into a ToolScope. Returns `Full`
    /// when the input is `None` or empty.
    pub fn from_allowed(allowed: Option<Vec<String>>) -> Self {
        match allowed {
            None => ToolScope::Full,
            Some(list) => {
                let cleaned: Vec<String> = list
                    .into_iter()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                ToolScope::AllowList(cleaned)
            }
        }
    }
}

fn claude_args(
    prompt: &str,
    mode: NodeMode,
    resume_id: Option<&str>,
    add_dirs: &[String],
    scope: &ToolScope,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".into(),
        prompt.to_string(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
    ];
    for d in add_dirs {
        args.push("--add-dir".into());
        args.push(d.clone());
    }
    if let Some(rid) = resume_id {
        args.push("--resume".into());
        args.push(rid.to_string());
        args.push("--fork-session".into());
    }
    // Chat nodes without add_dirs get no tool access flags at all (safest).
    // Agent nodes (or chat with add_dirs) either get a whitelist or the
    // unrestricted `--dangerously-skip-permissions` escape hatch.
    let needs_tools = matches!(mode, NodeMode::Agent) || !add_dirs.is_empty();
    if needs_tools {
        match scope {
            ToolScope::AllowList(list) => {
                args.push("--allowed-tools".into());
                args.push(list.join(","));
            }
            ToolScope::Full => {
                args.push("--dangerously-skip-permissions".into());
            }
        }
    }
    args
}

/// Core subprocess runner: spawns `claude`, pushes each stdout line into `tx`.
/// Returns Ok(stderr_text) on success, Err otherwise.
pub async fn spawn_claude_stream(
    workdir: &Path,
    prompt: &str,
    mode: NodeMode,
    resume_id: Option<&str>,
    add_dirs: &[String],
    scope: &ToolScope,
    tx: UnboundedSender<String>,
    track_id: Option<&str>,
) -> Result<String, String> {
    let args = claude_args(prompt, mode, resume_id, add_dirs, scope);
    let mut cmd = Command::new("claude");
    cmd.current_dir(workdir)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Put the child in its own process group on Unix so we can signal the
    // whole tree (claude + its node/ripgrep/python helpers) on cancel.
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            // New session → new process group led by this PID.
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let spawn = cmd.spawn();

    let mut child: Child = match spawn {
        Ok(c) => c,
        Err(e) => {
            return Err(format!(
                "spawn claude failed: {e} (is the `claude` CLI on PATH?)"
            ))
        }
    };
    if let (Some(id), Some(pid)) = (track_id, child.id()) {
        running_lock().insert(id.to_string(), pid);
    }

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => return Err("stdout pipe missing".into()),
    };
    let stderr = match child.stderr.take() {
        Some(s) => s,
        None => return Err("stderr pipe missing".into()),
    };

    let tx_out = tx.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = tx_out.send(line);
        }
    });

    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    });

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = stdout_task.await;
    let stderr_text = stderr_task.await.unwrap_or_default();

    if status.success() {
        Ok(stderr_text)
    } else {
        Err(format!(
            "claude exited with status {}: {}",
            status.code().unwrap_or(-1),
            stderr_text.trim()
        ))
    }
}

/// Tauri-facing runner: spawns claude and forwards each stdout line as an event.
pub async fn run_claude(
    app: AppHandle,
    id: String,
    prompt: String,
    mode: NodeMode,
    resume_id: Option<String>,
    add_dirs: Vec<String>,
    scope: ToolScope,
) -> Result<(), String> {
    let workdir = workspace::ensure_node_dir(&id)
        .await
        .map_err(|e| format!("mkdir failed: {e}"))?;

    let _ = tokio::fs::write(workdir.join("prompt.txt"), &prompt).await;

    let stream_event = format!("node:{id}:stream");
    let done_event = format!("node:{id}:done");

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let app_fwd = app.clone();
    let stream_event_fwd = stream_event.clone();
    let forwarder = tauri::async_runtime::spawn(async move {
        while let Some(line) = rx.recv().await {
            let _ = app_fwd.emit(&stream_event_fwd, line);
        }
    });

    let result = spawn_claude_stream(
        &workdir,
        &prompt,
        mode,
        resume_id.as_deref(),
        &add_dirs,
        &scope,
        tx,
        Some(&id),
    )
    .await;
    let _ = forwarder.await;
    running_lock().remove(&id);

    match result {
        Ok(_stderr) => {
            let _ = app.emit(&done_event, serde_json::json!({ "ok": true }));
            Ok(())
        }
        Err(err) => {
            let _ = app.emit(
                &done_event,
                serde_json::json!({ "ok": false, "error": err.clone() }),
            );
            Err(err)
        }
    }
}

/// Send SIGTERM to a running node's entire process group. No-op if not running.
/// Using the negative pid targets the group (set up via setsid in spawn_claude_stream),
/// so child helpers (node, ripgrep, python, etc.) get killed too — no zombies.
pub fn cancel_node(node_id: &str) -> bool {
    let pid = match running_lock().remove(node_id) {
        Some(p) => p,
        None => return false,
    };
    #[cfg(unix)]
    unsafe {
        // Signal the whole process group led by `pid`.
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_args_default_to_skip_permissions() {
        let args = claude_args("x", NodeMode::Agent, None, &[], &ToolScope::Full);
        assert!(args.iter().any(|a| a == "--dangerously-skip-permissions"));
        assert!(!args.iter().any(|a| a == "--allowed-tools"));
    }

    #[test]
    fn agent_args_with_allowlist_use_flag() {
        let args = claude_args(
            "x",
            NodeMode::Agent,
            None,
            &[],
            &ToolScope::AllowList(vec!["Read".into(), "Glob".into()]),
        );
        let s = args.join(" ");
        assert!(s.contains("--allowed-tools Read,Glob"));
        assert!(!args.iter().any(|a| a == "--dangerously-skip-permissions"));
    }

    #[test]
    fn chat_args_without_add_dirs_have_no_permission_flags() {
        let args = claude_args("x", NodeMode::Chat, None, &[], &ToolScope::Full);
        assert!(!args.iter().any(|a| a == "--dangerously-skip-permissions"));
        assert!(!args.iter().any(|a| a == "--allowed-tools"));
        assert!(args.iter().any(|a| a == "--output-format"));
        assert!(args.iter().any(|a| a == "stream-json"));
    }

    #[test]
    fn add_dirs_each_get_flag() {
        let args = claude_args(
            "x",
            NodeMode::Chat,
            None,
            &["/a".to_string(), "/b".to_string()],
            &ToolScope::Full,
        );
        let s = args.join(" ");
        assert!(s.contains("--add-dir /a"));
        assert!(s.contains("--add-dir /b"));
    }

    #[test]
    fn add_dirs_trigger_permission_flags_for_chat() {
        let args = claude_args(
            "x",
            NodeMode::Chat,
            None,
            &["/some/dir".to_string()],
            &ToolScope::Full,
        );
        assert!(args.iter().any(|a| a == "--dangerously-skip-permissions"));
    }

    #[test]
    fn resume_args_include_resume_and_fork() {
        let args = claude_args("x", NodeMode::Chat, Some("abc-123"), &[], &ToolScope::Full);
        let s = args.join(" ");
        assert!(s.contains("--resume abc-123"));
        assert!(s.contains("--fork-session"));
    }

    #[test]
    fn tool_scope_from_empty_list_is_allowlist_empty() {
        match ToolScope::from_allowed(Some(vec!["".to_string(), "  ".to_string()])) {
            ToolScope::AllowList(v) => assert!(v.is_empty()),
            _ => panic!("expected AllowList"),
        }
    }

    #[test]
    fn tool_scope_from_none_is_full() {
        assert!(matches!(ToolScope::from_allowed(None), ToolScope::Full));
    }

    /// End-to-end integration test: actually spawns `claude -p` and verifies we receive
    /// at least one JSONL line with type "assistant".
    ///
    /// Opt-in: run with `cargo test -- --ignored` because it makes a real API call and costs money.
    #[tokio::test]
    #[ignore]
    async fn spawn_claude_stream_produces_assistant_text() {
        let tmp = std::env::temp_dir().join(format!(
            "orka-spawn-test-{}",
            std::process::id()
        ));
        tokio::fs::create_dir_all(&tmp).await.unwrap();

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let collector = tokio::spawn(async move {
            let mut lines: Vec<String> = vec![];
            while let Some(l) = rx.recv().await {
                lines.push(l);
            }
            lines
        });

        let res = spawn_claude_stream(
            &tmp,
            "reply with just: ok",
            NodeMode::Chat,
            None,
            &[],
            &ToolScope::Full,
            tx,
            None,
        )
        .await;
        let lines = collector.await.unwrap();
        let _ = tokio::fs::remove_dir_all(&tmp).await;

        assert!(res.is_ok(), "spawn failed: {:?}", res);
        assert!(
            lines.iter().any(|l| l.contains(r#""type":"assistant""#)),
            "no assistant line in stream: {:?}",
            lines
        );
        assert!(
            lines.iter().any(|l| l.contains(r#""type":"result""#)),
            "no result line in stream: {:?}",
            lines
        );
    }
}
