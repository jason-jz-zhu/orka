//! Reconstruct the output of a past run so the Runs tab can show +
//! annotate it. Two sources, tried in priority order:
//!
//!   1. **workdir** — any `*.md` in the run's working directory (but
//!      NOT under `.orka/` where internal files live). This is the
//!      user-facing artifact the skill was designed to produce.
//!   2. **session** — concatenated `type:"assistant"` text blocks from
//!      the corresponding Claude session JSONL. Fallback for runs
//!      where the skill didn't write a markdown file, or legacy runs
//!      without a tracked workdir.
//!
//! Returns `source: "none"` when neither is available — the UI uses
//! this to disable the "Notes" button or show a fallback message.
//!
//! Security: workdir paths are validated to live under either the
//! OrkaCanvas root or the user's home. A crafted run record pointing
//! at `/etc/passwd` or similar can't exfiltrate content — we refuse
//! to read anything outside known-safe roots.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct ReconstructResult {
    /// The markdown (or plain-text) payload to hand to OutputAnnotator.
    /// Empty string when source is "none".
    pub markdown: String,
    /// One of: "workdir" | "session" | "none". Drives a UI affordance
    /// so users can tell whether they're looking at the skill's
    /// output artifact or a transcript reconstruction.
    pub source: String,
    /// Human-readable origin, e.g. "summary.md" or "session abc-123".
    /// Shown in the drawer header so power users can trust the source.
    pub source_path: Option<String>,
    /// True when the markdown was truncated to stay under the size cap.
    pub truncated: bool,
}

impl ReconstructResult {
    fn none() -> Self {
        Self {
            markdown: String::new(),
            source: "none".into(),
            source_path: None,
            truncated: false,
        }
    }
}

/// Cap for any single artifact we return to the frontend. Past this
/// size the webview's markdown renderer starts to lag visibly; we'd
/// rather truncate than hand it 50 MB. Users can always open the raw
/// file in Finder if they want the full thing.
const MAX_BYTES: usize = 2 * 1024 * 1024;

/// Roots under which a workdir is allowed to live. Anything else is
/// rejected so a malicious run record can't point us at arbitrary
/// filesystem locations. OrkaCanvas root covers legacy internal workdirs;
/// the home dir covers user-configured per-skill output folders.
///
/// Two-layer check:
///   1. Lexical prefix — catches obvious `/etc/passwd` style paths
///      without needing the dir to exist
///   2. If the dir exists, canonicalize and prefix-check again —
///      catches symlinks that point somewhere legitimate at first
///      glance (`~/Documents/x`) but resolve to `/etc/...`. The
///      earlier lexical-only check would miss these.
fn is_workdir_safe(workdir: &Path) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let orka_root = home.join("OrkaCanvas");

    // Lexical check first — cheap rejection for paths that never had
    // a chance. Also the only check we can do for dirs that don't
    // yet exist (mkdir-then-read workflows).
    if !(workdir.starts_with(&orka_root) || workdir.starts_with(&home)) {
        return false;
    }

    // If the dir exists, also verify the canonical (symlink-resolved)
    // path stays under the safe root. Skipped if canonicalize fails
    // (permission denied, dir missing) — the lexical check above is
    // the fallback safety net.
    if let Ok(canonical) = workdir.canonicalize() {
        let home_canon = home.canonicalize().unwrap_or(home.clone());
        let orka_canon = orka_root.canonicalize().unwrap_or(orka_root);
        if !(canonical.starts_with(&orka_canon)
            || canonical.starts_with(&home_canon))
        {
            return false;
        }
    }
    true
}

/// Scan `workdir` (non-recursively, skipping `.orka/`) for markdown
/// files. Returns the newest one's content + filename.
fn read_workdir_artifact(workdir: &Path) -> Option<(String, String, bool)> {
    let Ok(rd) = std::fs::read_dir(workdir) else {
        return None;
    };
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            continue; // skip `.orka/` and any user subfolders
        }
        // Prefer .md over other extensions. We could broaden to .txt
        // later; MVP sticks to markdown since that's what OutputAnnotator
        // is built to render.
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        match &best {
            Some((bt, _)) if *bt > mtime => {}
            _ => best = Some((mtime, path)),
        }
    }
    let (_, path) = best?;
    let bytes = std::fs::read(&path).ok()?;
    let (text, truncated) = truncate_bytes_to_utf8(&bytes, MAX_BYTES);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("output.md")
        .to_string();
    Some((text, name, truncated))
}

