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
    fork_on_resume: bool,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".into(),
        prompt.to_string(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
    ];
    // User-configurable model for skill runs + continue-chats.
    let model = crate::model_config::model_for_skill_run();
    if !model.trim().is_empty() {
        args.push("--model".into());
        args.push(model);
    }
    for d in add_dirs {
        args.push("--add-dir".into());
        args.push(d.clone());
    }
    if let Some(rid) = resume_id {
        args.push("--resume".into());
        args.push(rid.to_string());
        // Fork is the default for skill re-runs (prevents parallel resumes
        // from racing the session jsonl). For chat/annotator follow-ups
        // we append instead — otherwise the turns land in a brand-new
        // session id and the user's "Terminal" button opens a transcript
        // that's missing everything they asked in the panel.
        if fork_on_resume {
            args.push("--fork-session".into());
        }
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
    fork_on_resume: bool,
) -> Result<String, String> {
    let args = claude_args(prompt, mode, resume_id, add_dirs, scope, fork_on_resume);
    // Gate: cap total concurrent `claude` subprocesses across the app.
    // Held until this function returns (after the child exits).
    let _permit = crate::claude_gate::acquire().await;
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
    workdir_key: Option<String>,
    skill_slug: Option<String>,
    schedule_label: Option<String>,
    inputs_for_template: Option<Vec<String>>,
    explicit_workdir: Option<String>,
    fork_on_resume: bool,
) -> Result<(), String> {
    // Workdir resolution order:
    //   1. `skill_slug` + user config → <user_folder>/<timestamped>/
    //   2. `workdir_key` → reuse another run's node dir (for --resume chaining)
    //   3. `id` → per-run node dir under the workspace (legacy default)
    //
    // The user-folder path lets skill outputs land somewhere the user
    // can find with Finder/Spotlight. The `workdir_key` path matters
    // for `--resume <session>`: claude derives its project folder from
    // the cwd, and session files only live under the project that
    // created them. A "continue chat" spawn uses a unique `id` for
    // event isolation but must share the workdir of the source run
    // or --resume reports "No conversation found".
    let workdir = if let Some(w) = explicit_workdir.as_deref() {
        // Frontend already resolved the workdir via `preview_run_workdir`
        // at user-click time. Re-resolving here would pick up a later
        // `chrono::Local::now()` — different minute bucket when the
        // subprocess actually starts after any modal / trust check
        // delay — and the path written to the run record would no
        // longer match the directory we actually run in. Accept the
        // caller's path verbatim and just mkdir it.
        let p = std::path::PathBuf::from(w);
        tokio::fs::create_dir_all(&p)
            .await
            .map_err(|e| format!("mkdir explicit workdir failed: {e}"))?;
        p
    } else if skill_slug.is_some() {
        let inputs = inputs_for_template.unwrap_or_default();
        let resolved = crate::skill_workdir::resolve_run_workdir(
            skill_slug.as_deref(),
            schedule_label.as_deref(),
            &id,
            &inputs,
            chrono::Local::now(),
        );
        tokio::fs::create_dir_all(&resolved)
            .await
            .map_err(|e| format!("mkdir resolved workdir failed: {e}"))?;
        resolved
    } else {
        let dir_key = workdir_key.as_deref().unwrap_or(&id);
        workspace::ensure_node_dir(dir_key)
            .await
            .map_err(|e| format!("mkdir failed: {e}"))?
    };

    // Internal per-run files (prompt.txt, any future stream dumps) live
    // under .orka/ so a directory listing of the user-configured folder
    // only shows the artifacts they care about (markdown, generated
    // files, etc). Legacy node_dir fallback gets the same treatment so
    // the layout is consistent regardless of where the run landed.
    let internal = crate::skill_workdir::internal_dir(&workdir);
    let _ = tokio::fs::create_dir_all(&internal).await;
    let _ = tokio::fs::write(internal.join("prompt.txt"), &prompt).await;

    let stream_event = format!("node:{id}:stream");
    let done_event = format!("node:{id}:done");

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let app_fwd = app.clone();
    let stream_event_fwd = stream_event.clone();
    // Forwarder owns its own String — no Arc<Mutex> contention per
    // stream line. At 100-300 tokens/sec the previous Mutex version
    // did 30k `.lock().await`s per long run, serializing on a single
    // lock for no reason (this task is the sole writer). Now the
    // accumulator lives in the forwarder's stack and is returned via
    // the JoinHandle when the stream closes.
    let forwarder = tauri::async_runtime::spawn(async move {
        let mut buf = String::new();
        while let Some(line) = rx.recv().await {
            let extracted = extract_assistant_text(&line);
            if !extracted.is_empty() {
                buf.push_str(&extracted);
            }
            let _ = app_fwd.emit(&stream_event_fwd, line);
        }
        buf
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
        fork_on_resume,
    )
    .await;
    // Await the forwarder and take ownership of its accumulated text.
    // Falling back to an empty string on join-error is safe — output.md
    // just won't be written that run, which is also what happens when
    // the skill emits no text at all.
    let final_text = forwarder.await.unwrap_or_default();
    running_lock().remove(&id);

    // Kick the write into a detached task so the spin-disk fsync
    // (10-50ms on HDD) doesn't delay the UI's "run complete" signal.
    // The frontend only reads output.md when the user opens
    // RunDetailDrawer — by then the write is long done. Kernel page
    // cache gives read-after-write consistency even without fsync,
    // so the only thing we lose is durability across a kernel crash
    // in the few-ms window — acceptable for a derived artifact.
    if !final_text.trim().is_empty() {
        let output_path = workdir.join("output.md");
        let text = final_text;
        tauri::async_runtime::spawn(async move {
            if let Ok(mut f) = tokio::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&output_path)
                .await
            {
                use tokio::io::AsyncWriteExt;
                let _ = f.write_all(text.as_bytes()).await;
                let _ = f.sync_all().await;
            }
        });
    }

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

/// Extract assistant text content from a single stream-json line and
/// append it to the shared buffer. Silently tolerates any non-matching
/// line (tool_use, tool_result, system, result, etc.) — those don't
/// contribute to the user-visible output artifact.
///
/// Only used by tests — the prod path replaced this Arc<Mutex> flow
/// with a local String owned by the forwarder task, eliminating
/// per-event async lock acquisition.
#[cfg(test)]
async fn append_text_from_stream_line(
    line: &str,
    buf: &std::sync::Arc<tokio::sync::Mutex<String>>,
) {
    let extracted = extract_assistant_text(line);
    if extracted.is_empty() {
        return;
    }
    let mut g = buf.lock().await;
    if !g.is_empty() {
        g.push_str("");
    }
    g.push_str(&extracted);
}

/// Pure parser: returns concatenated assistant text blocks from one
/// stream-json line. Exposed for tests so we don't need a running
/// subprocess to assert behaviour.
pub fn extract_assistant_text(line: &str) -> String {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return String::new();
    };
    if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return String::new();
    }
    let Some(blocks) = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return String::new();
    };
    let mut out = String::new();
    for block in blocks {
        if block.get("type").and_then(|t| t.as_str()) != Some("text") {
            continue;
        }
        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
            out.push_str(text);
        }
    }
    out
}

