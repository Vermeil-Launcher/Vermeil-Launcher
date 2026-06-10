//! Modpack installation service (Modrinth .mrpack format).
//!
//! Single-pass install: writes instance.json, builds the list of mod-content
//! download tasks from `modrinth.index.json`, then hands everything to
//! `prepare_with_extras` so game files + Java + mod content all stream through
//! one batch with one progress popup.

use crate::models::instance::{Instance, JavaConfig, LoaderConfig, LoaderType, ModEntry, WindowConfig};
use crate::services::download::{DownloadTask, download_file};
use crate::services::prepare::{PostAction, prepare_with_extras};
use crate::util::paths;
use serde::Deserialize;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use tauri::Emitter;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
struct MrpackIndex {
    name: String,
    files: Vec<MrpackFile>,
    dependencies: std::collections::HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct MrpackFile {
    path: String,
    hashes: MrpackHashes,
    downloads: Vec<String>,
    #[serde(rename = "fileSize")]
    file_size: u64,
}

#[derive(Debug, Deserialize)]
struct MrpackHashes {
    sha1: Option<String>,
}

/// Install a modpack from a Modrinth project. Downloads the .mrpack metadata,
/// then runs the unified prepare flow (game files + Java + mod content + overrides).
pub async fn install_from_modrinth(
    project_id: &str,
    version_id: Option<&str>,
    window: Option<tauri::WebviewWindow>,
) -> Result<Instance, String> {
    let source_project_id = project_id.to_string();

    // Show the install-progress popup immediately so the user sees feedback while
    // we do the API calls + .mrpack download. Without this, the UI sits frozen on
    // a closed modal for several seconds before `prepare_with_extras` opens the popup.
    if let Some(ref w) = window {
        let _ = w.emit(
            "install-progress",
            crate::services::prepare::InstallProgressPayload {
                section: "game".to_string(),
                title: "Modpack".to_string(),
                message: "Fetching modpack metadata...".to_string(),
                fraction: 0.0,
                skipped: false,
            },
        );
    }

    // Fetch the project's icon up-front so the new instance carries it as
    // its tile icon in the Library and sidebar pin tile. Best-effort —
    // a missing icon falls back to the generic placeholder.
    let project_icon_path = match fetch_project_icon(project_id).await {
        Ok(Some(url)) => crate::services::icon_cache::cache_remote_icon(&url).await,
        _ => None,
    };

    // 1. Get the version to install
    let version_url = if let Some(vid) = version_id {
        format!("https://api.modrinth.com/v2/version/{}", vid)
    } else {
        // Get latest version
        let versions_url = format!(
            "https://api.modrinth.com/v2/project/{}/version",
            project_id
        );
        let resp = crate::util::http::HTTP
            .get(&versions_url)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch versions for {}: {}", project_id, e))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Modrinth returned HTTP {} when fetching versions for project {}: {}",
                status, project_id, body.chars().take(200).collect::<String>()
            ));
        }
        let versions: Vec<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse versions list for {}: {}", project_id, e))?;
        let first = versions.first().ok_or("No versions available")?;
        let vid = first.get("id").and_then(|v| v.as_str()).ok_or("No version ID")?;
        format!("https://api.modrinth.com/v2/version/{}", vid)
    };

    let resp = crate::util::http::HTTP
        .get(&version_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch version data: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Modrinth returned HTTP {} when fetching version data: {}",
            status, body.chars().take(200).collect::<String>()
        ));
    }
    let version_data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse version data: {}", e))?;

    // Find the .mrpack file
    let files = version_data
        .get("files")
        .and_then(|f| f.as_array())
        .ok_or("No files in version")?;
    let mrpack_file = files
        .iter()
        .find(|f| {
            f.get("filename")
                .and_then(|n| n.as_str())
                .map(|n| n.ends_with(".mrpack"))
                .unwrap_or(false)
        })
        .ok_or("No .mrpack file found")?;

    let mrpack_url = mrpack_file
        .get("url")
        .and_then(|u| u.as_str())
        .ok_or("No URL for mrpack")?;

    // 2. Download the .mrpack file (small, single download — kept outside the unified batch
    // because we need to read its manifest before we know what else to download).
    if let Some(ref w) = window {
        let _ = w.emit(
            "install-progress",
            crate::services::prepare::InstallProgressPayload {
                section: "game".to_string(),
                title: "Modpack".to_string(),
                message: "Downloading modpack...".to_string(),
                fraction: 0.0,
                skipped: false,
            },
        );
    }
    let temp_path = paths::data_dir().join("temp_modpack.mrpack");
    let task = DownloadTask {
        url: mrpack_url.to_string(),
        dest: temp_path.clone(),
        expected_sha1: None,
        expected_size: None,
    };
    download_file(&crate::util::http::HTTP, &task).await?;

    // 3. Install from the downloaded file
    let result = install_from_mrpack_file(
        &temp_path,
        Some(source_project_id),
        project_icon_path,
        window,
    )
    .await;

    // Cleanup temp file regardless of success/failure
    let _ = fs::remove_file(&temp_path);

    result
}

