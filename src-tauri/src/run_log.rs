use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub id: String,
    pub skill: String,
    #[serde(default)]
    pub inputs: Vec<String>,
    pub started_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub trigger: String,
    #[serde(default)]
    pub error_message: Option<String>,
}

fn runs_dir() -> PathBuf {
    crate::workspace::templates_dir()
        .parent()
        .map(|p| p.join("runs"))
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_default()
                .join("OrkaCanvas")
                .join("runs")
        })
}

/// Read a JSONL file tail-first, chunk by chunk, without loading the whole
/// file into memory. Stops once `limit` records are pushed into `out`.
fn read_tail_jsonl(path: &PathBuf, limit: usize, out: &mut Vec<RunRecord>) {
    const CHUNK: usize = 64 * 1024;
    let Ok(mut f) = std::fs::File::open(path) else { return; };
    let Ok(size) = f.metadata().map(|m| m.len()) else { return; };
    let mut pos = size as i64;
    let mut tail: Vec<u8> = Vec::with_capacity(CHUNK);

    while pos > 0 && out.len() < limit {
        let step = (pos as usize).min(CHUNK) as u64;
        pos -= step as i64;
        if f.seek(SeekFrom::Start(pos as u64)).is_err() { return; }
        let mut chunk = vec![0u8; step as usize];
        use std::io::Read;
        if f.read_exact(&mut chunk).is_err() { return; }
        chunk.extend_from_slice(&tail);
        // Find first newline — everything before it is a partial line that
        // belongs to the previous chunk. Stash it for next iteration.
        let split = chunk.iter().position(|b| *b == b'\n').unwrap_or(chunk.len());
        let (partial, rest) = chunk.split_at(split);
        tail = partial.to_vec();
        // Parse `rest` (starts with '\n') bottom-up.
        let rest_str = match std::str::from_utf8(rest) {
            Ok(s) => s,
            Err(_) => continue,
        };
        for line in rest_str.lines().rev() {
            if line.trim().is_empty() { continue; }
            if let Ok(rec) = serde_json::from_str::<RunRecord>(line) {
                out.push(rec);
                if out.len() >= limit { return; }
            }
        }
    }
    // Handle any leftover prefix (if file has no leading newline).
    if !tail.is_empty() && out.len() < limit {
        if let Ok(s) = std::str::from_utf8(&tail) {
            for line in s.lines().rev() {
                if line.trim().is_empty() { continue; }
                if let Ok(rec) = serde_json::from_str::<RunRecord>(line) {
                    out.push(rec);
                    if out.len() >= limit { return; }
                }
            }
        }
    }
}

pub fn list_runs(limit: usize) -> Vec<RunRecord> {
    let dir = runs_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|e| e == "jsonl").unwrap_or(false))
        .collect();
    // Newest-month first (YYYY-MM sorts lexicographically).
    files.sort_by(|a, b| b.cmp(a));

    let mut records = Vec::with_capacity(limit.min(1024));
    for file in files {
        if records.len() >= limit { break; }
        read_tail_jsonl(&file, limit, &mut records);
    }
    records
}

/// Find a single run by id. Scans JSONL files with a fast needle-match before
/// deserializing, so the common case skips serde entirely.
pub fn get_run(id: &str) -> Option<RunRecord> {
    let dir = runs_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return None;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|e| e == "jsonl").unwrap_or(false))
        .collect();
    files.sort_by(|a, b| b.cmp(a));

    // Needle: the JSON-escaped id field is what we'll find in each line.
    let needle = format!("\"id\":\"{id}\"");

    for file in files {
        let Ok(f) = std::fs::File::open(&file) else { continue };
        let reader = BufReader::new(f);
        for line in reader.lines().map_while(Result::ok) {
            if !line.contains(&needle) { continue; }
            if let Ok(rec) = serde_json::from_str::<RunRecord>(&line) {
                if rec.id == id { return Some(rec); }
            }
        }
    }
    None
}

pub fn append_run(record: &RunRecord) -> Result<(), String> {
    let dir = runs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir runs: {e}"))?;

    let now = chrono::Local::now();
    let filename = now.format("%Y-%m").to_string() + ".jsonl";
    let path = dir.join(filename);

    let mut line = serde_json::to_string(record)
        .map_err(|e| format!("serialize run: {e}"))?;
    line.push('\n');

    use std::io::Write;
    let f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open log: {e}"))?;
    // Advisory exclusive lock so GUI + CLI + scheduled processes writing to
    // the same YYYY-MM.jsonl can't interleave partial lines.
    f.lock_exclusive().map_err(|e| format!("lock log: {e}"))?;
    let result = (&f).write_all(line.as_bytes()).map_err(|e| format!("write log: {e}"));
    let _ = f.unlock();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_run_record_roundtrip() {
        let rec = RunRecord {
            id: "run-123".into(),
            skill: "test-skill".into(),
            inputs: vec!["key=val".into()],
            started_at: "2026-04-15T10:00:00Z".into(),
            ended_at: None,
            duration_ms: Some(1234),
            status: "ok".into(),
            trigger: "cli".into(),
            error_message: None,
        };
        let json = serde_json::to_string(&rec).unwrap();
        let parsed: RunRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "run-123");
        assert_eq!(parsed.skill, "test-skill");
        assert_eq!(parsed.duration_ms, Some(1234));
    }

    fn write_record(path: &PathBuf, id: &str, skill: &str) {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        let rec = serde_json::json!({
            "id": id, "skill": skill, "inputs": [],
            "started_at": "2026-01-01T00:00:00Z", "status": "ok", "trigger": "test"
        });
        writeln!(f, "{}", rec).unwrap();
    }

    #[test]
    fn test_read_tail_jsonl_multi_month() {
        // Two JSONL files, newest-month first semantics.
        let tmp = std::env::temp_dir().join(format!("orka-runs-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let jan = tmp.join("2026-01.jsonl");
        let feb = tmp.join("2026-02.jsonl");
        for i in 1..=5 { write_record(&jan, &format!("jan-{i}"), "x"); }
        for i in 1..=3 { write_record(&feb, &format!("feb-{i}"), "y"); }

        // Use read_tail_jsonl directly to validate ordering within a single file.
        let mut feb_records = Vec::new();
        read_tail_jsonl(&feb, 10, &mut feb_records);
        assert_eq!(feb_records.len(), 3);
        // tail-first ordering: feb-3 before feb-1
        assert_eq!(feb_records[0].id, "feb-3");
        assert_eq!(feb_records[2].id, "feb-1");

        // Limit cap respected.
        let mut capped = Vec::new();
        read_tail_jsonl(&jan, 2, &mut capped);
        assert_eq!(capped.len(), 2);
        assert_eq!(capped[0].id, "jan-5");
        assert_eq!(capped[1].id, "jan-4");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_tail_jsonl_empty_file() {
        let tmp = std::env::temp_dir().join(format!("orka-empty-{}", std::process::id()));
        let f = tmp.with_extension("jsonl");
        std::fs::write(&f, "").unwrap();
        let mut out = Vec::new();
        read_tail_jsonl(&f, 10, &mut out);
        assert!(out.is_empty());
        let _ = std::fs::remove_file(&f);
    }
}