/// Send SIGTERM to a running node's entire process group, then SIGKILL
/// after a 5s grace window if the tree hasn't exited. No-op if not
/// running. Using the negative pid targets the group (set up via
/// setsid in spawn_claude_stream), so child helpers (node, ripgrep,
/// python, etc.) get killed too — no zombies.
///
/// The SIGKILL escalation matters for claude builds that ignore
/// SIGTERM while in the middle of a tool use, or for stuck child
/// processes (network hangs). Without it cancel_node returned true
/// but the process would linger forever.
pub fn cancel_node(node_id: &str) -> bool {
    let pid = match running_lock().remove(node_id) {
        Some(p) => p,
        None => return false,
    };
    #[cfg(unix)]
    unsafe {
        // SIGTERM the whole group first — well-behaved children clean
        // up (claude flushes session state, closes pipes, etc.).
        libc::kill(-(pid as i32), libc::SIGTERM);

        // Detached escalation: give the tree ~5s, then SIGKILL if
        // anything's still alive. Using a blocking thread rather than
        // tokio::spawn because this function is sync (called from a
        // Tauri command). The signal is idempotent — kill(0) returns
        // -1 if the process is gone, so no harm done.
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(5));
            // Check if the group leader is still alive before SIGKILL —
            // avoid sending a signal to a PID the OS has since reused.
            if libc::kill(pid as i32, 0) == 0 {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        });
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
    }
    true
}