/// Install a modpack from a local .mrpack file. Writes instance.json, then runs
/// the unified prepare flow with mod tasks + an override-extraction post action.
///
/// `project_icon_path` is an optional pre-cached icon path (typically populated
/// when this is called via `install_from_modrinth`). If supplied, it becomes
/// the new instance's `icon`. Imports from a local file with no project context
/// pass `None` and get the generic `"cube"` placeholder.
pub async fn install_from_mrpack_file(
    mrpack_path: &PathBuf,
    source_project_id: Option<String>,
    project_icon_path: Option<String>,
    window: Option<tauri::WebviewWindow>,
) -> Result<Instance, String> {
    // Open the ZIP and read the manifest.
    let file = fs::File::open(mrpack_path).map_err(|e| format!("Open mrpack: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Read mrpack ZIP: {}", e))?;

    let mut index_str = String::new();
    {
        let mut entry = archive
            .by_name("modrinth.index.json")
            .map_err(|_| "No modrinth.index.json in mrpack")?;
        entry
            .read_to_string(&mut index_str)
            .map_err(|e| format!("Read index: {}", e))?;
    }

    let index: MrpackIndex = serde_json::from_str(&index_str)
        .map_err(|e| format!("Parse modrinth.index.json: {}", e))?;

    // Determine loader and game version
    let game_version = index
        .dependencies
        .get("minecraft")
        .cloned()
        .ok_or("No minecraft version in modpack")?;

    let (loader_type, loader_version) = if let Some(v) = index.dependencies.get("fabric-loader") {
        (LoaderType::Fabric, Some(v.clone()))
    } else if let Some(v) = index.dependencies.get("quilt-loader") {
        (LoaderType::Quilt, Some(v.clone()))
    } else if let Some(v) = index.dependencies.get("neoforge") {
        (LoaderType::Neoforge, Some(v.clone()))
    } else if let Some(v) = index.dependencies.get("forge") {
        (LoaderType::Forge, Some(v.clone()))
    } else {
        (LoaderType::Vanilla, None)
    };

    // Create instance directory
    let id = Uuid::new_v4().to_string();
    let instance_dir = paths::instances_dir().join(&id);
    let minecraft_dir = instance_dir.join(".minecraft");
    let mods_dir = minecraft_dir.join("mods");
    fs::create_dir_all(&mods_dir).map_err(|e| e.to_string())?;

    // Build mod download tasks + ModEntry list (entries reflect what *will* be on disk
    // after `prepare_with_extras` finishes downloading them).
    let mut mod_tasks: Vec<DownloadTask> = Vec::new();
    let mut mod_entries: Vec<ModEntry> = Vec::new();

    for mf in &index.files {
        if let Some(url) = mf.downloads.first() {
            let dest = minecraft_dir.join(&mf.path);
            mod_tasks.push(DownloadTask {
                url: url.clone(),
                dest: dest.clone(),
                expected_sha1: mf.hashes.sha1.clone(),
                expected_size: Some(mf.file_size),
            });

            // Track as content entry based on path
            if let Some(filename) = mf.path.strip_prefix("mods/") {
                mod_entries.push(ModEntry {
                    id: filename.to_string(),
                    source: "modpack".to_string(),
                    project_id: String::new(),
                    version_id: String::new(),
                    filename: filename.to_string(),
                    enabled: true,
                    pinned: false,
                    title: None,
                    icon_url: None,
                    local_icon_path: None,
                    description: None,
                    category: "mod".to_string(),
                    author: None,
                });
            } else if let Some(filename) = mf.path.strip_prefix("resourcepacks/") {
                mod_entries.push(ModEntry {
                    id: filename.to_string(),
                    source: "modpack".to_string(),
                    project_id: String::new(),
                    version_id: String::new(),
                    filename: filename.to_string(),
                    enabled: true,
                    pinned: false,
                    title: None,
                    icon_url: None,
                    local_icon_path: None,
                    description: None,
                    category: "resourcepack".to_string(),
                    author: None,
                });
            } else if let Some(filename) = mf.path.strip_prefix("shaderpacks/") {
                mod_entries.push(ModEntry {
                    id: filename.to_string(),
                    source: "modpack".to_string(),
                    project_id: String::new(),
                    version_id: String::new(),
                    filename: filename.to_string(),
                    enabled: true,
                    pinned: false,
                    title: None,
                    icon_url: None,
                    local_icon_path: None,
                    description: None,
                    category: "shader".to_string(),
                    author: None,
                });
            }
        }
    }

    // Write the instance metadata so it appears in the library immediately
    // (with duplicate-name handling).
    let final_name = unique_instance_name(&index.name)?;
    let now = chrono::Utc::now().to_rfc3339();
    // The pre-cached project icon (passed in by `install_from_modrinth`) becomes
    // the new instance's tile icon. Local-file imports pass `None` and fall
    // back to the generic `"cube"` placeholder, which the frontend reads as
    // "show the loader-tinted default tile."
    let icon_value = project_icon_path.unwrap_or_else(|| "cube".to_string());
    let instance = Instance {
        format_version: 1,
        id: id.clone(),
        name: final_name,
        icon: icon_value,
        icon_custom: None,
        created_at: now,
        last_played: None,
        total_play_seconds: 0,
        game_version,
        loader: LoaderConfig {
            loader_type,
            version: loader_version,
        },
        java: JavaConfig::default(),
        window: WindowConfig::default(),
        mods: mod_entries,
        source_project_id,
    };

    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    fs::write(instance_dir.join("instance.json"), json).map_err(|e| e.to_string())?;

    // Build the override-extraction post action. Captures the .mrpack path; runs
    // after all downloads complete so overrides are written on top of mod files.
    let mrpack_path_owned = mrpack_path.clone();
    let minecraft_dir_owned = minecraft_dir.clone();
    let post: PostAction = Box::new(move || {
        Box::pin(async move {
            extract_overrides(&mrpack_path_owned, &minecraft_dir_owned).await
        })
    });

    // Run the unified prepare flow. This handles MC libs/assets/client jar,
    // loader libs, Java, then mod files, and finally extracts overrides via
    // the post action above.
    // On failure, delete the partially-created instance directory so no broken
    // instance shows up in the library.
    let window_for_revalidate = window.clone();
    if let Err(e) = prepare_with_extras(&instance, mod_tasks, Some(post), window).await {
        tracing::error!("Modpack prepare failed, cleaning up instance {}: {}", id, e);
        let _ = fs::remove_dir_all(&instance_dir);
        return Err(e);
    }

    // Loader-version validation: now that the mods are on disk, scan them for
    // loader requirements the pack's declared loader version doesn't meet. If
    // a bump is needed, instance.json is updated and we re-run prepare to pull
    // the newer loader libraries.
    if let Err(e) = revalidate_loader(&id, window_for_revalidate).await {
        tracing::warn!("Loader revalidation failed for {} (non-fatal): {}", id, e);
    }

    // Re-read the (possibly loader-bumped) instance so the returned value
    // reflects the final state.
    let final_instance = crate::services::instance_service::get_by_id(&id)
        .await
        .unwrap_or(instance);

    Ok(final_instance)
}

