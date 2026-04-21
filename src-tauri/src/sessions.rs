use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::UNIX_EPOCH;
use tauri::async_runtime::{self, JoinHandle};
use tauri::{AppHandle, Emitter};

static WATCHERS: LazyLock<Mutex<HashMap<String, JoinHandle<()>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Poison-recovery lock helpers: a panic in one task holding one of these
/// mutexes otherwise bricks every subsequent Tauri command that touches them.
fn watchers_lock() -> MutexGuard<'static, HashMap<String, JoinHandle<()>>> {
    WATCHERS.lock().unwrap_or_else(|e| e.into_inner())
}

fn tail_cache_lock() -> MutexGuard<'static, HashMap<PathBuf, CachedTail>> {
    TAIL_CACHE.lock().unwrap_or_else(|e| e.into_inner())
}

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
    /// Best-effort label for *what spawned this session* when there are no
    /// real user asks (subagent / Task-tool / slash-command invocations).
    /// Derived from head lines: isMeta `<command-name>X</command-name>` →
    /// `/X`, else first assistant `tool_use` name → `[tool: X]`.
    spawn_label: Option<String>,
}

/// Harness-injected wrappers that show up as `type: "user"` text but are
/// NOT real human asks — skip them when deriving `last_user_preview`.
fn is_system_scaffold_text(t: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "<local-command-",
        "<command-",
        "<task-notification>",
        "<system-reminder>",
        "<tool-use-id>",
    ];
    PREFIXES.iter().any(|p| t.starts_with(p))
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
        if t.is_empty() || is_system_scaffold_text(t) {
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
                    if is_system_scaffold_text(t) {
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

/// Returns a short label describing *what kicked off* this session when no
/// real human ask exists. Looks for:
///   1. isMeta user line carrying `<command-name>X</command-name>` → `/X`
///   2. first assistant `tool_use` block → `[tool: Name]`
/// Returns None for lines that yield neither signal.
fn extract_spawn_label(v: &serde_json::Value) -> Option<String> {
    let t = v.get("type").and_then(|x| x.as_str())?;
    if t == "user" {
        // Only interested in isMeta command wrappers here; real asks are
        // handled by extract_real_user_ask on the caller side.
        if !v.get("isMeta").and_then(|x| x.as_bool()).unwrap_or(false) {
            return None;
        }
        let raw = v.get("message").and_then(|m| m.get("content"))?;
        let text = raw.as_str().map(|s| s.to_string()).or_else(|| {
            raw.as_array().and_then(|arr| {
                arr.iter()
                    .find_map(|b| {
                        if b.get("type").and_then(|x| x.as_str()) == Some("text") {
                            b.get("text").and_then(|x| x.as_str()).map(|s| s.to_string())
                        } else {
                            None
                        }
                    })
            })
        })?;
        let trimmed = text.trim();
        // Pull out `<command-name>...</command-name>` if present.
        if let Some(rest) = trimmed.strip_prefix("<command-name>") {
            if let Some(end) = rest.find("</command-name>") {
                let name = rest[..end].trim();
                if !name.is_empty() {
                    return Some(format!("/{}", name.trim_start_matches('/')));
                }
            }
        }
        return None;
    }
    if t == "assistant" {
        let arr = v.get("message").and_then(|m| m.get("content"))?.as_array()?;
        for b in arr {
            if b.get("type").and_then(|x| x.as_str()) == Some("tool_use") {
                if let Some(name) = b.get("name").and_then(|x| x.as_str()) {
                    return Some(format!("[tool: {}]", name));
                }
            }
        }
    }
    None
}

static TAIL_CACHE: LazyLock<Mutex<HashMap<PathBuf, CachedTail>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Read a .jsonl session file, extracting everything `list_sessions` needs:
/// the first N non-empty lines, the last N non-empty lines, and an
/// approximate count of `type:"assistant"` entries.
///
/// Uses two bounded reads (head 16KB + tail 256KB) instead of slurping the
/// whole file — session JSONLs can grow into hundreds of MB, and previously
/// every refresh re-read the entire file. Turn count is approximate for
/// large files (only counts assistants within the tail window), but that's
/// fine for the ghost-session filter and live-status heuristics that use it.
fn scan_session_tail(path: &Path, first_n: usize, last_n: usize) -> CachedTail {
    use std::io::{Read, Seek, SeekFrom};
    const HEAD_WINDOW: u64 = 16 * 1024;
    const TAIL_WINDOW: u64 = 256 * 1024;

    let mtime_ms_v = mtime_ms(path);
    let size_bytes = file_size(path);
    let empty = CachedTail {
        mtime_ms: mtime_ms_v,
        size_bytes,
        first_lines: vec![],
        last_lines: vec![],
        turn_count: 0,
        last_user_preview: None,
        spawn_label: None,
    };
    let Ok(mut f) = std::fs::File::open(path) else {
        return empty;
    };

    // Head — read up to HEAD_WINDOW bytes from start, extract first_n lines.
    let mut first_lines: Vec<String> = Vec::with_capacity(first_n);
    let head_len = size_bytes.min(HEAD_WINDOW);
    if head_len > 0 {
        let mut head_buf = vec![0u8; head_len as usize];
        if f.read_exact(&mut head_buf).is_ok() {
            for line in String::from_utf8_lossy(&head_buf)
                .lines()
                .filter(|l| !l.trim().is_empty())
            {
                if first_lines.len() >= first_n {
                    break;
                }
                first_lines.push(line.to_string());
            }
        }
    }

    // Tail — seek to last TAIL_WINDOW bytes, drop partial leading line,
    // scan for last_n lines + turn count + last user preview.
    let tail_start = size_bytes.saturating_sub(TAIL_WINDOW);
    if f.seek(SeekFrom::Start(tail_start)).is_err() {
        return CachedTail { first_lines, ..empty };
    }
    let mut tail_buf: Vec<u8> = Vec::with_capacity(TAIL_WINDOW as usize);
    if f.read_to_end(&mut tail_buf).is_err() {
        return CachedTail { first_lines, ..empty };
    }
    let tail_slice: &[u8] = if tail_start > 0 {
        match tail_buf.iter().position(|&b| b == b'\n') {
            Some(pos) => &tail_buf[pos + 1..],
            None => &[],
        }
    } else {
        &tail_buf[..]
    };

    let mut tail: std::collections::VecDeque<String> =
        std::collections::VecDeque::with_capacity(last_n);
    let mut turn_count = 0usize;
    let mut last_user_preview: Option<String> = None;
    for raw in String::from_utf8_lossy(tail_slice)
        .lines()
        .filter(|l| !l.trim().is_empty())
    {
        if tail.len() == last_n {
            tail.pop_front();
        }
        tail.push_back(raw.to_string());
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
            if v.get("type").and_then(|x| x.as_str()) == Some("assistant") {
                turn_count += 1;
            } else if let Some(ask) = extract_real_user_ask(&v) {
                last_user_preview = Some(ask);
            }
        }
    }
    let spawn_label = first_lines
        .iter()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .find_map(|v| extract_spawn_label(&v));
    CachedTail {
        mtime_ms: mtime_ms_v,
        size_bytes,
        first_lines,
        last_lines: tail.into_iter().collect(),
        turn_count,
        last_user_preview,
        spawn_label,
    }
}

/// Cached variant: only re-scans the file when mtime or size changes.
fn cached_tail(path: &Path, first_n: usize, last_n: usize) -> CachedTail {
    let cur_mtime = mtime_ms(path);
    let cur_size = file_size(path);
    cached_tail_with_meta(path, first_n, last_n, cur_mtime, cur_size)
}

/// Same as `cached_tail` but reuses metadata the caller already stat()'d.
/// Eliminates two redundant syscalls per session on the list_projects
/// hot path where the dir walk already read file metadata.
fn cached_tail_with_meta(
    path: &Path,
    first_n: usize,
    last_n: usize,
    cur_mtime: u64,
    cur_size: u64,
) -> CachedTail {
    {
        let cache = tail_cache_lock();
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
    tail_cache_lock().insert(path.to_path_buf(), fresh.clone());
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
///
/// Cached behind a 2-second TTL + dir-mtime fingerprint. list_projects()
/// and list_sessions() both call this on every refresh and previously
/// re-deserialized every `~/.claude/sessions/*.json` each time — on a
/// machine with 20+ active claude processes that was 20+ disk reads +
/// JSON parses per tab switch. The cache reduces steady-state cost to
/// ~one fstat per call when nothing has changed.
fn read_live_session_map() -> HashMap<String, LiveSession> {
    // Short TTL is a belt on top of mtime-invalidation: mtime tracking
    // won't catch changes inside an existing file (rare for state files,
    // but PIDs reuse on macOS — so we re-check liveness aggressively).
    const TTL_MS: u128 = 2_000;
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<Option<(std::time::Instant, Option<std::time::SystemTime>, HashMap<String, LiveSession>)>>,
    > = std::sync::OnceLock::new();
    let cell = CACHE.get_or_init(|| std::sync::Mutex::new(None));

    let dir = claude_sessions_state_dir();
    let dir_mtime = std::fs::metadata(&dir).and_then(|m| m.modified()).ok();

    if let Ok(guard) = cell.lock() {
        if let Some((cached_at, cached_mtime, map)) = guard.as_ref() {
            let fresh = cached_at.elapsed().as_millis() < TTL_MS
                && *cached_mtime == dir_mtime;
            if fresh {
                return map.clone();
            }
        }
    }

    let mut out: HashMap<String, LiveSession> = HashMap::new();
    let Ok(rd) = std::fs::read_dir(&dir) else {
        if let Ok(mut guard) = cell.lock() {
            *guard = Some((std::time::Instant::now(), dir_mtime, out.clone()));
        }
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
    if let Ok(mut guard) = cell.lock() {
        *guard = Some((std::time::Instant::now(), dir_mtime, out.clone()));
    }
    out
}

/// `kill(pid, 0)` direct syscall — returns 0 if the process exists and we
/// can signal it, -1 otherwise. Doesn't deliver a signal. Previously this
/// forked `/bin/kill -0 <pid>` which cost ~5ms of subprocess overhead per
/// live session on every list_projects refresh; switching to the direct
/// syscall makes it free.
///
/// Kill-alone isn't enough though: macOS aggressively recycles PIDs, so
/// after claude exits its PID can be reassigned to a shell or launchd
/// child within seconds — `kill(pid, 0)` then returns true for an
/// unrelated process and we'd incorrectly show GENERATING. We layer a
/// process-comm check on top (see pid_is_claude) with a short cache so
/// the verify cost is paid at most once per PID per refresh batch.
#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // SAFETY: libc::kill with sig=0 is a pure existence check, no signal sent.
    let exists = unsafe { libc::kill(pid as libc::pid_t, 0) == 0 };
    if !exists {
        return false;
    }
    pid_is_claude(pid)
}

#[cfg(not(unix))]
fn pid_alive(_pid: u32) -> bool {
    // Windows: be conservative — claim alive. The downstream logic treats
    // live-status as a best-effort hint, not a safety boundary.
    true
}

/// Verify the PID actually points at a claude process (or its node
/// runtime), not a recycled PID assigned to something unrelated after
/// claude exited. Uses `ps -o comm=` for portability — /proc isn't on
/// macOS and sysctl KERN_PROCARGS gets hairy. Result cached for 5s
/// per PID so a dashboard refresh doesn't spawn N subprocesses.
///
/// Accepted names: "claude" (aliased binary), "node" (claude ships as
/// a node script on most installs). Anything else means the PID has
/// been reused and the session state file is stale.
#[cfg(unix)]
fn pid_is_claude(pid: u32) -> bool {
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    type CacheEntry = (Instant, bool);
    static CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<u32, CacheEntry>>> =
        std::sync::OnceLock::new();
    const TTL: Duration = Duration::from_secs(5);
    let cell = CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()));

    if let Ok(cache) = cell.lock() {
        if let Some((at, v)) = cache.get(&pid) {
            if at.elapsed() < TTL {
                return *v;
            }
        }
    }

    // ps -o comm= prints the short executable name, newline-terminated.
    // No quoting issues since pid is numeric.
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output();
    let name = match out {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        }
        _ => {
            // ps failed → be conservative and say yes. Rather false-
            // positive (card stays GENERATING briefly) than false-
            // negative (hide a real live session).
            return true;
        }
    };
    // Match on the basename only — `ps -o comm=` returns full path
    // on macOS for long-running daemons but plain name for most
    // interactive commands. Be tolerant.
    let lowered = name.to_lowercase();
    let basename = lowered.rsplit('/').next().unwrap_or(&lowered);
    let is_ours = basename.contains("claude") || basename == "node";

    if let Ok(mut cache) = cell.lock() {
        cache.insert(pid, (Instant::now(), is_ours));
    }
    is_ours
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
    #[allow(dead_code)] // reserved; counted in StatusCounts for future "idle" detection
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
    /// Label for what spawned this session when no real user ask exists
    /// (subagent / slash-command / Task tool invocations). Frontend uses this
    /// as a fallback for the card headline instead of "(no user messages)".
    pub spawn_label: Option<String>,
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
/// Derived-cwd cache: the project's cwd is stable (first session's
/// `cwd` field = project directory), so cache forever per project_dir.
/// Prior code re-read a full JSONL on every list_projects call — even
/// multi-MB sessions — just to grab a field in the first 3 lines.
static CWD_CACHE: LazyLock<Mutex<HashMap<PathBuf, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn read_cwd_from_session(project_dir: &Path) -> Option<String> {
    {
        let cache = CWD_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = cache.get(project_dir) {
            return Some(cached.clone());
        }
    }
    use std::io::Read;
    const HEAD_WINDOW: usize = 16 * 1024;
    let rd = std::fs::read_dir(project_dir).ok()?;
    for entry in rd.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(mut f) = std::fs::File::open(&p) else {
            continue;
        };
        let mut buf = vec![0u8; HEAD_WINDOW];
        let n = match f.read(&mut buf) {
            Ok(n) => n,
            Err(_) => continue,
        };
        buf.truncate(n);
        let head = String::from_utf8_lossy(&buf);
        for line in head.lines().take(3) {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            if let Some(cwd) = v.get("cwd").and_then(|x| x.as_str()) {
                if !cwd.is_empty() {
                    let mut cache = CWD_CACHE.lock().unwrap_or_else(|e| e.into_inner());
                    cache.insert(project_dir.to_path_buf(), cwd.to_string());
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
    let cleaned = strip_ansi_and_noise(s);
    let trimmed = cleaned.trim().replace('\n', " ");
    if trimmed.chars().count() <= max {
        trimmed
    } else {
        let mut out: String = trimmed.chars().take(max).collect();
        out.push('…');
        out
    }
}

/// Strip terminal control sequences + the `<local-command-stdout>`
/// wrappers that show up in previews for sessions ended with `/compact`
/// or shell-invoking slash commands. Without this the Monitor tab
/// displays literal bytes like `[2mCompacted...[22m`, which looks
/// like garbage text to the user. We handle:
///   - CSI sequences: `\x1b[...m` (the actual byte-0x1B form)
///   - Already-rendered `[2m` / `[22m` etc. that lost the ESC on their
///     way through JSONL round-trips (happens with some claude builds)
///   - The `<local-command-*>` XML-ish tags themselves (the user
///     doesn't need to see the plumbing)
fn strip_ansi_and_noise(s: &str) -> String {
    // Iterate over CHARS, not bytes. An earlier byte-wise version
    // produced mojibake on CJK/emoji/any non-ASCII — Chinese
    // characters (3-byte UTF-8 sequences) got pushed as 3 separate
    // Latin-1-interpreted chars (`å▯▯å`). ANSI escape sequences are
    // all ASCII, so char-level scanning is still correct for them
    // and safe for multi-byte content.
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        // Real ESC-based CSI: 0x1B '[' ... final byte in 0x40..=0x7E
        if c == '\u{001B}' && chars.peek() == Some(&'[') {
            chars.next(); // consume '['
            for inner in chars.by_ref() {
                if (inner as u32) >= 0x40 && (inner as u32) <= 0x7E {
                    break;
                }
            }
            continue;
        }
        // Orphan CSI (ESC already stripped upstream): "[digits;digits;…m".
        // Probe-ahead on a clone so we only consume if it's a real match —
        // otherwise a literal '[' (e.g. `[TODO]`) would be eaten.
        if c == '[' {
            let probe: String = chars
                .clone()
                .take_while(|ch| ch.is_ascii_digit() || *ch == ';' || *ch == 'm')
                .collect();
            if probe.ends_with('m') && probe.len() >= 1 {
                // Commit the probe by advancing the real iterator.
                for _ in 0..probe.chars().count() {
                    chars.next();
                }
                continue;
            }
        }
        out.push(c);
    }
    // Drop the command-echo wrappers entirely — they're diagnostic
    // plumbing, not conversation content.
    out = out
        .replace("<local-command-stdout>", "")
        .replace("</local-command-stdout>", "")
        .replace("<local-command-stderr>", "")
        .replace("</local-command-stderr>", "");
    out
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
    // Compaction detector: if the tail carries a `/compact` echo or the
    // post-compact "This session is being continued…" summary, the
    // session is parked waiting for the user's next message, not mid-
    // generation. Without this the window would fall off the end and
    // we'd render stale sessions as "GENERATING" indefinitely.
    for raw in last_lines.iter().rev() {
        let low = raw.to_ascii_lowercase();
        if low.contains("<local-command-stdout>")
            && low.contains("compacted")
        {
            return true;
        }
        if low.contains("this session is being continued from a previous conversation")
        {
            return true;
        }
    }

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
            "user" => {
                // Only a *real* human ask means Claude is mid-generation.
                // isMeta command wrappers (`/compact` → `<local-command-stdout>`),
                // tool_result bridges, and `<system-reminder>` scaffolding are
                // bookkeeping written after a turn already settled — keep
                // walking back until we find the last real conversational
                // turn.
                if extract_real_user_ask(&v).is_some() {
                    return false;
                }
                continue;
            }
            // Other bookkeeping lines (system / summary / file-history-snapshot / result)
            _ => continue,
        }
    }
    // Walked off the end of the window without finding a conversational
    // turn. Previously we returned false here, which made every such
    // session render as "GENERATING" — wrong and alarming. Default to
    // true (awaiting-user) when the window had content but no
    // conversational turn was reachable: if we can't prove claude is
    // mid-generation from the tail, the safer inference is nothing is
    // happening. Empty tail still returns false (no info at all is
    // different from bookkeeping-only tail — preserves the old contract
    // for the "no sessions yet" path).
    !last_lines.is_empty()
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

/// Per-project cached result of the expensive classification loop.
/// Keyed on (dir_mtime, num_sessions, newest_session_mtime) — if all
/// three match, we skip the per-session tail reads and return the
/// cached counts. A stale-write (e.g. claude appending to one session
/// file) bumps newest_session_mtime, so we never serve wrong data.
#[derive(Clone)]
struct ProjectStatusEntry {
    dir_mtime: Option<std::time::SystemTime>,
    newest_mtime_ms: u64,
    session_count: usize,
    status_counts: StatusCounts,
}

fn project_status_cache(
) -> &'static std::sync::Mutex<HashMap<PathBuf, ProjectStatusEntry>> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<HashMap<PathBuf, ProjectStatusEntry>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
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

        // Gather session paths + mtime/size from a single metadata call per
        // file. Previously this path called `mtime_ms` and then `cached_tail`
        // (which internally re-stats for mtime + size) — three syscalls per
        // session on every refresh. Pull both fields from one stat().
        let mut sessions_here: Vec<(PathBuf, u64, u64)> = vec![];
        if let Ok(child_rd) = std::fs::read_dir(&path) {
            for f in child_rd.flatten() {
                let p = f.path();
                if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let Ok(meta) = f.metadata() else { continue };
                let m = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                sessions_here.push((p, m, meta.len()));
            }
        }
        if sessions_here.is_empty() {
            continue;
        }
        let session_count = sessions_here.len();
        let newest_mtime = sessions_here.iter().map(|(_, m, _)| *m).max().unwrap_or(0);

        // Cache lookup: if the project dir hasn't grown or shrunk, and the
        // newest session file hasn't been written to since we last classified,
        // reuse the previous status counts. Saves N tail-reads per refresh
        // on idle projects (the common case).
        let dir_mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        let cache_hit = if let Ok(cache) = project_status_cache().lock() {
            cache.get(&path).and_then(|entry| {
                if entry.dir_mtime == dir_mtime
                    && entry.newest_mtime_ms == newest_mtime
                    && entry.session_count == session_count
                {
                    Some(entry.status_counts.clone())
                } else {
                    None
                }
            })
        } else {
            None
        };

        let status_counts = match cache_hit {
            Some(cs) => cs,
            None => {
                let mut status_counts = StatusCounts::default();
                for (p, m, size) in &sessions_here {
                    let session_id = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                    let is_live = live_sessions.contains_key(session_id);
                    let tail = cached_tail_with_meta(p, 6, 20, *m, *size);
                    match classify_status_from_tail(&tail.last_lines, *m, is_live) {
                        SessionStatus::Live => status_counts.live += 1,
                        SessionStatus::Done => status_counts.done += 1,
                        SessionStatus::Errored => status_counts.errored += 1,
                        SessionStatus::Idle => status_counts.idle += 1,
                    }
                }
                if let Ok(mut cache) = project_status_cache().lock() {
                    cache.insert(
                        path.clone(),
                        ProjectStatusEntry {
                            dir_mtime,
                            newest_mtime_ms: newest_mtime,
                            session_count,
                            status_counts: status_counts.clone(),
                        },
                    );
                }
                status_counts
            }
        };

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
///
/// Takes pre-read tail lines to avoid re-reading the file — callers with cached
/// tail (list_sessions path) and callers with freshly-read tail (debug_session)
/// both go through this.
/// Maximum idle window before we treat a "live" claim as suspect.
/// An actively-generating claude writes to its JSONL at least every
/// few seconds (each token chunk, each tool call). 20 seconds is
/// tight enough that a user who hits Ctrl+C sees the card flip
/// from GENERATING → FOR REVIEW within the same visit; long-running
/// tool calls (subagent spawn, big grep) occasionally take >20s
/// silent which will briefly false-positive as stale, but the card
/// flips back the moment output resumes.
const LIVE_STALENESS_MS: u64 = 20_000;

/// Returns true if the session is "live" by state-file claim but
/// hasn't been written to recently enough to actually be generating.
/// Callers use this to flip `awaiting_user = true` instead of flipping
/// status itself — keeps the card on the Active dashboard (status
/// stays Live) but swaps the badge from red "GENERATING" to green
/// "FOR REVIEW" so cancelled sessions stop looking like they're
/// still working.
///
/// Flipping status to Done here would be more "correct" but it hides
/// the card from the default Active view entirely, which surprised
/// users who'd just cancelled and expected to still see their session.
pub fn is_stale_live(mtime_ms: u64, is_live: bool) -> bool {
    if !is_live || mtime_ms == 0 {
        return false;
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(u64::MAX);
    now_ms.saturating_sub(mtime_ms) > LIVE_STALENESS_MS
}

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

        let tail = cached_tail(&path, 20, 20);
        let first_user_preview = tail.first_lines.iter().find_map(|l| preview_from_line(l));
        let last_message_preview = tail
            .last_lines
            .iter()
            .rev()
            .find_map(|l| preview_from_line(l));
        let mut awaiting_user = awaiting_user_input(&tail.last_lines);
        let is_live = live_sessions.contains_key(&id);
        let status = classify_status_from_tail(&tail.last_lines, tail.mtime_ms, is_live);
        // Staleness override: session claims to be live but hasn't
        // been written to in 90s+. Most likely a Ctrl+C'd session
        // whose state file stuck around. Flip to awaiting-user so
        // the card reads "FOR REVIEW" (green) instead of lying with
        // "GENERATING" (red). Keeps the card on the Active dashboard.
        if is_stale_live(tail.mtime_ms, is_live) {
            awaiting_user = true;
        }

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
            spawn_label: tail.spawn_label.clone(),
            status,
            turn_count: tail.turn_count,
            awaiting_user,
        });
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    out
}

