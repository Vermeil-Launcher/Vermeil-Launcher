//! Persistent window position / size / maximized flag for the launcher's
//! main window.
//!
//! Replaces `tauri-plugin-window-state`. The plugin defaulted to writing
//! `<app_config_dir>/.window-state`, which on Windows resolves to
//! `%APPDATA%\com.vermeil.launcher\.window-state` — a second app-data folder
//! sitting next to our real `%APPDATA%\Vermeil\` data dir. Consolidating the
//! state file into our own data dir kills the duplicate folder.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::util::paths;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WindowState {
    /// Physical-pixel screen position of the outer window. `None` while the
    /// window has never been moved (first-launch placement is left to Tauri).
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// Physical-pixel inner size. `0` is treated as "unset" — Tauri's
    /// configured default size in `tauri.conf.json` wins.
    pub width: u32,
    pub height: u32,
    /// Whether the window was maximized at last save. We don't capture the
    /// inner size while maximized so that an unmaximize restores the prior
    /// real geometry, not the screen-filling one.
    pub maximized: bool,
}

const FILENAME: &str = "window-state.json";

fn current_path() -> PathBuf {
    paths::data_dir().join(FILENAME)
}

/// Path the previous `tauri-plugin-window-state` setup wrote to. We read it
/// once on first launch of the in-tree implementation and copy the geometry
/// over, so the user doesn't notice the launcher window forgetting where it
/// was. The legacy file is left in place — auto-deleting another app's folder
/// shape is risky and the empty `com.vermeil.launcher/` folder is harmless.
///
/// The plugin renamed its state file from `.window-state` (no extension) to
/// `.window-state.json` somewhere around v2.0; we try both so users coming
/// from any prior version migrate cleanly.
fn legacy_paths() -> Vec<PathBuf> {
    let Some(base) = dirs::config_dir() else { return Vec::new(); };
    let dir = base.join("com.vermeil.launcher");
    vec![dir.join(".window-state.json"), dir.join(".window-state")]
}

/// Read the saved state, falling back to a one-time migration from the legacy
/// plugin's file. Returns `None` only when neither file exists or both are
/// unparseable — in that case the caller leaves the window at the default.
pub fn load() -> Option<WindowState> {
    if let Ok(raw) = std::fs::read_to_string(current_path()) {
        if let Ok(s) = serde_json::from_str::<WindowState>(&raw) {
            return Some(s);
        }
    }
    // First-launch migration. Try every known legacy filename and pick the
    // first that parses; persist into our location so subsequent launches
    // skip this branch entirely.
    for legacy in legacy_paths() {
        if let Ok(raw) = std::fs::read_to_string(&legacy) {
            if let Some(migrated) = parse_legacy(&raw) {
                let _ = save(&migrated);
                return Some(migrated);
            }
        }
    }
    None
}

/// `tauri-plugin-window-state` serializes a `HashMap<String, LegacyState>`
/// keyed by window label. We only care about `"main"`.
fn parse_legacy(raw: &str) -> Option<WindowState> {
    #[derive(Deserialize)]
    struct LegacyEntry {
        x: i32,
        y: i32,
        width: f64,
        height: f64,
        maximized: bool,
    }
    let map: std::collections::HashMap<String, LegacyEntry> =
        serde_json::from_str(raw).ok()?;
    let entry = map.get("main")?;
    Some(WindowState {
        x: Some(entry.x),
        y: Some(entry.y),
        width: entry.width.round().max(1.0) as u32,
        height: entry.height.round().max(1.0) as u32,
        maximized: entry.maximized,
    })
}

/// Atomically persist the state to `<data_dir>/window-state.json`. Writes
/// are tiny (~200 bytes) so we don't bother debouncing across the burst of
/// `Resized` events fired during a drag-resize.
pub fn save(state: &WindowState) -> std::io::Result<()> {
    let json = serde_json::to_vec_pretty(state)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    paths::atomic_write(current_path(), &json)
}
