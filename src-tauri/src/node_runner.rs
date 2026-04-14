use crate::workspace;
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc::UnboundedSender;

static RUNNING: LazyLock<Mutex<HashMap<String, u32>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Copy, Debug)]
pub enum NodeMode {
    /// Plain chat — no tool use (safest).
    Chat,
    /// Full agent — tool use permitted (bash, edit, mcp).
    Agent,
}

fn claude_args(
    prompt: &str,
    mode: NodeMode,
    resume_id: Option<&str>,
    add_dirs: &[String],
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
    // If we're granting directory access, the user clearly wants tool use — skip
    // permission prompts since headless `-p` mode can't answer them.
    if matches!(mode, NodeMode::Agent) || !add_dirs.is_empty() {
        args.push("--dangerously-skip-permissions".into());
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
    tx: UnboundedSender<String>,
    track_id: Option<&str>,
) -> Result<String, String> {
    let args = claude_args(prompt, mode, resume_id, add_dirs);
    let spawn = Command::new("claude")
        .current_dir(workdir)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child: Child = match spawn {
        Ok(c) => c,
        Err(e) => {
            return Err(format!(
                "spawn claude failed: {e} (is the `claude` CLI on PATH?)"
            ))
        }
    };
    if let (Some(id), Some(pid)) = (track_id, child.id()) {
        RUNNING.lock().unwrap().insert(id.to_string(), pid);
    }

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

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
        tx,
        Some(&id),
    )
    .await;
    let _ = forwarder.await;
    RUNNING.lock().unwrap().remove(&id);

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

/// Send SIGTERM to a running node's subprocess. No-op if not running.
pub fn cancel_node(node_id: &str) -> bool {
    let pid = match RUNNING.lock().unwrap().remove(node_id) {
        Some(p) => p,
        None => return false,
    };
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
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
    fn agent_args_include_skip_permissions() {
        let args = claude_args("x", NodeMode::Agent, None, &[]);
        assert!(args.iter().any(|a| a == "--dangerously-skip-permissions"));
    }

    #[test]
    fn chat_args_exclude_skip_permissions() {
        let args = claude_args("x", NodeMode::Chat, None, &[]);
        assert!(!args.iter().any(|a| a == "--dangerously-skip-permissions"));
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
        );
        let s = args.join(" ");
        assert!(s.contains("--add-dir /a"));
        assert!(s.contains("--add-dir /b"));
    }

    #[test]
    fn add_dirs_trigger_skip_permissions_for_chat() {
        let args = claude_args(
            "x",
            NodeMode::Chat,
            None,
            &["/some/dir".to_string()],
        );
        assert!(args.iter().any(|a| a == "--dangerously-skip-permissions"));
    }

    #[test]
    fn resume_args_include_resume_and_fork() {
        let args = claude_args("x", NodeMode::Chat, Some("abc-123"), &[]);
        let s = args.join(" ");
        assert!(s.contains("--resume abc-123"));
        assert!(s.contains("--fork-session"));
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
