use crate::services::launch;
use crate::services::instance_service;
use crate::services::auth::MinecraftProfile;
use crate::util::{paths, credentials};
use std::fs;

#[tauri::command]
pub async fn launch_instance(instance_id: String, window: tauri::WebviewWindow) -> Result<u32, String> {
    // Clear old log file before launching
    let log_path = paths::instances_dir()
        .join(&instance_id)
        .join(".minecraft")
        .join("logs")
        .join("latest.log");
    let _ = fs::write(&log_path, "");

    // Get instance
    let instance = instance_service::get_by_id(&instance_id).await
        .map_err(|e| e.to_string())?;

    // Get active account
    let accounts_path = paths::data_dir().join("accounts.json");
    let (username, uuid, token) = if accounts_path.exists() {
        let content = fs::read_to_string(&accounts_path).map_err(|e| e.to_string())?;
        let mut accounts: Vec<MinecraftProfile> = serde_json::from_str(&content)
            .map_err(|e| e.to_string())?;

        // Decrypt tokens stored encrypted on disk
        for a in accounts.iter_mut() {
            if let Ok(dec) = credentials::decrypt_credential(&a.access_token) {
                a.access_token = dec;
            }
        }

        if let Some(account) = accounts.iter().find(|a| a.active).or(accounts.first()) {
            (
                account.name.clone(),
                account.id.clone(),
                if account.is_offline { "0".to_string() } else { account.access_token.clone() },
            )
        } else {
            return Err("No account found. Please sign in first.".to_string());
        }
    } else {
        return Err("No account found. Please sign in first.".to_string());
    };

    // Launch the game
    let pid = launch::launch(&instance, &username, &uuid, &token, Some(window.clone())).await?;

    // Set Discord Rich Presence to "Playing"
    let loader_name = format!("{:?}", instance.loader.loader_type).to_lowercase();
    crate::services::discord::set_playing(
        &instance.name,
        &instance.game_version,
        &loader_name,
        instance.mods.len(),
    );

    // Update last_played
    let meta_path = paths::instances_dir().join(&instance_id).join("instance.json");
    if let Ok(content) = fs::read_to_string(&meta_path) {
        if let Ok(mut inst) = serde_json::from_str::<crate::models::instance::Instance>(&content) {
            inst.last_played = Some(chrono::Utc::now().to_rfc3339());
            if let Ok(json) = serde_json::to_string_pretty(&inst) {
                let _ = fs::write(&meta_path, json);
            }
        }
    }

    Ok(pid)
}

#[tauri::command]
pub async fn install_mod_to_instance(
    instance_id: String,
    project_id: String,
    loader: String,
    game_version: String,
    category: Option<String>,
) -> Result<String, String> {
    let cat = category.unwrap_or_else(|| "mod".to_string());
    let result = crate::services::mod_install::install_mod(
        &instance_id,
        &project_id,
        &loader,
        &game_version,
        &cat,
    )
    .await?;

    // Return JSON with mod entry + accurate dependency counts/titles, mirroring
    // what Modrinth returns to its frontend so the toast can list installed deps.
    let json = serde_json::json!({
        "mod_entry": result.mod_entry,
        "deps_installed": result.deps_installed.len(),
        "dep_titles": result.dep_titles,
        "issues": result.issues,
    });
    Ok(json.to_string())
}

/// Install a mod from CurseForge into an instance. Same return shape as
/// `install_mod_to_instance` so the frontend reuses the same toast/modal.
#[tauri::command]
pub async fn install_cf_mod_to_instance(
    instance_id: String,
    mod_id: String,
    loader: String,
    game_version: String,
    category: Option<String>,
) -> Result<String, String> {
    let settings = crate::services::settings_service::load()
        .await
        .map_err(|e| format!("Load settings: {}", e))?;

    let cat = category.unwrap_or_else(|| "mod".to_string());
    let api_key = if settings.curseforge_api_key.is_empty() {
        "$2a$10$Vqhx8J1qatEwez9lhg6cjeh1W6RC6H8AtXeLdu7o8H45smb66wCgu".to_string()
    } else {
        settings.curseforge_api_key.clone()
    };
    let result = crate::services::cf_mod_install::install_cf_mod(
        &instance_id,
        &mod_id,
        &loader,
        &game_version,
        &cat,
        &api_key,
    )
    .await?;

    let json = serde_json::json!({
        "mod_entry": result.mod_entry,
        "deps_installed": result.deps_installed.len(),
        "dep_titles": result.dep_titles,
        "issues": result.issues,
    });
    Ok(json.to_string())
}

