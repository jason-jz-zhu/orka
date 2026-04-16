use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::skill_md;

#[derive(Debug, Clone, Serialize)]
pub struct SkillMeta {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: SkillSource,
    pub has_graph: bool,
    pub inputs: Vec<SkillInputMeta>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillInputMeta {
    pub name: String,
    #[serde(rename = "type")]
    pub input_type: String,
    pub default: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillSource {
    Global,
    Workspace,
    Sibling,
}

pub fn scan_skills_dirs() -> Vec<SkillMeta> {
    let mut results = Vec::new();
    let mut seen_slugs = std::collections::HashSet::new();

    if let Some(global) = global_skills_dir() {
        scan_dir(&global, SkillSource::Global, &mut results, &mut seen_slugs);
    }

    if let Some(ws) = workspace_skills_dir() {
        scan_dir(&ws, SkillSource::Workspace, &mut results, &mut seen_slugs);
    }

    results
}

fn global_skills_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("skills"))
}

fn workspace_skills_dir() -> Option<PathBuf> {
    let ws = crate::workspace::templates_dir();
    let ws_root = ws.parent()?;
    Some(ws_root.join(".claude").join("skills"))
}

fn scan_dir(
    dir: &Path,
    source: SkillSource,
    results: &mut Vec<SkillMeta>,
    seen: &mut std::collections::HashSet<String>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        let skill_md_path = path.join("SKILL.md");
        if !skill_md_path.exists() { continue; }

        let slug = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if slug.is_empty() || slug.starts_with('.') { continue; }
        if seen.contains(&slug) { continue; }

        if let Ok(parsed) = skill_md::parse_skill_md(&skill_md_path) {
            seen.insert(slug.clone());
            let inputs = parsed.inputs.iter().map(|i| SkillInputMeta {
                name: i.name.clone(),
                input_type: i.input_type.clone(),
                default: i.default.clone(),
                description: i.description.clone(),
            }).collect();
            results.push(SkillMeta {
                slug,
                name: parsed.name,
                description: parsed.description,
                path: skill_md_path.to_string_lossy().to_string(),
                source: source.clone(),
                has_graph: parsed.graph.is_some(),
                inputs,
            });
        }
    }
}

pub fn get_skill(slug: &str) -> Result<SkillMeta, String> {
    let all = scan_skills_dirs();
    all.into_iter()
        .find(|s| s.slug == slug)
        .ok_or_else(|| format!("skill '{}' not found", slug))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_scan_empty_dir() {
        let dir = std::env::temp_dir().join("orka_test_skills_empty");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut results = Vec::new();
        let mut seen = std::collections::HashSet::new();
        scan_dir(&dir, SkillSource::Global, &mut results, &mut seen);
        assert!(results.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_scan_with_skill() {
        let dir = std::env::temp_dir().join("orka_test_skills_one");
        let _ = fs::remove_dir_all(&dir);
        let skill_dir = dir.join("test-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "---\nname: test-skill\ndescription: A test skill.\norka:\n  schema: 1\n---\n\n# Test\n\nDo stuff.\n").unwrap();

        let mut results = Vec::new();
        let mut seen = std::collections::HashSet::new();
        scan_dir(&dir, SkillSource::Global, &mut results, &mut seen);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].slug, "test-skill");
        assert_eq!(results[0].description, "A test skill.");
        assert!(!results[0].has_graph);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_scan_deduplicates() {
        let dir = std::env::temp_dir().join("orka_test_skills_dedup");
        let _ = fs::remove_dir_all(&dir);
        let skill_dir = dir.join("my-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "---\nname: my-skill\ndescription: dedup test\norka:\n  schema: 1\n---\n\nBody.\n").unwrap();

        let mut results = Vec::new();
        let mut seen = std::collections::HashSet::new();
        scan_dir(&dir, SkillSource::Global, &mut results, &mut seen);
        scan_dir(&dir, SkillSource::Workspace, &mut results, &mut seen);
        assert_eq!(results.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
