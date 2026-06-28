//! CurseForge import service.
//! Supports two import methods:
//! 1. Import from .zip file (CurseForge export format with manifest.json)
//! 2. Import from profile share code (requires CurseForge API key)

use crate::models::instance::{Instance, LoaderType, LoaderConfig, JavaConfig, WindowConfig};
use crate::services::download::DownloadTask;
use crate::services::prepare::{PostAction, prepare_with_extras};
use crate::util::paths;
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

const CF_API_BASE: &str = "https://api.curseforge.com/v1";

// === CurseForge manifest format (inside .zip exports) ===

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfManifest {
    pub minecraft: CfMinecraft,
    pub name: String,
    /// Modpack release version from the CurseForge manifest. Shown as the
    /// Library card's modpack version badge.
    #[serde(default)]
    pub version: Option<String>,
    pub files: Vec<CfFile>,
    #[serde(default)]
    pub overrides: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfMinecraft {
    pub version: String,
    #[serde(default)]
    pub mod_loaders: Vec<CfModLoader>,
}

#[derive(Debug, Deserialize)]
pub struct CfModLoader {
    pub id: String,
    #[serde(default)]
    pub primary: bool,
}

#[derive(Debug, Deserialize)]
pub struct CfFile {
    #[serde(rename = "projectID")]
    pub project_id: u64,
    #[serde(rename = "fileID")]
    pub file_id: u64,
}

// === CurseForge API response types ===

#[derive(Debug, Deserialize)]
pub struct CfApiResponse<T> {
    pub data: T,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfFileInfo {
    pub id: u64,
    pub file_name: String,
    pub download_url: Option<String>,
    pub file_length: u64,
    pub hashes: Vec<CfHash>,
}

#[derive(Debug, Deserialize)]
pub struct CfHash {
    pub value: String,
    #[serde(rename = "algo")]
    pub algo: u32, // 1 = SHA1, 2 = MD5
}

// === Import from .zip ===

/// Import a CurseForge modpack from a .zip file.
/// Extracts manifest.json, resolves mod URLs, writes instance.json, then runs
/// the unified prepare flow (game files + Java + mod content + overrides).
///
/// `source_project_id` ties the resulting instance back to its CurseForge
/// project so the modpack browser's "already installed" tracker can match it.
/// Direct zip imports (from the Import modal) pass `None`.
pub async fn import_zip(
    zip_path: &str,
    api_key: &str,
    source_project_id: Option<String>,
    window: Option<tauri::WebviewWindow>,
) -> Result<Instance, String> {
    let zip_path_buf = PathBuf::from(zip_path);
    let zip_file = fs::File::open(&zip_path_buf)
        .map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive = zip::ZipArchive::new(zip_file)
        .map_err(|e| format!("Invalid zip file: {}", e))?;

    // Find and parse manifest.json
    let manifest: CfManifest = {
        let mut manifest_file = archive.by_name("manifest.json")
            .map_err(|_| "No manifest.json found in zip. Is this a CurseForge export?".to_string())?;
        let mut content = String::new();
        std::io::Read::read_to_string(&mut manifest_file, &mut content)
            .map_err(|e| format!("Read manifest: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Parse manifest.json: {}", e))?
    };

    // Parse loader info
    let (loader_type, loader_version) = parse_loader(&manifest.minecraft.mod_loaders);

    // Resolve a non-conflicting display name. Reuses the Modrinth dedup helper
    // so importing the same CurseForge modpack twice yields "Name (2)", "(3)",
    // etc. instead of two identically-named instances.
    let instance_name = crate::services::modpack::unique_instance_name(&manifest.name)?;

    // Create the instance
    let instance_id = uuid::Uuid::new_v4().to_string();
    let instance_dir = paths::instances_dir().join(&instance_id);
    let minecraft_dir = instance_dir.join(".minecraft");
    let mods_dir = minecraft_dir.join("mods");
    fs::create_dir_all(&mods_dir).map_err(|e| e.to_string())?;

    // Resolve and prepare mod download tasks (no actual downloading yet — that
    // happens inside `prepare_with_extras` so the progress bar is unified).
    let (mod_tasks, mod_entries) = build_mod_tasks(&manifest.files, &mods_dir, api_key).await?;

    // Build instance metadata
    let instance = Instance {
        format_version: 1,
        id: instance_id.clone(),
        name: instance_name,
        icon: "cube".to_string(),
        icon_custom: None,
        game_version: manifest.minecraft.version.clone(),
        loader: LoaderConfig {
            loader_type,
            version: loader_version,
        },
        java: JavaConfig {
            override_path: None,
            memory_max_mb: 4096,
            memory_min_mb: 512,
            extra_args: Vec::new(),
            adaptive_override: false,
        },
        window: WindowConfig {
            width: 1280,
            height: 720,
        },
        mods: mod_entries,
        last_played: None,
        total_play_seconds: 0,
        created_at: chrono::Utc::now().to_rfc3339(),
        source_project_id,
        source_platforms: vec!["curseforge".to_string()],
        source_version: manifest.version.clone(),
        companion_enabled: true,
    };

    // Save instance.json
    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    fs::write(instance_dir.join("instance.json"), json).map_err(|e| e.to_string())?;

    // Build the override-extraction post action
    let zip_path_owned = zip_path_buf.clone();
    let overrides_prefix = if manifest.overrides.is_empty() {
        "overrides".to_string()
    } else {
        manifest.overrides.clone()
    };
    let minecraft_dir_owned = minecraft_dir.clone();
    let post: PostAction = Box::new(move || {
        Box::pin(async move {
            extract_overrides_async(zip_path_owned, overrides_prefix, minecraft_dir_owned).await
        })
    });

    // Run the unified prepare flow: MC libs/assets/client + loader libs + Java + mods + overrides
    // On failure, delete the partially-created instance directory so no broken
    // instance shows up in the library.
    let window_for_revalidate = window.clone();
    let window_for_enrichment = window.clone();
    if let Err(e) = prepare_with_extras(&instance, mod_tasks, Some(post), window).await {
        tracing::error!("CurseForge import prepare failed, cleaning up instance {}: {}", instance_id, e);
        let _ = fs::remove_dir_all(&instance_dir);
        return Err(e);
    }

    // Loader-version validation — bump the loader if any mod needs a newer
    // one than the manifest declared, then re-prepare loader libs.
    if let Err(e) = crate::services::modpack::revalidate_loader(&instance_id, window_for_revalidate).await {
        tracing::warn!("Loader revalidation failed for {} (non-fatal): {}", instance_id, e);
    }

    // Enrich mod metadata in the background so the install completes
    // immediately. Two-phase: metadata first (cards populate), icons
    // second (cards swap to local copies). The function emits
    // `instance-enriched` itself after each phase.
    let id_for_enrichment = instance_id.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::services::modpack::enrich_mod_metadata(&id_for_enrichment, window_for_enrichment).await {
            tracing::warn!("Metadata enrichment failed for {} (non-fatal): {}", id_for_enrichment, e);
        }
    });

    let final_instance = crate::services::instance_service::get_by_id(&instance_id)
        .await
        .unwrap_or(instance);

    Ok(final_instance)
}