#[tauri::command]
pub async fn remove_mod_from_instance(
    instance_id: String,
    entry_id: String,
) -> Result<(), String> {
    crate::services::mod_install::remove_mod(&instance_id, &entry_id).await
}

/// Detect available Modrinth updates for every Modrinth-sourced mod in the
/// given instance. Returned map is keyed by `project_id` so the frontend can
/// look up update info per card without scanning a list.
#[tauri::command]
pub async fn check_mod_updates(
    instance_id: String,
) -> Result<std::collections::HashMap<String, crate::services::mod_updates::ModUpdate>, String> {
    let instance = crate::services::instance_service::get_by_id(&instance_id)
        .await
        .map_err(|e| e.to_string())?;
    crate::services::mod_updates::check_updates(&instance).await
}

/// Apply an update for a single project. Removes the old file, downloads the
/// new version, and walks required dependencies. Returns the same shape as
/// `install_mod_to_instance` so the frontend can reuse the issues modal.
#[tauri::command]
pub async fn apply_mod_update(
    instance_id: String,
    project_id: String,
) -> Result<String, String> {
    let result = crate::services::mod_updates::apply_update(&instance_id, &project_id).await?;
    let json = serde_json::json!({
        "mod_entry": result.mod_entry,
        "deps_installed": result.deps_installed.len(),
        "dep_titles": result.dep_titles,
        "issues": result.issues,
    });
    Ok(json.to_string())
}

/// Bulk-delete every content entry in an instance. `category` filters by
/// "mod" / "resourcepack" / "shader" / "datapack", or "all" for every entry.
/// Returns the count removed so the UI can show a confirmation toast.
#[tauri::command]
pub async fn remove_all_content(
    instance_id: String,
    category: String,
) -> Result<usize, String> {
    crate::services::mod_install::remove_all_content(&instance_id, &category).await
}

#[tauri::command]
pub async fn toggle_mod_in_instance(
    instance_id: String,
    entry_id: String,
) -> Result<bool, String> {
    crate::services::mod_install::toggle_mod(&instance_id, &entry_id).await
}

#[tauri::command]
pub async fn get_instance_logs(instance_id: String) -> Result<Vec<String>, String> {
    let log_path = paths::instances_dir()
        .join(&instance_id)
        .join(".minecraft")
        .join("logs")
        .join("latest.log");

    if !log_path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&log_path).map_err(|e| e.to_string())?;
    let lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    Ok(lines)
}

/// Read a crash-report file and return its contents as a string. Path comes
/// from the `game-crashed` event payload (the launcher service emits the
/// most recently written `crash-reports/*.txt` when the JVM exits non-zero).
///
/// Crash reports are typically 5–50 KB; reading them in one go is fine. We
/// resolve them under the configured instances directory so the path can't
/// be used to read arbitrary files even if a malicious payload were
/// constructed somehow.
#[tauri::command]
pub async fn get_crash_report(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    let canonical = p
        .canonicalize()
        .map_err(|e| format!("Resolve crash report path: {}", e))?;
    let instances_dir = paths::instances_dir()
        .canonicalize()
        .map_err(|e| format!("Resolve instances dir: {}", e))?;
    if !canonical.starts_with(&instances_dir) {
        return Err("Crash report path is outside instances dir".to_string());
    }
    fs::read_to_string(&canonical).map_err(|e| format!("Read crash report: {}", e))
}

#[tauri::command]
pub async fn stop_instance() -> Result<(), String> {
    // Kill all java processes spawned by us (simple approach)
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(&["/F", "/IM", "java.exe"])
            .output();
        let _ = std::process::Command::new("taskkill")
            .args(&["/F", "/IM", "javaw.exe"])
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        // On Linux/macOS, kill java processes by name
        let _ = std::process::Command::new("pkill")
            .args(&["-f", "java"])
            .output();
    }
    Ok(())
}

#[tauri::command]
pub async fn minimize_to_tray(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}
