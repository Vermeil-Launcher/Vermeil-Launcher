//! Download-on-demand install of the Vermeil companion mod jar.
//!
//! The mod jars are published as GitHub release assets on `mod-v*` tags, each
//! release carrying a `companion-manifest.json` that lists every jar's Minecraft
//! version, loaders, URL, SHA-1, and size (see
//! `.github/workflows/mod-release.yml`).
//!
//! At launch, for a **supported** instance with the in-game cape **enabled**, we
//! ensure the matching jar is present in the instance's `mods/` — fetching and
//! SHA-1-verifying it the first time it's needed — and we remove our managed jar
//! when the cape is off or the instance is unsupported. The jar pairs with the
//! cape files the mod reads from the global `companion/` dir (see
//! `instance_cape`).
//!
//! Best-effort throughout: a cosmetic cape must never block or fail a launch, so
//! every network/IO error is logged and swallowed.

use crate::models::instance::Instance;
use crate::services::download::{download_file, DownloadTask};
use crate::services::{instance_cape, settings_service};
use crate::util::{http, paths};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Repo that hosts the companion mod releases.
const REPO: &str = "davekb1976-beep/Vermeil-Launcher";
/// Filename prefix for jars we manage. Only files matching our published naming
/// (`vermeil-<modVersion>+<mcVersion>.jar`) are ever added or removed, so a
/// user's own mods are never touched.
const JAR_PREFIX: &str = "vermeil-";

#[derive(Debug, Deserialize)]
struct Manifest {
    entries: Vec<ManifestEntry>,
}

#[derive(Debug, Deserialize)]
struct ManifestEntry {
    #[serde(rename = "minecraftVersion")]
    minecraft_version: String,
    loaders: Vec<String>,
    file: String,
    url: String,
    sha1: String,
    size: u64,
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

fn mods_dir(instance_id: &str) -> PathBuf {
    paths::instances_dir().join(instance_id).join(".minecraft").join("mods")
}

/// Whether a filename is one of our managed jars (our naming includes a `+`
/// version separator, so this won't match arbitrary user mods).
fn is_managed(name: &str) -> bool {
    name.starts_with(JAR_PREFIX) && name.contains('+') && name.ends_with(".jar")
}

/// Result of `ensure_installed`. Surfaced as a launch-time event so the user
/// can see whether the cape will work this run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case", tag = "kind", content = "detail")]
pub enum CompanionStatus {
    /// Already there or freshly installed — cape will render this run.
    Installed { file: String },
    /// Cape off or instance unsupported — no jar managed (any prior one removed).
    Skipped,
    /// Tried to install but it failed (network / no matching build / disk). The
    /// cape won't render this run; everything else launches fine.
    Failed { reason: String },
}

/// Ensure the companion mod jar matches the cape state for this instance. Called
/// at launch, before the game starts. Best-effort: never throws.
pub async fn ensure_installed(instance: &Instance) -> CompanionStatus {
    let enabled = settings_service::load()
        .await
        .map(|s| s.ingame_cape.enabled)
        .unwrap_or(false);
    let want = enabled && instance_cape::is_supported(instance);
    let mods = mods_dir(&instance.id);

    if !want {
        // Cape off or unsupported: drop any managed jar so we don't leave a mod
        // the user can't see the effect of.
        remove_managed(&mods, None);
        return CompanionStatus::Skipped;
    }

    // Already have a managed jar for this Minecraft version → nothing to do, and
    // crucially no network call on the common already-installed launch path.
    if let Some(file) = installed_jar_for_version(&mods, &instance.game_version) {
        return CompanionStatus::Installed { file };
    }

    match resolve_and_install(instance, &mods).await {
        Ok(file) => CompanionStatus::Installed { file },
        Err(e) => {
            tracing::warn!("Companion mod not installed for instance {}: {}", instance.id, e);
            CompanionStatus::Failed { reason: e }
        }
    }
}

/// Fetch the manifest, pick the jar for this instance, download + verify it into
/// `mods/`, then prune any older managed jars. Returns the installed filename.
async fn resolve_and_install(instance: &Instance, mods: &Path) -> Result<String, String> {
    let manifest = fetch_manifest().await?;
    let loader = instance.loader.loader_type.as_str();

    let entry = manifest
        .entries
        .into_iter()
        .find(|e| e.minecraft_version == instance.game_version && e.loaders.iter().any(|l| l == loader))
        .ok_or_else(|| {
            format!("no companion build for Minecraft {} ({})", instance.game_version, loader)
        })?;

    fs::create_dir_all(mods).map_err(|e| format!("create mods dir: {}", e))?;
    let dest = mods.join(&entry.file);

    let task = DownloadTask {
        url: entry.url.clone(),
        dest: dest.clone(),
        expected_sha1: Some(entry.sha1.clone()),
        expected_size: Some(entry.size),
    };
    download_file(&http::HTTP, &task).await?;

    // Remove any other managed jars (e.g. a previous mod version) now that the
    // current one is in place.
    remove_managed(mods, Some(&entry.file));
    tracing::info!("Installed companion mod {} into instance {}", entry.file, instance.id);
    Ok(entry.file)
}

/// Find the latest `mod-v*` GitHub release and read its `companion-manifest.json`.
async fn fetch_manifest() -> Result<Manifest, String> {
    let api = format!("https://api.github.com/repos/{}/releases?per_page=50", REPO);
    let resp = http::send_with_retry(|| {
        http::HTTP.get(&api).header("Accept", "application/vnd.github+json")
    })
    .await?;
    let releases: Vec<GhRelease> = resp
        .json()
        .await
        .map_err(|e| format!("parse releases list: {}", e))?;

    // The API returns releases newest-first; take the latest published mod release.
    let release = releases
        .into_iter()
        .find(|r| !r.draft && r.tag_name.starts_with("mod-v"))
        .ok_or_else(|| "no published mod-v* release found".to_string())?;

    let asset = release
        .assets
        .iter()
        .find(|a| a.name == "companion-manifest.json")
        .ok_or_else(|| format!("release {} has no companion-manifest.json", release.tag_name))?;

    let resp = http::send_with_retry(|| http::HTTP.get(&asset.browser_download_url)).await?;
    resp.json::<Manifest>()
        .await
        .map_err(|e| format!("parse manifest: {}", e))
}

/// Returns the filename of the managed jar already in `mods/` for the given
/// Minecraft version, or `None`.
fn installed_jar_for_version(mods: &Path, mc_version: &str) -> Option<String> {
    let suffix = format!("+{}.jar", mc_version);
    read_jar_names(mods)
        .into_iter()
        .find(|name| is_managed(name) && name.ends_with(&suffix))
}

/// Remove every managed jar in `mods/`, except `keep` if given. Best-effort.
fn remove_managed(mods: &Path, keep: Option<&str>) {
    for name in read_jar_names(mods) {
        if !is_managed(&name) {
            continue;
        }
        if keep == Some(name.as_str()) {
            continue;
        }
        let path = mods.join(&name);
        if let Err(e) = fs::remove_file(&path) {
            tracing::warn!("Could not remove companion jar {}: {}", path.display(), e);
        }
    }
}

/// List `.jar` file names directly under `mods/` (no recursion). Empty on error.
fn read_jar_names(mods: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(mods) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.ends_with(".jar") {
                    out.push(name.to_string());
                }
            }
        }
    }
    out
}
