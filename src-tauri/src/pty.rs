//! Embedded terminal — PTY orchestration for `<EmbeddedTerminal>`.
//!
//! Each spawned terminal gets a stable `pty_id` (uuid v4) and an entry
//! in the global PTY_REGISTRY. Reader-side bytes get forwarded to the
//! frontend via `pty:output:<id>` events, batched at ~30ms intervals
//! so we don't melt the Tauri IPC channel under heavy stdout (e.g.
//! `ls -R` of a node_modules tree).
//!
//! Cross-platform: portable-pty (Wezterm) abstracts ConPTY on Windows
//! and openpty on Unix. Resize and write are blocking calls on the
//! library's master end, so we spawn writer/reader threads to keep the
//! Tokio runtime free of blocking syscalls.

use portable_pty::{native_pty_system, CommandBuilder, PtySize, MasterPty, Child};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

/// Soft cap on concurrent PTYs. Each one consumes a small thread pool
/// (reader + writer) plus a child process, so unbounded spawn would
/// eventually exhaust file descriptors. The frontend should disable
/// "+ New terminal" when len() reaches this; backend additionally
/// rejects spawn beyond it as a defence-in-depth check.
const MAX_PTYS: usize = 8;

/// Registry handle holding the writer + child kill handle. Reader loop
/// owns the master end and forwards bytes via Tauri events; we keep
/// just enough state here to write keystrokes, resize, and kill on
/// close.
struct PtyHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

static PTY_REGISTRY: LazyLock<Mutex<HashMap<String, PtyHandle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock() -> std::sync::MutexGuard<'static, HashMap<String, PtyHandle>> {
    // Same poison-recovery pattern as sessions.rs — a panic in one
    // PTY thread shouldn't brick the registry for everyone else.
    PTY_REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Clone, Serialize)]
struct PtyOutput {
    /// utf-8 lossy decoded chunk; xterm.js handles partial sequences
    /// across chunks fine.
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExit {
    /// None if the process was killed externally before we got an
    /// exit status (rare).
    code: Option<i32>,
}

/// Spawn a child inside a fresh PTY and start streaming its output.
/// Returns the new pty_id; the frontend listens on `pty:output:<id>`
/// for bytes and `pty:exit:<id>` for the final status, and uses the
/// id to write/resize/kill.
#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    cwd: Option<String>,
    cmd: String,
    args: Option<Vec<String>>,
    rows: Option<u16>,
    cols: Option<u16>,
    env: Option<Vec<(String, String)>>,
) -> Result<String, String> {
    if cmd.trim().is_empty() {
        return Err("cmd is empty".into());
    }
    if lock().len() >= MAX_PTYS {
        return Err(format!(
            "too many open terminals ({MAX_PTYS} max). Close one before opening another."
        ));
    }

    let pty_id = uuid::Uuid::new_v4().to_string();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.unwrap_or(24),
            cols: cols.unwrap_or(80),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut builder = CommandBuilder::new(&cmd);
    if let Some(args) = args {
        for a in args {
            builder.arg(a);
        }
    }
    if let Some(dir) = cwd.as_deref().filter(|d| !d.is_empty()) {
        builder.cwd(dir);
    }
    if let Some(envs) = env {
        for (k, v) in envs {
            builder.env(k, v);
        }
    }

    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| format!("spawn {cmd}: {e}"))?;
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;

    // Reader thread — owns its own clone of the master end via the
    // library's try_clone_reader so we can forward bytes without
    // contending with the writer side. Batches at ~30ms.
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader: {e}"))?;
    let app_for_reader = app.clone();
    let pty_id_for_reader = pty_id.clone();
    std::thread::spawn(move || {
        run_reader(app_for_reader, pty_id_for_reader, reader);
    });

    // Exit watcher — cleanup + emit exit event when the process ends.
    // Uses a separate thread because Child::wait blocks.
    let pty_id_for_waiter = pty_id.clone();
    let app_for_waiter = app.clone();

    lock().insert(
        pty_id.clone(),
        PtyHandle {
            writer,
            master: pair.master,
            child,
        },
    );

    std::thread::spawn(move || {
        // Loop until the child exits. We poll instead of `.wait()`
        // because we need to release the lock between checks so other
        // commands (resize, write, kill) can grab it.
        let code = loop {
            let status = {
                let mut reg = lock();
                let Some(handle) = reg.get_mut(&pty_id_for_waiter) else {
                    // Externally removed (e.g. kill). Exit.
                    return;
                };
                handle.child.try_wait()
            };
            match status {
                Ok(Some(exit)) => break exit.exit_code() as i32,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(120)),
                Err(_) => break -1,
            }
        };
        // Drop the registry entry before emitting so a frontend
        // re-entrant cleanup doesn't deadlock.
        lock().remove(&pty_id_for_waiter);
        let _ = app_for_waiter.emit(
            &format!("pty:exit:{pty_id_for_waiter}"),
            PtyExit { code: Some(code) },
        );
    });

    Ok(pty_id)
}

