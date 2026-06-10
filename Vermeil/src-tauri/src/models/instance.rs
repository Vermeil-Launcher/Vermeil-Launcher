use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoaderType {
    Vanilla,
    Fabric,
    Forge,
    Neoforge,
    Quilt,
}

impl LoaderType {
    /// Lowercase loader id used by Modrinth's API and our own URL building.
    /// Avoids `format!("{:?}", x).to_lowercase()` scattered across services.
    pub fn as_str(&self) -> &'static str {
        match self {
            LoaderType::Vanilla => "vanilla",
            LoaderType::Fabric => "fabric",
            LoaderType::Forge => "forge",
            LoaderType::Neoforge => "neoforge",
            LoaderType::Quilt => "quilt",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoaderConfig {
    #[serde(rename = "type")]
    pub loader_type: LoaderType,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JavaConfig {
    pub override_path: Option<String>,
    pub memory_max_mb: u32,
    pub memory_min_mb: u32,
    pub extra_args: Vec<String>,
}

impl Default for JavaConfig {
    fn default() -> Self {
        Self {
            override_path: None,
            memory_max_mb: 4096,
            memory_min_mb: 512,
            extra_args: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowConfig {
    pub width: u32,
    pub height: u32,
    pub fullscreen: bool,
}

impl Default for WindowConfig {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 720,
            fullscreen: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModEntry {
    pub id: String,
    pub source: String,
    pub project_id: String,
    pub version_id: String,
    pub filename: String,
    pub enabled: bool,
    pub pinned: bool,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub icon_url: Option<String>,
    /// Absolute path to a locally-cached copy of `icon_url`. Populated by the
    /// install flow via `services::icon_cache`. The frontend prefers this over
    /// `icon_url` because it's served via Tauri's `asset://` protocol — no
    /// network hit, works offline, no CDN cache-bust surprises.
    #[serde(default)]
    pub local_icon_path: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default = "default_category")]
    pub category: String,
    /// Primary author display name (Modrinth search `author` or first entry
    /// of CurseForge `authors[]`). Cached at install time so the Installed
    /// list and download history can show "by Author" without a fresh API
    /// call.
    #[serde(default)]
    pub author: Option<String>,
}

fn default_category() -> String { "mod".to_string() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Instance {
    pub format_version: u32,
    pub id: String,
    pub name: String,
    pub icon: String,
    pub icon_custom: Option<String>,
    pub created_at: String,
    pub last_played: Option<String>,
    pub total_play_seconds: u64,
    pub game_version: String,
    pub loader: LoaderConfig,
    pub java: JavaConfig,
    pub window: WindowConfig,
    pub mods: Vec<ModEntry>,
    /// Modrinth project ID if this instance was created from a modpack
    #[serde(default)]
    pub source_project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateInstanceConfig {
    pub name: String,
    pub game_version: String,
    pub loader_type: LoaderType,
    pub loader_version: Option<String>,
    pub icon: Option<String>,
    pub memory_max_mb: Option<u32>,
}
