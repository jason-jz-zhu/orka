use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;
use tauri::async_runtime::{self, JoinHandle};
use tauri::{AppHandle, Emitter};

static WATCHERS: LazyLock<Mutex<HashMap<String, JoinHandle<()>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Per-file cache of the expensive I/O work a refresh would otherwise repeat:
/// reading the whole .jsonl to compute first/last-line previews and to count
/// assistant turns. Invalidated when the file's mtime or size changes.
#[derive(Clone)]
struct CachedTail {
    mtime_ms: u64,
    size_bytes: u64,
    first_lines: Vec<String>,
    last_lines: Vec<String>,
    turn_count: usize,
    /// Text preview of the most recent *real* user ask. Filters out
    /// tool_result lines, local-command wrappers, and isMeta markers.
    last_user_preview: Option<String>,
}

/// Returns the extracted text of a real user ask, or None if the line
/// isn't one.
///
/// Rules (per session-jsonl audit):
///   - `type == "user"` is required
///   - skip `isMeta == true` (shell command wrappers like `/clear`)
///   - skip lines with top-level `sourceToolAssistantUUID` (tool_result)
///   - skip lines with top-level `toolUseResult`
///   - skip content blocks of `type: "tool_result"`
///   - skip text content starting with `<local-command-` or `<command-`
fn extract_real_user_ask(v: &serde_json::Value) -> Option<String> {
    if v.get("type").and_then(|x| x.as_str()) != Some("user") {
        return None;
    }
    if v.get("isMeta").and_then(|x| x.as_bool()).unwrap_or(false) {
        return None;
    }
    if v.get("sourceToolAssistantUUID").is_some() {
        return None;
    }
    if v.get("toolUseResult").is_some() {
        return None;
    }
    let content = v.get("message").and_then(|m| m.get("content"))?;

    // Two content shapes: plain string OR array of blocks.
    if let Some(s) = content.as_str() {
        let t = s.trim();
        if t.is_empty() || t.starts_with("<local-command-") || t.starts_with("<command-") {
            return None;
        }
        return Some(truncate(s, 160));
    }

    let arr = content.as_array()?;
    // Reject if ANY block is a tool_result.
    if arr
        .iter()
        .any(|b| b.get("type").and_then(|x| x.as_str()) == Some("tool_result"))
    {
        return None;
    }
    // Concatenate text blocks; note images by marker.
    let mut out = String::new();
    let mut had_image = false;
    for b in arr {
        match b.get("type").and_then(|x| x.as_str()) {
            Some("text") => {
                if let Some(s) = b.get("text").and_then(|x| x.as_str()) {
                    let t = s.trim();
                    if t.starts_with("<local-command-") || t.starts_with("<command-") {
                        continue;
                    }
                    if !out.is_empty() {
                        out.push(' ');
                    }
                    out.push_str(s);
                }
            }
            Some("image") => had_image = true,
            _ => {}
        }
    }
    let joined = out.trim().to_string();
    if joined.is_empty() {
        if had_image {
            return Some("[image]".into());
        }
        return None;
    }
    Some(truncate(&joined, 160))
}

static TAIL_CACHE: LazyLock<Mutex<HashMap<PathBuf, CachedTail>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Read a .jsonl session file in a single pass, extracting everything
/// `list_sessions` needs: the first N non-empty lines, the last N non-empty
/// lines, and the count of `type:"assistant"` entries. Replaces three
/// separate full-file reads.
fn scan_session_tail(path: &Path, first_n: usize, last_n: usize) -> CachedTail {
    let mtime_ms_v = mtime_ms(path);
    let size_bytes = file_size(path);
    let Ok(text) = std::fs::read_to_string(path) else {
        return CachedTail {
            mtime_ms: mtime_ms_v,
            size_bytes,
            first_lines: vec![],
            last_lines: vec![],
            turn_count: 0,
            last_user_preview: None,
        };
    };
    let mut first_lines: Vec<String> = Vec::with_capacity(first_n);
    let mut tail: std::collections::VecDeque<String> =
        std::collections::VecDeque::with_capacity(last_n);
    let mut turn_count = 0usize;
    let mut last_user_preview: Option<String> = None;
    for raw in text.lines().filter(|l| !l.trim().is_empty()) {
        if first_lines.len() < first_n {
            first_lines.push(raw.to_string());
        }
        if tail.len() == last_n {
            tail.pop_front();
        }
        tail.push_back(raw.to_string());
        // Single-parse-per-line: update turn_count AND last_user_preview
        // from the same deserialized value.
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
            if v.get("type").and_then(|x| x.as_str()) == Some("assistant") {
                turn_count += 1;
            } else if let Some(ask) = extract_real_user_ask(&v) {
                last_user_preview = Some(ask);
            }
        }
    }
    CachedTail {
        mtime_ms: mtime_ms_v,
        size_bytes,
        first_lines,
        last_lines: tail.into_iter().collect(),
        turn_count,
        last_user_preview,
    }
}

