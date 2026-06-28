//! CurseForge mod install service.
//!
//! Resolves the best file for a given CurseForge project, downloads it,
//! and walks required dependencies. Returns the same `InstallResult` shape
//! as the Modrinth install flow so the frontend can reuse the same UI.

use crate::models::instance::{Instance, ModEntry};
use crate::services::curseforge;
use crate::services::download::{DownloadTask, download_file};
use crate::services::icon_cache;
use crate::services::mod_install::{InstallResult, DependencyIssue};
use crate::util::paths;
use std::fs;

/// Install a CurseForge mod into an instance. Resolves the best compatible
/// file, downloads it, and recursively installs required dependencies.
pub async fn install_cf_mod(
    instance_id: &str,
    mod_id: &str,
    loader: &str,
    game_version: &str,
    category: &str,
    api_key: &str,
) -> Result<InstallResult, String> {
    let mut issues: Vec<DependencyIssue> = Vec::new();
    let mut deps_installed: Vec<String> = Vec::new();
    let mut dep_titles: Vec<String> = Vec::new();

    // 1. Get available files for this project.
    // Shaders, resource packs, and datapacks are loader-agnostic on CurseForge —
    // their files aren't tagged with a modLoaderType. Passing a loader filter
    // returns 0 results, so we skip it for non-mod categories.
    let effective_loader = match category {
        "resourcepack" | "shader" | "datapack" => "",
        _ => loader,
    };
    let files = curseforge::get_project_files(api_key, mod_id, game_version, effective_loader).await?;

    if files.is_empty() {
        return Err(format!("No compatible files found for CurseForge project {}", mod_id));
    }

    // 2. Pick the best file (first one — CF returns them sorted by date desc)
    let file = &files[0];

    // 3. Check distribution permission
    let download_url = file.download_url.as_ref().ok_or_else(|| {
        "This mod doesn't allow third-party downloads. Visit CurseForge to download it manually.".to_string()
    })?;

    // 4. Download the file
    let instance_dir = paths::instances_dir().join(instance_id);
    let target_folder = match category {
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        "datapack" => "datapacks",
        _ => "mods",
    };
    let target_dir = instance_dir.join(".minecraft").join(target_folder);
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Create {}: {}", target_folder, e))?;

    let dest = target_dir.join(&file.file_name);
    let task = DownloadTask {
        url: download_url.clone(),
        dest: dest.clone(),
        expected_sha1: file.hashes.first().cloned(),
        expected_size: Some(file.file_length),
    };
    download_file(&crate::util::http::HTTP, &task).await?;

    // 5. Fetch project metadata for icon/title/author
    let (title, icon_url, author) = fetch_cf_project_meta(api_key, mod_id).await;
    let local_icon_path = match icon_url.as_deref() {
        Some(u) => icon_cache::cache_remote_icon(u).await,
        None => None,
    };

    // 6. Build the ModEntry
    let mod_entry = ModEntry {
        id: file.file_id.to_string(),
        source: "curseforge".to_string(),
        project_id: mod_id.to_string(),
        version_id: file.file_id.to_string(),
        filename: file.file_name.clone(),
        version_number: if file.display_name.is_empty() { None } else { Some(file.display_name.clone()) },
        enabled: true,
        pinned: false,
        title: title.clone(),
        icon_url,
        local_icon_path,
        description: None,
        category: category.to_string(),
        author,
    };

    // 7. Save to instance.json
    let meta_path = instance_dir.join("instance.json");
    let content = fs::read_to_string(&meta_path)
        .map_err(|e| format!("Read instance.json: {}", e))?;
    let mut instance: Instance = serde_json::from_str(&content)
        .map_err(|e| format!("Parse instance.json: {}", e))?;

    // Skip if already installed
    if !instance.mods.iter().any(|m| m.project_id == mod_id && m.source == "curseforge") {
        instance.mods.push(mod_entry.clone());
        let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
        fs::write(&meta_path, json).map_err(|e| e.to_string())?;
    }

    // 8. Install required dependencies (one level deep to avoid infinite recursion)
    for dep_id in &file.dependencies {
        match install_cf_dep(instance_id, dep_id, loader, game_version, category, api_key).await {
            Ok(dep_title) => {
                deps_installed.push(dep_id.clone());
                dep_titles.push(dep_title);
            }
            Err(e) => {
                issues.push(DependencyIssue {
                    parent_title: title.clone().unwrap_or_else(|| mod_id.to_string()),
                    dep_title: format!("CF:{}", dep_id),
                    dep_project_id: dep_id.clone(),
                    required_game_versions: vec![game_version.to_string()],
                    required_loaders: vec![loader.to_string()],
                    instance_game_version: game_version.to_string(),
                    instance_loader: loader.to_string(),
                    kind: "failed".to_string(),
                    reason: e,
                });
            }
        }
    }

    Ok(InstallResult {
        mod_entry,
        deps_installed,
        dep_titles,
        issues,
    })
}