/// Terminate every tracked run. Used at app shutdown so users don't
/// orphan claude processes when they quit mid-run. Iterates a
/// snapshot of the RUNNING map to avoid holding the lock while
/// sending signals.
pub fn cancel_all_nodes() {
    let snapshot: Vec<String> = {
        let g = running_lock();
        g.keys().cloned().collect()
    };
    for id in snapshot {
        cancel_node(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_args_default_to_skip_permissions() {
        let args = claude_args("x", NodeMode::Agent, None, &[], &ToolScope::Full, true);
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
            true,
        );
        let s = args.join(" ");
        assert!(s.contains("--allowed-tools Read,Glob"));
        assert!(!args.iter().any(|a| a == "--dangerously-skip-permissions"));
    }

    #[test]
    fn chat_args_without_add_dirs_have_no_permission_flags() {
        let args = claude_args("x", NodeMode::Chat, None, &[], &ToolScope::Full, true);
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
            true,
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
            true,
        );
        assert!(args.iter().any(|a| a == "--dangerously-skip-permissions"));
    }

    #[test]
    fn resume_args_include_resume_and_fork_when_enabled() {
        let args = claude_args(
            "x",
            NodeMode::Chat,
            Some("abc-123"),
            &[],
            &ToolScope::Full,
            true,
        );
        let s = args.join(" ");
        assert!(s.contains("--resume abc-123"));
        assert!(s.contains("--fork-session"));
    }

    #[test]
    fn resume_args_skip_fork_when_disabled() {
        // Regression for the "Terminal doesn't see chat follow-ups" bug:
        // chat panel + annotator pass fork=false so the follow-up
        // appends to the original session jsonl, not a brand-new fork.
        let args = claude_args(
            "x",
            NodeMode::Chat,
            Some("abc-123"),
            &[],
            &ToolScope::Full,
            false,
        );
        let s = args.join(" ");
        assert!(s.contains("--resume abc-123"));
        assert!(
            !args.iter().any(|a| a == "--fork-session"),
            "fork=false must not pass --fork-session"
        );
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
            true,
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

    #[test]
    fn harness_extract_assistant_text_basic() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello world"}]}}"#;
        assert_eq!(extract_assistant_text(line), "Hello world");
    }

    #[test]
    fn harness_extract_assistant_text_concatenates_multiple_blocks() {
        // A single stream line can carry multiple text blocks — combine
        // them in emit order so the captured output mirrors what the
        // user saw streaming in the UI.
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"A"},{"type":"text","text":"B"}]}}"#;
        assert_eq!(extract_assistant_text(line), "AB");
    }

    #[test]
    fn harness_extract_assistant_text_ignores_tool_use() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"},{"type":"tool_use","name":"Read","input":{}}]}}"#;
        assert_eq!(extract_assistant_text(line), "hello");
    }

    #[test]
    fn harness_extract_assistant_text_ignores_non_assistant() {
        // user / tool_result / system / result messages don't count.
        assert_eq!(
            extract_assistant_text(r#"{"type":"user","message":{"content":"nope"}}"#),
            ""
        );
        assert_eq!(
            extract_assistant_text(r#"{"type":"result","subtype":"success"}"#),
            ""
        );
        assert_eq!(
            extract_assistant_text(r#"{"type":"system","subtype":"init"}"#),
            ""
        );
    }

    #[test]
    fn harness_extract_assistant_text_tolerates_garbage() {
        // Malformed JSON or unexpected shapes never panic — just yield empty.
        assert_eq!(extract_assistant_text(""), "");
        assert_eq!(extract_assistant_text("not json"), "");
        assert_eq!(extract_assistant_text("{}"), "");
        assert_eq!(
            extract_assistant_text(r#"{"type":"assistant"}"#),
            ""
        );
    }

    #[tokio::test]
    async fn harness_append_text_from_stream_line_accumulates() {
        let buf = std::sync::Arc::new(tokio::sync::Mutex::new(String::new()));

        let mixed_lines = vec![
            r#"{"type":"system","subtype":"init"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Part 1"}]}}"#,
            r#"{"type":"user","message":{"content":"ignored"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Part 2"}]}}"#,
        ];
        for line in mixed_lines {
            append_text_from_stream_line(line, &buf).await;
        }
        let g = buf.lock().await;
        assert_eq!(*g, "Part 1Part 2");
    }
}