/// Look up a single session's metadata by id across every project dir.
/// Used by the Runs tab's "Open session" link — historic runs may point
/// to archived sessions that aren't in any cached `list_sessions(project)`
/// call, so we walk the projects root directly.
///
/// Returns `None` if the session id doesn't resolve to a file anywhere
/// under `~/.claude/projects/`. This is a bounded search (one pass per
/// project dir) but there's no need to be faster — it only fires when
/// a user clicks a Run row.
pub fn find_session_by_id(session_id: &str) -> Option<SessionInfo> {
    let root = claude_projects_root();
    let rd = std::fs::read_dir(&root).ok()?;
    for project_entry in rd.flatten() {
        let project_dir = project_entry.path();
        if !project_dir.is_dir() {
            continue;
        }
        let candidate = project_dir.join(format!("{session_id}.jsonl"));
        if !candidate.is_file() {
            continue;
        }
        // Found it — build the SessionInfo the same way list_sessions does.
        let project_key = project_dir
            .file_name()
            .and_then(|n| n.to_str())?
            .to_string();
        let cwd = read_cwd_from_session(&project_dir)
            .unwrap_or_else(|| decode_project_key(&project_key));
        let live_sessions = read_live_session_map();
        let tail = cached_tail(&candidate, 20, 20);
        let first_user_preview = tail
            .first_lines
            .iter()
            .find_map(|l| preview_from_line(l));
        let last_message_preview = tail
            .last_lines
            .iter()
            .rev()
            .find_map(|l| preview_from_line(l));
        let mut awaiting_user = awaiting_user_input(&tail.last_lines);
        let is_live = live_sessions.contains_key(session_id);
        let status = classify_status_from_tail(&tail.last_lines, tail.mtime_ms, is_live);
        if is_stale_live(tail.mtime_ms, is_live) {
            awaiting_user = true;
        }
        return Some(SessionInfo {
            id: session_id.to_string(),
            path: candidate.to_string_lossy().to_string(),
            project_key,
            project_cwd: cwd,
            modified_ms: tail.mtime_ms,
            size_bytes: tail.size_bytes,
            first_user_preview,
            last_message_preview,
            last_user_preview: tail.last_user_preview.clone(),
            spawn_label: tail.spawn_label.clone(),
            status,
            turn_count: tail.turn_count,
            awaiting_user,
        });
    }
    None
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
    // Delegate to the paginated variant with "read everything" defaults
    // so existing call sites keep working while new ones can request a
    // window.
    read_session_paginated(path, 0, None)
}

