//! Mod update detection + application.
//!
//! For each Modrinth-sourced mod in an instance we fetch the project's full
//! version list (filtered to the instance's loader + game version), run the
//! same compatibility picker we use at install time (`find_preferred_version`),
//! and compare the result's `version_id` against what's recorded in
//! `instance.json`. A mismatch with a newer `date_published` means an update
//! is available.
//!
//! Update application reuses `mod_install::install_mod` so dep walking,
//! compatibility gates, and folder routing all behave identically to a fresh
//! install — the only extra step is removing the old file before downloading
//! the new one and preserving `enabled` state across the swap.

use crate::models::instance::Instance;
use crate::services::mod_install::{
    self, InstallResult, ProjectType, find_preferred_version,
};
use crate::services::modrinth;
use crate::util::paths;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;

/// One available update for an installed Modrinth mod. Surfaced per project
/// id so the frontend can decorate each installed-tab card with an "Update"
/// pill when a match exists.
#[derive(Debug, Clone, Serialize)]
pub struct ModUpdate {
    pub project_id: String,
    pub current_version_id: String,
    pub latest_version_id: String,
    pub latest_version_number: String,
    pub latest_filename: String,
    pub latest_published: Option<String>,
}

/// Check every Modrinth-sourced mod in an instance for updates.
///
/// Returns a map keyed by project_id so the frontend can render a badge by
/// looking up `mod.project_id` directly. Non-Modrinth mods (modpack-bundled,
/// CurseForge imports, manually-added files) are skipped — there's no source
/// of truth to compare against.
///
/// Network calls are issued sequentially to be polite to Modrinth's API; this
/// runs at most once per Installed-tab mount and the result is cached on the
/// frontend until the user navigates away.
pub async fn check_updates(instance: &Instance) -> Result<HashMap<String, ModUpdate>, String> {
    let mut updates: HashMap<String, ModUpdate> = HashMap::new();

    // Avoid checking the same project twice (a user could have the same mod
    // installed under two different categories — unlikely but cheap to guard).
    let mut seen: HashSet<String> = HashSet::new();

    for entry in &instance.mods {
        if entry.source != "modrinth" {
            continue;
        }
        if entry.project_id.is_empty() || entry.version_id.is_empty() {
            continue;
        }
        if !seen.insert(entry.project_id.clone()) {
            continue;
        }

        // Fetch the full version list once per project (Modrinth returns it
        // sorted newest first, which is the order `find_preferred_version`
        // expects).
        let versions = match modrinth::get_project_versions(&entry.project_id, "", "").await {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!(
                    "Skipping update check for {} ({}): {}",
                    entry.title.as_deref().unwrap_or(&entry.project_id),
                    entry.project_id,
                    e
                );
                continue;
            }
        };

        let project_type = ProjectType::from_category(&entry.category);
        let chosen = find_preferred_version(
            &versions,
            project_type,
            instance.loader.loader_type.as_str(),
            &instance.game_version,
        );

        let Some(chosen) = chosen else {
            // No compatible version — nothing to update to.
            continue;
        };

        if chosen.id == entry.version_id {
            // Already on the recommended version.
            continue;
        }

        // Sanity: only flag as an update if the picker's choice is newer than
        // what we have. Without this, a stale local `version_id` could be
        // "updated" to a now-removed older version. Modrinth's
        // `check_modpack_update` does the same comparison.
        let current_published = versions
            .iter()
            .find(|v| v.id == entry.version_id)
            .and_then(|v| v.date_published.as_deref());
        let chosen_published = chosen.date_published.as_deref();

        if let (Some(curr), Some(next)) = (current_published, chosen_published) {
            if next <= curr {
                continue;
            }
        }

        let filename = chosen
            .files
            .iter()
            .find(|f| f.primary)
            .or_else(|| chosen.files.first())
            .map(|f| f.filename.clone())
            .unwrap_or_default();

        updates.insert(
            entry.project_id.clone(),
            ModUpdate {
                project_id: entry.project_id.clone(),
                current_version_id: entry.version_id.clone(),
                latest_version_id: chosen.id.clone(),
                latest_version_number: chosen.version_number.clone(),
                latest_filename: filename,
                latest_published: chosen.date_published.clone(),
            },
        );
    }

    Ok(updates)
}

