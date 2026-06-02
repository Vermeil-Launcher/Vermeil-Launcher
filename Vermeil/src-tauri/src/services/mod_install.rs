//! Mod install service. Algorithm:
//!
//! 1. Fetch the project's full version list (sorted newest first by Modrinth).
//! 2. Pick the version using `find_preferred_version`:
//!    - **Pass 1**: exact `game_version` AND exact `loader` (loader rule applies
//!      to mods only — resource packs / shaders / datapacks skip it).
//!    - **Pass 2**: same loader rule but accept any `game_version` whose base
//!      release matches (we strip pre-release suffixes so `26.1` and
//!      `26.1-pre7` are treated as compatible). This is a deliberate extension
//!      of Modrinth's strict string compare to handle the snapshot case.
//!    - **Pass 3** (mods only): accept versions whose loader includes
//!      `"datapack"` (a common Modrinth pattern when the same content type
//!      lives under multiple project_type values).
//! 3. If still no match → record an `incompatible` issue and bail. Same as
//!    most launchers, dependencies are NOT installed for incompatible
//!    primaries.
//! 4. Walk dependencies recursively. Only `Required` deps install; `Optional`,
//!    `Embedded`, and `Incompatible` are skipped. Quilt instances skip Fabric
//!    API (project `P7dR8mSH`) because Quilt provides it natively.

use crate::models::instance::{Instance, ModEntry};
use crate::services::download::{DownloadTask, download_file};
use crate::services::modrinth::{self, ModrinthVersion};
use crate::util::paths;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;

/// Modrinth's project ID for "Fabric API". Quilt's loader provides Fabric API
/// natively, so installing it on a Quilt instance both wastes a slot and can
/// cause classpath conflicts. We skip it automatically for Quilt instances.
const FABRIC_API_PROJECT_ID: &str = "P7dR8mSH";

/// A compatibility / install issue surfaced to the frontend. Each entry powers
/// one card in `DependencyIssuesModal`.
#[derive(Debug, Clone, Serialize)]
pub struct DependencyIssue {
    pub parent_title: String,
    pub dep_title: String,
    pub dep_project_id: String,
    pub required_game_versions: Vec<String>,
    pub required_loaders: Vec<String>,
    pub instance_game_version: String,
    pub instance_loader: String,
    /// `"missing"` (no versions exist), `"incompatible"` (version exists but
    /// loader/MC version don't match), `"failed"` (download / resolution
    /// error during install).
    pub kind: String,
    pub reason: String,
}

pub struct InstallResult {
    pub mod_entry: ModEntry,
    pub deps_installed: Vec<String>,
    pub dep_titles: Vec<String>,
    pub issues: Vec<DependencyIssue>,
}

/// Public entry point. Resolves and installs the project plus its required
/// dependency tree.
pub async fn install_mod(
    instance_id: &str,
    project_id: &str,
    loader: &str,
    game_version: &str,
    category: &str,
) -> Result<InstallResult, String> {
    let mut visited_projects: HashSet<String> = HashSet::new();
    let mut visited_versions: HashSet<String> = HashSet::new();
    let mut deps_installed: Vec<String> = Vec::new();
    let mut dep_titles: Vec<String> = Vec::new();
    let mut issues: Vec<DependencyIssue> = Vec::new();

    let root = install_one(
        instance_id,
        project_id,
        loader,
        game_version,
        category,
        None,
        &mut visited_projects,
        &mut visited_versions,
        &mut deps_installed,
        &mut dep_titles,
        &mut issues,
        true,
    )
    .await?;

    Ok(InstallResult {
        mod_entry: root,
        deps_installed,
        dep_titles,
        issues,
    })
}