/// Cached variant: only re-scans the file when mtime or size changes.
fn cached_tail(path: &Path, first_n: usize, last_n: usize) -> CachedTail {
    let cur_mtime = mtime_ms(path);
    let cur_size = file_size(path);
    {
        let cache = TAIL_CACHE.lock().unwrap();
        if let Some(c) = cache.get(path) {
            if c.mtime_ms == cur_mtime
                && c.size_bytes == cur_size
                && c.first_lines.len() >= first_n.min(c.first_lines.len())
                && c.last_lines.len() >= last_n.min(c.last_lines.len())
            {
                return c.clone();
            }
        }
    }
    let fresh = scan_session_tail(path, first_n, last_n);
    TAIL_CACHE
        .lock()
        .unwrap()
        .insert(path.to_path_buf(), fresh.clone());
    fresh
}

/// The user-level directory where Claude Code stores project session transcripts.
pub fn claude_projects_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("projects")
}

/// `~/.claude/sessions/<pid>.json` — Claude Code writes one of these per
/// running interactive session, recording {pid, sessionId, cwd, startedAt}.
fn claude_sessions_state_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("sessions")
}

#[derive(Debug, Clone)]
struct LiveSession {
    pid: u32,
    cwd: String,
}

/// Returns a map sessionId → LiveSession for every claude interactive session
/// currently alive on this machine. Filters out stale state files whose PID
/// no longer exists. Authoritative for "is this .jsonl actively owned" —
/// supersedes earlier mtime/heuristic guessing.
fn read_live_session_map() -> HashMap<String, LiveSession> {
    let mut out: HashMap<String, LiveSession> = HashMap::new();
    let dir = claude_sessions_state_dir();
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return out;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let Some(pid) = v.get("pid").and_then(|x| x.as_u64()).map(|n| n as u32) else {
            continue;
        };
        let Some(session_id) = v.get("sessionId").and_then(|x| x.as_str()).map(String::from)
        else {
            continue;
        };
        let cwd = v
            .get("cwd")
            .and_then(|x| x.as_str())
            .map(String::from)
            .unwrap_or_default();
        if !pid_alive(pid) {
            // Stale leftover file — claude crashed without cleanup. Skip.
            continue;
        }
        out.insert(session_id, LiveSession { pid, cwd });
    }
    out
}

/// `kill -0 <pid>` returns 0 if the process exists and we can signal it.
/// Doesn't actually deliver a signal.
fn pid_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[derive(Serialize, Default, Clone)]
pub struct StatusCounts {
    pub live: usize,
    pub done: usize,
    pub errored: usize,
    pub idle: usize,
}

#[derive(Serialize)]
pub struct ProjectInfo {
    pub key: String,
    pub cwd: String,
    pub name: String,
    pub session_count: usize,
    pub last_modified_ms: u64,
    pub status_counts: StatusCounts,
    pub is_orka: bool,
}

/// Is this project's cwd an Orka-generated artifact?
/// Covers:
///   - Anything under `~/OrkaCanvas/` (user-visible workspaces + node workdirs)
///   - Cargo-test tmp dirs we create (`orka-spawn-test-*`, `orka-test-*`, `orka-kb-*`, etc.)
fn is_orka_cwd(cwd: &str) -> bool {
    if cwd.contains("/OrkaCanvas/") {
        return true;
    }
    if let Some(home) = dirs::home_dir() {
        let orka_root = home.join("OrkaCanvas");
        if let Ok(root_str) = orka_root.into_os_string().into_string() {
            if cwd.starts_with(&root_str) {
                return true;
            }
        }
    }
    let basename = std::path::Path::new(cwd)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    basename.starts_with("orka-spawn-test-")
        || basename.starts_with("orka-test-")
        || basename.starts_with("orka-kb-")
        || basename.starts_with("orka-graph-")
        || basename.starts_with("orka-ensure-")
        || cwd.contains("/orka-spawn-test-")
        || cwd.contains("/orka-test-")
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Live,
    Done,
    Errored,
    Idle,
}

#[derive(Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub path: String,
    pub project_key: String,
    pub project_cwd: String,
    pub modified_ms: u64,
    pub size_bytes: u64,
    pub first_user_preview: Option<String>,
    pub last_message_preview: Option<String>,
    /// Preview of the most recent *real* user ask (filters tool_results,
    /// `/command` wrappers, and meta lines). In long sessions this beats
    /// `first_user_preview` for "what am I actually reviewing".
    pub last_user_preview: Option<String>,
    pub status: SessionStatus,
    pub turn_count: usize,
    /// True when the last JSONL entry is an `assistant` message that contains
    /// a text block (i.e. Claude has finished a turn and is waiting for user
    /// input, not mid-generation / mid-tool-call). Only meaningful alongside
    /// `status == Live`.
    pub awaiting_user: bool,
}

#[derive(Serialize, Clone)]
pub struct SessionLine {
    pub line_no: usize,
    pub role: String,
    pub text: String,
    pub session_id: Option<String>,
    pub uuid: Option<String>,
}

fn decode_project_key(key: &str) -> String {
    // Lossy fallback: Claude encodes `/` as `-`. We can't perfectly recover paths
    // that originally contained hyphens. Use `read_cwd_from_session` when possible.
    if key.starts_with('-') {
        let mut s = key.replacen('-', "/", 1);
        s = s.replace('-', "/");
        s
    } else {
        key.to_string()
    }
}

