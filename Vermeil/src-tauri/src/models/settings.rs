use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherSettings {
    pub java_runtime: String,
    pub default_memory_mb: u32,
    pub gc_preset: String,
    pub close_on_launch: bool,
    pub auto_update: bool,
    pub discord_rpc: bool,
    pub show_snapshots: bool,
    #[serde(default = "default_concurrent_downloads")]
    pub concurrent_downloads: u8,
    /// Maximum simultaneous disk writes. Separated from network concurrency so a slow
    /// disk doesn't starve fetches and vice versa.
    #[serde(default = "default_concurrent_writes")]
    pub concurrent_writes: u8,
    pub mod_sources: Vec<String>,
    #[serde(default)]
    pub force_delete: bool,
    #[serde(default)]
    pub curseforge_api_key: String,
    /// Whether the user has completed the first-run onboarding wizard. Defaults
    /// to `false` so existing users who upgrade also see it once (a five-second
    /// detour vs an indefinitely empty Library for new installs).
    #[serde(default)]
    pub onboarded: bool,
    /// User-selected Java executable per major version (e.g. `21 → "C:/Program
    /// Files/Eclipse Adoptium/jdk-21.0.2+13/bin/javaw.exe"`). Populated by the
    /// Settings → Resources → Java section. Falls back to auto-detection /
    /// auto-install when a major isn't pinned. Keys are major versions
    /// (8, 17, 21, 25, etc.).
    #[serde(default)]
    pub java_paths: HashMap<u8, String>,
    /// Instance IDs pinned to the sidebar as quick-launch shortcuts. Capped
    /// at 3 by the UI; we don't enforce server-side because anything saved
    /// here was authored by the launcher itself, not user input.
    #[serde(default)]
    pub sidebar_pinned_instances: Vec<String>,
    /// Global video settings applied to every instance's options.txt before launch.
    /// When a field is `None`, the launcher leaves that setting untouched in options.txt.
    #[serde(default)]
    pub video_settings: GlobalVideoSettings,

    /// User-customizable keyboard shortcuts. Map of action ID → key combo
    /// (e.g. `"Ctrl+P"`). Action IDs are defined in `Vermeil/src/lib/keybinds.ts`
    /// (frontend is the source of truth for the action registry; settings just
    /// store user overrides). Missing entries fall back to hardcoded defaults
    /// in the frontend, so a partial / empty map still works.
    #[serde(default)]
    pub keybinds: HashMap<String, String>,
}

/// Video settings that get written into each instance's options.txt before launch.
/// `None` means "don't override, leave whatever the user set in-game."
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GlobalVideoSettings {
    /// Max framerate (10–260). None = don't override.
    pub max_fps: Option<u32>,
    /// VSync on/off. None = don't override.
    pub vsync: Option<bool>,
    /// View bobbing on/off. None = don't override.
    pub view_bobbing: Option<bool>,
    /// GUI scale (0=auto, 1=small, 2=normal, 3=large, 4=huge). None = don't override.
    pub gui_scale: Option<u32>,
    /// FOV as the options.txt float value (-1.0 to 1.0). Degrees = 40*value + 70.
    /// So 0.0 = 70°, 1.0 = 110°, -1.0 = 30°. None = don't override.
    pub fov: Option<f64>,
    /// FOV Effects scale (0.0 to 1.0). Controls how much speed/slowness affects
    /// the field of view (accessibility setting: fovEffectScale). None = don't override.
    pub fov_effects: Option<f64>,
}

fn default_concurrent_downloads() -> u8 { 10 }
fn default_concurrent_writes() -> u8 { 10 }

impl Default for LauncherSettings {
    fn default() -> Self {
        Self {
            java_runtime: "auto".to_string(),
            default_memory_mb: 4096,
            gc_preset: "g1gc".to_string(),
            close_on_launch: true,
            auto_update: true,
            discord_rpc: false,
            show_snapshots: false,
            concurrent_downloads: default_concurrent_downloads(),
            concurrent_writes: default_concurrent_writes(),
            mod_sources: vec!["modrinth".to_string(), "curseforge".to_string()],
            force_delete: false,
            curseforge_api_key: "$2a$10$Vqhx8J1qatEwez9lhg6cjeh1W6RC6H8AtXeLdu7o8H45smb66wCgu".to_string(),
            onboarded: false,
            java_paths: HashMap::new(),
            sidebar_pinned_instances: Vec::new(),
            video_settings: GlobalVideoSettings::default(),
            keybinds: HashMap::new(),
        }
    }
}