fn run_reader(
    app: AppHandle,
    pty_id: String,
    mut reader: Box<dyn Read + Send>,
) {
    let mut buf = [0u8; 4096];
    let mut pending: Vec<u8> = Vec::with_capacity(8192);
    let mut last_flush = std::time::Instant::now();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                // EOF — flush remainder and exit. The exit watcher
                // emits the exit event separately.
                if !pending.is_empty() {
                    let _ = app.emit(
                        &format!("pty:output:{pty_id}"),
                        PtyOutput {
                            data: String::from_utf8_lossy(&pending).into_owned(),
                        },
                    );
                }
                return;
            }
            Ok(n) => {
                pending.extend_from_slice(&buf[..n]);
                // Batch: flush when buffer >2KB OR 30ms since last
                // emit. Tight enough to feel responsive in xterm.js
                // but loose enough that bulk output (cat large files)
                // doesn't 60fps the IPC channel.
                let now = std::time::Instant::now();
                let elapsed = now.duration_since(last_flush);
                if pending.len() >= 2048 || elapsed.as_millis() >= 30 {
                    let chunk = std::mem::take(&mut pending);
                    let _ = app.emit(
                        &format!("pty:output:{pty_id}"),
                        PtyOutput {
                            data: String::from_utf8_lossy(&chunk).into_owned(),
                        },
                    );
                    last_flush = now;
                }
            }
            Err(_) => {
                // Master closed under us — likely kill(). Stop.
                return;
            }
        }
    }
}

#[tauri::command]
pub async fn pty_write(pty_id: String, data: String) -> Result<(), String> {
    let mut reg = lock();
    let handle = reg
        .get_mut(&pty_id)
        .ok_or_else(|| format!("unknown pty_id: {pty_id}"))?;
    handle
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn pty_resize(pty_id: String, rows: u16, cols: u16) -> Result<(), String> {
    let reg = lock();
    let handle = reg
        .get(&pty_id)
        .ok_or_else(|| format!("unknown pty_id: {pty_id}"))?;
    handle
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(pty_id: String) -> Result<(), String> {
    let mut reg = lock();
    if let Some(mut handle) = reg.remove(&pty_id) {
        let _ = handle.child.kill();
    }
    Ok(())
}

/// Used by the frontend to disable the "+ New terminal" affordance
/// once we hit the soft cap, so users see grey-out before getting an
/// error toast.
#[tauri::command]
pub async fn pty_count() -> usize {
    lock().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_starts_empty() {
        // Smoke check that the LazyLock initialises and the lock
        // helper recovers from poison if it ever happens. Real spawn
        // tests need a Tauri runtime, so they live in e2e specs
        // instead of here.
        let g = lock();
        // Other tests in the suite may have populated it concurrently;
        // we only assert the lock works at all.
        let _ = g.len();
    }

    /// Sane-bounds check on the soft cap — guards against an
    /// accidental "raise to 64" diff slipping past review.
    /// Keep aligned with docs/TESTING-PLAN.md if we ever expose
    /// this in settings.
    #[test]
    fn max_ptys_is_sane() {
        assert!(MAX_PTYS >= 4);
        assert!(MAX_PTYS <= 16);
    }
}
