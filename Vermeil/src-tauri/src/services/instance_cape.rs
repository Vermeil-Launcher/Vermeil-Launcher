//! In-game custom cape integration with the Vermeil companion mod.
//!
//! The companion mod reads its cape from `<game_dir>/vermeil/cape.png` (the game
//! dir is `instances/<id>/.minecraft`) plus a `cape.json` toggle/metadata file.
//!
//! This is a **global, single-toggle** feature: the user turns one custom cape on
//! for in-game display, and the launcher applies it automatically — but only to
//! **supported** instances (the loaders + Minecraft versions the companion mod
//! actually runs on). There is no per-instance selection. The chosen cape is
//! stored once under `<data>/ingame_cape/`, and at launch we sync it into the
//! launching instance: write it if the instance is supported and the toggle is
//! on, otherwise remove any stale copy. So enabling/disabling and unsupported
//! instances all resolve themselves the next time the instance launches, and new
//! instances are covered with no extra bookkeeping.
//!
//! The cape PNG is baked **by the frontend** (canvas — the backend has no image
//! library) into the mod's texture layout: a square 64×64 cape frame, or a
//! vertical strip of square frames for an animation (`height == width * frames`).
//! We only validate the PNG header, bound its size, and move bytes around.

use crate::models::instance::{Instance, LoaderType};
use crate::util::paths;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Largest cape strip we'll store — bounds an untrusted/baked PNG on disk.
const MAX_STRIP_BYTES: usize = 32 * 1024 * 1024;
/// Largest single-frame edge (an HD cape frame is 64×N; 2048 = 32× of 64).
const MAX_FRAME_SIZE: u32 = 2048;
/// Largest frame count we'll accept in a strip.
const MAX_FRAMES: u32 = 300;

/// Global in-game cape state as the frontend sees it.
#[derive(Debug, Clone, Serialize)]
pub struct IngameCapeState {
    pub enabled: bool,
    pub cape_id: Option<String>,
    pub frame_time_ms: Option<u32>,
}

/// On-disk metadata. The global `cape.json` keeps all three fields; the
/// per-instance `cape.json` the mod reads only needs `enabled`/`frameTimeMs`
/// (the mod ignores `capeId`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CapeMeta {
    enabled: bool,
    #[serde(rename = "frameTimeMs", default, skip_serializing_if = "Option::is_none")]
    frame_time_ms: Option<u32>,
    #[serde(rename = "capeId", default, skip_serializing_if = "Option::is_none")]
    cape_id: Option<String>,
}

// ───────────────────────── Global store ─────────────────────────────────

fn global_dir() -> PathBuf {
    paths::data_dir().join("ingame_cape")
}

fn global_png() -> PathBuf {
    global_dir().join("cape.png")
}

fn global_meta_path() -> PathBuf {
    global_dir().join("cape.json")
}

fn read_global_meta() -> Option<CapeMeta> {
    serde_json::from_str(&fs::read_to_string(global_meta_path()).ok()?).ok()
}

fn write_global_meta(meta: &CapeMeta) -> Result<(), String> {
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    paths::atomic_write(global_meta_path(), json.as_bytes())
        .map_err(|e| format!("Write ingame cape.json: {}", e))
}

/// Set the in-game cape: store the baked strip globally and turn it on.
pub fn set_ingame_cape(
    cape_id: Option<String>,
    strip_png: &[u8],
    frame_time_ms: Option<u32>,
) -> Result<(), String> {
    validate_strip(strip_png)?;
    fs::create_dir_all(global_dir()).map_err(|e| format!("Create ingame cape dir: {}", e))?;
    paths::atomic_write(global_png(), strip_png).map_err(|e| format!("Write cape.png: {}", e))?;
    write_global_meta(&CapeMeta { enabled: true, frame_time_ms, cape_id })
}

/// Flip the global toggle without re-baking. Errors if no cape is set yet.
pub fn set_ingame_cape_enabled(enabled: bool) -> Result<(), String> {
    let mut meta = read_global_meta()
        .ok_or_else(|| "No in-game cape has been set yet.".to_string())?;
    meta.enabled = enabled;
    write_global_meta(&meta)
}

