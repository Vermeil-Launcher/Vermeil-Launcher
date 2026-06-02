use crate::services::download::{DownloadTask, download_file};
use crate::util::paths;
use serde::Deserialize;
use std::path::PathBuf;

const QUILT_META: &str = "https://meta.quiltmc.org/v3";

#[derive(Debug, Deserialize)]
pub struct QuiltVersionMeta {
    #[serde(rename = "mainClass")]
    pub main_class: String,
    pub libraries: Vec<QuiltLibrary>,
}

#[derive(Debug, Deserialize)]
pub struct QuiltLibrary {
    pub name: String,
    pub url: String,
}

/// Fetch the Quilt loader profile
pub async fn get_quilt_profile(game_version: &str, loader_version: &str) -> Result<QuiltVersionMeta, String> {
    let url = format!("{}/versions/loader/{}/{}/profile/json", QUILT_META, game_version, loader_version);

    let resp = crate::util::http::HTTP.get(&url)
        .send()
        .await
        .map_err(|e| format!("Quilt profile fetch failed: {}", e))?;

    if !resp.status().is_success() {
        if resp.status().as_u16() == 404 {
            return Err(format!("Quilt does not support Minecraft {}. Try a different version.", game_version));
        }
        return Err(format!("Quilt meta returned HTTP {}", resp.status()));
    }

    resp.json::<QuiltVersionMeta>()
        .await
        .map_err(|e| format!("Parse Quilt profile: {}", e))
}

/// Maven coordinate to path (same logic as Fabric)
fn maven_to_path(coordinate: &str) -> String {
    let parts: Vec<&str> = coordinate.split(':').collect();
    if parts.len() < 3 { return coordinate.to_string(); }
    let group = parts[0].replace('.', "/");
    let artifact = parts[1];
    let version = parts[2];
    format!("{}/{}/{}/{}-{}.jar", group, artifact, version, artifact, version)
}

/// Ensure all Quilt libraries are downloaded
pub async fn ensure_quilt_libraries(game_version: &str, loader_version: &str) -> Result<(String, Vec<PathBuf>), String> {
    let profile = get_quilt_profile(game_version, loader_version).await?;
    let libs_dir = paths::libraries_dir();
    let mut paths_out = Vec::new();

    for lib in &profile.libraries {
        let rel_path = maven_to_path(&lib.name);
        let dest = libs_dir.join(&rel_path);

        if !dest.exists() {
            let url = format!("{}{}", lib.url, rel_path);
            let task = DownloadTask { url, dest: dest.clone(), expected_sha1: None, expected_size: None };
            download_file(&crate::util::http::HTTP, &task).await?;
        }
        paths_out.push(dest);
    }

    Ok((profile.main_class, paths_out))
}
