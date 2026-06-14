//! CurseForge API integration.
//!
//! Provides search, version listing, and file resolution for the CurseForge
//! mod platform. All requests go through `https://api.curseforge.com/v1` and
//! require an `x-api-key` header. The key is read from `LauncherSettings`.
//!
//! Results are mapped into the same `ModSearchResult` / `ModHit` shape that
//! the Modrinth service uses so the frontend can render both sources with
//! the same card components.

use crate::util::http::HTTP;
use serde::Deserialize;

const CF_BASE: &str = "https://api.curseforge.com/v1";
const MINECRAFT_GAME_ID: u32 = 432;

/// CurseForge class IDs for Minecraft content types.
fn class_id_for(project_type: &str) -> u32 {
    match project_type {
        "mod" => 6,
        "resourcepack" => 12,
        "shader" => 6552,
        "modpack" => 4471,
        "datapack" => 6945,
        _ => 6,
    }
}

/// Map our loader name to CurseForge's modLoaderType enum.
fn loader_type_id(loader: &str) -> Option<u32> {
    match loader {
        "forge" => Some(1),
        "fabric" => Some(4),
        "quilt" => Some(5),
        "neoforge" => Some(6),
        _ => None,
    }
}

/// Map CurseForge sortField enum values to our sort names.
fn sort_field_id(sort: &str) -> u32 {
    match sort {
        "relevance" | "featured" => 1,
        "popularity" => 2,
        "updated" => 3,
        "name" => 4,
        "downloads" => 6,
        "newest" => 11,
        _ => 1,
    }
}

// ─── Response types (CurseForge JSON shape) ─────────────────────────────

#[derive(Debug, Deserialize)]
struct CfSearchResponse {
    data: Vec<CfMod>,
    pagination: CfPagination,
}

#[derive(Debug, Deserialize)]
struct CfPagination {
    index: u32,
    #[serde(rename = "pageSize")]
    page_size: u32,
    #[serde(rename = "totalCount")]
    total_count: u64,
}

#[derive(Debug, Deserialize)]
struct CfMod {
    id: u64,
    name: String,
    slug: String,
    summary: String,
    #[serde(rename = "downloadCount")]
    download_count: u64,
    #[serde(rename = "thumbsUpCount")]
    thumbs_up_count: u32,
    logo: Option<CfLogo>,
    categories: Vec<CfCategory>,
    /// Author list. CurseForge always returns at least one for published
    /// projects. We only display the first one to match Modrinth's
    /// single-author display.
    #[serde(default)]
    authors: Vec<CfAuthor>,
    #[serde(rename = "latestFilesIndexes")]
    latest_files_indexes: Vec<CfFileIndex>,
}

#[derive(Debug, Deserialize)]
struct CfAuthor {
    name: String,
}

#[derive(Debug, Deserialize)]
struct CfLogo {
    #[serde(rename = "thumbnailUrl")]
    thumbnail_url: String,
    /// Full-size icon URL. Used as fallback when `thumbnailUrl` is empty
    /// (some CurseForge projects only populate the full `url` field).
    #[serde(default)]
    url: String,
}

#[derive(Debug, Deserialize)]
struct CfCategory {
    slug: String,
}

#[derive(Debug, Deserialize)]
struct CfFileIndex {
    #[serde(rename = "gameVersion")]
    game_version: String,
    #[serde(rename = "fileId")]
    file_id: u64,
    #[serde(rename = "modLoader")]
    mod_loader: Option<u32>,
}

// ─── Public result types (shared with commands layer) ───────────────────

/// A single search hit, mapped to the same shape as Modrinth's `ModHit`.
pub struct CfHit {
    pub project_id: String,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub icon_url: Option<String>,
    pub downloads: u64,
    pub follows: u32,
    pub categories: Vec<String>,
    pub versions: Vec<String>,
    pub latest_version: Option<String>,
    /// Primary author display name (first entry in CurseForge's authors array).
    pub author: Option<String>,
}

pub struct CfSearchResult {
    pub hits: Vec<CfHit>,
    pub total_hits: u32,
    pub offset: u32,
    pub limit: u32,
}

// ─── Public API ─────────────────────────────────────────────────────────

