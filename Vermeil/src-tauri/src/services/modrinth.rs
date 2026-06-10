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

    let resp = crate::util::http::HTTP
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Modrinth search failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Modrinth HTTP error: {}", text));
    }

    resp.json::<ModrinthSearchResult>()
        .await
        .map_err(|e| format!("Parse Modrinth search: {}", e))
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

    let resp = crate::util::http::HTTP
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Modrinth modpack search failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Modrinth HTTP error: {}", text));
    }

    resp.json::<ModrinthSearchResult>()
        .await
        .map_err(|e| format!("Parse Modrinth modpacks: {}", e))
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
