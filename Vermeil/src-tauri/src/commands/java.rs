//! Tauri commands for Java location management.
//!
//! Thin wrappers around `services::java`. All heavy work (subprocess spawn,
//! registry access, archive extraction) lives in the service.

use crate::services::java::{self, JavaInstall};
use crate::services::settings_service;

/// Re-scan the system for installed JREs across all five sources.
#[tauri::command]
pub async fn detect_java_installations() -> Result<Vec<JavaInstall>, String> {
    Ok(java::detect_installations().await)
}

/// Validate a user-picked path and return the parsed [`JavaInstall`] if it
/// resolves to a runnable JRE. The frontend uses this to verify the file
/// chosen via the Browse button before saving it.
#[tauri::command]
pub async fn validate_java_path(path: String) -> Result<JavaInstall, String> {
    java::validate_path(&path).await
}

/// Persist a per-major Java path override into `LauncherSettings`. Pass
/// `path = None` to clear the override (which falls back to auto-detection /
/// auto-install).
#[tauri::command]
pub async fn set_java_path(major: u8, path: Option<String>) -> Result<(), String> {
    let mut settings = settings_service::load().await.map_err(|e| e.to_string())?;
    match path {
        Some(p) if !p.is_empty() => {
            settings.java_paths.insert(major, p);
        }
        _ => {
            settings.java_paths.remove(&major);
        }
    }
    settings_service::save(&settings)
        .await
        .map_err(|e| e.to_string())
}

/// Trigger an Adoptium download for the given major version and store the
/// resulting executable path on `LauncherSettings::java_paths` so subsequent
/// launches use it without re-detection.
#[tauri::command]
pub async fn install_recommended_java(major: u8) -> Result<JavaInstall, String> {
    let install = java::install_recommended(major).await?;
    let mut settings = settings_service::load().await.map_err(|e| e.to_string())?;
    settings.java_paths.insert(major, install.path.clone());
    settings_service::save(&settings)
        .await
        .map_err(|e| e.to_string())?;
    Ok(install)
}
