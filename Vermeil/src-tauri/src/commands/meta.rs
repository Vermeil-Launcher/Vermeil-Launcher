use crate::services::meta;
use serde::Serialize;

#[derive(Serialize)]
pub struct GameVersionInfo {
    pub id: String,
    pub version_type: String,
    pub release_time: String,
}

#[tauri::command]
pub async fn get_game_versions(include_snapshots: bool) -> Result<Vec<GameVersionInfo>, String> {
    let manifest = meta::get_version_manifest(false).await?;

    let versions: Vec<GameVersionInfo> = manifest
        .versions
        .into_iter()
        .filter(|v| include_snapshots || v.version_type == "release")
        .map(|v| GameVersionInfo {
            id: v.id,
            version_type: v.version_type,
            release_time: v.release_time,
        })
        .collect();

    Ok(versions)
}

#[derive(Serialize)]
pub struct FabricVersionInfo {
    pub version: String,
    pub stable: bool,
}

#[tauri::command]
pub async fn get_fabric_loader_versions() -> Result<Vec<FabricVersionInfo>, String> {
    let versions = meta::get_fabric_versions().await?;

    Ok(versions
        .into_iter()
        .map(|v| FabricVersionInfo {
            version: v.version,
            stable: v.stable,
        })
        .collect())
}

#[derive(Serialize)]
pub struct NewsArticle {
    pub title: String,
    pub version: String,
    pub image_url: String,
    pub url: String,
    pub body: String,
}

#[tauri::command]
pub async fn get_java_news() -> Result<Vec<NewsArticle>, String> {
    let resp = crate::util::http::HTTP
        .get("https://launchercontent.mojang.com/v2/javaPatchNotes.json")
        .send()
        .await
        .map_err(|e| format!("News fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("News HTTP {}", resp.status()));
    }

    #[derive(serde::Deserialize)]
    struct PatchNotes { entries: Vec<PatchEntry> }
    #[derive(serde::Deserialize)]
    struct PatchEntry { title: String, version: String, image: PatchImage, #[serde(rename = "contentPath")] content_path: Option<String> }
    #[derive(serde::Deserialize)]
    struct PatchImage { url: String }

    let data: PatchNotes = resp.json().await.map_err(|e| format!("Parse news: {}", e))?;

    let articles: Vec<NewsArticle> = data.entries.iter().map(|e| {
        NewsArticle {
            title: e.title.clone(),
            version: e.version.clone(),
            image_url: format!("https://launchercontent.mojang.com{}", e.image.url),
            url: format!(
                "https://www.minecraft.net/en-us/article/minecraft-{}",
                article_slug(&e.version)
            ),
            body: e.content_path.clone().unwrap_or_default(),
        }
    }).collect();

    Ok(articles)
}

/// Build the minecraft.net article slug from Mojang's `version` field.
///
/// The patch-notes feed uses short forms (`-rc-1`, `-pre-2`) while the website
/// uses long forms (`-release-candidate-1`, `-pre-release-2`). Snapshots are
/// already correct (`-snapshot-N`). Examples observed in the live feed:
///
///     26.2-snapshot-8     → minecraft-26-2-snapshot-8
///     26.1.2-rc-1         → minecraft-26-1-2-release-candidate-1
///     1.21.11-pre-3       → minecraft-1-21-11-pre-release-3
///     1.21                → minecraft-1-21
fn article_slug(version: &str) -> String {
    // Order matters: replace `-rc-` and `-pre-` BEFORE the `.` → `-` swap so
    // we're matching against the original short form, not a partially-mangled
    // string. Each match anchors on the surrounding `-` so we don't false-
    // positive on a release version that happens to contain "rc" or "pre".
    let expanded = version
        .replace("-rc-", "-release-candidate-")
        .replace("-pre-", "-pre-release-");
    expanded.replace('.', "-")
}

#[tauri::command]
pub async fn get_article_body(content_url: String) -> Result<String, String> {
    if content_url.is_empty() {
        return Ok(String::new());
    }

    // contentPath is like "javaPatchNotes/abc123.json" — needs /v2/ prefix
    let url = if content_url.starts_with("http") {
        content_url
    } else {
        format!("https://launchercontent.mojang.com/v2/{}", content_url)
    };

    let resp = crate::util::http::HTTP
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Fetch article failed: {}", e))?;

    if !resp.status().is_success() {
        return Ok(String::new());
    }

    let body = resp.text().await.map_err(|e| format!("Read article: {}", e))?;

    // Mojang returns `{"body": "<html content>"}` for v2 patch notes; older
    // entries are raw HTML. Pull the HTML out either way.
    let raw_html = if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) {
        parsed
            .get("body")
            .and_then(|b| b.as_str())
            .map(|s| s.to_string())
            .unwrap_or(body)
    } else {
        body
    };

    // Sanitize before sending to the webview. The frontend renders this via
    // `innerHTML`, so anything we let through becomes live DOM. Even though
    // the source is Mojang's CDN, treating it as untrusted means a CDN
    // compromise (or an attacker tricking us into fetching a different URL)
    // can't pivot into invoking Tauri commands. `ammonia` strips <script>,
    // <iframe>, on*= handlers, javascript:/data:/vbscript: URLs, and any
    // other XSS vectors not on its allow-list.
    Ok(ammonia::clean(&raw_html))
}

#[tauri::command]
pub async fn get_quilt_loader_versions() -> Result<Vec<FabricVersionInfo>, String> {
    let resp = crate::util::http::HTTP
        .get("https://meta.quiltmc.org/v3/versions/loader")
        .send()
        .await
        .map_err(|e| format!("Quilt versions fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Quilt meta HTTP {}", resp.status()));
    }

    #[derive(serde::Deserialize)]
    struct QuiltVersion { version: String }

    let versions: Vec<QuiltVersion> = resp.json().await.map_err(|e| format!("Parse: {}", e))?;
    Ok(versions.iter().map(|v| FabricVersionInfo { version: v.version.clone(), stable: true }).collect())
}

