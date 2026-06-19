//! In-game custom cape integration with the Vermeil companion mod.
//!
//! The companion mod reads its cape from `<game_dir>/vermeil/cape.png` (the game
//! dir is `instances/<id>/.minecraft`, the process CWD at launch) plus an
//! optional `cape.json` toggle/metadata file. This module is the launcher side
//! of that contract: it writes the baked cape strip + metadata into an instance
//! and reads/toggles the current state.
//!
//! The cape PNG is baked **by the frontend** (canvas — the backend has no image
//! library) into the mod's texture layout: a square 64×64 cape frame, or a
//! vertical strip of square frames for an animation (`height == width * frames`).
//! We only validate the PNG header, bound its size, and write the files.
//!
//! `cape.json` is the single source of truth for per-instance cape state — the
//! mod reads `enabled`/`frameTimeMs` and ignores the launcher-only `capeId`.
//! Keeping state in the file (not `instance.json`) avoids a model migration and
//! keeps the launcher and mod reading the same record.

use crate::util::paths;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// Largest cape strip we'll write — bounds an untrusted/baked PNG on disk.
const MAX_STRIP_BYTES: usize = 32 * 1024 * 1024;
/// Largest single-frame edge (an HD cape frame is 64×N; 2048 = 32× of 64).
const MAX_FRAME_SIZE: u32 = 2048;
/// Largest frame count we'll accept in a strip.
const MAX_FRAMES: u32 = 300;

/// Per-instance cape state as the frontend sees it.
#[derive(Debug, Clone, Serialize)]
pub struct InstanceCapeState {
    pub enabled: bool,
    pub cape_id: Option<String>,
    pub frame_time_ms: Option<u32>,
}

/// On-disk `cape.json`. Field names match what the mod reads (`enabled`,
/// `frameTimeMs`); `capeId` is launcher-only (the mod ignores unknown fields).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CapeMeta {
    enabled: bool,
    #[serde(rename = "frameTimeMs", default, skip_serializing_if = "Option::is_none")]
    frame_time_ms: Option<u32>,
    #[serde(rename = "capeId", default, skip_serializing_if = "Option::is_none")]
    cape_id: Option<String>,
}

/// Guard a frontend-supplied instance id before it becomes a filesystem path —
/// reject anything that could escape the instances directory.
fn validate_instance_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("Invalid instance id: {}", id))
    }
}

/// `instances/<id>/.minecraft/vermeil` — the dir the mod reads its cape from.
fn cape_dir(instance_id: &str) -> PathBuf {
    paths::instances_dir()
        .join(instance_id)
        .join(".minecraft")
        .join("vermeil")
}

fn cape_png_path(instance_id: &str) -> PathBuf {
    cape_dir(instance_id).join("cape.png")
}

fn cape_meta_path(instance_id: &str) -> PathBuf {
    cape_dir(instance_id).join("cape.json")
}

/// Validate the baked cape PNG: a square frame, or a vertical strip of square
/// frames (`height == width * n`), within sane size bounds. Mirrors the mod's
/// own frame-strip interpretation so a write that succeeds here renders there.
fn validate_strip(png: &[u8]) -> Result<(), String> {
    if png.len() > MAX_STRIP_BYTES {
        return Err(format!(
            "Cape image is too large ({} MB). Max is {} MB.",
            png.len() / (1024 * 1024),
            MAX_STRIP_BYTES / (1024 * 1024)
        ));
    }
    if png.len() < 24 || &png[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("Cape image isn't a valid PNG".to_string());
    }
    let width = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let height = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    if width == 0 || height == 0 || width > MAX_FRAME_SIZE {
        return Err(format!("Cape frame size out of range — got {}x{}", width, height));
    }
    if height % width != 0 {
        return Err(format!(
            "Cape image must be a square frame or a vertical strip of square frames — got {}x{}",
            width, height
        ));
    }
    let frames = height / width;
    if frames > MAX_FRAMES {
        return Err(format!("Cape animation has too many frames ({}). Max is {}.", frames, MAX_FRAMES));
    }
    Ok(())
}

fn read_meta(instance_id: &str) -> Option<CapeMeta> {
    let path = cape_meta_path(instance_id);
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_meta(instance_id: &str, meta: &CapeMeta) -> Result<(), String> {
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    paths::atomic_write(cape_meta_path(instance_id), json.as_bytes())
        .map_err(|e| format!("Write cape.json: {}", e))
}

/// Write a baked cape into an instance and set its toggle/metadata. Overwrites
/// any existing cape for that instance.
pub fn write_instance_cape(
    instance_id: &str,
    cape_id: Option<String>,
    strip_png: &[u8],
    frame_time_ms: Option<u32>,
    enabled: bool,
) -> Result<(), String> {
    validate_instance_id(instance_id)?;
    validate_strip(strip_png)?;

    let dir = cape_dir(instance_id);
    fs::create_dir_all(&dir).map_err(|e| format!("Create cape dir: {}", e))?;
    paths::atomic_write(cape_png_path(instance_id), strip_png)
        .map_err(|e| format!("Write cape.png: {}", e))?;
    write_meta(
        instance_id,
        &CapeMeta { enabled, frame_time_ms, cape_id },
    )?;
    Ok(())
}

/// Flip the enabled toggle for an instance's existing cape without re-writing
/// the PNG. No-op-with-error if no cape has been written yet.
pub fn set_instance_cape_enabled(instance_id: &str, enabled: bool) -> Result<(), String> {
    validate_instance_id(instance_id)?;
    let mut meta = read_meta(instance_id)
        .ok_or_else(|| "No in-game cape is set for this instance.".to_string())?;
    meta.enabled = enabled;
    write_meta(instance_id, &meta)
}

/// Remove an instance's cape files entirely (cape.png + cape.json).
pub fn clear_instance_cape(instance_id: &str) -> Result<(), String> {
    validate_instance_id(instance_id)?;
    for path in [cape_png_path(instance_id), cape_meta_path(instance_id)] {
        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("Remove {}: {}", path.display(), e))?;
        }
    }
    // Tidy the now-empty vermeil dir; ignore failure (e.g. not empty).
    let _ = fs::remove_dir(cape_dir(instance_id));
    Ok(())
}

/// Read an instance's current cape state, or `None` if no cape is set.
pub fn get_instance_cape(instance_id: &str) -> Option<InstanceCapeState> {
    if validate_instance_id(instance_id).is_err() {
        return None;
    }
    if !cape_png_path(instance_id).exists() {
        return None;
    }
    let meta = read_meta(instance_id).unwrap_or_default();
    Some(InstanceCapeState {
        enabled: meta.enabled,
        cape_id: meta.cape_id,
        frame_time_ms: meta.frame_time_ms,
    })
}
