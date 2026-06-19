//! Icon cache.
//!
//! Mods, resource packs, shaders, and modpacks each carry a remote `icon_url`
//! pointing at a CDN-hosted PNG. We don't want to re-fetch those every time a
//! card is rendered, and we don't want the UI to break offline. So whenever we
//! install something, we fetch the icon once and write it to a content-
//! addressed file under `%LOCALAPPDATA%\Vermeil\icons\`.
//!
//! The frontend then uses Tauri's `asset://` protocol to read the cached file
//! directly off disk — no network hit, no CORS, works offline.
//!
//! Cache key: SHA-1 of the lowercased URL. Same URL → same file → dedup
//! across instances. (Modrinth's icon CDN serves the same hashed URL for
//! the same icon across all consumers, so this dedups well in practice.)

use sha1::{Digest, Sha1};
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;

use crate::util::http::HTTP;
use crate::util::paths;

/// Try to cache an icon from `url`. Returns the absolute path to the cached
/// file as a string on success, `None` on any failure.
///
/// Failures are deliberately non-fatal: a missing icon should never block an
/// install or update flow. The caller falls back to the remote URL (or to a
/// generic placeholder), and we just retry on the next install.
pub async fn cache_remote_icon(url: &str) -> Option<String> {
    if url.trim().is_empty() {
        return None;
    }

    let icons_dir = paths::data_dir().join("icons");
    if let Err(e) = tokio::fs::create_dir_all(&icons_dir).await {
        tracing::debug!("icon cache: create_dir_all failed for {:?}: {}", icons_dir, e);
        return None;
    }

    // Hash the URL to get a stable file name. Lowercase first so trivial casing
    // differences don't blow up the cache.
    let mut hasher = Sha1::new();
    hasher.update(url.trim().to_lowercase().as_bytes());
    let hash = hex_lower(&hasher.finalize());

    // Pick the file extension from the URL path. We default to `.png` because
    // every icon source we currently talk to (Modrinth, CurseForge) serves PNGs
    // and Tauri's webview happily renders unknown extensions as raw PNG anyway.
    let ext = guess_extension(url).unwrap_or_else(|| "png".to_string());
    let path: PathBuf = icons_dir.join(format!("{}.{}", hash, ext));

    if path.exists() {
        // Already cached — return as data URL
        return file_to_data_url(&path).await;
    }

    // Not cached yet — go fetch.
    let resp = match HTTP.get(url).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            tracing::debug!("icon cache: {} returned status {}", url, r.status());
            return None;
        }
        Err(e) => {
            tracing::debug!("icon cache: GET {} failed: {}", url, e);
            return None;
        }
    };

    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            tracing::debug!("icon cache: read body for {} failed: {}", url, e);
            return None;
        }
    };

    // Write to a `.part` file first and rename so a partial download never
    // looks cached.
    let part = path.with_extension(format!("{}.part", ext));
    let mut file = match tokio::fs::File::create(&part).await {
        Ok(f) => f,
        Err(e) => {
            tracing::debug!("icon cache: create {:?}: {}", part, e);
            return None;
        }
    };
    if let Err(e) = file.write_all(&bytes).await {
        tracing::debug!("icon cache: write {:?}: {}", part, e);
        return None;
    }
    drop(file);

    if let Err(e) = tokio::fs::rename(&part, &path).await {
        if path.exists() {
            let _ = tokio::fs::remove_file(&part).await;
            return file_to_data_url(&path).await;
        }
        tracing::debug!("icon cache: rename {:?} -> {:?}: {}", part, path, e);
        return None;
    }

    file_to_data_url(&path).await
}

/// Read a cached icon file and return it as a `data:image/...;base64,...` URL.
/// This sidesteps all Tauri asset-protocol scope/path-encoding issues — the
/// webview loads the image directly from the inline data URL, same pattern
/// we use for skin textures.
async fn file_to_data_url(path: &PathBuf) -> Option<String> {
    let bytes = match tokio::fs::read(path).await {
        Ok(b) => b,
        Err(e) => {
            tracing::debug!("icon cache: read {:?} for data URL: {}", path, e);
            return None;
        }
    };

    let mime = match path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        _ => "image/png",
    };

    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{}", mime, encoded))
}

fn guess_extension(url: &str) -> Option<String> {
    // Strip query string before sniffing.
    let url = url.split('?').next().unwrap_or(url);
    let last = url.rsplit('/').next()?;
    let dot = last.rfind('.')?;
    let ext = &last[dot + 1..];
    // Sanity: only accept short alphanumeric extensions. Anything weirder and
    // we fall back to PNG.
    if ext.is_empty() || ext.len() > 5 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext.to_lowercase())
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