/// Read the first JSONL line of any session in a project dir to recover the real cwd.
/// Each session has `{"type":"system","subtype":"init","cwd":"...","sessionId":"..."}` as the first line.
fn read_cwd_from_session(project_dir: &Path) -> Option<String> {
    let rd = std::fs::read_dir(project_dir).ok()?;
    for entry in rd.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else {
            continue;
        };
        for line in text.lines().take(3) {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            if let Some(cwd) = v.get("cwd").and_then(|x| x.as_str()) {
                if !cwd.is_empty() {
                    return Some(cwd.to_string());
                }
            }
        }
    }
    None
}

fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn file_size(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// Extract a short human-readable text preview from a single JSONL line.
fn preview_from_line(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let t = v.get("type")?.as_str()?;
    match t {
        "user" | "assistant" => {
            let content = v.get("message")?.get("content");
            if let Some(arr) = content.and_then(|c| c.as_array()) {
                // join all text blocks
                let mut out = String::new();
                for b in arr {
                    if b.get("type").and_then(|x| x.as_str()) == Some("text") {
                        if let Some(s) = b.get("text").and_then(|x| x.as_str()) {
                            if !out.is_empty() {
                                out.push(' ');
                            }
                            out.push_str(s);
                        }
                    } else if b.get("type").and_then(|x| x.as_str()) == Some("tool_use") {
                        if let Some(n) = b.get("name").and_then(|x| x.as_str()) {
                            if !out.is_empty() {
                                out.push(' ');
                            }
                            out.push_str(&format!("[tool: {}]", n));
                        }
                    } else if b.get("type").and_then(|x| x.as_str()) == Some("tool_result") {
                        if !out.is_empty() {
                            out.push(' ');
                        }
                        out.push_str("[tool result]");
                    }
                }
                if out.is_empty() {
                    None
                } else {
                    Some(truncate(&out, 160))
                }
            } else if let Some(s) = content.and_then(|c| c.as_str()) {
                Some(truncate(s, 160))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn truncate(s: &str, max: usize) -> String {
    let trimmed = s.trim().replace('\n', " ");
    if trimmed.chars().count() <= max {
        trimmed
    } else {
        let mut out: String = trimmed.chars().take(max).collect();
        out.push('…');
        out
    }
}

/// Read the first N non-empty lines of a file cheaply.
/// Check whether the session is currently waiting for user input.
///
/// Claude Code's JSONL file contains several "types" of lines; only
/// `user` and `assistant` carry conversational turn state. Bookkeeping lines
/// such as `file-history-snapshot`, `system`, and `result` can appear AFTER
/// the last real turn — so we walk backwards until we find the most recent
/// conversational message, then:
///   - `assistant` whose *last* content block is `text`  → awaiting user
///   - anything else (tool_use-ending assistant, user message, missing)  → generating
///
/// Each content block (thinking / text / tool_use) is written as its own
/// JSONL line, so checking "last block of last conversational assistant line"
/// is the correct turn-ending signal.
fn awaiting_user_input(last_lines: &[String]) -> bool {
    for raw in last_lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
            continue;
        };
        let Some(t) = v.get("type").and_then(|x| x.as_str()) else {
            continue;
        };
        match t {
            "assistant" => {
                let Some(arr) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                else {
                    return false;
                };
                let last_block_type = arr
                    .last()
                    .and_then(|b| b.get("type"))
                    .and_then(|t| t.as_str());
                return last_block_type == Some("text");
            }
            "user" => return false,
            // Bookkeeping lines — skip and keep walking back.
            _ => continue,
        }
    }
    false
}

/// Read the last N non-empty lines.
fn read_last_lines(path: &Path, n: usize) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return vec![];
    };
    let all: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    all.iter()
        .rev()
        .take(n)
        .rev()
        .map(|s| s.to_string())
        .collect()
}

pub fn list_projects() -> Vec<ProjectInfo> {
    let root = claude_projects_root();
    let Ok(rd) = std::fs::read_dir(&root) else {
        return vec![];
    };
    let live_sessions = read_live_session_map();
    let mut out: Vec<ProjectInfo> = vec![];
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(key) = path.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()) else {
            continue;
        };
        let cwd = read_cwd_from_session(&path).unwrap_or_else(|| decode_project_key(&key));
        let name = Path::new(&cwd)
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| cwd.clone());

        // Gather session paths + mtimes first so we can mark the newest one Live
        // when a claude process is cwd'd to this project.
        let mut sessions_here: Vec<(PathBuf, u64)> = vec![];
        if let Ok(child_rd) = std::fs::read_dir(&path) {
            for f in child_rd.flatten() {
                let p = f.path();
                if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    let m = mtime_ms(&p);
                    sessions_here.push((p, m));
                }
            }
        }
        if sessions_here.is_empty() {
            continue;
        }
        let session_count = sessions_here.len();
        let newest_mtime = sessions_here.iter().map(|(_, m)| *m).max().unwrap_or(0);

        let mut status_counts = StatusCounts::default();
        for (p, m) in &sessions_here {
            let session_id = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let is_live = live_sessions.contains_key(session_id);
            let tail = cached_tail(p, 6, 20);
            match classify_status_from_tail(&tail.last_lines, *m, is_live) {
                SessionStatus::Live => status_counts.live += 1,
                SessionStatus::Done => status_counts.done += 1,
                SessionStatus::Errored => status_counts.errored += 1,
                SessionStatus::Idle => status_counts.idle += 1,
            }
        }

        let is_orka = is_orka_cwd(&cwd);
        out.push(ProjectInfo {
            key,
            cwd,
            name,
            session_count,
            last_modified_ms: newest_mtime,
            status_counts,
            is_orka,
        });
    }
    out.sort_by(|a, b| b.last_modified_ms.cmp(&a.last_modified_ms));
    out
}

