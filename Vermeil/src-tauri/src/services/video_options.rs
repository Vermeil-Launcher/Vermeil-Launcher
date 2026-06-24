//! Bidirectional bridge between the launcher's `GlobalVideoSettings` and a
//! Minecraft instance's `options.txt`.
//!
//! Minecraft owns `options.txt` — it reads it at start and rewrites it on quit.
//! The launcher mirrors a chosen subset of video settings into it:
//!
//! - **Write (pre-launch)** — [`apply`] writes every mirrored key with a concrete
//!   value (the user's setting, or Mojang's vanilla default when unset), so the
//!   launcher and game always agree on launch. There is no "leave alone" state:
//!   the launcher is authoritative at launch time.
//! - **Read (post-exit)** — [`read_back`] parses the file the game just saved and
//!   returns the values for the mirrored keys, so in-game changes flow back into
//!   the launcher. Together these make the settings round-trip.
//!
//! One key map lives here so the write and read directions can never drift apart
//! (a key written but not read, or vice versa, would silently break the
//! round-trip for that setting).
//!
//! `fovEffectScale` is special: it only exists natively from Minecraft 1.16. On
//! older versions the companion mod owns the key (reads it from `options.txt`,
//! writes it back from its in-game control), so the launcher mirrors it on every
//! version and leaves the per-version interpretation to the game or the mod.

use crate::models::settings::GlobalVideoSettings;

/// Mojang's vanilla defaults for each mirrored key. Used when the launcher has
/// no stored value yet, so we still write a concrete line (matching what a fresh
/// `options.txt` would contain) rather than nothing. Sourced from the Minecraft
/// Wiki options.txt reference.
pub mod defaults {
    pub const MAX_FPS: u32 = 120;
    pub const VSYNC: bool = true;
    pub const VIEW_BOBBING: bool = true;
    pub const GUI_SCALE: u32 = 0; // 0 = Auto
    pub const FOV: f64 = 0.0; // 0.0 = 70 degrees
    pub const FOV_EFFECTS: f64 = 1.0;
    pub const MASTER_VOLUME: f64 = 1.0;
    pub const MUSIC_VOLUME: f64 = 1.0;
}

/// Resolve each mirrored field to a concrete value, falling back to the vanilla
/// default when the launcher has no stored value. Centralises the "no Default
/// state — always a real value" rule so both the writer and the frontend agree.
fn resolved(vs: &GlobalVideoSettings) -> Resolved {
    Resolved {
        max_fps: vs.max_fps.unwrap_or(defaults::MAX_FPS),
        vsync: vs.vsync.unwrap_or(defaults::VSYNC),
        view_bobbing: vs.view_bobbing.unwrap_or(defaults::VIEW_BOBBING),
        gui_scale: vs.gui_scale.unwrap_or(defaults::GUI_SCALE),
        fov: vs.fov.unwrap_or(defaults::FOV),
        fov_effects: vs.fov_effects.unwrap_or(defaults::FOV_EFFECTS),
        master_volume: vs.master_volume.unwrap_or(defaults::MASTER_VOLUME),
        music_volume: vs.music_volume.unwrap_or(defaults::MUSIC_VOLUME),
    }
}

struct Resolved {
    max_fps: u32,
    vsync: bool,
    view_bobbing: bool,
    gui_scale: u32,
    fov: f64,
    fov_effects: f64,
    master_volume: f64,
    music_volume: f64,
}

fn bool_str(b: bool) -> &'static str {
    if b { "true" } else { "false" }
}

/// Write every mirrored video setting into `content` (the text of an
/// `options.txt`), replacing existing lines in place or appending new ones, and
/// return the updated text. Always writes concrete values.
///
/// `fovEffectScale` is written on every version: 1.16+ reads it natively, and
/// the companion mod reads it on older versions (it's an inert unknown key to
/// vanilla pre-1.16, so writing it there is harmless even without the mod).
pub fn apply(content: &str, vs: &GlobalVideoSettings) -> String {
    let r = resolved(vs);
    let mut out = content.to_string();
    set_line(&mut out, "maxFps", &r.max_fps.to_string());
    set_line(&mut out, "enableVsync", bool_str(r.vsync));
    set_line(&mut out, "bobView", bool_str(r.view_bobbing));
    set_line(&mut out, "guiScale", &r.gui_scale.to_string());
    set_line(&mut out, "fov", &format!("{:.6}", r.fov));
    set_line(&mut out, "fovEffectScale", &format!("{:.6}", r.fov_effects));
    set_line(&mut out, "soundCategory_master", &format!("{:.6}", r.master_volume));
    set_line(&mut out, "soundCategory_music", &format!("{:.6}", r.music_volume));
    out
}

/// Parse `content` (the text of an `options.txt`) and return a
/// `GlobalVideoSettings` whose mirrored fields are populated from the file.
/// Fields whose key is absent or unparseable are left `None`, so the caller can
/// merge only what the game actually wrote and keep its prior value otherwise.
pub fn read_back(content: &str) -> GlobalVideoSettings {
    let get = |key: &str| line_value(content, key);
    GlobalVideoSettings {
        max_fps: get("maxFps").and_then(|v| v.parse::<u32>().ok()),
        vsync: get("enableVsync").and_then(parse_bool),
        view_bobbing: get("bobView").and_then(parse_bool),
        gui_scale: get("guiScale").and_then(|v| v.parse::<u32>().ok()),
        fov: get("fov").and_then(|v| v.parse::<f64>().ok()),
        fov_effects: get("fovEffectScale").and_then(|v| v.parse::<f64>().ok()),
        master_volume: get("soundCategory_master").and_then(|v| v.parse::<f64>().ok()),
        music_volume: get("soundCategory_music").and_then(|v| v.parse::<f64>().ok()),
        // Window settings are launcher-managed (not in options.txt), so they
        // never come back from the game — leave them None and let the caller
        // preserve its stored values.
        window_width: None,
        window_height: None,
        start_maximized: None,
    }
}