/// Resolve and install a single project. Recurses into required dependencies.
#[allow(clippy::too_many_arguments)]
async fn install_one(
    instance_id: &str,
    project_id: &str,
    loader: &str,
    game_version: &str,
    category: &str,
    parent_title: Option<&str>,
    visited_projects: &mut HashSet<String>,
    visited_versions: &mut HashSet<String>,
    deps_installed: &mut Vec<String>,
    dep_titles: &mut Vec<String>,
    issues: &mut Vec<DependencyIssue>,
    is_root: bool,
) -> Result<ModEntry, String> {
    if !visited_projects.insert(project_id.to_string()) {
        return Err(format!("Cycle detected on project {}", project_id));
    }

    // Fetch the project's full version list once. Modrinth returns them sorted
    // newest first by `date_published`, which is the order their frontend
    // expects when running `findPreferredVersion`.
    let versions = modrinth::get_project_versions(project_id, "", "")
        .await
        .map_err(|e| format!("Fetch versions for {}: {}", project_id, e))?;

    // === Resolve which version to install ===
    let project_type = ProjectType::from_category(category);
    let chosen = find_preferred_version(&versions, project_type, loader, game_version);

    let version = match chosen {
        Some(v) => v.clone(),
        None => {
            // No compatible version exists. Record a structured issue (the
            // frontend renders this as a card listing required loaders +
            // versions next to the instance's values), then refuse the
            // install. We do NOT pick a "closest" fallback because installing
            // a Forge mod into a Fabric instance is silent corruption.
            let dep_title = lookup_project_title(project_id)
                .await
                .unwrap_or_else(|| project_id.to_string());

            // Aggregate all loaders / game_versions across the project's
            // versions so the modal can show "supports: forge, neoforge —
            // 1.20.1, 1.21" etc.
            let mut all_loaders: Vec<String> = Vec::new();
            let mut all_game_versions: Vec<String> = Vec::new();
            for v in &versions {
                for l in &v.loaders {
                    if !all_loaders.contains(l) {
                        all_loaders.push(l.clone());
                    }
                }
                for g in &v.game_versions {
                    if !all_game_versions.contains(g) {
                        all_game_versions.push(g.clone());
                    }
                }
            }

            let kind = if versions.is_empty() { "missing" } else { "incompatible" };
            let reason = if versions.is_empty() {
                "No versions of this dependency exist on Modrinth.".to_string()
            } else {
                let mut bits = Vec::new();
                if project_type.checks_loader()
                    && !all_loaders.iter().any(|l| l == loader)
                {
                    bits.push(format!(
                        "supports {} (instance uses {})",
                        all_loaders.join(", "),
                        loader
                    ));
                }
                if !all_game_versions.iter().any(|g| compatible_game_version(g, game_version)) {
                    bits.push(format!(
                        "supports MC {} (instance is on {})",
                        truncate_list(&all_game_versions, 6),
                        game_version
                    ));
                }
                if bits.is_empty() {
                    "No version satisfies the instance's loader and MC version.".to_string()
                } else {
                    bits.join("; ")
                }
            };

            issues.push(DependencyIssue {
                parent_title: parent_title.unwrap_or("(unknown)").to_string(),
                dep_title,
                dep_project_id: project_id.to_string(),
                required_game_versions: all_game_versions,
                required_loaders: all_loaders,
                instance_game_version: game_version.to_string(),
                instance_loader: loader.to_string(),
                kind: kind.to_string(),
                reason,
            });
            return Err(format!("No compatible version for project {}", project_id));
        }
    };

    if !visited_versions.insert(version.id.clone()) {
        // Some other project already pulled in this version; nothing to do.
        return Err("Version already handled in this run".to_string());
    }

    // === Pick a file ===
    let file = version
        .files
        .iter()
        .find(|f| f.primary)
        .or_else(|| version.files.first())
        .ok_or("No files in version")?;

    // === Project metadata for icon/title ===
    let (title, icon_url, description, _project_type) = lookup_project_meta(project_id).await;

    // Best-effort cache the project icon to disk so the Installed-tab card
    // and any future render of this mod doesn't re-hit the CDN every time.
    // Cache is content-addressed by URL hash so dedups across mods that
    // share an icon (rare, but cheap to handle).
    let local_icon_path = match icon_url.as_deref() {
        Some(u) => crate::services::icon_cache::cache_remote_icon(u).await,
        None => None,
    };

    // === Download into the right folder for the category ===
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

    let dest = target_dir.join(&file.filename);
    let task = DownloadTask {
        url: file.url.clone(),
        dest: dest.clone(),
        expected_sha1: file.hashes.sha1.clone(),
        expected_size: Some(file.size),
    };
    download_file(&crate::util::http::HTTP, &task).await?;

    let mod_entry = ModEntry {
        id: version.id.clone(),
        source: "modrinth".to_string(),
        project_id: project_id.to_string(),
        version_id: version.id.clone(),
        filename: file.filename.clone(),
        enabled: true,
        pinned: false,
        title: title.clone(),
        icon_url,
        local_icon_path,
        description,
        category: category.to_string(),
    };

    // === Persist instance.json (idempotent — skip if project already present) ===
    let meta_path = instance_dir.join("instance.json");
    let content = fs::read_to_string(&meta_path)
        .map_err(|e| format!("Read instance.json: {}", e))?;
    let mut instance: Instance = serde_json::from_str(&content)
        .map_err(|e| format!("Parse instance.json: {}", e))?;

    let already_present = instance.mods.iter().any(|m| m.project_id == project_id);
    if !already_present {
        instance.mods.push(mod_entry.clone());
        let json = serde_json::to_string_pretty(&instance)
            .map_err(|e| format!("Serialize instance.json: {}", e))?;
        fs::write(&meta_path, json).map_err(|e| format!("Write instance.json: {}", e))?;

        if !is_root {
            deps_installed.push(project_id.to_string());
            dep_titles.push(title.clone().unwrap_or_else(|| project_id.to_string()));
        }
    }

    // === Walk required dependencies ===
    for dep in &version.dependencies {
        if dep.dependency_type != "required" {
            continue; // Optional / Embedded / Incompatible — skip per Modrinth.
        }

        // Resolve a project_id for the dep. Modrinth deps usually carry
        // `project_id`; some carry only `version_id` (a pin), in which case we
        // fetch the version to learn its parent project.
        let dep_project_id = if let Some(ref pid) = dep.project_id {
            pid.clone()
        } else if let Some(ref vid) = dep.version_id {
            match resolve_project_from_version(vid).await {
                Some(pid) => pid,
                None => continue,
            }
        } else {
            continue;
        };

        // Quilt provides Fabric API natively — installing it again would clash.
        if dep_project_id == FABRIC_API_PROJECT_ID && loader == "quilt" {
            continue;
        }

        if visited_projects.contains(&dep_project_id) {
            continue;
        }
        let already_in_instance = serde_json::from_str::<Instance>(
            &fs::read_to_string(&meta_path).unwrap_or_default(),
        )
        .map(|inst| inst.mods.iter().any(|m| m.project_id == dep_project_id))
        .unwrap_or(false);
        if already_in_instance {
            visited_projects.insert(dep_project_id);
            continue;
        }

        let parent = title.clone().unwrap_or_else(|| project_id.to_string());

        // Determine the dep's actual project type before recursing. Modrinth's
        // `dependency` struct doesn't carry it, so we look it up. Datapack deps
        // belong in `datapacks/`, resource pack deps in `resourcepacks/`, etc.
        // Without this every dep — including datapacks — was being dropped
        // into `mods/`, which silently broke loaders that scan folders.
        let dep_category = lookup_project_type(&dep_project_id)
            .await
            .map(|t| match t.as_str() {
                "resourcepack" => "resourcepack".to_string(),
                "shader" => "shader".to_string(),
                "datapack" => "datapack".to_string(),
                _ => "mod".to_string(),
            })
            .unwrap_or_else(|| "mod".to_string());

        if let Err(e) = Box::pin(install_one(
            instance_id,
            &dep_project_id,
            loader,
            game_version,
            &dep_category,
            Some(&parent),
            visited_projects,
            visited_versions,
            deps_installed,
            dep_titles,
            issues,
            false,
        ))
        .await
        {
            tracing::warn!(
                "Skipping dependency {} of {}: {}",
                dep_project_id,
                project_id,
                e
            );
            // If `install_one` returned without recording its own issue
            // (uncommon — happens on transient network errors), surface a
            // generic "failed" entry so the user still sees it.
            let already_recorded = issues.iter().any(|i| i.dep_project_id == dep_project_id);
            if !already_recorded {
                let dep_title = lookup_project_title(&dep_project_id)
                    .await
                    .unwrap_or_else(|| dep_project_id.clone());
                issues.push(DependencyIssue {
                    parent_title: parent.clone(),
                    dep_title,
                    dep_project_id: dep_project_id.clone(),
                    required_game_versions: Vec::new(),
                    required_loaders: Vec::new(),
                    instance_game_version: game_version.to_string(),
                    instance_loader: loader.to_string(),
                    kind: "failed".to_string(),
                    reason: e,
                });
            }
        }
    }

    Ok(mod_entry)
}