/// Scan installed mods and bump the loader version if any mod requires a
/// newer one, then re-prepare to install the new loader libraries. Shared by
/// the Modrinth and CurseForge modpack install paths.
pub async fn revalidate_loader(
    instance_id: &str,
    window: Option<tauri::WebviewWindow>,
) -> Result<(), String> {
    let fix = crate::services::loader_scan::validate_and_fix_loader(instance_id).await?;
    if !fix.bumped {
        return Ok(());
    }

    // Surface the bump to the user.
    if let (Some(ref w), Some(ref from), Some(ref to)) =
        (window.as_ref(), &fix.from_version, &fix.to_version)
    {
        let _ = w.emit(
            "install-progress",
            crate::services::prepare::InstallProgressPayload {
                section: "game".to_string(),
                title: "Adjusting loader".to_string(),
                message: format!(
                    "Upgraded loader {} → {} for {} mod{}",
                    from, to, fix.mods_requiring,
                    if fix.mods_requiring == 1 { "" } else { "s" }
                ),
                fraction: 0.0,
                skipped: false,
            },
        );
    }

    // Re-run prepare with the bumped loader version to fetch its libraries.
    let bumped = crate::services::instance_service::get_by_id(instance_id)
        .await
        .map_err(|e| format!("Reload instance after bump: {}", e))?;
    crate::services::prepare::prepare(&bumped, window).await
}

