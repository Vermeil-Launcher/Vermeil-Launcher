//! Download-on-demand install of the Vermeil companion mod jar.
//!
//! The mod jars are published as GitHub release assets on `mod-v*` tags, each
//! release carrying a `companion-manifest.json` that lists every jar's Minecraft
//! version, loaders, URL, SHA-1, and size (see
//! `.github/workflows/mod-release.yml`).
//!
//! At launch, for a **supported** instance with the companion **enabled** (the
//! per-instance toggle), we ensure the matching jar is the active build in the
//! instance's `mods/` — fetching and SHA-1-verifying it the first time it's
//! needed — and when it's toggled off (or unsupported) we **disable** our jar in
//! place by renaming it `.disabled` rather than deleting it, so flipping it back
//! on needs no re-download. The mod reads its data (cape, `vermeil-settings.json`)
//! from the global `companion/` dir (see `instance_cape`).
//!
//! Best-effort throughout: a cosmetic cape must never block or fail a launch, so
//! every network/IO error is logged and swallowed.

use crate::models::instance::Instance;
use crate::services::download::{download_file, DownloadTask};
use crate::services::instance_cape;
use crate::util::{http, paths};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Repo that hosts the companion mod releases.
const REPO: &str = "davekb1976-beep/Vermeil-Launcher";
/// Filename prefix for jars we manage. Only files matching our published naming
/// (`vermeil-<modVersion>+<mcVersion>.jar`) are ever added, disabled, or
/// removed, so a user's own mods are never touched.
const JAR_PREFIX: &str = "vermeil-";
/// Suffix used to disable a managed jar in place (loaders ignore `.jar.disabled`),
/// so toggling the companion off then on needs no re-download.
const DISABLED_SUFFIX: &str = ".disabled";

#[derive(Debug, Deserialize)]
struct Manifest {
    entries: Vec<ManifestEntry>,
}

