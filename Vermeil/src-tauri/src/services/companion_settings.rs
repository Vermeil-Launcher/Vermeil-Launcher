//! The Vermeil companion mod's own settings file — `vermeil-settings.json` in the
//! shared companion data dir (`<data>/companion/`).
//!
//! This is the single store for everything the mod *does* — cape on/off, FOV
//! effects, and future features — as opposed to whether the mod is installed
//! (that's the per-instance toggle in `companion_mod`). It lives once in the
//! shared dir, so a setting changed in-game persists across every supported
//! Minecraft version.
//!
//! Round-trip, mirroring the `options.txt` bridge in [`crate::services::video_options`]:
//! - **Write (pre-launch)** — [`write_for_launch`] writes the file from the
//!   launcher's stored settings, so the launcher is authoritative at launch time.
//! - **Read (post-exit)** — [`read_back`] parses the file the mod may have changed
//!   in-game, so those changes flow back into the launcher's own settings.
//!
//! Best-effort throughout: a cosmetic settings file must never block or fail a
//! launch.

use crate::models::settings::LauncherSettings;
use crate::util::paths;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// `vermeil-settings.json` lives alongside the cape files in the companion dir.
fn settings_path() -> PathBuf {
    paths::data_dir().join("companion").join("vermeil-settings.json")
}

/// The mod-facing settings. JSON keys are camelCase to match the mod's reader.
/// Each field carries a default so a partial / hand-edited file still loads.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VermeilSettings {
    /// Whether the custom cape renders (when a texture is present). Default true.
    #[serde(rename = "capeEnabled", default = "default_true")]
    pub cape_enabled: bool,
    /// FOV-effects scale in `[0.0, 1.0]` for the versions where the mod owns it
    /// (pre-1.16; 1.16+ uses the vanilla key). `1.0` = vanilla. Default `1.0`.
    #[serde(rename = "fovEffectsScale", default = "default_scale")]
    pub fov_effects_scale: f64,
}

fn default_true() -> bool {
    true
}
fn default_scale() -> f64 {
    1.0
}

impl Default for VermeilSettings {
    fn default() -> Self {
        Self {
            cape_enabled: true,
            fov_effects_scale: 1.0,
        }
    }
}

/// Write `vermeil-settings.json` from the launcher's stored settings, before
/// launch. The launcher is authoritative at launch time (same model as
/// `options.txt`). Best-effort — never blocks a launch.
pub fn write_for_launch(settings: &LauncherSettings) {
    let vs = VermeilSettings {
        cape_enabled: settings.ingame_cape.enabled,
        fov_effects_scale: settings.video_settings.fov_effects.unwrap_or(1.0),
    };
    let path = settings_path();
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            tracing::warn!("Could not create companion dir for vermeil-settings.json: {}", e);
            return;
        }
    }
    match serde_json::to_string_pretty(&vs) {
        Ok(json) => {
            if let Err(e) = paths::atomic_write(&path, json.as_bytes()) {
                tracing::warn!("Could not write vermeil-settings.json: {}", e);
            }
        }
        Err(e) => tracing::warn!("Could not serialize vermeil-settings.json: {}", e),
    }
}

/// Read `vermeil-settings.json` back after a session, or `None` if it's absent or
/// unreadable. The mod may have changed it in-game; the caller merges the values
/// it owns into launcher settings.
pub fn read_back() -> Option<VermeilSettings> {
    let content = std::fs::read_to_string(settings_path()).ok()?;
    serde_json::from_str(&content).ok()
}
