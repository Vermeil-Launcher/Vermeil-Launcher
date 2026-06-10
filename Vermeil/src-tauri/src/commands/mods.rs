use crate::services::modrinth;
use serde::Serialize;

#[derive(Serialize)]
pub struct ModSearchResult {
    pub hits: Vec<ModHit>,
    pub total_hits: u32,
    pub offset: u32,
    pub limit: u32,
}

#[derive(Serialize)]
pub struct ModHit {
    pub project_id: String,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub icon_url: Option<String>,
    pub downloads: u64,
    pub follows: u32,
    pub client_side: Option<String>,
    pub server_side: Option<String>,
    pub categories: Vec<String>,
    /// Game versions this project supports (Modrinth's `versions[]` field).
    /// Surfaced so the frontend can display "1.20.1 – 1.21.4" badges on cards.
    pub versions: Vec<String>,
    pub latest_version: Option<String>,
    /// Primary author display name. Modrinth: search hit's `author`.
    /// CurseForge: first entry of `authors[]`. None when the source doesn't
    /// expose an author (rare).
    pub author: Option<String>,
}

#[tauri::command]
pub async fn search_mods(
    query: String,
    loader: String,
    game_version: String,
    offset: Option<u32>,
    limit: Option<u32>,
    sort: Option<String>,
    project_type: Option<String>,
) -> Result<ModSearchResult, String> {
    let lim = limit.unwrap_or(20);
    let off = offset.unwrap_or(0);
    let sort_by = sort.unwrap_or_else(|| "relevance".to_string());
    let ptype = project_type.unwrap_or_else(|| "mod".to_string());

    let result = modrinth::search_mods(
        &query,
        &loader,
        &game_version,
        off,
        lim,
        &sort_by,
        &ptype,
    )
    .await?;

    Ok(ModSearchResult {
        total_hits: result.total_hits,
        offset: result.offset,
        limit: result.limit,
        hits: result
            .hits
            .into_iter()
            .map(|h| ModHit {
                project_id: h.project_id,
                slug: h.slug,
                title: h.title,
                description: h.description,
                icon_url: h.icon_url,
                downloads: h.downloads,
                follows: h.follows,
                client_side: h.client_side,
                server_side: h.server_side,
                categories: h.categories,
                versions: h.versions,
                latest_version: h.latest_version,
                author: h.author,
            })
            .collect(),
    })
}

#[tauri::command]
pub async fn search_modpacks(
    query: String,
    offset: Option<u32>,
    sort: Option<String>,
    loader: Option<String>,
) -> Result<ModSearchResult, String> {
    let result = modrinth::search_modpacks(
        &query,
        offset.unwrap_or(0),
        10,
        &sort.unwrap_or_else(|| "relevance".to_string()),
        &loader.unwrap_or_default(),
    ).await?;

    Ok(ModSearchResult {
        total_hits: result.total_hits,
        offset: result.offset,
        limit: result.limit,
        hits: result
            .hits
            .into_iter()
            .map(|h| ModHit {
                project_id: h.project_id,
                slug: h.slug,
                title: h.title,
                description: h.description,
                icon_url: h.icon_url,
                downloads: h.downloads,
                follows: h.follows,
                client_side: h.client_side,
                server_side: h.server_side,
                categories: h.categories,
                versions: h.versions,
                latest_version: h.latest_version,
                author: h.author,
            })
            .collect(),
    })
}

/// Search CurseForge for mods, resource packs, shaders, or modpacks.
/// Returns the same `ModSearchResult` shape as `search_mods` so the
/// frontend can render both sources with the same card components.
#[tauri::command]
pub async fn search_curseforge(
    query: String,
    loader: String,
    game_version: String,
    offset: Option<u32>,
    limit: Option<u32>,
    sort: Option<String>,
    project_type: Option<String>,
) -> Result<ModSearchResult, String> {
    let settings = crate::services::settings_service::load()
        .await
        .map_err(|e| format!("Load settings: {}", e))?;

    let api_key = if settings.curseforge_api_key.is_empty() {
        // Fallback to the built-in key for users with existing configs that
        // predate the CurseForge integration.
        "$2a$10$Vqhx8J1qatEwez9lhg6cjeh1W6RC6H8AtXeLdu7o8H45smb66wCgu".to_string()
    } else {
        settings.curseforge_api_key.clone()
    };
    let lim = limit.unwrap_or(20);
    let off = offset.unwrap_or(0);
    let sort_by = sort.unwrap_or_else(|| "relevance".to_string());
    let ptype = project_type.unwrap_or_else(|| "mod".to_string());

    let result = crate::services::curseforge::search(
        &api_key,
        &query,
        &loader,
        &game_version,
        off,
        lim,
        &sort_by,
        &ptype,
    )
    .await?;

    Ok(ModSearchResult {
        total_hits: result.total_hits,
        offset: result.offset,
        limit: result.limit,
        hits: result
            .hits
            .into_iter()
            .map(|h| ModHit {
                project_id: h.project_id,
                slug: h.slug,
                title: h.title,
                description: h.description,
                icon_url: h.icon_url,
                downloads: h.downloads,
                follows: h.follows,
                client_side: None,
                server_side: None,
                categories: h.categories,
                versions: h.versions,
                latest_version: h.latest_version,
                author: h.author,
            })
            .collect(),
    })
}
