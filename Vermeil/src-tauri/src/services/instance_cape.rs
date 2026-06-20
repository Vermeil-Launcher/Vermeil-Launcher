//! In-game custom cape integration with the Vermeil companion mod.
//!
//! This is a **global, single-toggle** feature. The state (on/off, which library
//! cape, frame timing) lives in the launcher settings (`config.json` →
//! `ingame_cape`), and the cape itself is stored **once** in the launcher's
//! companion-mod data directory — `<data>/companion/` holding `cape.png` (the
//! baked texture) and `cape.json` (`{enabled, frameTimeMs}`, mirrored from
//! settings for the mod to read). There are no per-instance copies. The
//! `companion` dir is the mod's data home generally (capes are its first
//! feature); future mod data slots in alongside the cape files.
//!
//! The companion mod reads its data dir from the `vermeil.dataDir` system
//! property. At launch we inject `-Dvermeil.dataDir=<that dir>` for **supported**
//! instances (the loaders + Minecraft versions the mod runs on) when a cape has
//! been set — see [`jvm_property`]. So every instance (custom, modpack, imported,
//! pre-existing or new) is pointed at the same global data dir uniformly, and a
//! running supported instance live-reloads when the files change. Unsupported
//! instances get no property, so they're never touched.
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
use std::path::PathBuf;

/// Largest cape strip we'll store — bounds an untrusted/baked PNG on disk.
const MAX_STRIP_BYTES: usize = 32 * 1024 * 1024;
/// Largest single-frame edge (an HD cape frame is 64×N; 2048 = 32× of 64).
const MAX_FRAME_SIZE: u32 = 2048;
/// Largest frame count we'll accept in a strip.
const MAX_FRAMES: u32 = 300;

/// The `cape.json` the mod reads (`capeId` is launcher-only and omitted).
#[derive(Debug, Serialize)]
struct CapeMeta {
    enabled: bool,
    #[serde(rename = "frameTimeMs", skip_serializing_if = "Option::is_none")]
    frame_time_ms: Option<u32>,
}

/// The launcher's data directory for the companion mod (`vermeil.dataDir`). Holds
/// the cape files now; the mod's data home for future features too.
fn companion_dir() -> PathBuf {
    paths::data_dir().join("companion")
}

fn global_cape_png() -> PathBuf {
    companion_dir().join("cape.png")
}

fn global_cape_meta() -> PathBuf {
    companion_dir().join("cape.json")
}

/// One-time rename of an earlier companion dir name (`<data>/ingame-cape/` or
/// `<data>/mod-data/`) to the current `companion/`, so a cape set before a rename
/// keeps working without re-toggling. Idempotent and best-effort.
fn migrate_legacy_dir() {
    let new = companion_dir();
    if new.exists() {
        return;
    }
    for old_name in ["mod-data", "ingame-cape"] {
        let old = paths::data_dir().join(old_name);
        if old.is_dir() {
            let _ = fs::rename(&old, &new);
            return;
        }
    }
}

/// Write the mod-facing `cape.json` mirroring the launcher's toggle state.
fn write_global_meta(enabled: bool, frame_time_ms: Option<u32>) -> Result<(), String> {
    fs::create_dir_all(companion_dir()).map_err(|e| format!("create companion dir: {}", e))?;
    let meta = CapeMeta { enabled, frame_time_ms };
    let json = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    paths::atomic_write(global_cape_meta(), json.as_bytes())
        .map_err(|e| format!("write cape.json: {}", e))
}

// ───────────────────────── Toggle / store (settings-backed) ─────────────

/// Set the in-game cape: store the baked strip + meta in the companion dir and
/// record it in settings (on). Running supported instances live-reload it.
pub async fn set_ingame_cape(
    cape_id: Option<String>,
    strip_png: &[u8],
    frame_time_ms: Option<u32>,
) -> Result<(), String> {
    validate_strip(strip_png)?;
    migrate_legacy_dir();
    fs::create_dir_all(companion_dir()).map_err(|e| format!("create companion dir: {}", e))?;
    paths::atomic_write(global_cape_png(), strip_png).map_err(|e| format!("write cape.png: {}", e))?;
    write_global_meta(true, frame_time_ms)?;

    let mut settings = settings_service::load().await.map_err(|e| e.to_string())?;
    settings.ingame_cape = IngameCapeSettings { enabled: true, cape_id, frame_time_ms };
    settings_service::save(&settings).await.map_err(|e| e.to_string())?;

    cleanup_legacy_instance_capes().await;
    Ok(())
}