/// Classify a session. User's model:
///   Live = claude REPL is still running (process alive, cwd matches, newest session)
///   Done = user exited claude (no process)
///   Errored = an Orka `-p` run produced is_error=true
fn classify_status_with_live(
    path: &Path,
    mtime_ms: u64,
    is_live: bool,
) -> SessionStatus {
    let tail = read_last_lines(path, 20);
    classify_status_from_tail(&tail, mtime_ms, is_live)
}

/// Like `classify_status_with_live` but uses pre-read tail lines to avoid
/// re-reading the file. Call this from the cached `list_sessions` path.
fn classify_status_from_tail(
    tail: &[String],
    _mtime_ms: u64,
    is_live: bool,
) -> SessionStatus {
    // Errored only applies to Orka's own `-p` runs which emit a result line.
    for raw in tail.iter().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
            continue;
        };
        if v.get("type").and_then(|x| x.as_str()) == Some("result") {
            let is_error = v
                .get("is_error")
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            if is_error {
                return SessionStatus::Errored;
            }
            // A successful result event from an Orka run → Done (no running process anyway)
            return SessionStatus::Done;
        }
    }
    if is_live {
        SessionStatus::Live
    } else {
        SessionStatus::Done
    }
}


pub fn list_sessions(project_key: &str) -> Vec<SessionInfo> {
    let dir = claude_projects_root().join(project_key);
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return vec![];
    };
    let cwd =
        read_cwd_from_session(&dir).unwrap_or_else(|| decode_project_key(project_key));
    // Authoritative: ~/.claude/sessions/<PID>.json maps every running claude
    // process to its exact sessionId. We mark a session Live iff its id is
    // in this map — no mtime guessing, no "newest in cwd" heuristic.
    let live_sessions = read_live_session_map();
    let mut out: Vec<SessionInfo> = vec![];
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(id) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
        else {
            continue;
        };

        let tail = cached_tail(&path, 6, 20);
        let first_user_preview = tail.first_lines.iter().find_map(|l| preview_from_line(l));
        let last_message_preview = tail
            .last_lines
            .iter()
            .rev()
            .find_map(|l| preview_from_line(l));
        let awaiting_user = awaiting_user_input(&tail.last_lines);
        let is_live = live_sessions.contains_key(&id);
        let status = classify_status_from_tail(&tail.last_lines, tail.mtime_ms, is_live);

        out.push(SessionInfo {
            id,
            path: path.to_string_lossy().to_string(),
            project_key: project_key.to_string(),
            project_cwd: cwd.clone(),
            modified_ms: tail.mtime_ms,
            size_bytes: tail.size_bytes,
            first_user_preview,
            last_message_preview,
            last_user_preview: tail.last_user_preview.clone(),
            status,
            turn_count: tail.turn_count,
            awaiting_user,
        });
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    out
}

pub fn parse_raw_line(raw: &str, line_no: usize) -> Option<SessionLine> {
    if raw.trim().is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("unknown");
    let session_id = v
        .get("sessionId")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let uuid = v
        .get("uuid")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let text = preview_from_line(raw).unwrap_or_default();
    if text.is_empty() && !matches!(t, "user" | "assistant") {
        return None;
    }
    Some(SessionLine {
        line_no,
        role: t.to_string(),
        text,
        session_id,
        uuid,
    })
}

pub fn read_session(path: &str) -> Vec<SessionLine> {
    let p = Path::new(path);
    let Ok(text) = std::fs::read_to_string(p) else {
        return vec![];
    };
    text.lines()
        .enumerate()
        .filter_map(|(i, raw)| parse_raw_line(raw, i))
        .collect()
}