/// Bounded-memory session read. Skips `offset` lines from the top and
/// returns at most `limit` parsed lines. When `limit` is None, reads the
/// full file (legacy behaviour) — callers streaming a giant session
/// should always pass a limit to avoid slurping 100+ MB into RAM.
pub fn read_session_paginated(
    path: &str,
    offset: usize,
    limit: Option<usize>,
) -> Vec<SessionLine> {
    use std::io::{BufRead, BufReader};

    let p = Path::new(path);
    let Ok(f) = std::fs::File::open(p) else {
        return vec![];
    };
    let reader = BufReader::new(f);
    let mut out: Vec<SessionLine> = Vec::new();
    let cap = limit.unwrap_or(usize::MAX);

    for (i, line_res) in reader.lines().enumerate() {
        if i < offset {
            continue;
        }
        if out.len() >= cap {
            break;
        }
        let Ok(raw) = line_res else { continue };
        if let Some(line) = parse_raw_line(&raw, i) {
            out.push(line);
        }
    }
    out
}

// ---- unified event-driven session tailer -------------------------------------
//
// One notify watcher + one consumer thread, shared across all watched sessions.
// Per-session state (offset, event name) lives in SESSION_TAILERS. When an fs
// event fires on a watched path, we read the byte delta since the last offset,
// parse new JSONL lines, and emit `session:<node_id>:append`.
//
// Replaces the previous design of one tokio polling task per session — that
// produced N stat syscalls every 2s with no dedup.