// ============================================================================
// Compatibility algorithm — picks the best version from the project's
// version list given the instance's loader and game version.
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProjectType {
    Mod,
    ResourcePack,
    Shader,
    DataPack,
}

impl ProjectType {
    pub(crate) fn from_category(category: &str) -> Self {
        match category {
            "resourcepack" => ProjectType::ResourcePack,
            "shader" => ProjectType::Shader,
            "datapack" => ProjectType::DataPack,
            _ => ProjectType::Mod,
        }
    }

    /// Whether the loader filter applies. Modrinth only enforces the loader
    /// check on mods; everything else is loader-agnostic.
    fn checks_loader(&self) -> bool {
        matches!(self, ProjectType::Mod)
    }
}

/// Given a project's full version list (newest first), pick the best match.
/// Used by both the install flow and the update checker — keeping the picker
/// in one place ensures updates only surface versions we'd actually install.
pub(crate) fn find_preferred_version<'a>(
    versions: &'a [ModrinthVersion],
    project_type: ProjectType,
    loader: &str,
    game_version: &str,
) -> Option<&'a ModrinthVersion> {
    // Pass 1 — strict: exact game_version + exact loader.
    let strict = versions.iter().find(|v| {
        v.game_versions.iter().any(|g| g == game_version)
            && (!project_type.checks_loader() || v.loaders.iter().any(|l| l == loader))
    });
    if strict.is_some() {
        return strict;
    }

    // Pass 2 — lenient game version: accept versions whose game_versions list
    // contains a string with the same base release as the instance's MC
    // version (e.g., `26.1-pre7` matches `26.1`). Loader rule still strict.
    let lenient = versions.iter().find(|v| {
        v.game_versions
            .iter()
            .any(|g| compatible_game_version(g, game_version))
            && (!project_type.checks_loader() || v.loaders.iter().any(|l| l == loader))
    });
    if lenient.is_some() {
        return lenient;
    }

    // Pass 3 — datapack-as-mod (Modrinth's `isVersionCompatible` accepts a mod
    // that ships as a datapack on any loader instance).
    if project_type == ProjectType::Mod {
        let datapack = versions.iter().find(|v| {
            v.game_versions
                .iter()
                .any(|g| compatible_game_version(g, game_version))
                && v.loaders.iter().any(|l| l == "datapack")
        });
        if datapack.is_some() {
            return datapack;
        }
    }

    None
}