/// Start a polling tail on `path`, emitting new lines as `session:<node_id>:append`.
/// No-op if already watching this node_id.
pub fn watch_session(app: AppHandle, node_id: String, path: String) {
    {
        let w = WATCHERS.lock().unwrap();
        if w.contains_key(&node_id) {
            return;
        }
    }
    let event_name = format!("session:{}:append", node_id);
    let handle = async_runtime::spawn(async move {
        let mut offset: u64 = match tokio::fs::metadata(&path).await {
            Ok(m) => m.len(),
            Err(_) => 0,
        };
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let current = match tokio::fs::metadata(&path).await {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            if current <= offset {
                continue;
            }
            use tokio::io::{AsyncReadExt, AsyncSeekExt};
            let mut f = match tokio::fs::File::open(&path).await {
                Ok(f) => f,
                Err(_) => continue,
            };
            if f.seek(std::io::SeekFrom::Start(offset)).await.is_err() {
                continue;
            }
            let mut buf = String::new();
            if f.read_to_string(&mut buf).await.is_err() {
                continue;
            }
            offset = current;
            let lines: Vec<SessionLine> = buf
                .lines()
                .enumerate()
                .filter_map(|(i, raw)| parse_raw_line(raw, i))
                .collect();
            if !lines.is_empty() {
                let _ = app.emit(&event_name, lines);
            }
        }
    });
    WATCHERS.lock().unwrap().insert(node_id, handle);
}

pub fn unwatch_session(node_id: &str) {
    if let Some(h) = WATCHERS.lock().unwrap().remove(node_id) {
        h.abort();
    }
}

// ---- global watcher for ~/.claude/projects/ -----------------------------------

static PROJECTS_WATCHER_STARTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Start a recursive fs watcher on ~/.claude/projects. Emits a debounced
/// `sessions:changed` event whenever any file in the tree changes. Idempotent.
pub fn start_projects_watcher(app: AppHandle) {
    use std::sync::atomic::Ordering;
    if PROJECTS_WATCHER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let root = claude_projects_root();
    if !root.exists() {
        return;
    }

    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = match notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    }) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("projects watcher init failed: {e}");
            return;
        }
    };

    use notify::Watcher;
    if let Err(e) = watcher.watch(&root, notify::RecursiveMode::Recursive) {
        eprintln!("projects watcher watch failed: {e}");
        return;
    }

    // Move both the watcher and the rx into a dedicated thread so the watcher stays alive.
    std::thread::spawn(move || {
        let _keepalive = watcher; // keep the watcher alive for this thread's lifetime
        let mut last_emit = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_secs(10))
            .unwrap_or_else(std::time::Instant::now);
        loop {
            let Ok(_) = rx.recv() else { break };
            // Coalesce bursts: wait up to 250ms for more events, then emit once.
            while rx.recv_timeout(std::time::Duration::from_millis(250)).is_ok() {}
            if last_emit.elapsed() < std::time::Duration::from_millis(400) {
                continue;
            }
            last_emit = std::time::Instant::now();
            let _ = app.emit("sessions:changed", ());
        }
    });
}

/// Locate the PID of a running `claude` process whose cwd matches `target_cwd`.
/// Reads `~/.claude/sessions/*.json` (which Claude Code maintains) — way
/// faster and more accurate than ps + lsof scanning.
fn find_claude_pid_for_cwd(target_cwd: &str) -> Option<u32> {
    read_live_session_map()
        .into_values()
        .find(|s| s.cwd == target_cwd)
        .map(|s| s.pid)
}

/// Get the (ppid, comm) for a given pid via `ps`.
fn parent_of_pid(pid: u32) -> Option<(u32, String)> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "ppid=,comm="])
        .output()
        .ok()?;
    let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let mut parts = line.splitn(2, char::is_whitespace);
    let ppid: u32 = parts.next()?.trim().parse().ok()?;
    let comm = parts.next().unwrap_or("").trim().to_string();
    Some((ppid, comm))
}

/// Extract the outermost `.app` bundle path from a process's `comm` string.
/// `/Users/.../Visual Studio Code 2.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper`
/// → `/Users/.../Visual Studio Code 2.app`
fn extract_app_bundle(comm: &str) -> Option<String> {
    // Use FIRST `.app/` so we get the outer bundle, not any nested helper bundle.
    let idx = comm.find(".app/")?;
    Some(comm[..idx + ".app".len()].to_string())
}

/// Walk up ancestors of `pid` looking for a process whose `comm` contains an
/// absolute `.app` bundle path. Returns that bundle path. Covers VSCode
/// (including renamed copies like "Visual Studio Code 2.app"), Cursor, Warp,
/// Electron-based terminals, and any GUI-hosted claude.
fn find_app_bundle_in_ancestors(pid: u32) -> Option<String> {
    let mut cur = pid;
    for _ in 0..20 {
        let (ppid, comm) = parent_of_pid(cur)?;
        if ppid <= 1 {
            break;
        }
        if let Some(bundle) = extract_app_bundle(&comm) {
            return Some(bundle);
        }
        cur = ppid;
    }
    None
}

/// Look up the controlling TTY for a given PID via `ps -p PID -o tty=`.
/// Returns a full path like `/dev/ttys001`, or None.
fn tty_of_pid(pid: u32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "tty="])
        .output()
        .ok()?;
    let tty = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if tty.is_empty() || tty == "??" {
        return None;
    }
    if tty.starts_with("/dev/") {
        Some(tty)
    } else {
        Some(format!("/dev/{tty}"))
    }
}

