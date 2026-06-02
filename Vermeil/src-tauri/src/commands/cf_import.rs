use crate::models::instance::Instance;
use crate::services::cf_import;
use crate::services::settings_service;

/// Import a CurseForge modpack from a .zip file.
#[tauri::command]
pub async fn import_cf_zip(
    zip_path: String,
    window: tauri::WebviewWindow,
) -> Result<Instance, String> {
    let settings = settings_service::load().await.map_err(|e| e.to_string())?;
    cf_import::import_zip(&zip_path, &settings.curseforge_api_key, Some(window)).await
}

/// Import a CurseForge profile using a share code.
#[tauri::command]
pub async fn import_cf_code(
    code: String,
    window: tauri::WebviewWindow,
) -> Result<Instance, String> {
    let settings = settings_service::load().await.map_err(|e| e.to_string())?;
    if settings.curseforge_api_key.is_empty() {
        return Err(
            "CurseForge API key is required for profile codes. Set it in Settings.".to_string(),
        );
    }
    cf_import::import_profile_code(&code, &settings.curseforge_api_key, Some(window)).await
}