// === Import from profile code ===

/// Import a CurseForge profile using a share code.
/// Note: This feature requires CurseForge's internal API which may not be publicly available.
pub async fn import_profile_code(
    code: &str,
    api_key: &str,
    window: Option<tauri::WebviewWindow>,
) -> Result<Instance, String> {
    if api_key.is_empty() {
        return Err("CurseForge API key is required. Set it in Settings → CurseForge API Key.".to_string());
    }

    // Try the known endpoints for share code resolution
    // CurseForge doesn't publicly document this endpoint — try common patterns
    let endpoints = [
        format!("{}/mods/share-code/{}", CF_API_BASE, code.trim()),
        format!("{}/minecraft/modpacks/share-code/{}", CF_API_BASE, code.trim()),
        format!("{}/profiles/{}", CF_API_BASE, code.trim()),
    ];

    let mut last_error = String::new();
    for url in &endpoints {
        let resp = crate::util::http::HTTP
            .get(url)
            .header("x-api-key", api_key)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("CurseForge API request failed: {}", e))?;

        if resp.status().is_success() {
            let body: serde_json::Value = resp.json().await
                .map_err(|e| format!("Parse CurseForge response: {}", e))?;

            // Try to extract data from the response
            let data = body.get("data").unwrap_or(&body);

            let name = data.get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("Imported Pack")
                .to_string();
            // Dedupe against existing instances so re-importing yields "Name (2)".
            let name = crate::services::modpack::unique_instance_name(&name)?;

            let game_version = data.get("gameVersion")
                .or(data.get("minecraft").and_then(|m| m.get("version")))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let files: Vec<CfFile> = if let Some(files_arr) = data.get("files").and_then(|v| v.as_array()) {
                files_arr.iter().filter_map(|f| {
                    let project_id = f.get("projectID").or(f.get("projectId")).and_then(|v| v.as_u64())?;
                    let file_id = f.get("fileID").or(f.get("fileId")).and_then(|v| v.as_u64())?;
                    Some(CfFile { project_id, file_id })
                }).collect()
            } else {
                Vec::new()
            };

            let loader_type;
            let loader_version;
            if let Some(loaders) = data.get("modLoaders").or(data.get("minecraft").and_then(|m| m.get("modLoaders"))).and_then(|v| v.as_array()) {
                let parsed: Vec<CfModLoader> = loaders.iter().filter_map(|l| {
                    Some(CfModLoader {
                        id: l.get("id").and_then(|v| v.as_str())?.to_string(),
                        primary: l.get("primary").and_then(|v| v.as_bool()).unwrap_or(false),
                    })
                }).collect();
                let (lt, lv) = parse_loader(&parsed);
                loader_type = lt;
                loader_version = lv;
            } else {
                loader_type = LoaderType::Vanilla;
                loader_version = None;
            }

            let instance_id = uuid::Uuid::new_v4().to_string();
            let instance_dir = paths::instances_dir().join(&instance_id);
            let minecraft_dir = instance_dir.join(".minecraft");
            let mods_dir = minecraft_dir.join("mods");
            fs::create_dir_all(&mods_dir).map_err(|e| e.to_string())?;

            let (mod_tasks, mod_entries) = build_mod_tasks(&files, &mods_dir, api_key).await?;

            let instance = Instance {
                format_version: 1,
                id: instance_id.clone(),
                name,
                icon: "cube".to_string(),
                icon_custom: None,
                game_version,
                loader: LoaderConfig { loader_type, version: loader_version },
                java: JavaConfig { override_path: None, memory_max_mb: 4096, memory_min_mb: 512, extra_args: Vec::new(), adaptive_override: false },
                window: WindowConfig { width: 1280, height: 720 },
                mods: mod_entries,
                last_played: None,
                total_play_seconds: 0,
                created_at: chrono::Utc::now().to_rfc3339(),
                source_project_id: None,
                source_platforms: vec!["curseforge".to_string()],
                source_version: None,
                companion_enabled: true,
            };

            let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
            fs::write(instance_dir.join("instance.json"), json).map_err(|e| e.to_string())?;

            // No overrides to extract from a profile-code import (no zip on disk).
            prepare_with_extras(&instance, mod_tasks, None, window).await?;

            return Ok(instance);
        }

        last_error = format!("HTTP {}", resp.status());
    }

    Err(format!(
        "Profile code import is not supported by CurseForge's public API. \
        Use the .zip export method instead: In CurseForge app → three dots → Share Profile → Export as .zip. \
        (Last API error: {})", last_error
    ))
}