#[cfg(target_os = "macos")]
fn run_applescript(script: &str) -> Option<String> {
    let out = std::process::Command::new("osascript")
        .args(["-e", script])
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Focus the terminal window/tab that owns the given tty. Tries Terminal.app,
/// then iTerm2. Returns the name of the app we successfully focused, or an
/// error message.
#[cfg(target_os = "macos")]
fn focus_terminal_tab_by_tty(tty: &str) -> Result<String, String> {
    // Terminal.app
    let tapp_script = format!(
        r#"tell application "Terminal"
    activate
    repeat with w in windows
        repeat with t in tabs of w
            if tty of t is "{tty}" then
                set selected of t to true
                set index of w to 1
                return "ok"
            end if
        end repeat
    end repeat
    return "not-found"
end tell"#
    );
    if let Some(r) = run_applescript(&tapp_script) {
        if r == "ok" {
            return Ok("Terminal".into());
        }
    }
    // iTerm2
    let iterm_script = format!(
        r#"tell application "iTerm2"
    repeat with w in windows
        repeat with t in tabs of w
            repeat with s in sessions of t
                if tty of s is "{tty}" then
                    select t
                    activate
                    return "ok"
                end if
            end repeat
        end repeat
    end repeat
    return "not-found"
end tell"#
    );
    if let Some(r) = run_applescript(&iterm_script) {
        if r == "ok" {
            return Ok("iTerm2".into());
        }
    }
    Err(format!("no terminal window found for {tty}"))
}

/// Best-effort: bring the user back to the terminal running this session.
/// Returns a human-readable message on success, or an error.
///
/// Strategy (in order):
///   1. Resolve claude's TTY. If Terminal.app or iTerm2 has a tab bound to
///      that TTY, focus that specific tab.
///   2. Otherwise walk claude's ancestor processes looking for a known
///      terminal host (VSCode, Cursor, Warp, WezTerm, Alacritty, kitty, ...)
///      and activate that app. The user still has to find the tab manually
///      but at least the window comes forward.
pub fn focus_session_terminal(session_path: &str) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = session_path;
        return Err("focus_session_terminal only supported on macOS".into());
    }
    #[cfg(target_os = "macos")]
    {
        let path = Path::new(session_path);
        let project_dir = path.parent().ok_or("invalid session path")?;
        let cwd = read_cwd_from_session(project_dir)
            .ok_or_else(|| "could not determine session cwd".to_string())?;
        let pid = find_claude_pid_for_cwd(&cwd)
            .ok_or_else(|| format!("no running claude process in {cwd}"))?;

        // Strategy 1: exact tab focus by TTY (Terminal.app / iTerm2).
        if let Some(tty) = tty_of_pid(pid) {
            if let Ok(app) = focus_terminal_tab_by_tty(&tty) {
                return Ok(format!("focused {app} · {tty}"));
            }
        }

        // Strategy 2: find the .app bundle of the ancestor GUI process
        // (VSCode / Cursor / Electron-based terminal / etc.) and activate it
        // with the session cwd as an argument. For folder-aware apps (VSCode,
        // Cursor, etc.) this focuses the existing window that already has
        // this project open — distinguishing between multiple sessions
        // running across different projects. Same-project / different-pane
        // still needs manual switching (no public API to target a terminal
        // pane from outside).
        if let Some(bundle) = find_app_bundle_in_ancestors(pid) {
            let status = std::process::Command::new("open")
                .args(["-a", &bundle, &cwd])
                .status();
            if status.map(|s| s.success()).unwrap_or(false) {
                let name = Path::new(&bundle)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("app");
                return Ok(format!("activated {name} window for {cwd}"));
            }
        }

        Err(format!(
            "could not identify terminal host for claude pid {pid} in {cwd}"
        ))
    }
}

/// Diagnostic dump of what Orka's status logic sees for a given session file.
/// Exposed as a Tauri command so the UI (or a devtools console invocation)
/// can quickly check why a card is in the "wrong" state.
#[derive(Serialize)]
pub struct SessionDebug {
    pub path: String,
    pub mtime_ms: u64,
    pub mtime_age_sec: u64,
    pub total_lines: usize,
    pub status: SessionStatus,
    pub awaiting_user: bool,
    pub last_lines_summary: Vec<String>,
}

