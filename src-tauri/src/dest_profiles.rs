//! User-configured destination profiles (Notion / WeChat Work / Telegram /
//! etc). Stored as JSON in `~/OrkaCanvas/.destinations.json` with
//! 0600 permissions on macOS so other users on the machine can't read tokens.
//!
//! NOTE: this is plaintext local storage — fine for a local-first dev tool
//! but consider migrating to macOS Keychain if Orka grows.

use crate::workspace;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProfileConfig {
    /// 企业微信 group bot webhook
    WechatWork { webhook_url: String },
    /// Notion integration token + parent page id
    Notion { token: String, parent_page_id: String },
    /// Telegram bot
    Telegram { bot_token: String, chat_id: String },
    /// Generic webhook (already has node-level support but profiles are nicer)
    Webhook { url: String, headers: Option<String> },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DestinationProfile {
    pub id: String,
    pub name: String,
    /// Unix-ms when the user last successfully tested or sent.
    pub last_used_ms: Option<u64>,
    pub config: ProfileConfig,
}

fn profiles_path() -> PathBuf {
    // Stored under the OrkaCanvas root (not per-workspace) so profiles
    // are global across projects.
    let root = workspace::workspace_root()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("OrkaCanvas")
        });
    root.join(".destinations.json")
}

fn read_all() -> Vec<DestinationProfile> {
    let p = profiles_path();
    let Ok(text) = std::fs::read_to_string(&p) else {
        return vec![];
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_all(profiles: &[DestinationProfile]) -> Result<(), String> {
    let p = profiles_path();
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(profiles).map_err(|e| e.to_string())?;
    std::fs::write(&p, text).map_err(|e| e.to_string())?;
    // Tighten perms on macOS so credentials aren't world-readable.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
pub fn list_destination_profiles() -> Vec<DestinationProfile> {
    read_all()
}

#[tauri::command]
pub fn save_destination_profile(profile: DestinationProfile) -> Result<(), String> {
    let mut all = read_all();
    if let Some(existing) = all.iter_mut().find(|p| p.id == profile.id) {
        *existing = profile;
    } else {
        all.push(profile);
    }
    write_all(&all)
}

#[tauri::command]
pub fn delete_destination_profile(id: String) -> Result<(), String> {
    let mut all = read_all();
    let before = all.len();
    all.retain(|p| p.id != id);
    if all.len() == before {
        return Err(format!("profile {id} not found"));
    }
    write_all(&all)
}

#[tauri::command]
pub fn get_destination_profile(id: String) -> Option<DestinationProfile> {
    read_all().into_iter().find(|p| p.id == id)
}

// ---- WeChat Work (企业微信) helpers ------------------------------------

/// Send an arbitrary text body to a WeChat Work group bot. Format is
/// "markdown" | "text". Returns a short summary string.
async fn wework_send_inner(
    webhook_url: &str,
    body: &str,
    format: &str,
) -> Result<String, String> {
    if !webhook_url.starts_with("https://qyapi.weixin.qq.com/")
        && !webhook_url.starts_with("http://")
        && !webhook_url.starts_with("https://")
    {
        return Err("invalid WeChat Work webhook URL".into());
    }
    let payload = match format {
        "text" => serde_json::json!({
            "msgtype": "text",
            "text": { "content": body },
        }),
        _ => serde_json::json!({
            "msgtype": "markdown",
            "markdown": { "content": body },
        }),
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(webhook_url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("POST: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), text));
    }
    // WeChat returns { errcode: 0, errmsg: "ok" } on success even with HTTP 200.
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(code) = v.get("errcode").and_then(|x| x.as_i64()) {
            if code != 0 {
                let msg = v
                    .get("errmsg")
                    .and_then(|x| x.as_str())
                    .unwrap_or("unknown");
                return Err(format!("errcode={code}: {msg}"));
            }
        }
    }
    Ok(format!("HTTP {} · sent", status.as_u16()))
}

#[tauri::command]
pub async fn test_wework_webhook(webhook_url: String) -> Result<String, String> {
    wework_send_inner(
        &webhook_url,
        "🎉 *Orka 测试消息*\n如果你看到这条消息，说明 Orka 已成功连接到这个群机器人。",
        "markdown",
    )
    .await
}

#[tauri::command]
pub async fn send_via_profile(
    profile_id: String,
    body: String,
) -> Result<String, String> {
    let profile = read_all()
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("profile {profile_id} not found"))?;
    let result = match &profile.config {
        ProfileConfig::WechatWork { webhook_url } => {
            wework_send_inner(webhook_url, &body, "markdown").await
        }
        ProfileConfig::Webhook { url, headers } => {
            crate::destinations::post_to_webhook(url.clone(), headers.clone(), body).await
        }
        ProfileConfig::Notion { .. } => {
            Err("Notion delivery not implemented yet".into())
        }
        ProfileConfig::Telegram { .. } => {
            Err("Telegram delivery not implemented yet".into())
        }
    };
    if result.is_ok() {
        // Update last_used_ms.
        let mut all = read_all();
        if let Some(p) = all.iter_mut().find(|p| p.id == profile_id) {
            p.last_used_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_millis() as u64);
            let _ = write_all(&all);
        }
    }
    result
}
