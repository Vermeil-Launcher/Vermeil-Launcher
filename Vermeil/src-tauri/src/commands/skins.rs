//! Tauri commands for skin and cape management.
//!
//! Thin wrappers around `services::skins`. Active-account lookup is
//! centralized here so each command can return a single targeted error
//! when no account is signed in.

use crate::services::auth::MinecraftProfile;
use crate::services::skins::{
    self, CustomCape, LocalSkin, PlayerProfile, SkinVariant,
};
use crate::util::{paths, credentials};
use std::fs;

/// Look up the currently active Microsoft account. Returns `Err` if there
/// isn't one or the active account is offline.
fn active_microsoft_account() -> Result<MinecraftProfile, String> {
    let accounts_path = paths::data_dir().join("accounts.json");
    let raw = fs::read_to_string(&accounts_path)
        .map_err(|_| "No accounts file — sign in first".to_string())?;
    let mut accounts: Vec<MinecraftProfile> =
        serde_json::from_str(&raw).map_err(|e| format!("Accounts JSON parse: {}", e))?;
    // Decrypt tokens that are stored encrypted on disk
    for account in accounts.iter_mut() {
        if let Ok(dec) = credentials::decrypt_credential(&account.access_token) {
            account.access_token = dec;
        }
        if let Some(ref rt) = account.refresh_token {
            if let Ok(dec) = credentials::decrypt_credential(rt) {
                account.refresh_token = Some(dec);
            }
        }
    }
    let active = accounts
        .into_iter()
        .find(|a| a.active)
        .ok_or_else(|| "No active account".to_string())?;
    if active.is_offline {
        return Err("Skin features require a Microsoft account.".to_string());
    }
    Ok(active)
}

#[tauri::command]
pub async fn get_skin_profile() -> Result<PlayerProfile, String> {
    let account = active_microsoft_account()?;
    skins::fetch_profile(&account).await
}

#[tauri::command]
pub async fn upload_skin(
    png_bytes: Vec<u8>,
    variant: SkinVariant,
    save_to_library: bool,
    library_name: Option<String>,
) -> Result<PlayerProfile, String> {
    let account = active_microsoft_account()?;
    if save_to_library {
        let name = library_name.unwrap_or_else(|| "Custom skin".to_string());
        // Save before upload so the library entry exists even if the user
        // re-equips it later via the local list.
        let _ = skins::add_local_skin(&account.id, &name, &png_bytes, variant);
    }
    skins::upload_and_equip_skin(&account, png_bytes, variant).await
}

#[tauri::command]
pub async fn equip_local_skin(hash: String) -> Result<PlayerProfile, String> {
    let account = active_microsoft_account()?;
    let (bytes, variant) = skins::read_local_skin(&account.id, &hash)?;
    skins::upload_and_equip_skin(&account, bytes, variant).await
}

#[tauri::command]
pub async fn reset_skin() -> Result<PlayerProfile, String> {
    let account = active_microsoft_account()?;
    skins::reset_skin(&account).await
}

#[tauri::command]
pub async fn equip_cape(cape_id: String) -> Result<PlayerProfile, String> {
    let account = active_microsoft_account()?;
    skins::equip_cape(&account, &cape_id).await
}

#[tauri::command]
pub async fn unequip_cape() -> Result<PlayerProfile, String> {
    let account = active_microsoft_account()?;
    skins::unequip_cape(&account).await
}

#[tauri::command]
pub async fn list_local_skins() -> Result<Vec<LocalSkin>, String> {
    let account = active_microsoft_account()?;
    Ok(skins::list_local_skins(&account.id))
}

#[tauri::command]
pub async fn add_local_skin(
    name: String,
    png_bytes: Vec<u8>,
    variant: SkinVariant,
) -> Result<LocalSkin, String> {
    let account = active_microsoft_account()?;
    skins::add_local_skin(&account.id, &name, &png_bytes, variant)
}

#[tauri::command]
pub async fn remove_local_skin(hash: String) -> Result<(), String> {
    let account = active_microsoft_account()?;
    skins::remove_local_skin(&account.id, &hash)
}

// ───────────────────────── Custom capes ─────────────────────────────────

/// List the account's local custom capes (display-only, never sent to Mojang).
#[tauri::command]
pub async fn list_custom_capes() -> Result<Vec<CustomCape>, String> {
    let account = active_microsoft_account()?;
    Ok(skins::list_custom_capes(&account.id))
}

/// Create or update a custom cape. `id` is `None` for a new cape, or the
/// existing cape's id when re-editing. `texture_png` is the baked 64×32 cape
/// texture; `source_bytes` is the original uploaded image (kept for re-edits).
#[tauri::command]
pub async fn save_custom_cape(
    id: Option<String>,
    name: String,
    texture_png: Vec<u8>,
    source_bytes: Vec<u8>,
    source_mime: String,
    transform: serde_json::Value,
) -> Result<CustomCape, String> {
    let account = active_microsoft_account()?;
    skins::save_custom_cape(
        &account.id,
        id,
        &name,
        &texture_png,
        &source_bytes,
        &source_mime,
        transform,
    )
}

/// Delete a custom cape and its backing files.
#[tauri::command]
pub async fn remove_custom_cape(id: String) -> Result<(), String> {
    let account = active_microsoft_account()?;
    skins::remove_custom_cape(&account.id, &id)
}

/// Read a custom cape's original uploaded image (data URL) for re-editing.
#[tauri::command]
pub async fn read_custom_cape_source(id: String) -> Result<String, String> {
    let account = active_microsoft_account()?;
    skins::read_custom_cape_source(&account.id, &id)
}

/// Fetch the current skin head for any Microsoft account on file (not just
/// the active one). Returns the skin texture as a base64 data URL, or
/// `None` for offline accounts.
///
/// Used by the Account screen so every Microsoft row shows its real face,
/// not just the currently-active one. Without this command, switching the
/// active account would visually "remove" the skin head from the previous
/// row and replace it with the colored-initial fallback.
#[tauri::command]
pub async fn get_account_skin(account_id: String) -> Result<Option<String>, String> {
    let accounts_path = paths::data_dir().join("accounts.json");
    let raw = fs::read_to_string(&accounts_path)
        .map_err(|_| "No accounts file".to_string())?;
    let mut accounts: Vec<MinecraftProfile> =
        serde_json::from_str(&raw).map_err(|e| format!("Accounts JSON parse: {}", e))?;
    // Decrypt tokens stored encrypted on disk
    for a in accounts.iter_mut() {
        if let Ok(dec) = credentials::decrypt_credential(&a.access_token) {
            a.access_token = dec;
        }
    }
    let account = accounts
        .into_iter()
        .find(|a| a.id == account_id)
        .ok_or_else(|| format!("Account {} not found", account_id))?;
    if account.is_offline {
        return Ok(None);
    }
    let profile = skins::fetch_profile(&account).await?;
    let active = profile
        .skins
        .iter()
        .find(|s| s.state == "ACTIVE")
        .or_else(|| profile.skins.first());
    Ok(active.map(|s| s.texture.clone()))
}