pub fn debug_session(path_str: &str) -> SessionDebug {
    let path = Path::new(path_str);
    let mtime = mtime_ms(path);
    let now_ms = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let total_lines = std::fs::read_to_string(path)
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count())
        .unwrap_or(0);
    let last_lines = read_last_lines(path, 12);
    let awaiting = awaiting_user_input(&last_lines);
    let status = classify_status_with_live(path, mtime, true);
    // Summarize each tail line: "type [block_types...]" / "type -"
    let summary: Vec<String> = last_lines
        .iter()
        .map(|raw| {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
                return "<malformed>".into();
            };
            let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("?");
            let blocks: Vec<String> = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .map(|arr| {
                    arr.iter()
                        .map(|b| {
                            b.get("type")
                                .and_then(|x| x.as_str())
                                .unwrap_or("?")
                                .to_string()
                        })
                        .collect()
                })
                .unwrap_or_default();
            if blocks.is_empty() {
                format!("{t}  -")
            } else {
                format!("{t}  [{}]", blocks.join(", "))
            }
        })
        .collect();
    SessionDebug {
        path: path_str.to_string(),
        mtime_ms: mtime,
        mtime_age_sec: now_ms.saturating_sub(mtime) / 1000,
        total_lines,
        status,
        awaiting_user: awaiting,
        last_lines_summary: summary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_simple_key() {
        assert_eq!(
            decode_project_key("-Users-alice-Projects-demo-app"),
            "/Users/alice/Projects/demo/app"
        );
    }

    #[test]
    fn truncate_respects_chars_not_bytes() {
        assert_eq!(truncate("hello world", 5), "hello…");
        assert_eq!(truncate("abc", 10), "abc");
    }

    #[test]
    fn preview_extracts_assistant_text() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}"#;
        assert_eq!(preview_from_line(line), Some("Hello".into()));
    }

    #[test]
    fn preview_extracts_user_text() {
        let line =
            r#"{"type":"user","message":{"content":[{"type":"text","text":"hi there"}]}}"#;
        assert_eq!(preview_from_line(line), Some("hi there".into()));
    }

    #[test]
    fn preview_returns_none_for_system_init() {
        let line = r#"{"type":"system","subtype":"init","session_id":"x"}"#;
        assert_eq!(preview_from_line(line), None);
    }

    #[test]
    fn preview_handles_tool_use_block() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{}}]}}"#;
        assert_eq!(preview_from_line(line), Some("[tool: Bash]".into()));
    }

    #[test]
    fn parse_raw_line_matches_read_session_shape() {
        let raw = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]},"sessionId":"s1","uuid":"u1"}"#;
        let line = parse_raw_line(raw, 0).unwrap();
        assert_eq!(line.role, "assistant");
        assert_eq!(line.text, "hi");
        assert_eq!(line.session_id.as_deref(), Some("s1"));
    }

    #[test]
    fn list_projects_returns_something_on_this_machine() {
        let projects = list_projects();
        // Not an assertion about count (could be 0 on CI), just that it doesn't panic.
        let _ = projects.len();
    }

    // ---- awaiting_user_input: Monitor "FOR REVIEW" detection ----
    // Harness covers every terminal-block shape the Claude Code JSONL can have.
    // Each input is a Vec<String> mirroring the arg shape `read_last_lines`
    // returns (chronological order; `.last()` is the most recent line).

    fn line_assistant_text(text: &str) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":{}}}]}}}}"#,
            serde_json::to_string(text).unwrap()
        )
    }
    fn line_assistant_blocks(block_types: &[&str]) -> String {
        let blocks: Vec<String> = block_types
            .iter()
            .map(|t| match *t {
                "text" => r#"{"type":"text","text":"x"}"#.into(),
                "thinking" => r#"{"type":"thinking","thinking":""}"#.into(),
                "tool_use" => r#"{"type":"tool_use","name":"Bash","input":{}}"#.into(),
                _ => unreachable!(),
            })
            .collect();
        format!(
            r#"{{"type":"assistant","message":{{"content":[{}]}}}}"#,
            blocks.join(",")
        )
    }
    fn line_user_text(text: &str) -> String {
        format!(
            r#"{{"type":"user","message":{{"content":[{{"type":"text","text":{}}}]}}}}"#,
            serde_json::to_string(text).unwrap()
        )
    }
    fn line_user_tool_result() -> String {
        r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#.into()
    }
    fn line_file_history_snapshot() -> String {
        r#"{"type":"file-history-snapshot","timestamp":"2026-04-12T00:00:00Z"}"#.into()
    }
    fn line_system_init() -> String {
        r#"{"type":"system","subtype":"init","session_id":"s"}"#.into()
    }

    #[test]
    fn awaiting_single_assistant_text_is_true() {
        let lines = vec![line_assistant_text("hello")];
        assert!(awaiting_user_input(&lines));
    }

    #[test]
    fn awaiting_assistant_thinking_then_text_is_true() {
        let lines = vec![line_assistant_blocks(&["thinking", "text"])];
        assert!(awaiting_user_input(&lines));
    }

    #[test]
    fn awaiting_assistant_text_then_tool_use_is_false() {
        // preamble text + tool call in same content array → still working
        let lines = vec![line_assistant_blocks(&["text", "tool_use"])];
        assert!(!awaiting_user_input(&lines));
    }

    #[test]
    fn awaiting_assistant_thinking_only_is_false() {
        // block-per-line split: bare thinking, text hasn't been written yet
        let lines = vec![line_assistant_blocks(&["thinking"])];
        assert!(!awaiting_user_input(&lines));
    }

    #[test]
    fn awaiting_assistant_tool_use_is_false() {
        let lines = vec![line_assistant_blocks(&["tool_use"])];
        assert!(!awaiting_user_input(&lines));
    }

    #[test]
    fn awaiting_last_is_user_text_is_false() {
        // user just typed → claude generating
        let lines = vec![line_assistant_text("previous"), line_user_text("next prompt")];
        assert!(!awaiting_user_input(&lines));
    }

    #[test]
    fn awaiting_last_is_tool_result_is_false() {
        let lines = vec![
            line_assistant_blocks(&["tool_use"]),
            line_user_tool_result(),
        ];
        assert!(!awaiting_user_input(&lines));
    }

    #[test]
    fn awaiting_skips_file_history_snapshot_and_finds_assistant_text() {
        // Real-world shape — Orka was missing this case.
        let lines = vec![
            line_user_text("previous prompt"),
            line_assistant_blocks(&["thinking"]),
            line_assistant_text("here is my final answer"),
            line_file_history_snapshot(),
        ];
        assert!(awaiting_user_input(&lines));
    }

    #[test]
    fn awaiting_skips_multiple_bookkeeping_lines() {
        let lines = vec![
            line_assistant_text("done."),
            line_file_history_snapshot(),
            line_system_init(),
            line_file_history_snapshot(),
        ];
        assert!(awaiting_user_input(&lines));
    }

    #[test]
    fn awaiting_skips_snapshot_then_finds_user_is_false() {
        // User's current state in the wild: user just sent a message,
        // snapshot follows, claude hasn't started yet.
        let lines = vec![
            line_assistant_text("previous answer"),
            line_user_text("new question"),
            line_file_history_snapshot(),
        ];
        assert!(!awaiting_user_input(&lines));
    }

    #[test]
    fn awaiting_empty_is_false() {
        assert!(!awaiting_user_input(&[]));
    }

    #[test]
    fn extract_app_bundle_vscode_renamed() {
        let comm = "/Users/x/Desktop/Visual Studio Code 2.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper";
        assert_eq!(
            extract_app_bundle(comm).as_deref(),
            Some("/Users/x/Desktop/Visual Studio Code 2.app")
        );
    }

    #[test]
    fn extract_app_bundle_vscode_electron_main() {
        let comm = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
        assert_eq!(
            extract_app_bundle(comm).as_deref(),
            Some("/Applications/Visual Studio Code.app")
        );
    }

    #[test]
    fn extract_app_bundle_cursor() {
        let comm = "/Applications/Cursor.app/Contents/MacOS/Cursor";
        assert_eq!(
            extract_app_bundle(comm).as_deref(),
            Some("/Applications/Cursor.app")
        );
    }

    // ---- extract_real_user_ask ----

    fn parse(raw: &str) -> serde_json::Value {
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn real_ask_plain_string_content() {
        let v = parse(r#"{"type":"user","message":{"role":"user","content":"hello"}}"#);
        assert_eq!(extract_real_user_ask(&v).as_deref(), Some("hello"));
    }

    #[test]
    fn real_ask_text_block_array() {
        let v = parse(
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"fix bug X"}]}}"#,
        );
        assert_eq!(extract_real_user_ask(&v).as_deref(), Some("fix bug X"));
    }

    #[test]
    fn real_ask_with_image_block_keeps_text() {
        let v = parse(
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"see screenshot"},{"type":"image","source":{"type":"base64","data":"abc"}}]}}"#,
        );
        assert_eq!(extract_real_user_ask(&v).as_deref(), Some("see screenshot"));
    }

    #[test]
    fn real_ask_image_only_returns_placeholder() {
        let v = parse(
            r#"{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","data":"abc"}}]}}"#,
        );
        assert_eq!(extract_real_user_ask(&v).as_deref(), Some("[image]"));
    }

    #[test]
    fn real_ask_skips_tool_result_block() {
        let v = parse(
            r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t1","type":"tool_result","content":"ok"}]}}"#,
        );
        assert!(extract_real_user_ask(&v).is_none());
    }

    #[test]
    fn real_ask_skips_source_tool_assistant_uuid() {
        let v = parse(
            r#"{"type":"user","sourceToolAssistantUUID":"abc","message":{"role":"user","content":"ignored"}}"#,
        );
        assert!(extract_real_user_ask(&v).is_none());
    }

    #[test]
    fn real_ask_skips_tool_use_result_top_level() {
        let v = parse(
            r#"{"type":"user","toolUseResult":{"stdout":"x"},"message":{"role":"user","content":"ignored"}}"#,
        );
        assert!(extract_real_user_ask(&v).is_none());
    }

    #[test]
    fn real_ask_skips_is_meta() {
        let v = parse(
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<command-name>/clear</command-name>"}}"#,
        );
        assert!(extract_real_user_ask(&v).is_none());
    }

    #[test]
    fn real_ask_skips_local_command_wrapper_text() {
        let v = parse(
            r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout>Goodbye</local-command-stdout>"}}"#,
        );
        assert!(extract_real_user_ask(&v).is_none());
    }

    #[test]
    fn real_ask_returns_none_for_assistant_type() {
        let v = parse(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#);
        assert!(extract_real_user_ask(&v).is_none());
    }

    #[test]
    fn extract_app_bundle_none_for_plain_comm() {
        assert_eq!(extract_app_bundle("claude"), None);
        assert_eq!(extract_app_bundle("/bin/zsh"), None);
        assert_eq!(extract_app_bundle(""), None);
    }

    #[test]
    fn awaiting_ignores_malformed_json() {
        let lines = vec![
            line_assistant_text("final"),
            "not-json-garbage".into(),
            line_file_history_snapshot(),
        ];
        assert!(awaiting_user_input(&lines));
    }
}
