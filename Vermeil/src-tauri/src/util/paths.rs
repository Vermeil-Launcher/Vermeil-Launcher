use std::path::PathBuf;

/// Returns the root data directory for the launcher.
/// Windows: %APPDATA%/Vermeil
/// macOS: ~/Library/Application Support/Vermeil
/// Linux: ~/.local/share/Vermeil
pub fn data_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("Vermeil")
}

/// Returns the instances directory.
pub fn instances_dir() -> PathBuf {
    data_dir().join("instances")
}

/// Returns the shared assets directory.
pub fn assets_dir() -> PathBuf {
    data_dir().join("assets")
}

/// Returns the shared libraries directory.
pub fn libraries_dir() -> PathBuf {
    data_dir().join("libraries")
}

/// Returns the Java runtimes directory.
pub fn java_dir() -> PathBuf {
    data_dir().join("java")
}

/// Returns the metadata cache directory.
pub fn meta_dir() -> PathBuf {
    data_dir().join("meta")
}
