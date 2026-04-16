mod parse;
mod write;

pub use parse::{parse_skill_md, parse_skill_md_str, ParsedSkill, GraphBlock, SkillInput, SkillOutput, GraphNode, DriftStatus};
pub use write::write_graph_block;

/// The orka:graph schema version this build understands.
pub const SCHEMA_VERSION: u32 = 1;

/// List skill directories found in `~/.claude/skills/`.
/// Returns (slug, path) pairs.
pub fn list_skill_dirs() -> Vec<(String, String)> {
    let Some(dir) = dirs::home_dir().map(|h| h.join(".claude").join("skills")) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join("SKILL.md").exists() {
            let slug = path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            if !slug.is_empty() && !slug.starts_with('.') {
                result.push((slug, path.to_string_lossy().to_string()));
            }
        }
    }
    result.sort_by(|a, b| a.0.cmp(&b.0));
    result
}
