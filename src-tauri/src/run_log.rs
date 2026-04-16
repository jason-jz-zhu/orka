use serde::{Deserialize, Serialize};
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
    files.sort_by(|a, b| b.cmp(a));

    let mut records = Vec::new();
    for file in files {
        let Ok(content) = std::fs::read_to_string(&file) else { continue };
        for line in content.lines().rev() {
            if line.trim().is_empty() { continue; }
            if let Ok(rec) = serde_json::from_str::<RunRecord>(line) {
                records.push(rec);
                if records.len() >= limit { return records; }
            }
        }
    }
    records
}

pub fn get_run(id: &str) -> Option<RunRecord> {
    let all = list_runs(500);
    all.into_iter().find(|r| r.id == id)
}

pub fn append_run(record: &RunRecord) -> Result<(), String> {
    let dir = runs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir runs: {e}"))?;

    let now = chrono::Local::now();
    let filename = now.format("%Y-%m").to_string() + ".jsonl";
    let path = dir.join(filename);

    let line = serde_json::to_string(record)
        .map_err(|e| format!("serialize run: {e}"))?;

    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open log: {e}"))?;
    writeln!(f, "{line}").map_err(|e| format!("write log: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
