use crate::util::paths;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: String,
}

#[derive(Serialize)]
pub struct WorldEntry {
    pub name: String,
    pub folder_name: String,
    pub size_mb: f64,
    pub last_played: String,
    pub game_mode: String,
}

#[tauri::command]
pub async fn list_instance_files(instance_id: String, sub_path: Option<String>) -> Result<Vec<FileEntry>, String> {
    let base = paths::instances_dir().join(&instance_id).join(".minecraft");
    let dir = match &sub_path {
        Some(p) => base.join(p),
        None => base,
    };

    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(&dir).map_err(|e| e.to_string())?;

    for entry in read_dir.flatten() {
        let meta = entry.metadata().unwrap_or_else(|_| fs::metadata(entry.path()).unwrap());
        let modified = meta.modified()
            .map(|t| {
                let duration = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                chrono::DateTime::from_timestamp(duration.as_secs() as i64, 0)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default()
            })
            .unwrap_or_default();

        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().strip_prefix(&paths::instances_dir().join(&instance_id).join(".minecraft"))
                .unwrap_or(entry.path().as_path())
                .to_string_lossy().to_string().replace('\\', "/"),
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified,
        });
    }

    // Sort: directories first, then alphabetical
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub async fn list_instance_worlds(instance_id: String) -> Result<Vec<WorldEntry>, String> {
    let saves_dir = paths::instances_dir().join(&instance_id).join(".minecraft").join("saves");

    if !saves_dir.exists() {
        return Ok(Vec::new());
    }

    let mut worlds = Vec::new();

    for entry in fs::read_dir(&saves_dir).map_err(|e| e.to_string())?.flatten() {
        if !entry.path().is_dir() { continue; }

        let folder_name = entry.file_name().to_string_lossy().to_string();
        let world_dir = entry.path();

        // Try to read level.dat for world name (simplified — just use folder name)
        let name = folder_name.clone();

        // Calculate directory size
        let size = dir_size(&world_dir);
        let size_mb = size as f64 / (1024.0 * 1024.0);

        // Get last modified time
        let last_played = fs::metadata(&world_dir)
            .and_then(|m| m.modified())
            .map(|t| {
                let duration = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                chrono::DateTime::from_timestamp(duration.as_secs() as i64, 0)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default()
            })
            .unwrap_or_default();

        worlds.push(WorldEntry {
            name,
            folder_name,
            size_mb: (size_mb * 10.0).round() / 10.0,
            last_played,
            game_mode: "Survival".to_string(), // Would need NBT parsing for real value
        });
    }

    // Sort by last played (most recent first)
    worlds.sort_by(|a, b| b.last_played.cmp(&a.last_played));

    Ok(worlds)
}

fn dir_size(path: &PathBuf) -> u64 {
    let mut size = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let meta = entry.metadata().unwrap_or_else(|_| fs::metadata(entry.path()).unwrap());
            if meta.is_dir() {
                size += dir_size(&entry.path());
            } else {
                size += meta.len();
            }
        }
    }
    size
}

#[tauri::command]
pub async fn open_instance_folder(instance_id: String, sub_path: Option<String>) -> Result<(), String> {
    let base = paths::instances_dir().join(&instance_id).join(".minecraft");
    let dir = match &sub_path {
        Some(p) => base.join(p),
        None => base,
    };

    if dir.exists() {
        let _ = open::that(&dir);
    }
    Ok(())
}
