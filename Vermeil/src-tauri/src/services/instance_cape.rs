//! In-game custom cape integration with the Vermeil companion mod.
//!
//! The companion mod reads its cape from `<game_dir>/vermeil/cape.png` (the game
//! dir is `instances/<id>/.minecraft`) plus a `cape.json` toggle/metadata file.
//!
//! This is a **global, single-toggle** feature. The state (on/off, which library
//! cape, frame timing) lives in the launcher settings (`config.json` →
//! `ingame_cape`), and the baked cape image lives at `<data>/ingame-cape.png` —
//! no scattered sub-folders. The launcher applies the cape automatically, but
//! only to **supported** instances (the loaders + Minecraft versions the mod
//! runs on). There is no per-instance selection.
//!
//! At launch we sync the cape into the launching instance (`sync_to_instance`):
//! write it if the instance is supported and the toggle is on, otherwise remove
//! any stale copy — so new instances are covered with no bookkeeping. Toggling
//! also applies to all already-prepared instances immediately (`sync_all_instances`).
//!
//! The cape PNG is baked **by the frontend** (canvas — the backend has no image
//! library) into the mod's texture layout: a square 64×64 cape frame, or a
//! vertical strip of square frames for an animation (`height == width * frames`).

use crate::models::instance::{Instance, LoaderType};
use crate::models::settings::IngameCapeSettings;
use crate::services::{instance_service, settings_service};
use crate::util::paths;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Largest cape strip we'll store — bounds an untrusted/baked PNG on disk.
const MAX_STRIP_BYTES: usize = 32 * 1024 * 1024;
/// Largest single-frame edge (an HD cape frame is 64×N; 2048 = 32× of 64).
const MAX_FRAME_SIZE: u32 = 2048;
/// Largest frame count we'll accept in a strip.
const MAX_FRAMES: u32 = 300;

/// Per-instance `cape.json` the mod reads (`capeId` is launcher-only and omitted).
#[derive(Debug, Serialize)]
struct InstanceCapeMeta {
    enabled: bool,
    #[serde(rename = "frameTimeMs", skip_serializing_if = "Option::is_none")]
    frame_time_ms: Option<u32>,
}

/// The single baked in-game cape image (the mod's frame-strip layout).
fn ingame_png() -> PathBuf {
    paths::data_dir().join("ingame-cape.png")
}

// ───────────────────────── Toggle / store (settings-backed) ─────────────

/// Set the in-game cape: store the baked strip and record it in settings (on).
pub async fn set_ingame_cape(
    cape_id: Option<String>,
    strip_png: &[u8],
    frame_time_ms: Option<u32>,
) -> Result<(), String> {
    validate_strip(strip_png)?;
    fs::create_dir_all(paths::data_dir()).map_err(|e| format!("Create data dir: {}", e))?;
    paths::atomic_write(ingame_png(), strip_png).map_err(|e| format!("Write ingame cape: {}", e))?;

    let mut settings = settings_service::load().await.map_err(|e| e.to_string())?;
    settings.ingame_cape = IngameCapeSettings { enabled: true, cape_id, frame_time_ms };
    settings_service::save(&settings).await.map_err(|e| e.to_string())
}

/// Flip the toggle without re-baking. Errors if no cape has been set yet.
pub async fn set_ingame_cape_enabled(enabled: bool) -> Result<(), String> {
    let mut settings = settings_service::load().await.map_err(|e| e.to_string())?;
    if settings.ingame_cape.cape_id.is_none() {
        return Err("No in-game cape has been set yet.".to_string());
    }
    settings.ingame_cape.enabled = enabled;
    settings_service::save(&settings).await.map_err(|e| e.to_string())
}

/// Remove the in-game cape entirely (image + settings).
pub async fn clear_ingame_cape() -> Result<(), String> {
    if ingame_png().exists() {
        let _ = fs::remove_file(ingame_png());
    }
    let mut settings = settings_service::load().await.map_err(|e| e.to_string())?;
    settings.ingame_cape = IngameCapeSettings::default();
    settings_service::save(&settings).await.map_err(|e| e.to_string())
}

/// Current in-game cape state, or `None` if none has been set.
pub async fn get_ingame_cape() -> Option<IngameCapeSettings> {
    let settings = settings_service::load().await.ok()?;
    if settings.ingame_cape.cape_id.is_none() {
        return None;
    }
    Some(settings.ingame_cape)
}

// ───────────────────────── Per-launch / bulk sync ───────────────────────

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

/// Write or remove the cape in one instance's game dir given the toggle state.
/// Best-effort: failures are logged, never propagated (a cape must never block a
/// launch). Writes when the toggle is on and the instance is supported and a
/// baked cape exists; otherwise removes any stale copy.
fn apply_to_instance(instance: &Instance, game_dir: &Path, enabled: bool, frame_time_ms: Option<u32>) {
    let dest_dir = game_dir.join("vermeil");
    let dest_png = dest_dir.join("cape.png");
    let dest_meta = dest_dir.join("cape.json");

    let active = enabled && is_supported(instance) && ingame_png().exists();

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

    if let Err(e) = (|| -> Result<(), String> {
        fs::create_dir_all(&dest_dir).map_err(|e| format!("create {}: {}", dest_dir.display(), e))?;
        fs::copy(ingame_png(), &dest_png).map_err(|e| format!("copy cape.png: {}", e))?;
        let meta = InstanceCapeMeta { enabled: true, frame_time_ms };
        let json = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
        paths::atomic_write(&dest_meta, json.as_bytes()).map_err(|e| format!("write cape.json: {}", e))?;
        Ok(())
    })() {
        tracing::warn!("Could not sync in-game cape into instance {}: {}", instance.id, e);
    }
}

/// Sync the in-game cape into one instance at launch. Best-effort.
pub async fn sync_to_instance(instance: &Instance, game_dir: &Path) {
    let settings = match settings_service::load().await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("In-game cape: could not load settings: {}", e);
            return;
        }
    };
    apply_to_instance(
        instance,
        game_dir,
        settings.ingame_cape.enabled,
        settings.ingame_cape.frame_time_ms,
    );
}

/// Apply the current in-game cape state to every already-prepared instance now,
/// so toggling takes effect immediately and visibly (a running, supported
/// instance live-reloads it) instead of only at next launch. Instances that
/// haven't been prepared yet (no `.minecraft`) are skipped — they get the cape
/// from `sync_to_instance` when they launch. Best-effort.
pub async fn sync_all_instances() {
    let settings = match settings_service::load().await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("In-game cape: could not load settings to sync: {}", e);
            return;
        }
    };
    let instances = match instance_service::list_all().await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("In-game cape: could not list instances to sync: {}", e);
            return;
        }
    };
    for inst in &instances {
        let game_dir = paths::instances_dir().join(&inst.id).join(".minecraft");
        if game_dir.exists() {
            apply_to_instance(inst, &game_dir, settings.ingame_cape.enabled, settings.ingame_cape.frame_time_ms);
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