// === Helpers ===

/// Parse loader type and version from CurseForge mod loader IDs (e.g. "fabric-0.19.2", "forge-47.4.5")
fn parse_loader(loaders: &[CfModLoader]) -> (LoaderType, Option<String>) {
    let primary = loaders.iter().find(|l| l.primary).or(loaders.first());

    if let Some(loader) = primary {
        let id = &loader.id;
        if id.starts_with("fabric-") {
            let version = id.strip_prefix("fabric-").unwrap_or("").to_string();
            (LoaderType::Fabric, Some(version))
        } else if id.starts_with("quilt-") {
            let version = id.strip_prefix("quilt-").unwrap_or("").to_string();
            (LoaderType::Quilt, Some(version))
        } else if id.starts_with("neoforge-") {
            let version = id.strip_prefix("neoforge-").unwrap_or("").to_string();
            (LoaderType::Neoforge, Some(version))
        } else if id.starts_with("forge-") {
            let version = id.strip_prefix("forge-").unwrap_or("").to_string();
            (LoaderType::Forge, Some(version))
        } else {
            (LoaderType::Vanilla, None)
        }
    } else {
        (LoaderType::Vanilla, None)
    }
}

/// Build mod download tasks + ModEntry list using the CurseForge API to resolve URLs.
/// Returns (tasks, entries) — tasks are deferred to `prepare_with_extras` so the
/// progress bar covers game files + mods together.
async fn build_mod_tasks(
    files: &[CfFile],
    mods_dir: &PathBuf,
    api_key: &str,
) -> Result<(Vec<DownloadTask>, Vec<crate::models::instance::ModEntry>), String> {
    use crate::models::instance::ModEntry;

    if files.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }

    // Batch resolve file info from CurseForge API
    let file_infos = resolve_files(files, api_key).await?;

    let mut tasks: Vec<DownloadTask> = Vec::new();
    let mut mod_entries: Vec<ModEntry> = Vec::new();

    for info in &file_infos {
        // CurseForge returns `download_url: null` when a mod author opts out of
        // third-party API distribution. The file still exists on CurseForge's
        // CDN, though — we reconstruct the direct URL from the file ID using
        // the well-known forgecdn path scheme. This is the standard workaround
        // every third-party launcher uses; without it those mods silently
        // vanish from the install and the modpack crashes with NoClassDefFound.
        let url = match &info.download_url {
            Some(u) => u.clone(),
            None => forgecdn_fallback_url(info.id, &info.file_name),
        };

        let dest = mods_dir.join(&info.file_name);
        let sha1 = info
            .hashes
            .iter()
            .find(|h| h.algo == 1)
            .map(|h| h.value.clone());

        tasks.push(DownloadTask {
            url,
            dest: dest.clone(),
            expected_sha1: sha1,
            expected_size: Some(info.file_length),
        });

        // Find the corresponding project ID
        let project_id = files
            .iter()
            .find(|f| f.file_id == info.id)
            .map(|f| f.project_id.to_string())
            .unwrap_or_default();

        mod_entries.push(ModEntry {
            id: uuid::Uuid::new_v4().to_string(),
            source: "curseforge".to_string(),
            project_id,
            version_id: info.id.to_string(),
            filename: info.file_name.clone(),
            version_number: None,
            enabled: true,
            pinned: false,
            title: None,
            icon_url: None,
            local_icon_path: None,
            description: None,
            category: "mod".to_string(),
            author: None,
        });
    }

    Ok((tasks, mod_entries))
}