/// Remove the global in-game cape entirely.
pub fn clear_ingame_cape() -> Result<(), String> {
    for path in [global_png(), global_meta_path()] {
        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("Remove {}: {}", path.display(), e))?;
        }
    }
    let _ = fs::remove_dir(global_dir());
    Ok(())
}

/// Current global in-game cape state, or `None` if none is set.
pub fn get_ingame_cape() -> Option<IngameCapeState> {
    if !global_png().exists() {
        return None;
    }
    let meta = read_global_meta().unwrap_or_default();
    Some(IngameCapeState {
        enabled: meta.enabled,
        cape_id: meta.cape_id,
        frame_time_ms: meta.frame_time_ms,
    })
}

// ───────────────────────── Per-launch sync ──────────────────────────────

/// Loaders the companion mod runs on. It's a Fabric mod; Quilt runs Fabric mods.
fn loader_supported(loader: &LoaderType) -> bool {
    matches!(loader, LoaderType::Fabric | LoaderType::Quilt)
}

/// Minecraft versions the companion mod currently targets. Tracks the mod's
/// `gradle.properties` (`minecraft_version = 26.1.x`); widen as the mod adds
/// version branches.
fn version_supported(version: &str) -> bool {
    version.starts_with("26.1")
}

/// Whether the companion mod can render a cape on this instance.
pub fn is_supported(instance: &Instance) -> bool {
    loader_supported(&instance.loader.loader_type) && version_supported(&instance.game_version)
}

/// Sync the global in-game cape into one instance at launch. Best-effort: a
/// failure here is logged and never blocks the launch. Writes the cape when the
/// toggle is on and the instance is supported; otherwise removes any stale copy
/// so disabling (or an unsupported instance) cleans itself up.
pub fn sync_to_instance(instance: &Instance, game_dir: &Path) {
    let dest_dir = game_dir.join("vermeil");
    let dest_png = dest_dir.join("cape.png");
    let dest_meta = dest_dir.join("cape.json");

    let active = get_ingame_cape().filter(|s| s.enabled).is_some() && is_supported(instance);

    if !active {
        for path in [&dest_png, &dest_meta] {
            if path.exists() {
                if let Err(e) = fs::remove_file(path) {
                    tracing::warn!("Could not remove stale in-game cape {}: {}", path.display(), e);
                }
            }
        }
        return;
    }

    let meta = read_global_meta().unwrap_or_default();
    if let Err(e) = (|| -> Result<(), String> {
        fs::create_dir_all(&dest_dir).map_err(|e| format!("create {}: {}", dest_dir.display(), e))?;
        fs::copy(global_png(), &dest_png).map_err(|e| format!("copy cape.png: {}", e))?;
        let instance_meta = CapeMeta {
            enabled: true,
            frame_time_ms: meta.frame_time_ms,
            cape_id: None,
        };
        let json = serde_json::to_string_pretty(&instance_meta).map_err(|e| e.to_string())?;
        paths::atomic_write(&dest_meta, json.as_bytes()).map_err(|e| format!("write cape.json: {}", e))?;
        Ok(())
    })() {
        tracing::warn!("Could not sync in-game cape into instance {}: {}", instance.id, e);
    }
}

// ───────────────────────── Apply to all instances ───────────────────────

/// Apply the current in-game cape state to every already-prepared instance now,
/// so toggling takes effect immediately and visibly (and a running, supported
/// instance live-reloads it) instead of only at next launch. Instances that
/// haven't been prepared yet (no `.minecraft`) are skipped — they get the cape
/// from `sync_to_instance` when they launch. Best-effort.
pub async fn sync_all_instances() {
    let instances = match crate::services::instance_service::list_all().await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("In-game cape: could not list instances to sync: {}", e);
            return;
        }
    };
    for inst in &instances {
        let game_dir = paths::instances_dir().join(&inst.id).join(".minecraft");
        // Don't materialize a game dir for an instance that's never been
        // prepared; its launch will sync the cape in.
        if game_dir.exists() {
            sync_to_instance(inst, &game_dir);
        }
    }
}

// ───────────────────────── Validation ───────────────────────────────────

/// Validate the baked cape PNG: a square frame, or a vertical strip of square
/// frames (`height == width * n`), within sane size bounds. Mirrors the mod's
/// own frame-strip interpretation so a stored cape renders there.
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