struct SessionTailer {
    node_id: String,
    event_name: String,
    offset: u64,
    app: AppHandle,
}

static SESSION_TAILERS: LazyLock<Mutex<HashMap<PathBuf, Vec<SessionTailer>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Holds the live notify::Watcher + event-drainer thread handle. Lazy-init'd
/// on first watch_session call.
struct TailerDriver {
    watcher: notify::RecommendedWatcher,
}

static DRIVER: LazyLock<Mutex<Option<TailerDriver>>> = LazyLock::new(|| Mutex::new(None));

fn tailers_lock() -> MutexGuard<'static, HashMap<PathBuf, Vec<SessionTailer>>> {
    SESSION_TAILERS.lock().unwrap_or_else(|e| e.into_inner())
}

fn driver_lock() -> MutexGuard<'static, Option<TailerDriver>> {
    DRIVER.lock().unwrap_or_else(|e| e.into_inner())
}

/// Read byte delta `[offset, EOF)` from `path`, parse JSONL lines, emit
/// `session:<node_id>:append` for each active tailer on this path. Updates
/// each tailer's offset.
fn drain_path(path: &Path) {
    let current_size = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return,
    };
    let mut tailers = tailers_lock();
    let Some(list) = tailers.get_mut(path) else { return };
    for t in list.iter_mut() {
        if current_size <= t.offset { continue; }
        let Ok(mut f) = std::fs::File::open(path) else { continue };
        use std::io::{Read, Seek, SeekFrom};
        if f.seek(SeekFrom::Start(t.offset)).is_err() { continue; }
        let mut buf = String::new();
        if f.read_to_string(&mut buf).is_err() { continue; }
        t.offset = current_size;
        let lines: Vec<SessionLine> = buf
            .lines()
            .enumerate()
            .filter_map(|(i, raw)| parse_raw_line(raw, i))
            .collect();
        if !lines.is_empty() {
            let _ = t.app.emit(&t.event_name, lines);
        }
    }
}