/// Apply a previously-detected update for a single project. Removes the old
/// file from disk, then runs the install flow (which downloads the new file,
/// rewrites `instance.json`, and walks required dependencies).
pub async fn apply_update(
    instance_id: &str,
    project_id: &str,
) -> Result<InstallResult, String> {
    // Re-read the instance to get the current ModEntry — important if the
    // user toggled `enabled` between detection and application.
    let instance_dir = paths::instances_dir().join(instance_id);
    let meta_path = instance_dir.join("instance.json");
    let raw = fs::read_to_string(&meta_path)
        .map_err(|e| format!("Read instance.json: {}", e))?;
    let instance: Instance = serde_json::from_str(&raw)
        .map_err(|e| format!("Parse instance.json: {}", e))?;

    let entry = instance
        .mods
        .iter()
        .find(|m| m.project_id == project_id)
        .ok_or_else(|| format!("Mod {} not in instance", project_id))?
        .clone();

    let was_enabled = entry.enabled;
    let category = entry.category.clone();

    // Remove the old file so the new download replaces it cleanly. We do NOT
    // edit instance.json yet — `install_mod` rewrites it as part of its flow,
    // overwriting our stale entry with the new version data.
    let folder = match category.as_str() {
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        "datapack" => "datapacks",
        _ => "mods",
    };
    let old_path = instance_dir
        .join(".minecraft")
        .join(folder)
        .join(&entry.filename);
    if old_path.exists() {
        if let Err(e) = fs::remove_file(&old_path) {
            // Not fatal — the new file will land in the same folder. Log it
            // so we can chase down stale entries if someone reports issues.
            tracing::warn!(
                "Couldn't remove old file {} during update: {}",
                old_path.display(),
                e
            );
        }
    }

    // The install flow expects the project to NOT already be in the mod list
    // (it dedups otherwise). Strip the old entry from instance.json so the
    // install path can append the fresh one with new version_id + filename.
    {
        let mut mutated = instance.clone();
        mutated.mods.retain(|m| m.project_id != project_id);
        let json = serde_json::to_string_pretty(&mutated)
            .map_err(|e| format!("Serialize instance.json: {}", e))?;
        fs::write(&meta_path, json)
            .map_err(|e| format!("Write instance.json: {}", e))?;
    }

    let mut result = mod_install::install_mod(
        instance_id,
        project_id,
        instance.loader.loader_type.as_str(),
        &instance.game_version,
        &category,
    )
    .await?;

    // Preserve the old `enabled` state: install always writes `enabled: true`,
    // but if the user had the old version disabled they probably want the new
    // version disabled too.
    if !was_enabled {
        let raw = fs::read_to_string(&meta_path)
            .map_err(|e| format!("Read instance.json: {}", e))?;
        let mut inst: Instance = serde_json::from_str(&raw)
            .map_err(|e| format!("Parse instance.json: {}", e))?;
        if let Some(m) = inst.mods.iter_mut().find(|m| m.project_id == project_id) {
            m.enabled = false;
            // Also rename the new file on disk to match.
            let new_path = instance_dir.join(".minecraft").join(folder).join(&m.filename);
            let disabled_path = new_path.with_file_name(format!("{}.disabled", m.filename));
            if new_path.exists() {
                if let Err(e) = fs::rename(&new_path, &disabled_path) {
                    tracing::warn!(
                        "Couldn't re-disable {} after update: {}",
                        new_path.display(),
                        e
                    );
                } else {
                    m.filename = format!("{}.disabled", m.filename);
                }
            }
        }
        let json = serde_json::to_string_pretty(&inst)
            .map_err(|e| format!("Serialize instance.json: {}", e))?;
        fs::write(&meta_path, json)
            .map_err(|e| format!("Write instance.json: {}", e))?;
        result.mod_entry.enabled = false;
    }

    Ok(result)
}
