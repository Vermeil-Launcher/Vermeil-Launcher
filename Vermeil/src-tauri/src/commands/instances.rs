use crate::models::instance::{Instance, CreateInstanceConfig};
use crate::services::instance_service;
use crate::services::instance_cape;
use crate::models::settings::IngameCapeSettings;

#[tauri::command]
pub async fn list_instances() -> Result<Vec<Instance>, String> {
    instance_service::list_all()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_instance(config: CreateInstanceConfig) -> Result<Instance, String> {
    let instance = instance_service::create(config)
        .await
        .map_err(|e| e.to_string())?;
    // Auto-pin the first few instances a user creates so the dock is useful
    // out of the box (no-op once the pin cap is reached).
    crate::services::settings_service::auto_pin_instance(&instance.id).await;
    Ok(instance)
}

#[tauri::command]
pub async fn get_instance(id: String) -> Result<Instance, String> {
    instance_service::get_by_id(&id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_instance(id: String) -> Result<(), String> {
    let instance_dir = crate::util::paths::instances_dir().join(&id);
    if instance_dir.exists() {
        std::fs::remove_dir_all(&instance_dir).map_err(|e| format!("Failed to delete: {}", e))?;
    }

    // Strip the deleted instance from the sidebar pin list so the badge
    // doesn't keep counting a ghost pin. Best-effort — failures here
    // shouldn't block the delete itself, the next launch's startup sweep
    // catches anything that slips through.
    if let Ok(mut settings) = crate::services::settings_service::load().await {
        let before = settings.sidebar_pinned_instances.len();
        settings.sidebar_pinned_instances.retain(|pinned| pinned != &id);
        if settings.sidebar_pinned_instances.len() != before {
            let _ = crate::services::settings_service::save(&settings).await;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn update_instance_memory(id: String, memory_max_mb: u32) -> Result<(), String> {
    let meta_path = crate::util::paths::instances_dir().join(&id).join("instance.json");
    let content = std::fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: crate::models::instance::Instance = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    instance.java.memory_max_mb = memory_max_mb;
    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    crate::util::paths::atomic_write(&meta_path, json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn install_modpack(
    project_id: String,
    version_id: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<crate::models::instance::Instance, String> {
    let instance = crate::services::modpack::install_from_modrinth(
        &project_id,
        version_id.as_deref(),
        Some(window),
    )
    .await?;
    crate::services::settings_service::auto_pin_instance(&instance.id).await;
    Ok(instance)
}

#[tauri::command]
pub async fn install_cf_modpack(
    project_id: String,
    file_id: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<crate::models::instance::Instance, String> {
    let instance = crate::services::modpack::install_from_curseforge(
        &project_id,
        file_id.as_deref(),
        Some(window),
    )
    .await?;
    crate::services::settings_service::auto_pin_instance(&instance.id).await;
    Ok(instance)
}

#[tauri::command]
pub async fn update_instance_options(
    id: String,
    memory_max_mb: Option<u32>,
    width: Option<u32>,
    height: Option<u32>,
    extra_args: Option<Vec<String>>,
    adaptive_override: Option<bool>,
) -> Result<(), String> {
    let meta_path = crate::util::paths::instances_dir().join(&id).join("instance.json");
    let content = std::fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: crate::models::instance::Instance = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    if let Some(mem) = memory_max_mb { instance.java.memory_max_mb = mem; }
    if let Some(w) = width { instance.window.width = w; }
    if let Some(h) = height { instance.window.height = h; }
    if let Some(args) = extra_args { instance.java.extra_args = args; }
    if let Some(ovr) = adaptive_override { instance.java.adaptive_override = ovr; }

    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    crate::util::paths::atomic_write(&meta_path, json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn rename_instance(id: String, new_name: String) -> Result<(), String> {
    let meta_path = crate::util::paths::instances_dir().join(&id).join("instance.json");
    let content = std::fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: crate::models::instance::Instance = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    instance.name = new_name.trim().to_string();
    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    crate::util::paths::atomic_write(&meta_path, json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Set a user-supplied image as the instance's tile icon.
///
/// `source_path` is an absolute path to a local image file picked by the
/// user (the frontend opens a file dialog and hands us the path back). We
/// copy it into the instance's own directory so the icon survives across
/// re-imports and isn't tied to wherever the user happened to keep the
/// original. Stored at `instances/<id>/icon.png` regardless of the source
/// extension — the webview decodes by content, not extension.
///
/// Returns the absolute destination path so the frontend can immediately
/// re-render with the new icon (via `convertFileSrc`) without waiting for
/// `list_instances` to re-fetch.
#[tauri::command]
pub async fn set_instance_icon(id: String, source_path: String) -> Result<String, String> {
    let instance_dir = crate::util::paths::instances_dir().join(&id);
    let meta_path = instance_dir.join("instance.json");

    if !meta_path.exists() {
        return Err(format!("Instance {} not found", id));
    }

    // Validate source exists and is readable as an image-like file. We don't
    // try to validate the file is a real PNG/JPG — the frontend's file
    // dialog already filters by extension, and the webview's `<img>` will
    // simply fail to render anything weird, leaving the fallback in place.
    let src = std::path::Path::new(&source_path);
    if !src.exists() {
        return Err(format!("Source file not found: {}", source_path));
    }

    let dest = instance_dir.join("icon.png");

    // Copy bytes. We don't try to convert formats — most modpack icons are
    // PNG anyway and the webview decodes JPG / WebP transparently regardless
    // of the `.png` extension.
    std::fs::copy(src, &dest).map_err(|e| format!("Copy icon: {}", e))?;

    // Update instance.json to point at the new icon.
    let content = std::fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: crate::models::instance::Instance =
        serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let dest_str = strip_extended_prefix(&dest.to_string_lossy());
    instance.icon = dest_str.clone();

    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    std::fs::write(&meta_path, json).map_err(|e| e.to_string())?;

    // Return a data URL so the frontend can render immediately without
    // needing the asset protocol. Same pattern as the icon cache.
    let bytes = std::fs::read(&dest).map_err(|e| format!("Read icon: {}", e))?;
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    Ok(format!("data:image/png;base64,{}", encoded))
}

/// Reset an instance's tile icon back to the generic placeholder. Removes
/// the on-disk `icon.png` if it exists and writes the sentinel `"cube"` value
/// into `instance.json` so the frontend falls back to the loader-tinted
/// default banner.
#[tauri::command]
pub async fn clear_instance_icon(id: String) -> Result<(), String> {
    let instance_dir = crate::util::paths::instances_dir().join(&id);
    let meta_path = instance_dir.join("instance.json");

    if !meta_path.exists() {
        return Err(format!("Instance {} not found", id));
    }

    let icon_file = instance_dir.join("icon.png");
    if icon_file.exists() {
        let _ = std::fs::remove_file(&icon_file);
    }

    let content = std::fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: crate::models::instance::Instance =
        serde_json::from_str(&content).map_err(|e| e.to_string())?;

    instance.icon = "cube".to_string();

    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    std::fs::write(&meta_path, json).map_err(|e| e.to_string())?;

    Ok(())
}

/// Strip the Windows `\\?\` extended-length prefix from a path so the value
/// crossing the IPC boundary uses the friendly form (`C:\Users\...`).
/// Same idea as `services::java::strip_extended_prefix` but kept local to
/// avoid a backend-wide dependency from this command module.
fn strip_extended_prefix(s: &str) -> String {
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        s.to_string()
    }
}

/// Duplicate an instance's full directory tree (mods, worlds, configs,
/// resource packs, etc.) into a new instance with a fresh UUID and a unique
/// name. Used by the Library / Settings "Clone instance" button.
#[tauri::command]
pub async fn clone_instance(
    id: String,
    new_name: Option<String>,
) -> Result<crate::models::instance::Instance, String> {
    instance_service::clone_instance(&id, new_name)
        .await
        .map_err(|e| e.to_string())
}

/// Pre-download all files needed to launch an instance.
/// Emits `install-progress` events for real-time progress display.
/// On failure, deletes the instance directory so no broken instance lingers.
#[tauri::command]
pub async fn prepare_instance(id: String, window: tauri::WebviewWindow) -> Result<(), String> {
    let instance = instance_service::get_by_id(&id).await.map_err(|e| e.to_string())?;
    if let Err(e) = crate::services::prepare::prepare(&instance, Some(window)).await {
        // Clean up the broken instance so the library doesn't show a non-launchable entry.
        let instance_dir = crate::util::paths::instances_dir().join(&id);
        if instance_dir.exists() {
            tracing::error!("Instance prepare failed, cleaning up {}: {}", id, e);
            let _ = std::fs::remove_dir_all(&instance_dir);
        }
        return Err(e);
    }
    Ok(())
}

// ───────────────────────── In-game cape ─────────────────────────────────

/// Set the in-game custom cape: store the baked cape (a square frame, or a
/// vertical strip of square frames for an animation) and turn it on. The
/// launcher stores it once in the global cape dir and points supported instances
/// at it via a JVM property at launch — no per-instance copies, no selection.
/// `cape_id` records which library cape this is (UI only); `frame_time_ms` is
/// the per-frame duration for animated strips.
#[tauri::command]
pub async fn set_ingame_cape(
    cape_id: Option<String>,
    strip_png: Vec<u8>,
    frame_time_ms: Option<u32>,
) -> Result<(), String> {
    instance_cape::set_ingame_cape(cape_id, &strip_png, frame_time_ms).await
}

/// Toggle the in-game cape on/off without re-baking it.
#[tauri::command]
pub async fn set_ingame_cape_enabled(enabled: bool) -> Result<(), String> {
    instance_cape::set_ingame_cape_enabled(enabled).await
}

/// Remove the in-game cape entirely.
#[tauri::command]
pub async fn clear_ingame_cape() -> Result<(), String> {
    instance_cape::clear_ingame_cape().await
}

/// Read the current in-game cape state, or `None` if none is set.
#[tauri::command]
pub async fn get_ingame_cape() -> Result<Option<IngameCapeSettings>, String> {
    Ok(instance_cape::get_ingame_cape().await)
}