/// Merge the values the game wrote (`from_game`) into `target`, overwriting only
/// the mirrored fields that the game actually provided (a `Some`). Window
/// settings in `from_game` are always `None`, so `target` keeps its own.
pub fn merge_into(target: &mut GlobalVideoSettings, from_game: GlobalVideoSettings) {
    if from_game.max_fps.is_some() { target.max_fps = from_game.max_fps; }
    if from_game.vsync.is_some() { target.vsync = from_game.vsync; }
    if from_game.view_bobbing.is_some() { target.view_bobbing = from_game.view_bobbing; }
    if from_game.gui_scale.is_some() { target.gui_scale = from_game.gui_scale; }
    if from_game.fov.is_some() { target.fov = from_game.fov; }
    if from_game.fov_effects.is_some() { target.fov_effects = from_game.fov_effects; }
    if from_game.master_volume.is_some() { target.master_volume = from_game.master_volume; }
    if from_game.music_volume.is_some() { target.music_volume = from_game.music_volume; }
}

fn parse_bool(v: String) -> Option<bool> {
    match v.as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// Return the value of `key` in an `options.txt` body, if present. Lines are
/// `key:value`; we match the whole key before the first colon so `fov` doesn't
/// match `fovEffectScale`.
fn line_value(content: &str, key: &str) -> Option<String> {
    for line in content.lines() {
        if let Some((k, v)) = line.split_once(':') {
            if k == key {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// Replace the `key:` line in `content` in place, or append it if absent.
/// Matches the whole key before the colon to avoid `fov` clobbering
/// `fovEffectScale`.
fn set_line(content: &mut String, key: &str, value: &str) {
    let new_line = format!("{}:{}", key, value);
    let mut result = String::with_capacity(content.len() + new_line.len() + 1);
    let mut replaced = false;
    for line in content.lines() {
        let matches = line.split_once(':').map(|(k, _)| k == key).unwrap_or(false);
        if matches && !replaced {
            result.push_str(&new_line);
            replaced = true;
        } else {
            result.push_str(line);
        }
        result.push('\n');
    }
    if !replaced {
        result.push_str(&new_line);
        result.push('\n');
    }
    *content = result;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_then_read_round_trips_every_field() {
        let vs = GlobalVideoSettings {
            max_fps: Some(60),
            vsync: Some(false),
            view_bobbing: Some(false),
            gui_scale: Some(2),
            fov: Some(0.5),
            fov_effects: Some(0.25),
            master_volume: Some(0.8),
            music_volume: Some(0.1),
            window_width: None,
            window_height: None,
            start_maximized: None,
        };
        let written = apply("", &vs);
        let back = read_back(&written);
        assert_eq!(back.max_fps, Some(60));
        assert_eq!(back.vsync, Some(false));
        assert_eq!(back.view_bobbing, Some(false));
        assert_eq!(back.gui_scale, Some(2));
        assert_eq!(back.fov, Some(0.5));
        assert_eq!(back.fov_effects, Some(0.25));
        assert_eq!(back.master_volume, Some(0.8));
        assert_eq!(back.music_volume, Some(0.1));
    }

    #[test]
    fn unset_fields_write_vanilla_defaults() {
        let written = apply("", &GlobalVideoSettings::default());
        let back = read_back(&written);
        assert_eq!(back.max_fps, Some(defaults::MAX_FPS));
        assert_eq!(back.vsync, Some(defaults::VSYNC));
        assert_eq!(back.fov_effects, Some(defaults::FOV_EFFECTS));
    }

    #[test]
    fn fov_key_does_not_collide_with_fov_effect_scale() {
        // Both keys present; reading `fov` must not pick up `fovEffectScale`.
        let body = "fovEffectScale:0.500000\nfov:1.000000\n";
        assert_eq!(line_value(body, "fov"), Some("1.000000".to_string()));
        assert_eq!(line_value(body, "fovEffectScale"), Some("0.500000".to_string()));
    }

    #[test]
    fn apply_replaces_existing_line_in_place_and_preserves_others() {
        let existing = "maxFps:30\nrenderDistance:8\nfov:0.000000\n";
        let vs = GlobalVideoSettings { max_fps: Some(240), ..Default::default() };
        let out = apply(existing, &vs);
        // The unrelated key the launcher doesn't manage is preserved.
        assert!(out.contains("renderDistance:8"));
        // maxFps was replaced, not duplicated.
        assert_eq!(out.matches("maxFps:").count(), 1);
        assert_eq!(line_value(&out, "maxFps"), Some("240".to_string()));
    }

    #[test]
    fn read_back_leaves_absent_keys_none() {
        let back = read_back("renderDistance:8\n");
        assert_eq!(back.max_fps, None);
        assert_eq!(back.fov, None);
    }
}