/// Construct a CurseForge CDN download URL from a file ID + filename.
///
/// CurseForge's CDN lays files out at:
///   `https://edge.forgecdn.net/files/{id/1000}/{id%1000}/{filename}`
///
/// This works even when the API returns `downloadUrl: null` (author disabled
/// third-party distribution) because the CDN path is derived purely from the
/// numeric file ID. Spaces in the filename become `%20`; other characters in
/// CurseForge filenames are CDN-safe.
fn forgecdn_fallback_url(file_id: u64, file_name: &str) -> String {
    let a = file_id / 1000;
    let b = file_id % 1000;
    let encoded = file_name.replace(' ', "%20");
    format!("https://edge.forgecdn.net/files/{}/{}/{}", a, b, encoded)
}

/// Resolve file download URLs from CurseForge API (batch endpoint).
async fn resolve_files(files: &[CfFile], api_key: &str) -> Result<Vec<CfFileInfo>, String> {
    if api_key.is_empty() {
        // Without API key, try to construct URLs from the file IDs (edge.forgecdn.net pattern)
        // This works for most mods that allow third-party distribution
        return resolve_files_without_api(files).await;
    }

    // Use the batch files endpoint
    let file_ids: Vec<u64> = files.iter().map(|f| f.file_id).collect();

    let resp = crate::util::http::HTTP
        .post(&format!("{}/mods/files", CF_API_BASE))
        .header("x-api-key", api_key)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&serde_json::json!({ "fileIds": file_ids }))
        .send()
        .await
        .map_err(|e| format!("CurseForge files API failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("CurseForge files API error ({}): {}", status, text));
    }

    let body: CfApiResponse<Vec<CfFileInfo>> = resp.json().await
        .map_err(|e| format!("Parse files response: {}", e))?;

    Ok(body.data)
}

/// Fallback: construct download URLs without API key using the forgecdn pattern.
/// This only works for mods that allow third-party distribution.
async fn resolve_files_without_api(_files: &[CfFile]) -> Result<Vec<CfFileInfo>, String> {
    // We can't resolve filenames without the API, so we'll use a placeholder approach
    // The user should set their API key for full functionality
    Err("CurseForge API key is required to download mods. Set it in Settings.".to_string())
}

/// Extract override files from the zip into the .minecraft directory.
/// Runs as a post-download action so overrides land on top of mod files.
async fn extract_overrides_async(
    zip_path: PathBuf,
    overrides_prefix: String,
    minecraft_dir: PathBuf,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let zip_file = fs::File::open(&zip_path)
            .map_err(|e| format!("Reopen zip: {}", e))?;
        let mut archive = zip::ZipArchive::new(zip_file)
            .map_err(|e| format!("Reread zip: {}", e))?;
        let prefix = format!("{}/", overrides_prefix);

        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| format!("Zip entry: {}", e))?;
            let name = entry.name().to_string();

            if !name.starts_with(&prefix) || name == prefix {
                continue;
            }

            // Strip the overrides/ prefix to get the relative path
            let relative = &name[prefix.len()..];
            let dest = minecraft_dir.join(relative);

            if entry.is_dir() {
                let _ = fs::create_dir_all(&dest);
            } else {
                if let Some(parent) = dest.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let mut outfile = fs::File::create(&dest)
                    .map_err(|e| format!("Create override file: {}", e))?;
                std::io::copy(&mut entry, &mut outfile)
                    .map_err(|e| format!("Extract override: {}", e))?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Override extraction task panicked: {}", e))?
}
