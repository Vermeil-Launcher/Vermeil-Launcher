use serde::{Deserialize, Serialize};

const MODRINTH_API: &str = "https://api.modrinth.com/v2";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModrinthSearchResult {
    pub hits: Vec<ModrinthProject>,
    pub total_hits: u32,
    pub offset: u32,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModrinthProject {
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
    pub project_type: String,
    /// Human-readable latest version label (Modrinth `version_number`), shown
    /// as the content version on Browse cards. Not in the search response —
    /// filled in by a single batched `/v2/versions?ids=` call per page.
    #[serde(default)]
    pub version_name: Option<String>,
    /// Username of the project's primary author (Modrinth's `author` field
    /// in search hits — populated for /search responses, NOT for
    /// /project/{id} where it's named `team` instead).
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub client_side: Option<String>,
    #[serde(default)]
    pub server_side: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModrinthVersion {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub version_number: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub files: Vec<ModrinthFile>,
    pub dependencies: Vec<ModrinthDependency>,
    /// ISO 8601 timestamp when this version was published. Used to decide
    /// "newer than installed" for the update detector.
    #[serde(default)]
    pub date_published: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModrinthFile {
    pub url: String,
    pub filename: String,
    pub hashes: ModrinthHashes,
    pub size: u64,
    pub primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModrinthHashes {
    pub sha1: Option<String>,
    pub sha512: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModrinthDependency {
    pub project_id: Option<String>,
    pub version_id: Option<String>,
    pub dependency_type: String,
}

/// Search on Modrinth, filtered by loader and game version
pub async fn search_mods(
    query: &str,
    loader: &str,
    game_version: &str,
    offset: u32,
    limit: u32,
    sort: &str,
    project_type: &str,
) -> Result<ModrinthSearchResult, String> {
    // Only include loader facet for mods — resource packs/shaders/datapacks are loader-agnostic
    // If game_version is empty, don't filter by version (show all versions)
    let facets = if project_type == "mod" {
        format!(
            "[[\"categories:{}\"], [\"versions:{}\"], [\"project_type:{}\"]]",
            loader, game_version, project_type
        )
    } else if game_version.is_empty() {
        format!(
            "[[\"project_type:{}\"]]",
            project_type
        )
    } else {
        format!(
            "[[\"versions:{}\"], [\"project_type:{}\"]]",
            game_version, project_type
        )
    };

    let url = format!(
        "{}/search?query={}&facets={}&offset={}&limit={}&index={}",
        MODRINTH_API,
        urlencoding::encode(query),
        urlencoding::encode(&facets),
        offset,
        limit,
        sort
    );

    let resp = crate::util::http::send_with_retry(|| crate::util::http::HTTP.get(&url))
        .await
        .map_err(|e| format!("Modrinth search failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Modrinth HTTP error: {}", text));
    }

    let mut result = resp
        .json::<ModrinthSearchResult>()
        .await
        .map_err(|e| format!("Parse Modrinth search: {}", e))?;
    attach_version_names(&mut result).await;
    Ok(result)
}

/// Fetch multiple versions by id in one batched call
/// (`GET /v2/versions?ids=[...]`). Best-effort: returns an empty map on any
/// failure so search degrades gracefully (cards just omit the version tag).
pub async fn get_versions_by_ids(ids: &[String]) -> std::collections::HashMap<String, String> {
    use std::collections::HashMap;
    if ids.is_empty() {
        return HashMap::new();
    }
    let ids_json = serde_json::to_string(ids).unwrap_or_default();
    let url = format!(
        "{}/versions?ids={}",
        MODRINTH_API,
        urlencoding::encode(&ids_json)
    );
    let resp = match crate::util::http::send_with_retry(|| crate::util::http::HTTP.get(&url)).await {
        Ok(r) if r.status().is_success() => r,
        _ => return HashMap::new(),
    };
    match resp.json::<Vec<ModrinthVersion>>().await {
        Ok(versions) => versions
            .into_iter()
            .map(|v| (v.id, v.version_number))
            .collect(),
        Err(_) => HashMap::new(),
    }
}

/// Attach a human version label to each search hit by batch-resolving the
/// hits' `latest_version` ids. One extra API call per page; best-effort.
async fn attach_version_names(result: &mut ModrinthSearchResult) {
    let ids: Vec<String> = result
        .hits
        .iter()
        .filter_map(|h| h.latest_version.clone())
        .collect();
    if ids.is_empty() {
        return;
    }
    let map = get_versions_by_ids(&ids).await;
    if map.is_empty() {
        return;
    }
    for h in &mut result.hits {
        if let Some(vid) = &h.latest_version {
            h.version_name = map.get(vid).cloned();
        }
    }
}

/// Search modpacks on Modrinth
pub async fn search_modpacks(
    query: &str,
    offset: u32,
    limit: u32,
    sort: &str,
    loader: &str,
) -> Result<ModrinthSearchResult, String> {
    // Build facets: always filter to modpacks, optionally filter by loader
    let facets = if loader.is_empty() {
        "[[\"project_type:modpack\"]]".to_string()
    } else {
        format!("[[\"project_type:modpack\"],[\"categories:{}\"]]", loader)
    };

    let url = format!(
        "{}/search?query={}&facets={}&offset={}&limit={}&index={}",
        MODRINTH_API,
        urlencoding::encode(query),
        urlencoding::encode(&facets),
        offset,
        limit,
        sort
    );

    let resp = crate::util::http::send_with_retry(|| crate::util::http::HTTP.get(&url))
        .await
        .map_err(|e| format!("Modrinth modpack search failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Modrinth HTTP error: {}", text));
    }

    let mut result = resp
        .json::<ModrinthSearchResult>()
        .await
        .map_err(|e| format!("Parse Modrinth modpacks: {}", e))?;
    attach_version_names(&mut result).await;
    Ok(result)
}

/// Get versions for a specific project (to find the right file to download)
pub async fn get_project_versions(
    project_id: &str,
    loader: &str,
    game_version: &str,
) -> Result<Vec<ModrinthVersion>, String> {
    // Build query params lazily so empty filters drop out — Modrinth treats
    // `game_versions=[""]` as a literal empty-string filter and returns nothing,
    // which broke fallback fetches that wanted the project's full version list.
    let mut params: Vec<String> = Vec::new();
    if !loader.is_empty() {
        params.push(format!("loaders=[\"{}\"]", loader));
    }
    if !game_version.is_empty() {
        params.push(format!("game_versions=[\"{}\"]", game_version));
    }
    let url = if params.is_empty() {
        format!("{}/project/{}/version", MODRINTH_API, project_id)
    } else {
        format!(
            "{}/project/{}/version?{}",
            MODRINTH_API,
            project_id,
            params.join("&")
        )
    };

    let resp = crate::util::http::HTTP
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Modrinth versions failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Modrinth versions error: {}", text));
    }

    resp.json::<Vec<ModrinthVersion>>()
        .await
        .map_err(|e| format!("Parse Modrinth versions: {}", e))
}