/// Safe truncation to a UTF-8 boundary. Never splits a multi-byte
/// character; if cap lands mid-char, backs up to the last valid one.
fn truncate_bytes_to_utf8(bytes: &[u8], cap: usize) -> (String, bool) {
    if bytes.len() <= cap {
        return (String::from_utf8_lossy(bytes).to_string(), false);
    }
    let mut end = cap;
    while end > 0 && (bytes[end] & 0b1100_0000) == 0b1000_0000 {
        // Middle of a UTF-8 sequence — back up until we find a
        // single-byte start.
        end -= 1;
    }
    (String::from_utf8_lossy(&bytes[..end]).to_string(), true)
}

/// Walk a session JSONL and extract each assistant message's text
/// content blocks, concatenated with blank-line separators. Matches
/// the shape of what the user actually saw in the SkillRunner view
/// while the skill was running.
fn reconstruct_from_session(session_path: &Path) -> Option<(String, bool)> {
    use std::io::{BufRead, BufReader};

    let file = std::fs::File::open(session_path).ok()?;
    let reader = BufReader::new(file);

    let mut out = String::with_capacity(4096);
    let mut total_bytes = 0usize;
    let mut truncated = false;

    for line_res in reader.lines() {
        let Ok(line) = line_res else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        // Only assistant text blocks contribute to the reconstructed
        // output. tool_use / tool_result / system are irrelevant for
        // annotation purposes — users annotate the answer, not the
        // scaffolding.
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let Some(content) = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            continue;
        };
        for block in content {
            if block.get("type").and_then(|t| t.as_str()) != Some("text") {
                continue;
            }
            let Some(text) = block.get("text").and_then(|t| t.as_str()) else {
                continue;
            };
            if !out.is_empty() {
                out.push_str("\n\n");
                total_bytes += 2;
            }
            let remaining = MAX_BYTES.saturating_sub(total_bytes);
            if text.len() > remaining {
                // Truncate the current text block to fit the budget.
                let (head, did_truncate) =
                    truncate_bytes_to_utf8(text.as_bytes(), remaining);
                out.push_str(&head);
                truncated = truncated || did_truncate;
                return Some((out, true));
            }
            out.push_str(text);
            total_bytes += text.len();
            if total_bytes >= MAX_BYTES {
                return Some((out, true));
            }
        }
    }

    if out.is_empty() {
        None
    } else {
        Some((out, truncated))
    }
}

