//! Per-feature model selection. Lets the user override which Claude
//! model Orka uses for different feature classes without forking code.
//!
//! Defaults:
//!   - brief         → haiku (simple JSON extraction, needs speed, not smarts)
//!   - synthesis     → claude-opus-4-7[1m] (cross-source reasoning benefits
//!                     massively from Opus's 1M context window)
//!   - skill_run     → claude-opus-4-7[1m] (user-facing runs deserve the best)
//!   - evolution     → claude-opus-4-7[1m] (SKILL.md rewrites need nuance)
//!
//! Storage: ~/.orka/model-config.json. Safe to delete — defaults
//! restored next read. Tauri commands get_model_config / set_model_config
//! let the frontend wire up a Settings UI.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    pub brief: String,
    pub synthesis: String,
    #[serde(rename = "skillRun")]
    pub skill_run: String,
    pub evolution: String,
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            brief: "haiku".into(),
            synthesis: "claude-opus-4-7[1m]".into(),
            skill_run: "claude-opus-4-7[1m]".into(),
            evolution: "claude-opus-4-7[1m]".into(),
        }
    }
}

fn config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".orka").join("model-config.json"))
}

fn load() -> ModelConfig {
    let Some(path) = config_path() else { return ModelConfig::default(); };
    let Ok(text) = std::fs::read_to_string(&path) else { return ModelConfig::default(); };
    // Use Value first so missing fields fall back to defaults field-by-field.
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return ModelConfig::default();
    };
    let d = ModelConfig::default();
    ModelConfig {
        brief: v.get("brief").and_then(|s| s.as_str()).unwrap_or(&d.brief).to_string(),
        synthesis: v.get("synthesis").and_then(|s| s.as_str()).unwrap_or(&d.synthesis).to_string(),
        skill_run: v
            .get("skillRun")
            .and_then(|s| s.as_str())
            .unwrap_or(&d.skill_run)
            .to_string(),
        evolution: v
            .get("evolution")
            .and_then(|s| s.as_str())
            .unwrap_or(&d.evolution)
            .to_string(),
    }
}

fn save(cfg: &ModelConfig) -> Result<(), String> {
    let Some(path) = config_path() else { return Err("no home dir".into()) };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))
}

#[tauri::command]
pub fn get_model_config() -> ModelConfig {
    load()
}

#[tauri::command]
pub fn set_model_config(config: ModelConfig) -> Result<(), String> {
    save(&config)
}

/// Rust-facing helpers. Each callsite asks for the model it needs; if
/// the user hasn't customized, they get the default.
pub fn model_for_brief() -> String {
    load().brief
}

pub fn model_for_synthesis() -> String {
    load().synthesis
}

pub fn model_for_skill_run() -> String {
    load().skill_run
}

pub fn model_for_evolution() -> String {
    load().evolution
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_stable() {
        let d = ModelConfig::default();
        assert_eq!(d.brief, "haiku");
        assert_eq!(d.synthesis, "claude-opus-4-7[1m]");
        assert_eq!(d.skill_run, "claude-opus-4-7[1m]");
        assert_eq!(d.evolution, "claude-opus-4-7[1m]");
    }
}