/// Flip the toggle without re-baking. Errors if no cape has been set yet.
pub async fn set_ingame_cape_enabled(enabled: bool) -> Result<(), String> {
    let mut settings = settings_service::load().await.map_err(|e| e.to_string())?;
    if settings.ingame_cape.cape_id.is_none() {
        return Err("No in-game cape has been set yet.".to_string());
    }
    settings.ingame_cape.enabled = enabled;
    let frame_time_ms = settings.ingame_cape.frame_time_ms;
    settings_service::save(&settings).await.map_err(|e| e.to_string())?;

    // Mirror into the global cape.json so running instances live-reload.
    migrate_legacy_dir();
    write_global_meta(enabled, frame_time_ms)?;
    Ok(())
}

/// Remove the in-game cape entirely (global files + settings).
pub async fn clear_ingame_cape() -> Result<(), String> {
    if companion_dir().exists() {
        let _ = fs::remove_dir_all(companion_dir());
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

// ───────────────────────── Support gate + launch wiring ──────────────────

/// Loaders the companion mod runs on. It's a Fabric mod; Quilt runs Fabric mods.
fn loader_supported(loader: &LoaderType) -> bool {
    matches!(loader, LoaderType::Fabric | LoaderType::Quilt)
}

/// Minecraft versions the companion mod currently targets — every version the
/// published Fabric jars support. Each render-era jar covers a range:
/// `companion-mod/fabric/26.1` → 26.x; `companion-mod/fabric/1.21` → 1.21–1.21.1
/// (feature-renderer). Keep this in lockstep with the jars CI publishes (the
/// `mc_versions` lists in each project's `gradle.properties`). Add Forge to
/// `loader_supported` when a Forge build exists.
fn version_supported(version: &str) -> bool {
    const SUPPORTED: &[&str] = &[
        // 26.x render-state era (companion-mod/fabric/26.1).
        "26.1", "26.1.1", "26.1.2", "26.2",
        // 1.21 feature-renderer era (companion-mod/fabric/1.21).
        "1.21", "1.21.1",
        // 1.21.2–1.21.4 render-state era (companion-mod/fabric/1.21.2).
        "1.21.2", "1.21.3", "1.21.4",
        // 1.21.5–1.21.8 render-state era (companion-mod/fabric/1.21.5).
        "1.21.5", "1.21.6", "1.21.7", "1.21.8",
    ];
    SUPPORTED.contains(&version)
}

/// Whether the companion mod can render a cape on this instance.
pub fn is_supported(instance: &Instance) -> bool {
    loader_supported(&instance.loader.loader_type) && version_supported(&instance.game_version)
}

/// The `-Dvermeil.dataDir=…` JVM argument to inject at launch, or `None` when the
/// instance isn't supported or no cape has been set. Pointing every supported
/// instance at the one companion dir is what replaces per-instance file copies:
/// the mod reads the shared cape, and toggling/swapping it live-reloads anywhere
/// it's running.
pub fn jvm_property(instance: &Instance) -> Option<String> {
    migrate_legacy_dir();
    if !is_supported(instance) || !global_cape_png().is_file() {
        return None;
    }
    Some(format!("-Dvermeil.dataDir={}", companion_dir().display()))
}

/// Best-effort removal of cape files written by the earlier per-instance design
/// (`instances/<id>/.minecraft/vermeil/cape.{png,json}`) and the old single-file
/// global cape (`<data>/ingame-cape.png`). The mod now reads the `companion/` dir
/// via `vermeil.dataDir`, so these are obsolete; clean them up the next time the
/// user touches the cape so no stale folders linger. Never propagates errors.
async fn cleanup_legacy_instance_capes() {
    // Old single-file global cape (superseded by the companion/ dir).
    let legacy_global = paths::data_dir().join("ingame-cape.png");
    if legacy_global.is_file() {
        let _ = fs::remove_file(&legacy_global);
    }

    let instances = match instance_service::list_all().await {
        Ok(v) => v,
        Err(_) => return,
    };
    for inst in &instances {
        let vermeil_dir = paths::instances_dir().join(&inst.id).join(".minecraft").join("vermeil");
        if !vermeil_dir.exists() {
            continue;
        }
        for name in ["cape.png", "cape.json"] {
            let f = vermeil_dir.join(name);
            if f.exists() {
                let _ = fs::remove_file(&f);
            }
        }
        // Drop the dir if it's now empty (don't disturb it if the user put other files there).
        if let Ok(mut entries) = fs::read_dir(&vermeil_dir) {
            if entries.next().is_none() {
                let _ = fs::remove_dir(&vermeil_dir);
            }
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
