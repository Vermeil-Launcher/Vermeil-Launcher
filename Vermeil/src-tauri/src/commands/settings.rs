use crate::models::settings::LauncherSettings;
use crate::services::settings_service;

#[tauri::command]
pub async fn get_settings() -> Result<LauncherSettings, String> {
    settings_service::load()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_settings(settings: LauncherSettings) -> Result<(), String> {
    settings_service::save(&settings)
        .await
        .map_err(|e| e.to_string())
}

/// The launcher's root data directory as a display string for the current
/// platform (Windows `%LOCALAPPDATA%\Vermeil`, Linux `~/.local/share/Vermeil`,
/// macOS `~/Library/Application Support/Vermeil`). The Resources tab shows this
/// so the path matches reality instead of a hardcoded Windows string.
#[tauri::command]
pub async fn get_app_directory() -> Result<String, String> {
    Ok(paths::data_dir().to_string_lossy().to_string())
}

/// Open the launcher's data directory in the OS file manager.
#[tauri::command]
pub async fn open_app_directory() -> Result<(), String> {
    let dir = paths::data_dir();
    if dir.exists() {
        open::that(&dir).map_err(|e| format!("Failed to open {}: {}", dir.display(), e))?;
    }
    Ok(())
}

use crate::util::paths;
use std::fs;

/// Calculate the total size of all purgeable caches.
///
/// Includes:
/// - `meta/` — version metadata JSONs, loader metadata
/// - `loader-scratch/` — Forge/NeoForge installer artifacts and processor outputs
/// - `icons/` — cached project icon images
/// - `versions/` — cached vanilla client JARs
/// - `assets/indexes/` — asset index JSONs
///
/// Does NOT include (too expensive to re-download or user data):
/// - `libraries/` — shared Java libraries across all instances
/// - `assets/objects/` — shared game assets (sounds, textures, 1-2GB)
/// - `java/` — Java runtimes
/// - `instances/` — user worlds, mods, configs
/// - `accounts.json`, `config.json` — user credentials and settings
#[tauri::command]
pub async fn get_cache_size() -> Result<u64, String> {
    let data = paths::data_dir();
    let mut total: u64 = 0;

    // Version + loader metadata
    let meta_dir = paths::meta_dir();
    if meta_dir.exists() {
        total += dir_size(&meta_dir);
    }

    // Loader scratch directories (installer artifacts, processor outputs)
    let scratch_dir = data.join("loader-scratch");
    if scratch_dir.exists() {
        total += dir_size(&scratch_dir);
    }

    // Cached project icons
    let icons_dir = data.join("icons");
    if icons_dir.exists() {
        total += dir_size(&icons_dir);
    }

    // Cached vanilla client JARs
    let versions_dir = data.join("versions");
    if versions_dir.exists() {
        total += dir_size(&versions_dir);
    }

    // Asset index JSONs (not the objects — those are too large)
    let indexes_dir = paths::assets_dir().join("indexes");
    if indexes_dir.exists() {
        total += dir_size(&indexes_dir);
    }

    Ok(total)
}

/// Purge all purgeable caches. Returns the number of bytes freed.
///
/// After purging, the next instance launch will re-download version
/// metadata, client JARs, asset indexes, and project icons as needed.
/// Forge/NeoForge instances will re-run their installer on next launch.
#[tauri::command]
pub async fn purge_cache() -> Result<u64, String> {
    let data = paths::data_dir();
    let mut freed: u64 = 0;

    // Version + loader metadata
    let meta_dir = paths::meta_dir();
    if meta_dir.exists() {
        freed += dir_size(&meta_dir);
        let _ = fs::remove_dir_all(&meta_dir);
    }

    // Loader scratch directories
    let scratch_dir = data.join("loader-scratch");
    if scratch_dir.exists() {
        freed += dir_size(&scratch_dir);
        let _ = fs::remove_dir_all(&scratch_dir);
    }

    // Cached project icons
    let icons_dir = data.join("icons");
    if icons_dir.exists() {
        freed += dir_size(&icons_dir);
        let _ = fs::remove_dir_all(&icons_dir);
    }

    // Cached vanilla client JARs
    let versions_dir = data.join("versions");
    if versions_dir.exists() {
        freed += dir_size(&versions_dir);
        let _ = fs::remove_dir_all(&versions_dir);
    }

    // Asset index JSONs
    let indexes_dir = paths::assets_dir().join("indexes");
    if indexes_dir.exists() {
        freed += dir_size(&indexes_dir);
        let _ = fs::remove_dir_all(&indexes_dir);
    }

    Ok(freed)
}

fn dir_size(path: &std::path::Path) -> u64 {
    let mut size: u64 = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                size += dir_size(&p);
            } else if let Ok(meta) = p.metadata() {
                size += meta.len();
            }
        }
    }
    size
}

/// Get total system memory in MB.
#[tauri::command]
pub async fn get_system_memory() -> Result<u64, String> {
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_memory();
    Ok(sys.total_memory() / 1024 / 1024) // bytes → MB
}

/// Load persisted download history from disk.
#[tauri::command]
pub async fn load_download_history() -> Result<String, String> {
    let path = paths::data_dir().join("download_history.json");
    if !path.exists() {
        return Ok("[]".to_string());
    }
    fs::read_to_string(&path).map_err(|e| format!("Failed to read download history: {}", e))
}

/// Save download history to disk (capped at 200 entries by the frontend).
#[tauri::command]
pub async fn save_download_history(json: String) -> Result<(), String> {
    let path = paths::data_dir().join("download_history.json");
    fs::create_dir_all(paths::data_dir()).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("Failed to write download history: {}", e))
}