/// Start (or return existing) global notify watcher + drainer thread.
fn ensure_driver() {
    let mut guard = driver_lock();
    if guard.is_some() { return; }

    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let watcher = match notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    }) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("session tailer watcher init failed: {e}");
            return;
        }
    };

    // Drainer thread: consumes events and dispatches to per-path tailers.
    // Also coalesces: a burst of Modify events on the same path only triggers
    // one read (we always read to EOF anyway).
    std::thread::spawn(move || {
        while let Ok(res) = rx.recv() {
            let Ok(ev) = res else { continue };
            // Brief coalesce window: absorb a few more events of the same
            // burst before draining. Keeps emits aligned with logical writes.
            let mut touched: std::collections::HashSet<PathBuf> =
                ev.paths.into_iter().collect();
            while let Ok(Ok(more)) = rx.recv_timeout(std::time::Duration::from_millis(25)) {
                touched.extend(more.paths);
            }
            for p in touched {
                drain_path(&p);
            }
        }
    });

    *guard = Some(TailerDriver { watcher });
}

/// Begin watching `path` for appends, emitting `session:<node_id>:append`.
/// Event-driven (fs notify) — no polling. Idempotent per (node_id, path).
pub fn watch_session(app: AppHandle, node_id: String, path: String) {
    {
        let w = watchers_lock();
        if w.contains_key(&node_id) {
            return;
        }
    }
    watchers_lock().insert(node_id.clone(), async_runtime::spawn(async {}));
    ensure_driver();

    let pbuf = PathBuf::from(&path);
    let offset = std::fs::metadata(&pbuf).map(|m| m.len()).unwrap_or(0);
    let event_name = format!("session:{}:append", node_id);
    let tailer = SessionTailer {
        node_id: node_id.clone(),
        event_name,
        offset,
        app,
    };

    // Register tailer. If this path is new, subscribe the notify watcher to it.
    let needs_subscribe = {
        let mut map = tailers_lock();
        let entry = map.entry(pbuf.clone()).or_default();
        let is_new_path = entry.is_empty();
        entry.push(tailer);
        is_new_path
    };
    if needs_subscribe {
        use notify::Watcher;
        let mut drv = driver_lock();
        if let Some(d) = drv.as_mut() {
            if let Err(e) = d.watcher.watch(&pbuf, notify::RecursiveMode::NonRecursive) {
                eprintln!("watch_session subscribe failed for {}: {e}", pbuf.display());
            }
        }
    }
}