/// Search CurseForge for mods/resource packs/shaders/modpacks.
///
/// Maps CurseForge's response into our unified `CfSearchResult` shape.
/// The `api_key` is read from settings by the command layer and passed in
/// so this service stays free of Tauri types.
pub async fn search(
    api_key: &str,
    query: &str,
    loader: &str,
    game_version: &str,
    offset: u32,
    limit: u32,
    sort: &str,
    project_type: &str,
) -> Result<CfSearchResult, String> {
    if api_key.is_empty() {
        return Err("CurseForge API key not configured. Add it in Settings.".to_string());
    }

    let class_id = class_id_for(project_type);
    let sort_field = sort_field_id(sort);

    let mut url = format!(
        "{}/mods/search?gameId={}&classId={}&index={}&pageSize={}&sortField={}&sortOrder=desc",
        CF_BASE, MINECRAFT_GAME_ID, class_id, offset, limit.min(50), sort_field
    );

    if !query.is_empty() {
        url.push_str(&format!("&searchFilter={}", urlencoding::encode(query)));
    }
    if !game_version.is_empty() {
        url.push_str(&format!("&gameVersion={}", urlencoding::encode(game_version)));
    }
    // Only filter by loader for mods — resource packs, shaders, and datapacks
    // are loader-agnostic on CurseForge and return 0 results if a loader
    // filter is applied.
    if project_type == "mod" {
        if let Some(loader_id) = loader_type_id(loader) {
            url.push_str(&format!("&modLoaderType={}", loader_id));
        }
    }

    let resp = HTTP
        .get(&url)
        .header("x-api-key", api_key)
        .send()
        .await
        .map_err(|e| format!("CurseForge search failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("CurseForge HTTP {}: {}", status, body.chars().take(200).collect::<String>()));
    }

    let cf: CfSearchResponse = resp
        .json()
        .await
        .map_err(|e| format!("CurseForge parse error: {}", e))?;

    let hits: Vec<CfHit> = cf.data.into_iter().map(|m| {
        // Collect unique game versions from the latest files index
        let mut versions: Vec<String> = m.latest_files_indexes
            .iter()
            .map(|f| f.game_version.clone())
            .collect();
        versions.sort();
        versions.dedup();

        let latest_version = m.latest_files_indexes
            .first()
            .map(|f| f.file_id.to_string());

        // Build categories list. Start with CF's category slugs, then inject
        // loader names derived from the modLoader field in latestFilesIndexes.
        // The frontend uses these to render loader badges on cards.
        let mut categories: Vec<String> = m.categories.into_iter().map(|c| c.slug).collect();
        for fi in &m.latest_files_indexes {
            if let Some(loader_id) = fi.mod_loader {
                let name = match loader_id {
                    1 => "forge",
                    4 => "fabric",
                    5 => "quilt",
                    6 => "neoforge",
                    _ => continue,
                };
                if !categories.contains(&name.to_string()) {
                    categories.push(name.to_string());
                }
            }
        }

        CfHit {
            project_id: m.id.to_string(),
            slug: m.slug,
            title: m.name,
            description: m.summary,
            icon_url: m.logo.map(|l| {
                if l.thumbnail_url.is_empty() { l.url } else { l.thumbnail_url }
            }).filter(|u| !u.is_empty()),
            downloads: m.download_count,
            follows: m.thumbs_up_count,
            categories,
            versions,
            latest_version,
            author: m.authors.into_iter().next().map(|a| a.name),
        }
    }).collect();

    Ok(CfSearchResult {
        total_hits: cf.pagination.total_count as u32,
        offset: cf.pagination.index,
        limit: cf.pagination.page_size,
        hits,
    })
}

/// Get file versions for a specific CurseForge project.
pub async fn get_project_files(
    api_key: &str,
    mod_id: &str,
    game_version: &str,
    loader: &str,
) -> Result<Vec<CfFileInfo>, String> {
    if api_key.is_empty() {
        return Err("CurseForge API key not configured.".to_string());
    }

    let mut url = format!("{}/mods/{}/files?pageSize=50", CF_BASE, mod_id);
    if !game_version.is_empty() {
        url.push_str(&format!("&gameVersion={}", urlencoding::encode(game_version)));
    }
    if let Some(loader_id) = loader_type_id(loader) {
        url.push_str(&format!("&modLoaderType={}", loader_id));
    }

    let resp = HTTP
        .get(&url)
        .header("x-api-key", api_key)
        .send()
        .await
        .map_err(|e| format!("CurseForge files fetch failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("CurseForge HTTP {}: {}", status, body.chars().take(200).collect::<String>()));
    }

    let wrapper: CfFilesResponse = resp
        .json()
        .await
        .map_err(|e| format!("CurseForge files parse: {}", e))?;

    Ok(wrapper.data.into_iter().map(|f| {
        // Reconstruct the CDN URL when CurseForge withholds it (author opted
        // out of third-party API distribution). The file still lives on the
        // CDN at a path derived from its numeric ID. Same workaround used by
        // every third-party launcher; prevents mods silently failing to install.
        let download_url = f.download_url.clone().or_else(|| {
            Some(format!(
                "https://edge.forgecdn.net/files/{}/{}/{}",
                f.id / 1000,
                f.id % 1000,
                f.file_name.replace(' ', "%20")
            ))
        });
        CfFileInfo {
            file_id: f.id,
            file_name: f.file_name,
            download_url,
            file_length: f.file_length,
            hashes: f.hashes.into_iter()
                .filter(|h| h.algo == 1) // SHA-1
                .map(|h| h.value)
                .collect(),
            dependencies: f.dependencies.into_iter()
            .filter(|d| d.relation_type == 3) // RequiredDependency
            .map(|d| d.mod_id.to_string())
            .collect(),
        }
    }).collect())
}

// ─── File response types ────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct CfFilesResponse {
    data: Vec<CfFile>,
}

#[derive(Debug, Deserialize)]
struct CfFile {
    id: u64,
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "downloadUrl")]
    download_url: Option<String>,
    #[serde(rename = "fileLength")]
    file_length: u64,
    hashes: Vec<CfHash>,
    dependencies: Vec<CfDependency>,
}