/// Generate a unique instance name by appending "(N)" if needed. Shared with
/// the CurseForge import path so both modpack sources dedupe names the same way.
pub(crate) fn unique_instance_name(base_name: &str) -> Result<String, String> {
    let instances_dir = paths::instances_dir();
    if !instances_dir.exists() {
        return Ok(base_name.to_string());
    }

    let mut existing_names: Vec<String> = Vec::new();
    for entry in fs::read_dir(&instances_dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let meta = entry.path().join("instance.json");
        if meta.exists() {
            if let Ok(content) = fs::read_to_string(&meta) {
                if let Ok(inst) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(name) = inst.get("name").and_then(|n| n.as_str()) {
                        existing_names.push(name.to_string());
                    }
                }
            }
        }
    }

    if !existing_names.iter().any(|n| n == base_name) {
        return Ok(base_name.to_string());
    }

    let mut count = 2;
    loop {
        let candidate = format!("{} ({})", base_name, count);
        if !existing_names.iter().any(|n| n == &candidate) {
            return Ok(candidate);
        }
        count += 1;
    }
}

/// Extract override files from a .mrpack into the instance's .minecraft directory.
/// Run as a post-download action so overrides land on top of any mod files.
async fn extract_overrides(
    mrpack_path: &PathBuf,
    minecraft_dir: &PathBuf,
) -> Result<(), String> {
    let mrpack_path = mrpack_path.clone();
    let minecraft_dir = minecraft_dir.clone();

    // Run the synchronous zip extraction on a blocking thread so we don't
    // stall the async runtime.
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let file = fs::File::open(&mrpack_path).map_err(|e| format!("Reopen mrpack: {}", e))?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Reread ZIP: {}", e))?;

        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("ZIP entry: {}", e))?;
            let name = entry.name().to_string();

            let rel_path = if let Some(rest) = name.strip_prefix("overrides/") {
                Some(rest.to_string())
            } else {
                name.strip_prefix("client-overrides/").map(|s| s.to_string())
            };

            if let Some(rel) = rel_path {
                if rel.is_empty() || entry.is_dir() {
                    let dir = minecraft_dir.join(&rel);
                    let _ = fs::create_dir_all(&dir);
                } else {
                    let dest = minecraft_dir.join(&rel);
                    if let Some(parent) = dest.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    let mut outfile =
                        fs::File::create(&dest).map_err(|e| format!("Create: {}", e))?;
                    std::io::copy(&mut entry, &mut outfile)
                        .map_err(|e| format!("Extract: {}", e))?;
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Override extraction task panicked: {}", e))??;

    Ok(())
}


/// Fetch a Modrinth project's `icon_url` field. Returns `Ok(None)` when the
/// project has no icon set, `Err` only on transport / parse failure. Used by
/// `install_from_modrinth` to populate the new instance's tile icon.
async fn fetch_project_icon(project_id: &str) -> Result<Option<String>, String> {
    let url = format!("https://api.modrinth.com/v2/project/{}", project_id);
    let resp = crate::util::http::HTTP
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Modrinth project fetch: {}", e))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v.get("icon_url")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string()))
}

/// Fetch a CurseForge project's logo/thumbnail URL. Returns `Ok(None)` when
/// the project has no logo, `Err` only on transport failure. Used by
/// `install_from_curseforge` to populate the new instance's tile icon.
async fn fetch_cf_project_icon(api_key: &str, project_id: &str) -> Result<Option<String>, String> {
    let url = format!("https://api.curseforge.com/v1/mods/{}", project_id);
    let resp = crate::util::http::HTTP
        .get(&url)
        .header("x-api-key", api_key)
        .send()
        .await
        .map_err(|e| format!("CurseForge project fetch: {}", e))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v.get("data")
        .and_then(|d| d.get("logo"))
        .and_then(|l| l.get("thumbnailUrl"))
        .and_then(|u| u.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string()))
}