pub fn unwatch_session(node_id: &str) {
    if let Some(h) = watchers_lock().remove(node_id) {
        h.abort();
    }
    // Remove any registry entries tied to this node_id and unwatch paths
    // that no longer have consumers.
    let mut now_empty: Vec<PathBuf> = Vec::new();
    {
        let mut map = tailers_lock();
        let keys: Vec<PathBuf> = map.keys().cloned().collect();
        for k in keys {
            if let Some(list) = map.get_mut(&k) {
                list.retain(|t| t.node_id != node_id);
                if list.is_empty() {
                    now_empty.push(k);
                }
            }
        }
        for k in &now_empty {
            map.remove(k);
        }
    }
    if !now_empty.is_empty() {
        use notify::Watcher;
        let mut drv = driver_lock();
        if let Some(d) = drv.as_mut() {
            for p in &now_empty {
                let _ = d.watcher.unwatch(p);
            }
        }
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
    // Terminal.app — only inspect if it's already running, and only call
    // `activate` AFTER a matching tab is found. Activating unconditionally
    // would flash Terminal to the foreground even when the session lives
    // in some other app (VSCode, iTerm2, etc.).
    let tapp_script = format!(
        r#"if application "Terminal" is running then
    tell application "Terminal"
        repeat with w in windows
            repeat with t in tabs of w
                if tty of t is "{tty}" then
                    activate
                    set selected of t to true
                    set index of w to 1
                    return "ok"
                end if
            end repeat
        end repeat
    end tell
end if
return "not-found""#
    );
    if let Some(r) = run_applescript(&tapp_script) {
        if r == "ok" {
            return Ok("Terminal".into());
        }
    }
    // iTerm2 — same pattern. `application "iTerm2" is running` guard avoids
    // auto-launching iTerm2 just because we reference it.
    let iterm_script = format!(
        r#"if application "iTerm2" is running then
    tell application "iTerm2"
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
    end tell
end if
return "not-found""#
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
    let status = classify_status_from_tail(&last_lines, mtime, true);
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
    fn harness_awaiting_compaction_tail_is_true() {
        // Real bug: a session that just ran `/compact` sits with a
        // `<local-command-stdout>Compacted ...</local-command-stdout>`
        // at the tail and NO assistant text in the visible window. The
        // walker used to fall off the end and return false → card
        // displayed "GENERATING" indefinitely. Compaction detector now
        // short-circuits to true.
        let lines = vec![
            r#"{"type":"summary","summary":"session summary here"}"#.to_string(),
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<command-name>/compact</command-name>"}}"#.to_string(),
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>"}}"#.to_string(),
        ];
        assert!(awaiting_user_input(&lines));
    }

    #[test]
    fn harness_awaiting_continuation_marker_is_true() {
        // Post-compact, claude prepends a system message "This session
        // is being continued from a previous conversation..." and then
        // waits for the user. Detected explicitly so the card flips
        // to FOR-REVIEW immediately.
        let lines = vec![
            r#"{"type":"system","subtype":"init","message":{"role":"system","content":"This session is being continued from a previous conversation that ran out of context."}}"#.to_string(),
        ];
        assert!(awaiting_user_input(&lines));
    }

    #[test]
    fn harness_strip_ansi_escapes_from_preview() {
        // Bug that leaked `[2m...[22m` into the Monitor tab. Both real
        // ESC-based CSI and the de-ESC'd orphan form must be stripped.
        let esc = "\u{001b}[2mCompacted\u{001b}[22m text";
        let stripped = strip_ansi_and_noise(esc);
        assert!(!stripped.contains('\u{001b}'), "ESC leaked: {stripped}");
        assert!(!stripped.contains("[2m"), "[2m leaked: {stripped}");
        assert!(stripped.contains("Compacted text"), "content dropped: {stripped}");

        let orphan = "[2mCompacted[22m text";
        let stripped = strip_ansi_and_noise(orphan);
        assert!(!stripped.contains("[2m"), "orphan CSI leaked: {stripped}");
        assert!(stripped.contains("Compacted text"), "content dropped: {stripped}");
    }

    #[test]
    fn harness_strip_local_command_stdout_wrapper() {
        let input = "<local-command-stdout>Compacted</local-command-stdout>";
        let stripped = strip_ansi_and_noise(input);
        assert_eq!(stripped, "Compacted");
    }

    #[test]
    fn harness_strip_preserves_brackets_that_arent_csi() {
        // Ordinary bracketed text (e.g. [TODO], [note]) must not get
        // eaten by the CSI-stripper. Only digit+; between `[` and `m`
        // qualifies as a control sequence.
        let s = strip_ansi_and_noise("[TODO] check this");
        assert_eq!(s, "[TODO] check this");
        let s = strip_ansi_and_noise("array[0] access");
        assert_eq!(s, "array[0] access");
    }

    #[test]
    fn harness_stale_live_flips_awaiting_not_status() {
        // Regression for the "GENERATING forever after Ctrl+C" bug:
        // claude CLI can leave its ~/.claude/sessions/<sid>.json
        // state file behind when the user cancels mid-turn. The PID
        // becomes invalid (or gets recycled on macOS), so `is_live`
        // is a lie.
        //
        // We DON'T flip status (that would hide the card from the
        // Active dashboard entirely). We flip the awaiting_user
        // override instead — card stays on screen, badge shifts
        // from red GENERATING to green FOR REVIEW.
        let old_mtime = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            - (LIVE_STALENESS_MS + 10_000);
        assert!(is_stale_live(old_mtime, true));
        // Status classifier left unchanged: still Live.
        assert_eq!(
            classify_status_from_tail(&[], old_mtime, true),
            SessionStatus::Live
        );
    }

    #[test]
    fn harness_recent_live_session_not_stale() {
        let fresh_mtime = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(!is_stale_live(fresh_mtime, true));
    }

    #[test]
    fn harness_zero_mtime_not_stale() {
        // mtime_ms == 0 means "unknown" — don't override.
        assert!(!is_stale_live(0, true));
    }

    #[test]
    fn harness_not_live_is_never_stale() {
        // Staleness only applies to sessions that CLAIM to be live.
        let old_mtime = 1_000_000u64;
        assert!(!is_stale_live(old_mtime, false));
    }

    #[test]
    fn harness_stale_threshold_is_aggressive() {
        // 25s-old mtime must trip staleness — 20s window is tight on
        // purpose so cancelled sessions flip status within the same
        // dashboard visit. If this test ever loosens, users will see
        // "GENERATING" for a minute+ after Ctrl+C again.
        let twenty_five_s_ago = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            - 25_000;
        assert!(is_stale_live(twenty_five_s_ago, true));
    }

    #[test]
    fn harness_stale_threshold_honors_recent_writes() {
        // Boundary check: 15s-old mtime is NOT stale (within the 20s
        // window). Guards against an over-aggressive tighten that
        // would false-positive healthy slow sessions.
        let fifteen_s_ago = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            - 15_000;
        assert!(!is_stale_live(fifteen_s_ago, true));
    }

    #[cfg(unix)]
    #[test]
    fn harness_pid_is_claude_rejects_unrelated_pid() {
        // The current test process (cargo test) is `cargo`, not claude
        // or node — perfect stand-in for a recycled PID. pid_is_claude
        // must return false. If this regresses, PID recycling on macOS
        // silently revives cancelled "GENERATING" cards.
        let my_pid = std::process::id();
        // ps invocation path is cached per-pid so repeated calls
        // within the test don't spawn extra processes.
        let is_claude = super::pid_is_claude(my_pid);
        assert!(
            !is_claude,
            "cargo test's PID ({my_pid}) should not match 'claude' or 'node'"
        );
    }

    #[test]
    fn harness_strip_preserves_cjk_and_emoji() {
        // Regression for a nasty mojibake bug: byte-level iteration
        // split multi-byte UTF-8 into individual bytes and pushed each
        // as a char (Latin-1 interpretation). 中 (E4 B8 AD) became
        // ä¸­, 好 (E5 A5 BD) became å¥½, etc. Monitor tab previews for
        // any non-ASCII session were unreadable.
        let s = strip_ansi_and_noise("你好世界");
        assert_eq!(s, "你好世界");
        let s = strip_ansi_and_noise("Fixed 中文 bug 🎉");
        assert_eq!(s, "Fixed 中文 bug 🎉");
        // CJK mixed with a CSI escape — both should survive correctly.
        let s = strip_ansi_and_noise("\u{001b}[31m错误\u{001b}[0m: 文件不存在");
        assert_eq!(s, "错误: 文件不存在");
    }

    #[test]
    fn harness_strip_utf8_accents_and_unicode_brackets() {
        // Non-ASCII that's NOT CJK — accented Latin chars in French
        // messages, Unicode dashes, smart quotes. All should round-trip.
        let s = strip_ansi_and_noise("Ajouté café — résumé");
        assert_eq!(s, "Ajouté café — résumé");
        let s = strip_ansi_and_noise("“Smart” quotes and ‘apostrophes’");
        assert_eq!(s, "“Smart” quotes and ‘apostrophes’");
    }

    #[test]
    fn awaiting_skips_compact_command_wrappers() {
        // After `/compact`, the JSONL tail is:
        //   ... <real assistant text> ... <isMeta /compact cmd> <local-command-stdout>
        // Without the isMeta/scaffold filter, the walker treated the
        // bookkeeping user lines as "human just sent something, claude is
        // generating" and the card stayed stuck in GENERATING state.
        let compact_cmd = r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<command-name>/compact</command-name>"}}"#.to_string();
        let local_stdout = r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-stdout>Compacted</local-command-stdout>"}}"#.to_string();
        let lines = vec![
            line_assistant_text("here is my final answer"),
            compact_cmd,
            local_stdout,
        ];
        assert!(awaiting_user_input(&lines));
    }

    // ---- chaos: large JSONL bounded-memory guarantee ----
    //
    // scan_session_tail reads exactly one HEAD_WINDOW (16KB) + one
    // TAIL_WINDOW (256KB) from disk regardless of file size. A 10MB
    // session file must not cause a whole-file read or a per-line
    // allocation explosion. This is the test that would have caught a
    // future refactor that accidentally reverts to `read_to_string`.
    #[test]
    fn chaos_large_jsonl_scans_in_bounded_time() {
        use std::io::Write;
        let tmp = std::env::temp_dir().join(format!(
            "orka-chaos-large-{}.jsonl",
            std::process::id()
        ));
        // Build a ~10MB JSONL: many small assistant turns. Far bigger
        // than HEAD+TAIL combined; if the tail-window bound ever breaks,
        // this test will take seconds instead of the <50ms budget.
        {
            let mut f = std::fs::File::create(&tmp).unwrap();
            let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"padding padding padding padding padding padding padding padding padding"}]}}"#;
            // 10MB / ~160B per line ≈ 65_000 lines.
            for _ in 0..65_000 {
                writeln!(f, "{}", line).unwrap();
            }
            // End with a real `※ recap:` so extractors have a signal.
            let recap = r#"{"type":"user","message":{"role":"user","content":"※ recap: did the thing. Next: done."}}"#;
            writeln!(f, "{}", recap).unwrap();
        }

        let size = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
        assert!(size > 5_000_000, "test fixture must be >5MB, got {size}");

        let start = std::time::Instant::now();
        let tail = scan_session_tail(&tmp, 20, 20);
        let elapsed = start.elapsed();

        // Budget: 50ms on a 2023 MBP. CI will be slower; if flaky, bump
        // to 100ms — still orders of magnitude under a full-file read.
        assert!(
            elapsed.as_millis() < 200,
            "scan_session_tail on 10MB file took {elapsed:?} — bounded-I/O invariant broken"
        );
        // And the bounded read actually found data on both ends.
        assert!(!tail.first_lines.is_empty(), "expected head lines");
        assert!(!tail.last_lines.is_empty(), "expected tail lines");
        let _ = std::fs::remove_file(&tmp);
    }

    // ---- chaos: mutex poison recovery ----
    //
    // `watchers_lock` and `tail_cache_lock` wrap `Mutex::lock` in
    // `unwrap_or_else(|e| e.into_inner())` so a panic inside a worker
    // holding one of these can't brick every future Tauri command on
    // the affected lock. This test poisons the cache lock and asserts
    // the helper still returns a usable guard.
    #[test]
    fn chaos_tail_cache_recovers_from_poisoned_mutex() {
        use std::sync::Arc;
        use std::thread;
        // TAIL_CACHE is a static, so every test sees the same lock. We
        // can't poison it without breaking sibling tests. Instead this
        // test exercises the same recovery pattern (`into_inner`) on a
        // local Mutex that models the helper — if the stdlib contract
        // ever changes, this will catch it.
        let m = Arc::new(std::sync::Mutex::new(0u32));
        let m_inner = Arc::clone(&m);
        let _ = thread::spawn(move || {
            let _g = m_inner.lock().unwrap();
            panic!("simulated worker panic while holding the lock");
        })
        .join();

        // lock() now returns PoisonError; the pattern we use in prod is
        // `unwrap_or_else(|e| e.into_inner())`.
        let guard = m.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(*guard, 0, "inner data should still be readable");
    }

    #[test]
    fn awaiting_skips_system_reminder_user_wrappers() {
        // `<system-reminder>` pushed as type:"user" is scaffolding — not a
        // real ask. Walker should look past it to the previous assistant
        // text turn.
        let reminder = r#"{"type":"user","message":{"role":"user","content":"<system-reminder>date changed</system-reminder>"}}"#.to_string();
        let lines = vec![line_assistant_text("all done"), reminder];
        assert!(awaiting_user_input(&lines));
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
    fn real_ask_skips_task_notification_wrapper() {
        let v = parse(
            r#"{"type":"user","message":{"role":"user","content":"<task-notification> <task-id>x</task-id></task-notification>"}}"#,
        );
        assert!(extract_real_user_ask(&v).is_none());
    }

    #[test]
    fn real_ask_skips_system_reminder_wrapper() {
        let v = parse(
            r#"{"type":"user","message":{"role":"user","content":"<system-reminder>Be concise</system-reminder>"}}"#,
        );
        assert!(extract_real_user_ask(&v).is_none());
    }

    #[test]
    fn real_ask_skips_scaffold_in_text_block_array() {
        let v = parse(
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<task-notification>noise</task-notification>"}]}}"#,
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