#[tauri::command]
pub async fn get_fabric_game_versions() -> Result<Vec<String>, String> {
    // Fetch modern Fabric supported game versions
    let mut versions: Vec<String> = Vec::new();

    if let Ok(resp) = crate::util::http::HTTP.get("https://meta.fabricmc.net/v2/versions/game")
        .send().await {
        if resp.status().is_success() {
            #[derive(serde::Deserialize)]
            struct GameVer { version: String }
            if let Ok(list) = resp.json::<Vec<GameVer>>().await {
                for v in list { versions.push(v.version); }
            }
        }
    }

    // Fetch Legacy Fabric supported game versions
    if let Ok(resp) = crate::util::http::HTTP.get("https://meta.legacyfabric.net/v2/versions/game")
        .send().await {
        if resp.status().is_success() {
            #[derive(serde::Deserialize)]
            struct GameVer { version: String }
            if let Ok(list) = resp.json::<Vec<GameVer>>().await {
                for v in list {
                    if !versions.contains(&v.version) {
                        versions.push(v.version);
                    }
                }
            }
        }
    }

    Ok(versions)
}

#[tauri::command]
pub async fn get_neoforge_versions(game_version: String) -> Result<Vec<FabricVersionInfo>, String> {
    // NeoForge versions are tied to MC version. Format: MC_VERSION-LOADER_VERSION (e.g., "21.4.1" for MC 1.21.4)
    let resp = crate::util::http::HTTP
        .get("https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge")
        .send()
        .await
        .map_err(|e| format!("NeoForge versions fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("NeoForge maven HTTP {}", resp.status()));
    }

    #[derive(serde::Deserialize)]
    struct MavenVersions { versions: Vec<String> }

    let data: MavenVersions = resp.json().await.map_err(|e| format!("Parse: {}", e))?;

    // Filter versions that match the game version
    // NeoForge versions for MC 1.21.4 start with "21.4." , for MC 26.1.2 start with "26.1."
    let mc_prefix = if game_version.starts_with("1.") {
        // 1.21.4 -> "21.4"
        let parts: Vec<&str> = game_version.split('.').collect();
        if parts.len() >= 3 { format!("{}.{}", parts[1], parts[2]) }
        else if parts.len() == 2 { format!("{}.", parts[1]) }
        else { game_version.clone() }
    } else {
        // 26.1.2 -> "26.1"
        let parts: Vec<&str> = game_version.split('.').collect();
        if parts.len() >= 2 { format!("{}.{}", parts[0], parts[1]) }
        else { game_version.clone() }
    };

    let filtered: Vec<FabricVersionInfo> = data.versions.iter()
        .filter(|v| v.starts_with(&mc_prefix))
        .rev() // Latest first
        .take(20)
        .map(|v| FabricVersionInfo { version: v.clone(), stable: true })
        .collect();

    Ok(filtered)
}

/// Returns the list of MC versions that NeoForge supports, derived from available NeoForge versions.
#[tauri::command]
pub async fn get_neoforge_game_versions() -> Result<Vec<String>, String> {
    let resp = crate::util::http::HTTP
        .get("https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge")
        .send()
        .await
        .map_err(|e| format!("NeoForge versions fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("NeoForge maven HTTP {}", resp.status()));
    }

    #[derive(serde::Deserialize)]
    struct MavenVersions { versions: Vec<String> }

    let data: MavenVersions = resp.json().await.map_err(|e| format!("Parse: {}", e))?;

    // Extract unique MC versions from NeoForge version numbers.
    // NeoForge "20.2.86" → MC 1.20.2, "21.4.1" → MC 1.21.4, "26.1.2" → MC 26.1.2
    let mut mc_versions: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for v in &data.versions {
        let parts: Vec<&str> = v.split('.').collect();
        if parts.len() < 2 { continue; }

        // Skip snapshot/special versions like "0.25w14craftmine.3-beta"
        let major: u32 = match parts[0].parse() {
            Ok(n) => n,
            Err(_) => continue,
        };
        if major == 0 { continue; }

        let minor: u32 = match parts[1].parse() {
            Ok(n) => n,
            Err(_) => continue,
        };

        // Convert NeoForge prefix to MC version
        let mc_ver = if major >= 26 {
            // New MC format: 26.1.x → MC 26.1.2 (but we just need major.minor)
            // Actually for new format, NeoForge version IS the MC version prefix
            format!("{}.{}", major, minor)
        } else {
            // Old MC format: 20.2.x → MC 1.20.2, 21.4.x → MC 1.21.4
            format!("1.{}.{}", major, minor)
        };

        if seen.insert(mc_ver.clone()) {
            mc_versions.push(mc_ver);
        }
    }

    // Sort descending (newest first)
    mc_versions.sort_by(|a, b| {
        let a_parts: Vec<u32> = a.split('.').filter_map(|p| p.parse().ok()).collect();
        let b_parts: Vec<u32> = b.split('.').filter_map(|p| p.parse().ok()).collect();
        b_parts.cmp(&a_parts)
    });

    Ok(mc_versions)
}

#[tauri::command]
pub async fn get_forge_versions(game_version: String) -> Result<Vec<FabricVersionInfo>, String> {
    // Use Maven metadata to find all Forge versions for this MC version
    let resp = crate::util::http::HTTP.get("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml")
        .send()
        .await
        .map_err(|e| format!("Forge maven fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Ok(Vec::new());
    }

    let text = resp.text().await.map_err(|e| format!("Read: {}", e))?;

    // Find versions that start with this game version prefix
    // e.g. for "1.8.9", match "1.8.9-11.15.1.2318-1.8.9" and "1.8.9-11.15.0.1656"
    let prefix = format!("{}-", game_version);
    let mut versions: Vec<FabricVersionInfo> = Vec::new();

    // Forge versions before MC 1.5.2 don't have installer JARs on Maven
    // (the installer system didn't exist yet). Skip them entirely so the
    // user can't select a version that will always fail to download.
    let mc_parts: Vec<u32> = game_version.split('.').filter_map(|p| p.parse().ok()).collect();
    let too_old = if mc_parts.len() >= 2 && mc_parts[0] == 1 {
        // 1.0..1.4.x are all too old; 1.5.0 and 1.5.1 are borderline but 1.5.2+ is safe
        mc_parts[1] < 5 || (mc_parts[1] == 5 && mc_parts.get(2).copied().unwrap_or(0) < 2)
    } else if mc_parts.first() == Some(&1) && mc_parts.len() == 1 {
        true // bare "1" — too old
    } else {
        false
    };

    if too_old {
        return Ok(Vec::new());
    }

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("<version>") && trimmed.ends_with("</version>") {
            let ver = &trimmed[9..trimmed.len() - 10];
            if ver.starts_with(&prefix) {
                // Return the FULL Maven version string (used as-is for the installer URL)
                versions.push(FabricVersionInfo {
                    version: ver.to_string(),
                    stable: !ver.contains("beta") && !ver.contains("pre"),
                });
            }
        }
    }

    // Reverse so latest is first, take top 5
    versions.reverse();
    versions.truncate(5);

    Ok(versions)
}

/// Returns the list of MC versions that Forge supports, derived from the Maven metadata.
#[tauri::command]
pub async fn get_forge_game_versions() -> Result<Vec<String>, String> {
    let resp = crate::util::http::HTTP.get("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml")
        .send()
        .await
        .map_err(|e| format!("Forge maven metadata fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Ok(Vec::new());
    }

    let text = resp.text().await.map_err(|e| format!("Read: {}", e))?;

    // Parse MC versions from <version>MC_VERSION-FORGE_VERSION</version> entries
    let mut mc_versions: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("<version>") && trimmed.ends_with("</version>") {
            let ver = &trimmed[9..trimmed.len() - 10]; // strip tags
            // Format: "1.21.4-54.1.6" or "26.1.2-64.0.8"
            if let Some(mc_ver) = ver.split('-').next() {
                // Skip entries that don't look like MC versions (e.g. just numbers)
                if mc_ver.contains('.') && seen.insert(mc_ver.to_string()) {
                    // Filter out MC versions below 1.5.2 (no Forge installer JARs exist for them)
                    let parts: Vec<u32> = mc_ver.split('.').filter_map(|p| p.parse().ok()).collect();
                    let too_old = if parts.len() >= 2 && parts[0] == 1 {
                        parts[1] < 5 || (parts[1] == 5 && parts.get(2).copied().unwrap_or(0) < 2)
                    } else if parts.first() == Some(&1) && parts.len() == 1 {
                        true
                    } else {
                        false
                    };
                    if !too_old {
                        mc_versions.push(mc_ver.to_string());
                    }
                }
            }
        }
    }

    // Sort descending (newest first)
    mc_versions.sort_by(|a, b| {
        let a_parts: Vec<u32> = a.split('.').filter_map(|p| p.parse().ok()).collect();
        let b_parts: Vec<u32> = b.split('.').filter_map(|p| p.parse().ok()).collect();
        b_parts.cmp(&a_parts)
    });

    Ok(mc_versions)
}

/// Returns the list of MC versions that Quilt supports.
#[tauri::command]
pub async fn get_quilt_game_versions() -> Result<Vec<String>, String> {
    let resp = crate::util::http::HTTP.get("https://meta.quiltmc.org/v3/versions/game")
        .send()
        .await
        .map_err(|e| format!("Quilt game versions fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Ok(Vec::new());
    }

    #[derive(serde::Deserialize)]
    struct QuiltGameVer { version: String }

    let versions: Vec<QuiltGameVer> = resp.json().await.map_err(|e| format!("Parse: {}", e))?;
    Ok(versions.into_iter().map(|v| v.version).collect())
}