#[derive(Debug, Deserialize)]
struct ManifestEntry {
    /// Every Minecraft version this single jar supports. One jar can cover a
    /// whole render-era range (e.g. `["26.1","26.1.1","26.1.2","26.2"]`), so the
    /// launcher matches an instance's exact version against this list.
    #[serde(rename = "minecraftVersions")]
    minecraft_versions: Vec<String>,
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

/// Whether a filename is one of our managed jars, active or disabled (our naming
/// includes a `+` version separator, so this won't match arbitrary user mods).
fn is_managed(name: &str) -> bool {
    is_managed_active(name) || is_managed_disabled(name)
}

/// An active managed jar — our naming, ends `.jar`.
fn is_managed_active(name: &str) -> bool {
    name.starts_with(JAR_PREFIX) && name.contains('+') && name.ends_with(".jar")
}

/// A disabled managed jar — our naming with the `.disabled` suffix.
fn is_managed_disabled(name: &str) -> bool {
    name.starts_with(JAR_PREFIX) && name.contains('+') && name.ends_with(".jar.disabled")
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

/// Ensure the companion jar matches this instance's per-instance toggle. Called
/// at launch, before the game starts. Best-effort: never throws.
pub async fn ensure_installed(instance: &Instance) -> CompanionStatus {
    // The per-instance toggle plus the support gate decide it. The mod is a
    // feature host (cape, FOV effects, in-game settings), so its presence is
    // tied to the user wanting it on this instance and the instance being a
    // supported loader + Minecraft version — not to a cape being set.
    let want = instance.companion_enabled && instance_cape::is_supported(instance);
    let mods = mods_dir(&instance.id);

    if !want {
        // Toggled off (or unsupported): disable the jar by renaming it
        // `.disabled` rather than deleting it, so flipping it back on needs no
        // re-download. The game's loader ignores `.jar.disabled`.
        disable_managed(&mods);
        return CompanionStatus::Skipped;
    }

    // Resolve against the latest manifest every launch so an already-installed
    // instance picks up a newer mod build (the expected jar filename embeds the
    // mod version, so a stale `vermeil-0.1.3+…` no longer counts as "installed"
    // once `0.1.4+…` is published). The download itself is skipped when the exact
    // current jar is already present or sitting disabled (see `resolve_and_install`).
    match resolve_and_install(instance, &mods).await {
        Ok(file) => CompanionStatus::Installed { file },
        Err(e) => {
            // Couldn't reach/parse the manifest (e.g. offline). Don't fail a
            // launch over an inability to *check* for updates: re-enable a
            // disabled jar or keep an active one if present.
            if let Some(file) = reenable_existing(&mods) {
                tracing::warn!(
                    "Companion update check failed for instance {} ({}); using existing jar {}",
                    instance.id,
                    e,
                    file
                );
                return CompanionStatus::Installed { file };
            }
            tracing::warn!("Companion mod not installed for instance {}: {}", instance.id, e);
            CompanionStatus::Failed { reason: e }
        }
    }
}

/// Fetch the manifest, pick the jar for this instance, ensure it's the active
/// build in `mods/`, then prune any other managed jars. Returns the active
/// filename.
///
/// Order of cheap-first paths: the exact build already active → done; the exact
/// build sitting disabled → rename it active (no download); otherwise download.
/// Any other managed file (older version, active or disabled) is pruned so only
/// the current build remains — that's how existing instances get updated.
async fn resolve_and_install(instance: &Instance, mods: &Path) -> Result<String, String> {
    let manifest = fetch_manifest().await?;
    let loader = instance.loader.loader_type.as_str();

    let entry = manifest
        .entries
        .into_iter()
        .find(|e| {
            e.minecraft_versions.iter().any(|v| v == &instance.game_version)
                && e.loaders.iter().any(|l| l == loader)
        })
        .ok_or_else(|| {
            format!("no companion build for Minecraft {} ({})", instance.game_version, loader)
        })?;

    fs::create_dir_all(mods).map_err(|e| format!("create mods dir: {}", e))?;

    let dest = mods.join(&entry.file);
    let disabled = mods.join(format!("{}{}", entry.file, DISABLED_SUFFIX));

    // Exact build already active → fast path, no network on the file itself.
    if dest.exists() {
        prune_managed_except(mods, &entry.file);
        return Ok(entry.file);
    }

    // Exact build sitting disabled (user toggled off then on) → re-enable it
    // with a rename, no download.
    if disabled.exists() {
        fs::rename(&disabled, &dest).map_err(|e| format!("re-enable companion jar: {}", e))?;
        prune_managed_except(mods, &entry.file);
        return Ok(entry.file);
    }

    let task = DownloadTask {
        url: entry.url.clone(),
        dest: dest.clone(),
        expected_sha1: Some(entry.sha1.clone()),
        expected_size: Some(entry.size),
    };
    download_file(&http::HTTP, &task).await?;

    prune_managed_except(mods, &entry.file);
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

/// Returns the active managed filename in use, re-enabling a disabled one if
/// that's all we have. Used only for offline grace when the manifest check fails:
/// we only ever keep a single managed jar per instance, so any present is *the*
/// companion jar. Filenames embed a version *range*, so we match by our naming
/// rather than an exact version. Best-effort on the rename.
fn reenable_existing(mods: &Path) -> Option<String> {
    let names = read_dir_names(mods);
    if let Some(active) = names.iter().find(|n| is_managed_active(n)) {
        return Some(active.clone());
    }
    let disabled = names.into_iter().find(|n| is_managed_disabled(n))?;
    let active_name = disabled.trim_end_matches(DISABLED_SUFFIX).to_string();
    match fs::rename(mods.join(&disabled), mods.join(&active_name)) {
        Ok(_) => Some(active_name),
        Err(e) => {
            tracing::warn!("Could not re-enable companion jar {}: {}", disabled, e);
            None
        }
    }
}

/// Disable every active managed jar by renaming it `<name>.disabled` (the loader
/// ignores it), keeping the file so re-enabling needs no re-download. Best-effort.
fn disable_managed(mods: &Path) {
    for name in read_dir_names(mods) {
        if !is_managed_active(&name) {
            continue;
        }
        let from = mods.join(&name);
        let to = mods.join(format!("{}{}", name, DISABLED_SUFFIX));
        if let Err(e) = fs::rename(&from, &to) {
            tracing::warn!("Could not disable companion jar {}: {}", from.display(), e);
        }
    }
}

/// Remove every managed file (active or disabled) except the active `keep`.
/// Cleans up old versions and any stale disabled copy so only the current build
/// remains. Best-effort.
fn prune_managed_except(mods: &Path, keep: &str) {
    for name in read_dir_names(mods) {
        if !is_managed(&name) || name == keep {
            continue;
        }
        let path = mods.join(&name);
        if let Err(e) = fs::remove_file(&path) {
            tracing::warn!("Could not remove companion jar {}: {}", path.display(), e);
        }
    }
}

/// All entry names directly under `mods/` (no recursion). Empty on error.
fn read_dir_names(mods: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(mods) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                out.push(name.to_string());
            }
        }
    }
    out
}