/// Are these two MC version strings compatible? Strict equality, or one is the
/// pre-release / RC / snapshot variant of the other (e.g., `26.1` ↔
/// `26.1-pre7`, `1.20.1` ↔ `1.20.1-rc1`).
///
/// We strip the suffix from both sides and compare the bases. This is more
/// lenient than Modrinth's `Array.includes`, which is intentional — a mod
/// declaring support for `1.21-pre7` should still install on `1.21` because
/// the pre-release was the precursor to that exact final.
fn compatible_game_version(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    base_release(a) == base_release(b)
}

/// Strip pre-release / snapshot suffixes from an MC version string.
/// `"26.1-pre7"` → `"26.1"`, `"1.20.1-rc1"` → `"1.20.1"`. Snapshots like
/// `"24w14a"` have no base release and return as-is.
fn base_release(v: &str) -> &str {
    for sep in ["-pre", "-rc", "-experimental", "-snapshot", "-beta", "-alpha"] {
        if let Some(idx) = v.find(sep) {
            return &v[..idx];
        }
    }
    v
}

fn truncate_list(list: &[String], max: usize) -> String {
    if list.len() <= max {
        list.join(", ")
    } else {
        format!("{}, +{} more", list[..max].join(", "), list.len() - max)
    }
}

// ============================================================================
// Modrinth metadata helpers
// ============================================================================

async fn lookup_project_title(project_id: &str) -> Option<String> {
    lookup_project_meta(project_id).await.0
}

/// Returns `(title, icon_url, description, project_type)`. Each field falls
/// back to None on any error so install can still proceed with a barebones
/// ModEntry.
///
/// `project_type` is one of Modrinth's category strings (`"mod"`,
/// `"resourcepack"`, `"shader"`, `"datapack"`). We use it to route a
/// dependency's download to the right folder — without it, every dep
/// (including datapack deps of a datapack) was being dropped into `mods/`.
async fn lookup_project_meta(
    project_id: &str,
) -> (Option<String>, Option<String>, Option<String>, Option<String>) {
    let url = format!("https://api.modrinth.com/v2/project/{}", project_id);
    let resp = match crate::util::http::HTTP.get(&url).send().await {
        Ok(r) => r,
        Err(_) => return (None, None, None, None),
    };
    if !resp.status().is_success() {
        return (None, None, None, None);
    }
    #[derive(serde::Deserialize)]
    struct ProjectInfo {
        title: Option<String>,
        icon_url: Option<String>,
        description: Option<String>,
        project_type: Option<String>,
    }
    match resp.json::<ProjectInfo>().await {
        Ok(p) => (p.title, p.icon_url, p.description, p.project_type),
        Err(_) => (None, None, None, None),
    }
}