/// Install a modpack from a CurseForge project ID. Fetches the modpack zip
/// from the CurseForge API, downloads it, then imports via `cf_import::import_zip`.
pub async fn install_from_curseforge(
    project_id: &str,
    file_id: Option<&str>,
    window: Option<tauri::WebviewWindow>,
) -> Result<Instance, String> {
    // Show progress immediately
    if let Some(ref w) = window {
        let _ = w.emit(
            "install-progress",
            crate::services::prepare::InstallProgressPayload {
                section: "game".to_string(),
                title: "Modpack".to_string(),
                message: "Fetching modpack metadata...".to_string(),
                fraction: 0.0,
                skipped: false,
            },
        );
    }

    // Load settings for the API key
    let settings = crate::services::settings_service::load()
        .await
        .map_err(|e| format!("Load settings: {}", e))?;
    let api_key = if settings.curseforge_api_key.is_empty() {
        "$2a$10$Vqhx8J1qatEwez9lhg6cjeh1W6RC6H8AtXeLdu7o8H45smb66wCgu".to_string()
    } else {
        settings.curseforge_api_key.clone()
    };

    // Fetch the project's icon up-front so the new instance carries it as
    // its tile icon in the Library and sidebar pin tile. Best-effort —
    // a missing icon falls back to the generic placeholder.
    let project_icon_path = match fetch_cf_project_icon(&api_key, project_id).await {
        Ok(Some(url)) => crate::services::icon_cache::cache_remote_icon(&url).await,
        _ => None,
    };

    // Get the download URL for the modpack file
    let (download_url, _file_name) =
        crate::services::curseforge::get_modpack_file_url(&api_key, project_id, file_id).await?;

    // Download the modpack zip to a temp location
    if let Some(ref w) = window {
        let _ = w.emit(
            "install-progress",
            crate::services::prepare::InstallProgressPayload {
                section: "game".to_string(),
                title: "Modpack".to_string(),
                message: "Downloading modpack...".to_string(),
                fraction: 0.0,
                skipped: false,
            },
        );
    }

    let temp_path = paths::data_dir().join("temp_cf_modpack.zip");
    let task = DownloadTask {
        url: download_url,
        dest: temp_path.clone(),
        expected_sha1: None,
        expected_size: None,
    };
    download_file(&crate::util::http::HTTP, &task).await?;

    // Import via the existing CF import logic. Pass the CurseForge project ID
    // through so the resulting instance is tied back to its source — this is
    // what the modpack browser's "already installed" tracker matches on.
    let result =
        crate::services::cf_import::import_zip(
            temp_path.to_str().unwrap_or_default(),
            &api_key,
            Some(project_id.to_string()),
            window,
        )
        .await;

    // Cleanup temp file regardless of success/failure
    let _ = fs::remove_file(&temp_path);

    // If the import succeeded and we have a cached icon, update the instance
    // to carry it. The cf_import flow doesn't know about the project icon
    // (it only has the zip), so we patch it after the fact.
    if let Ok(ref instance) = result {
        if let Some(ref icon_data_url) = project_icon_path {
            let meta_path = paths::instances_dir().join(&instance.id).join("instance.json");
            if let Ok(content) = fs::read_to_string(&meta_path) {
                if let Ok(mut inst) = serde_json::from_str::<Instance>(&content) {
                    inst.icon = icon_data_url.clone();
                    if let Ok(json) = serde_json::to_string_pretty(&inst) {
                        let _ = fs::write(&meta_path, json);
                    }
                }
            }
        }
    }

    result
}
