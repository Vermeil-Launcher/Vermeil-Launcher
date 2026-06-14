use crate::services::launch;
use crate::services::instance_service;
use crate::services::auth::MinecraftProfile;
use crate::util::{paths, credentials};
use std::fs;
use std::sync::atomic::{AtomicU32, AtomicBool, Ordering};

/// PID of the currently running game process. 0 means no game is running.
pub static GAME_PID: AtomicU32 = AtomicU32::new(0);
/// Set to `true` when the user clicks "Stop" so the exit handler knows
/// not to emit `game-crashed` for the non-zero exit code that results
/// from a graceful termination signal.
static USER_STOPPED: AtomicBool = AtomicBool::new(false);

/// Check whether the user requested a stop (and clear the flag).
pub fn take_user_stopped() -> bool {
    USER_STOPPED.swap(false, Ordering::SeqCst)
}

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
    GAME_PID.store(pid, Ordering::SeqCst);
    USER_STOPPED.store(false, Ordering::SeqCst);

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
    let pid = GAME_PID.load(Ordering::SeqCst);
    if pid == 0 {
        return Err("No game is running".to_string());
    }

    // Mark that the user intentionally stopped the game, so the exit
    // handler (in launch.rs background task) won't emit `game-crashed`.
    USER_STOPPED.store(true, Ordering::SeqCst);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Send a graceful close (WM_CLOSE via taskkill without /F).
        // This triggers Minecraft's shutdown hook: saves worlds, flushes
        // chunks, closes connections — same as clicking the window X button.
        // CREATE_NO_WINDOW prevents the brief black console flash.
        let _ = std::process::Command::new("taskkill")
            .args(&["/PID", &pid.to_string()])
            .creation_flags(crate::services::java::CREATE_NO_WINDOW)
            .output();

        // Wait up to 10s for the process to exit gracefully.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            // Check if process still exists
            let check = std::process::Command::new("tasklist")
                .args(&["/FI", &format!("PID eq {}", pid), "/NH", "/FO", "CSV"])
                .creation_flags(crate::services::java::CREATE_NO_WINDOW)
                .output();
            if let Ok(output) = check {
                let out = String::from_utf8_lossy(&output.stdout);
                if !out.contains(&pid.to_string()) {
                    // Process exited
                    break;
                }
            }
            if std::time::Instant::now() >= deadline {
                // Force-kill as last resort
                tracing::warn!("Game PID {} didn't exit gracefully after 10s, force-killing", pid);
                let _ = std::process::Command::new("taskkill")
                    .args(&["/F", "/PID", &pid.to_string()])
                    .creation_flags(crate::services::java::CREATE_NO_WINDOW)
                    .output();
                break;
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Send SIGTERM for graceful shutdown (triggers JVM shutdown hooks).
        let _ = std::process::Command::new("kill")
            .args(&["-TERM", &pid.to_string()])
            .output();

        // Wait up to 10s, then force-kill.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let check = std::process::Command::new("kill")
                .args(&["-0", &pid.to_string()])
                .output();
            if let Ok(output) = check {
                if !output.status.success() {
                    // Process no longer exists
                    break;
                }
            }
            if std::time::Instant::now() >= deadline {
                tracing::warn!("Game PID {} didn't exit gracefully after 10s, force-killing", pid);
                let _ = std::process::Command::new("kill")
                    .args(&["-9", &pid.to_string()])
                    .output();
                break;
            }
        }
    }

    GAME_PID.store(0, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn minimize_to_tray(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

/// Resolve the full JVM argument string for a given instance's GC preset and
/// memory allocation. Used by the frontend to display the resolved flags in
/// the per-instance Java arguments field so users see exactly what's applied.
#[tauri::command]
pub async fn get_resolved_jvm_args(instance_id: String) -> Result<String, String> {
    let instance = crate::services::instance_service::get_by_id(&instance_id)
        .await
        .map_err(|e| e.to_string())?;

    let settings = crate::services::settings_service::load()
        .await
        .map_err(|e| format!("Load settings: {}", e))?;

    let java_major = crate::services::launch::required_java_version(&instance.game_version);
    let gc_preset = settings.gc_preset.as_str();
    let gc_flags = crate::services::launch::resolve_gc_flags(gc_preset, java_major, instance.java.memory_max_mb);

    // Build the full resolved string: -Xmx, -Xms, GC flags, then user extra args
    let mut all_args = vec![
        format!("-Xmx{}m", instance.java.memory_max_mb),
        format!("-Xms{}m", instance.java.memory_min_mb),
    ];
    all_args.extend(gc_flags);
    all_args.extend(instance.java.extra_args.iter().filter(|a| !a.is_empty()).cloned());

    Ok(all_args.join(" "))
}

/// Resolve just the *preset* JVM arguments (memory + GC flags) for an instance,
/// without the user's extra args. Returned as a list so the frontend can
/// render each flag on its own line in the args editor. Extras are already
/// available client-side in `instance.java.extra_args`.
#[tauri::command]
pub async fn get_preset_jvm_args(instance_id: String) -> Result<Vec<String>, String> {
    let instance = crate::services::instance_service::get_by_id(&instance_id)
        .await
        .map_err(|e| e.to_string())?;

    let settings = crate::services::settings_service::load()
        .await
        .map_err(|e| format!("Load settings: {}", e))?;

    let java_major = crate::services::launch::required_java_version(&instance.game_version);
    let gc_flags = crate::services::launch::resolve_gc_flags(
        &settings.gc_preset,
        java_major,
        instance.java.memory_max_mb,
    );

    let mut preset = vec![
        format!("-Xmx{}m", instance.java.memory_max_mb),
        format!("-Xms{}m", instance.java.memory_min_mb),
    ];
    preset.extend(gc_flags);
    Ok(preset)
}