/// Resolve a dependency's project type. Modrinth's `dependency` struct
/// doesn't carry the dep's project_type, so we have to ask the API.
/// Used during the dep walk to pick the right install folder.
async fn lookup_project_type(project_id: &str) -> Option<String> {
    lookup_project_meta(project_id).await.3
}

async fn resolve_project_from_version(version_id: &str) -> Option<String> {
    let url = format!("https://api.modrinth.com/v2/version/{}", version_id);
    let resp = crate::util::http::HTTP.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json: serde_json::Value = resp.json().await.ok()?;
    json.get("project_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

// ============================================================================
// Removal / toggle (unchanged from previous implementation)
// ============================================================================

pub async fn remove_mod(instance_id: &str, project_id: &str) -> Result<(), String> {
    let instance_dir = paths::instances_dir().join(instance_id);
    let meta_path = instance_dir.join("instance.json");

    let content = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: Instance = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    if let Some(pos) = instance.mods.iter().position(|m| m.project_id == project_id) {
        let mod_entry = instance.mods.remove(pos);
        let folder = match mod_entry.category.as_str() {
            "resourcepack" => "resourcepacks",
            "shader" => "shaderpacks",
            "datapack" => "datapacks",
            _ => "mods",
        };
        let file_path = instance_dir.join(".minecraft").join(folder).join(&mod_entry.filename);
        // .disabled files end with .jar.disabled — also try that.
        if file_path.exists() {
            let _ = fs::remove_file(&file_path);
        }

        let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
        fs::write(&meta_path, json).map_err(|e| e.to_string())?;
    }

    Ok(())
}

pub async fn remove_all_content(instance_id: &str, category: &str) -> Result<usize, String> {
    let instance_dir = paths::instances_dir().join(instance_id);
    let meta_path = instance_dir.join("instance.json");

    let content = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: Instance = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let initial = instance.mods.len();
    let (kept, removed): (Vec<_>, Vec<_>) = instance.mods.into_iter().partition(|m| {
        if category == "all" {
            return false;
        }
        m.category != category
    });

    for mod_entry in &removed {
        let folder = match mod_entry.category.as_str() {
            "resourcepack" => "resourcepacks",
            "shader" => "shaderpacks",
            "datapack" => "datapacks",
            _ => "mods",
        };
        let file_path = instance_dir.join(".minecraft").join(folder).join(&mod_entry.filename);
        if let Err(e) = fs::remove_file(&file_path) {
            tracing::warn!(
                "Failed to remove {} during bulk delete: {}",
                file_path.display(),
                e
            );
        }
    }

    instance.mods = kept;
    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    fs::write(&meta_path, json).map_err(|e| e.to_string())?;

    Ok(initial - instance.mods.len())
}

pub async fn toggle_mod(instance_id: &str, project_id: &str) -> Result<bool, String> {
    let instance_dir = paths::instances_dir().join(instance_id);
    let meta_path = instance_dir.join("instance.json");

    let content = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut instance: Instance = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let mod_idx = instance
        .mods
        .iter()
        .position(|m| m.project_id == project_id)
        .ok_or("Mod not found")?;

    let folder = match instance.mods[mod_idx].category.as_str() {
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        "datapack" => "datapacks",
        _ => "mods",
    };
    let target_dir = instance_dir.join(".minecraft").join(folder);
    let current_path = target_dir.join(&instance.mods[mod_idx].filename);
    let new_enabled;

    if instance.mods[mod_idx].enabled {
        let new_name = format!("{}.disabled", instance.mods[mod_idx].filename);
        let new_path = target_dir.join(&new_name);
        fs::rename(&current_path, &new_path).map_err(|e| format!("Rename failed: {}", e))?;
        instance.mods[mod_idx].filename = new_name;
        instance.mods[mod_idx].enabled = false;
        new_enabled = false;
    } else {
        let new_name = instance.mods[mod_idx].filename.trim_end_matches(".disabled").to_string();
        let new_path = target_dir.join(&new_name);
        fs::rename(&current_path, &new_path).map_err(|e| format!("Rename failed: {}", e))?;
        instance.mods[mod_idx].filename = new_name;
        instance.mods[mod_idx].enabled = true;
        new_enabled = true;
    }

    let json = serde_json::to_string_pretty(&instance).map_err(|e| e.to_string())?;
    fs::write(&meta_path, json).map_err(|e| e.to_string())?;

    Ok(new_enabled)
}
