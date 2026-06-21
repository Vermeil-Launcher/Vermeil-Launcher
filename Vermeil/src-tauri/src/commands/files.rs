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
    /// The world's `icon.png` (the in-game world thumbnail) as a
    /// `data:image/png;base64,...` URL, or `None` when the world has no icon
    /// yet. Re-read on every listing so a changed icon shows up automatically.
    pub icon: Option<String>,
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

        // Display name from level.dat's LevelName (reflects in-game renames);
        // falls back to the folder name when level.dat is missing/unreadable.
        let name = read_world_name(&world_dir, &folder_name);

        // World thumbnail (saves/<world>/icon.png), inlined as a data URL.
        let icon = read_world_icon(&world_dir);

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
            icon,
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

/// Read a world's `icon.png` (the in-game thumbnail) and return it as a
/// `data:image/png;base64,...` URL. Returns `None` when the world has no icon
/// (never opened, or a dimension-only folder). Icons are small (64×64), so
/// inlining is cheap and avoids exposing the saves path over the asset
/// protocol.
fn read_world_icon(world_dir: &std::path::Path) -> Option<String> {
    use base64::Engine;
    let bytes = fs::read(world_dir.join("icon.png")).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:image/png;base64,{}", b64))
}

/// Read a world's display name from `level.dat`. Java `level.dat` is a
/// gzip-compressed NBT compound; the display name lives in the `LevelName`
/// string tag, which changes when the player renames the world in-game (the
/// folder name does not). Rather than pull in a full NBT parser, we gunzip and
/// scan for the unique 12-byte signature of the `LevelName` string tag —
/// `08` (TAG_String) · `00 09` (name length 9) · "LevelName" — then read the
/// big-endian-length-prefixed UTF-8 value that follows. Falls back to the
/// folder name on any failure (missing file, not gzip, tag absent).
fn read_world_name(world_dir: &std::path::Path, fallback: &str) -> String {
    use std::io::Read;
    let Ok(raw) = fs::read(world_dir.join("level.dat")) else {
        return fallback.to_string();
    };
    let mut data = Vec::new();
    if flate2::read::GzDecoder::new(&raw[..]).read_to_end(&mut data).is_err() {
        return fallback.to_string();
    }
    const SIG: &[u8] = b"\x08\x00\x09LevelName";
    let Some(pos) = data.windows(SIG.len()).position(|w| w == SIG) else {
        return fallback.to_string();
    };
    let len_at = pos + SIG.len();
    if len_at + 2 > data.len() {
        return fallback.to_string();
    }
    let len = u16::from_be_bytes([data[len_at], data[len_at + 1]]) as usize;
    let start = len_at + 2;
    if start + len > data.len() {
        return fallback.to_string();
    }
    match std::str::from_utf8(&data[start..start + len]) {
        Ok(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => fallback.to_string(),
    }
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