/// Install a single dependency. Returns the dep's title on success.
async fn install_cf_dep(
    instance_id: &str,
    mod_id: &str,
    loader: &str,
    game_version: &str,
    category: &str,
    api_key: &str,
) -> Result<String, String> {
    // Check if already installed
    let meta_path = paths::instances_dir().join(instance_id).join("instance.json");
    let content = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let instance: Instance = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    if instance.mods.iter().any(|m| m.project_id == mod_id && m.source == "curseforge") {
        let title = instance.mods.iter()
            .find(|m| m.project_id == mod_id)
            .and_then(|m| m.title.clone())
            .unwrap_or_else(|| mod_id.to_string());
        return Ok(title);
    }

    // Get files — same loader-skip logic as the main install path.
    let effective_loader = match category {
        "resourcepack" | "shader" | "datapack" => "",
        _ => loader,
    };
    let files = curseforge::get_project_files(api_key, mod_id, game_version, effective_loader).await?;
    if files.is_empty() {
        return Err("No compatible file found".to_string());
    }

    let file = &files[0];
    let download_url = file.download_url.as_ref()
        .ok_or("Distribution not allowed for this dependency")?;

    // Download
    let instance_dir = paths::instances_dir().join(instance_id);
    let target_folder = match category {
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        _ => "mods",
    };
    let target_dir = instance_dir.join(".minecraft").join(target_folder);
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    let dest = target_dir.join(&file.file_name);
    let task = DownloadTask {
        url: download_url.clone(),
        dest,
        expected_sha1: file.hashes.first().cloned(),
        expected_size: Some(file.file_length),
    };
    download_file(&crate::util::http::HTTP, &task).await?;

    // Metadata
    let (title, icon_url, author) = fetch_cf_project_meta(api_key, mod_id).await;
    let local_icon_path = match icon_url.as_deref() {
        Some(u) => icon_cache::cache_remote_icon(u).await,
        None => None,
    };

    // Save
    let content = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: Instance = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let entry = ModEntry {
        id: file.file_id.to_string(),
        source: "curseforge".to_string(),
        project_id: mod_id.to_string(),
        version_id: file.file_id.to_string(),
        filename: file.file_name.clone(),
        version_number: if file.display_name.is_empty() { None } else { Some(file.display_name.clone()) },
        enabled: true,
        pinned: false,
        title: title.clone(),
        icon_url,
        local_icon_path,
        description: None,
        category: category.to_string(),
        author,
    };
    instance.mods.push(entry);
    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    fs::write(&meta_path, json).map_err(|e| e.to_string())?;

    Ok(title.unwrap_or_else(|| mod_id.to_string()))
}

/// Fetch project name, icon URL, and primary author from CurseForge.
/// All three come from the same `/v1/mods/{id}` response so this is a
/// single API call.
async fn fetch_cf_project_meta(api_key: &str, mod_id: &str) -> (Option<String>, Option<String>, Option<String>) {
    let url = format!("https://api.curseforge.com/v1/mods/{}", mod_id);
    let resp = match crate::util::http::HTTP
        .get(&url)
        .header("x-api-key", api_key)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return (None, None, None),
    };

    #[derive(serde::Deserialize)]
    struct Wrapper { data: ProjectData }
    #[derive(serde::Deserialize)]
    struct ProjectData {
        name: Option<String>,
        logo: Option<Logo>,
        #[serde(default)]
        authors: Vec<Author>,
    }
    #[derive(serde::Deserialize)]
    struct Logo {
        #[serde(rename = "thumbnailUrl")]
        thumbnail_url: String,
        #[serde(default)]
        url: String,
    }
    #[derive(serde::Deserialize)]
    struct Author {
        name: String,
    }

    match resp.json::<Wrapper>().await {
        Ok(w) => {
            let author = w.data.authors.into_iter().next().map(|a| a.name);
            let icon = w.data.logo.map(|l| {
                if l.thumbnail_url.is_empty() { l.url } else { l.thumbnail_url }
            }).filter(|u| !u.is_empty());
            (w.data.name, icon, author)
        }
        Err(_) => (None, None, None),
    }
}