#[derive(Debug, Deserialize)]
struct CfHash {
    value: String,
    algo: u32, // 1 = SHA-1, 2 = MD5
}

#[derive(Debug, Deserialize)]
struct CfDependency {
    #[serde(rename = "modId")]
    mod_id: u64,
    #[serde(rename = "relationType")]
    relation_type: u32, // 3 = RequiredDependency
}

/// Processed file info ready for the install flow.
pub struct CfFileInfo {
    pub file_id: u64,
    pub file_name: String,
    pub download_url: Option<String>,
    pub file_length: u64,
    pub hashes: Vec<String>, // SHA-1 only
    pub dependencies: Vec<String>, // mod IDs of required deps
}

// ─── Modpack install from project ID ────────────────────────────────────

/// Fetch the download URL for the latest (or specified) file of a CurseForge
/// modpack project. Returns `(download_url, file_name)`.
pub async fn get_modpack_file_url(
    api_key: &str,
    project_id: &str,
    file_id: Option<&str>,
) -> Result<(String, String), String> {
    if api_key.is_empty() {
        return Err("CurseForge API key not configured. Add it in Settings.".to_string());
    }

    let url = if let Some(fid) = file_id {
        format!("{}/mods/{}/files/{}", CF_BASE, project_id, fid)
    } else {
        // Get the main file for the modpack (latest)
        format!("{}/mods/{}/files?pageSize=1", CF_BASE, project_id)
    };

    let resp = HTTP
        .get(&url)
        .header("x-api-key", api_key)
        .send()
        .await
        .map_err(|e| format!("CurseForge file fetch failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "CurseForge HTTP {} when fetching modpack file: {}",
            status,
            body.chars().take(200).collect::<String>()
        ));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse CurseForge file response: {}", e))?;

    // Single file endpoint returns { data: { ... } }
    // List endpoint returns { data: [ ... ] }
    let file_data = if file_id.is_some() {
        body.get("data").cloned()
    } else {
        body.get("data")
            .and_then(|d| d.as_array())
            .and_then(|arr| arr.first())
            .cloned()
    };

    let file_data = file_data.ok_or("No file data returned from CurseForge")?;

    let download_url = file_data
        .get("downloadUrl")
        .and_then(|u| u.as_str())
        .ok_or("CurseForge file has no download URL (mod author may have disabled third-party downloads)")?
        .to_string();

    let file_name = file_data
        .get("fileName")
        .and_then(|n| n.as_str())
        .unwrap_or("modpack.zip")
        .to_string();

    Ok((download_url, file_name))
}