#[tauri::command]
pub fn reconstruct_run_output(
    _run_id: String,
    session_id: Option<String>,
    workdir: Option<String>,
) -> ReconstructResult {
    // 1. Workdir artifact is the preferred source — it's what the
    //    skill chose to emit, not a transcript.
    if let Some(w) = workdir.as_deref() {
        let path = PathBuf::from(w);
        if is_workdir_safe(&path) && path.is_dir() {
            if let Some((md, filename, truncated)) = read_workdir_artifact(&path) {
                return ReconstructResult {
                    markdown: md,
                    source: "workdir".into(),
                    source_path: Some(filename),
                    truncated,
                };
            }
        }
    }

    // 2. Fall back to session transcript. Uses the existing
    //    find_session_by_id to resolve a JSONL location without
    //    the caller needing to know Claude's project-hash layout.
    if let Some(sid) = session_id.as_deref() {
        if let Some(info) = crate::sessions::find_session_by_id(sid) {
            let path = PathBuf::from(&info.path);
            if let Some((md, truncated)) = reconstruct_from_session(&path) {
                return ReconstructResult {
                    markdown: md,
                    source: "session".into(),
                    source_path: Some(format!(
                        "session {}",
                        &sid[..sid.len().min(8)]
                    )),
                    truncated,
                };
            }
        }
    }

    ReconstructResult::none()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join(format!("orka-reconstruct-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn harness_reconstruct_prefers_workdir_over_session() {
        // Put a workdir under $HOME so is_workdir_safe accepts it. We
        // simulate it via a subdir of $HOME/.tmp-orka-test; the safety
        // check is a prefix match so this is legal.
        let home = dirs::home_dir().unwrap();
        let dir = home
            .join(".tmp-orka-test")
            .join(format!("prefers-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("summary.md"), "# Hello\n\nFrom workdir.").unwrap();

        let result = reconstruct_run_output(
            "run-x".into(),
            None,
            Some(dir.to_string_lossy().to_string()),
        );
        assert_eq!(result.source, "workdir");
        assert!(result.markdown.contains("From workdir"));
        assert_eq!(result.source_path.as_deref(), Some("summary.md"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn harness_reconstruct_reads_newest_md() {
        let home = dirs::home_dir().unwrap();
        let dir = home
            .join(".tmp-orka-test")
            .join(format!("newest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("older.md"), "older content").unwrap();
        // Sleep 10ms so mtimes differ measurably across filesystems.
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(dir.join("newer.md"), "newer content").unwrap();

        let result = reconstruct_run_output(
            "run-x".into(),
            None,
            Some(dir.to_string_lossy().to_string()),
        );
        assert_eq!(result.source, "workdir");
        assert!(result.markdown.contains("newer"));
        assert_eq!(result.source_path.as_deref(), Some("newer.md"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn harness_reconstruct_ignores_non_md() {
        let home = dirs::home_dir().unwrap();
        let dir = home
            .join(".tmp-orka-test")
            .join(format!("non-md-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("prompt.txt"), "internal prompt").unwrap();
        std::fs::write(dir.join("data.json"), "{}").unwrap();

        let result = reconstruct_run_output(
            "run-x".into(),
            None,
            Some(dir.to_string_lossy().to_string()),
        );
        // No .md present → falls through workdir + session (None) → none.
        assert_eq!(result.source, "none");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn harness_reconstruct_rejects_unsafe_workdir() {
        // Anything outside $HOME is refused — protects against a
        // run record with a tampered workdir pointing at system paths.
        let result = reconstruct_run_output(
            "run-x".into(),
            None,
            Some("/etc".into()),
        );
        assert_eq!(result.source, "none");
    }

    #[test]
    fn harness_reconstruct_from_session_extracts_assistant_text() {
        let dir = tmp_dir("session");
        let session_path = dir.join("sess-1.jsonl");
        let mut f = std::fs::File::create(&session_path).unwrap();
        // Mixed lines — only assistant text should appear in output.
        writeln!(
            f,
            r#"{{"type":"user","message":{{"role":"user","content":"ignored"}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"Hello"}},{{"type":"tool_use","name":"Read"}}]}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"World"}}]}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"system","subtype":"result"}}"#
        )
        .unwrap();
        drop(f);

        // Invoke the helper directly; going through the Tauri command
        // would require a real session_id resolver, which needs a full
        // ~/.claude layout.
        let (md, truncated) = reconstruct_from_session(&session_path).unwrap();
        assert!(md.contains("Hello"), "expected Hello in: {md}");
        assert!(md.contains("World"), "expected World in: {md}");
        assert!(!md.contains("ignored"), "user content leaked: {md}");
        assert!(!md.contains("Read"), "tool_use leaked: {md}");
        assert!(!truncated);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn harness_reconstruct_truncates_large_output() {
        let dir = tmp_dir("big");
        let session_path = dir.join("big.jsonl");
        let mut f = std::fs::File::create(&session_path).unwrap();
        // Write one giant assistant text block, larger than MAX_BYTES.
        let big = "x".repeat(MAX_BYTES + 10_000);
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"{}"}}]}}}}"#,
            big
        )
        .unwrap();
        drop(f);

        let (md, truncated) = reconstruct_from_session(&session_path).unwrap();
        assert!(truncated, "expected truncated flag on oversize input");
        assert!(
            md.len() <= MAX_BYTES,
            "reconstruct returned {} bytes > cap {}",
            md.len(),
            MAX_BYTES
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn harness_truncate_respects_utf8_boundary() {
        // 你 is 3 bytes in UTF-8 (0xE4 0xBD 0xA0). Asking for 1 or 2
        // bytes must not split the char mid-sequence.
        let bytes = "你好".as_bytes();
        let (text, truncated) = truncate_bytes_to_utf8(bytes, 2);
        assert!(truncated);
        // Either empty (safest) or a complete char — never a partial
        // sequence. from_utf8_lossy would substitute U+FFFD if we
        // produced an invalid slice; check we didn't.
        assert!(!text.contains('\u{FFFD}'), "got lossy replacement: {text}");
    }
}
