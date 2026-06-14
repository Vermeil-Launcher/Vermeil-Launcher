use crate::models::instance::Instance;
use crate::services::download::{DownloadTask, download_all, download_file};
use crate::util::paths;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;

/// Payload for the `game-log` Tauri event. Carries the originating instance
/// ID alongside the log line so the frontend can route output into a
/// per-instance buffer — without it, switching to a different instance and
/// viewing its Logs tab would show another session's output.
#[derive(Debug, Clone, Serialize)]
struct GameLogPayload<'a> {
    #[serde(rename = "instanceId")]
    instance_id: &'a str,
    line: &'a str,
}

#[derive(Debug, Deserialize)]
pub struct VersionJson {
    pub id: String,
    #[serde(rename = "mainClass")]
    pub main_class: String,
    pub libraries: Vec<Library>,
    pub downloads: Option<VersionDownloads>,
    #[serde(rename = "assetIndex")]
    pub asset_index: Option<AssetIndexInfo>,
    pub arguments: Option<Arguments>,
    #[serde(rename = "minecraftArguments")]
    pub minecraft_arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct VersionDownloads {
    pub client: Option<DownloadInfo>,
}

#[derive(Debug, Deserialize)]
pub struct DownloadInfo {
    pub url: String,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct AssetIndexInfo {
    pub id: String,
    pub url: String,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct Arguments {
    pub game: Option<Vec<serde_json::Value>>,
    pub jvm: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
pub struct Library {
    pub downloads: Option<LibraryDownloads>,
    pub rules: Option<Vec<Rule>>,
    pub natives: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
pub struct LibraryDownloads {
    pub artifact: Option<LibraryArtifact>,
    pub classifiers: Option<std::collections::HashMap<String, LibraryArtifact>>,
}

#[derive(Debug, Deserialize)]
pub struct LibraryArtifact {
    pub path: String,
    pub url: String,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct Rule {
    pub action: String,
    pub os: Option<OsRule>,
}

#[derive(Debug, Deserialize)]
pub struct OsRule {
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AssetIndex {
    pub objects: std::collections::HashMap<String, AssetObject>,
    #[serde(default)]
    pub map_to_resources: bool,
    #[serde(default, rename = "virtual")]
    pub is_virtual: bool,
}

#[derive(Debug, Deserialize)]
pub struct AssetObject {
    pub hash: String,
    pub size: u64,
}

/// Check if a library rule allows it on the current OS
pub fn library_allowed(lib: &Library) -> bool {
    let rules = match &lib.rules {
        Some(r) => r,
        None => return true,
    };

    let current_os = crate::util::platform::os_name();
    let mut allowed = false;
    for rule in rules {
        let os_matches = match &rule.os {
            None => true,
            Some(os) => match &os.name {
                None => true,
                Some(name) => name == current_os,
            },
        };

        if os_matches {
            allowed = rule.action == "allow";
        }
    }
    allowed
}

/// Evaluate whether a set of rules allows an argument/library on the current platform.
/// Handles OS rules and feature rules.
fn rules_allow(rules: &[serde_json::Value], has_custom_resolution: bool) -> bool {
    // If no rules evaluate to anything, default is disallow
    let mut result = false;

    for rule in rules {
        let action = rule.get("action").and_then(|a| a.as_str()).unwrap_or("disallow");
        let is_allow = action == "allow";

        // Check OS rule
        let os_matches = if let Some(os) = rule.get("os") {
            let current_os = crate::util::platform::os_name();
            let name_matches = if let Some(name) = os.get("name").and_then(|n| n.as_str()) {
                name == current_os
            } else {
                true // No name specified = matches all
            };
            // Skip x86 arch rules (we're x64)
            let arch_matches = if let Some(arch) = os.get("arch").and_then(|a| a.as_str()) {
                arch != "x86" && arch != "arm"
            } else {
                true
            };
            name_matches && arch_matches
        } else {
            true // No OS rule = matches
        };

        // Check feature rules
        let features_match = if let Some(features) = rule.get("features") {
            let mut all_match = true;
            if let Some(demo) = features.get("is_demo_user").and_then(|v| v.as_bool()) {
                if demo { all_match = false; } // We never run in demo mode
            }
            if let Some(res) = features.get("has_custom_resolution").and_then(|v| v.as_bool()) {
                if res && !has_custom_resolution { all_match = false; }
            }
            if let Some(qp) = features.get("has_quick_plays_support").and_then(|v| v.as_bool()) {
                if qp { all_match = false; } // Not implemented
            }
            if let Some(qp) = features.get("is_quick_play_singleplayer").and_then(|v| v.as_bool()) {
                if qp { all_match = false; }
            }
            if let Some(qp) = features.get("is_quick_play_multiplayer").and_then(|v| v.as_bool()) {
                if qp { all_match = false; }
            }
            if let Some(qp) = features.get("is_quick_play_realms").and_then(|v| v.as_bool()) {
                if qp { all_match = false; }
            }
            all_match
        } else {
            true // No feature rule = matches
        };

        if os_matches && features_match {
            result = is_allow;
        }
    }

    result
}

/// Parse versioned arguments (from version.json `arguments.jvm` or `arguments.game`).
/// Handles both plain strings and ruled objects with OS/feature conditions.
fn parse_versioned_args(
    args: &[serde_json::Value],
    interpolate: &dyn Fn(&str) -> String,
    has_custom_resolution: bool,
) -> Vec<String> {
    let mut result = Vec::new();

    for arg in args {
        if let Some(s) = arg.as_str() {
            // Plain string argument — always included
            result.push(interpolate(s));
        } else if arg.is_object() {
            // Ruled argument — check rules first
            if let Some(rules) = arg.get("rules").and_then(|r| r.as_array()) {
                if !rules_allow(rules, has_custom_resolution) {
                    continue; // Rules don't allow this arg
                }
            }

            // Rules passed — extract value
            if let Some(value) = arg.get("value") {
                if let Some(s) = value.as_str() {
                    result.push(interpolate(s));
                } else if let Some(arr) = value.as_array() {
                    for v in arr {
                        if let Some(s) = v.as_str() {
                            result.push(interpolate(s));
                        }
                    }
                }
            }
        }
    }

    result
}

/// Fetch and cache the version JSON
pub async fn get_version_json(version_id: &str) -> Result<VersionJson, String> {
    let meta_dir = paths::meta_dir().join("versions");
    let version_path = meta_dir.join(format!("{}.json", version_id));

    // Use cached if exists
    if version_path.exists() {
        let content = fs::read_to_string(&version_path).map_err(|e| e.to_string())?;
        return serde_json::from_str(&content).map_err(|e| format!("Parse version JSON: {}", e));
    }

    // Fetch from manifest
    let manifest = crate::services::meta::get_version_manifest(false).await?;
    let version_entry = manifest.versions.iter()
        .find(|v| v.id == version_id)
        .ok_or_else(|| format!("Version {} not found in manifest", version_id))?;

    let resp = crate::util::http::HTTP.get(&version_entry.url)
        .send().await.map_err(|e| e.to_string())?;

    let text = resp.text().await.map_err(|e| e.to_string())?;

    // Cache it
    fs::create_dir_all(&meta_dir).map_err(|e| e.to_string())?;
    let _ = fs::write(&version_path, &text);

    serde_json::from_str(&text).map_err(|e| format!("Parse version JSON: {}", e))
}

/// Download all required libraries for a version
pub async fn ensure_libraries(version: &VersionJson, app: Option<tauri::AppHandle>) -> Result<Vec<PathBuf>, String> {
    let libs_dir = paths::libraries_dir();
    let mut tasks = Vec::new();
    let mut classpath = Vec::new();

    for lib in &version.libraries {
        if !library_allowed(lib) {
            continue;
        }

        if let Some(downloads) = &lib.downloads {
            if let Some(artifact) = &downloads.artifact {
                let dest = libs_dir.join(&artifact.path);
                classpath.push(dest.clone());

                tasks.push(DownloadTask {
                    url: artifact.url.clone(),
                    dest,
                    expected_sha1: artifact.sha1.clone(),
                    expected_size: artifact.size,
                });
            }
        }
    }

    if !tasks.is_empty() {
        download_all(tasks, app).await?;
    }

    Ok(classpath)
}

/// Download and extract native libraries (LWJGL .dll files) for the version
pub async fn ensure_natives(version: &VersionJson, instance_id: &str) -> Result<(), String> {
    let libs_dir = paths::libraries_dir();
    let natives_dir = paths::instances_dir().join(instance_id).join("natives");
    fs::create_dir_all(&natives_dir).map_err(|e| e.to_string())?;

    for lib in &version.libraries {
        if !library_allowed(lib) { continue; }

        // Check if this library has natives for the current platform
        let classifier_key = if let Some(natives_map) = &lib.natives {
            natives_map.get(crate::util::platform::natives_map_key()).cloned()
        } else {
            None
        };

        if let Some(key) = classifier_key {
            // Replace ${arch} placeholder
            let key = key.replace("${arch}", "64");

            if let Some(downloads) = &lib.downloads {
                if let Some(classifiers) = &downloads.classifiers {
                    if let Some(native_artifact) = classifiers.get(&key) {
                        let dest = libs_dir.join(&native_artifact.path);

                        // Download if not cached
                        if !dest.exists() {
                            let task = DownloadTask {
                                url: native_artifact.url.clone(),
                                dest: dest.clone(),
                                expected_sha1: native_artifact.sha1.clone(),
                                expected_size: native_artifact.size,
                            };
                            let _ = download_file(&crate::util::http::HTTP, &task).await;
                        }

                        // Extract .dll and .so files from the jar into natives dir
                        if dest.exists() {
                            if let Ok(file) = fs::File::open(&dest) {
                                if let Ok(mut archive) = zip::ZipArchive::new(file) {
                                    for i in 0..archive.len() {
                                        if let Ok(mut entry) = archive.by_index(i) {
                                            let name = entry.name().to_string();
                                            // Only extract .dll, .so, .dylib files (skip META-INF, etc.)
                                            if name.ends_with(".dll") || name.ends_with(".so") || name.ends_with(".dylib") {
                                                let out_path = natives_dir.join(
                                                    std::path::Path::new(&name).file_name().unwrap_or_default()
                                                );
                                                if !out_path.exists() {
                                                    if let Ok(mut outfile) = fs::File::create(&out_path) {
                                                        let _ = io::copy(&mut entry, &mut outfile);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

/// Download the client JAR
pub async fn ensure_client_jar(version: &VersionJson) -> Result<PathBuf, String> {
    let versions_dir = paths::data_dir().join("versions");
    let jar_path = versions_dir.join(format!("{}.jar", version.id));

    if jar_path.exists() {
        return Ok(jar_path);
    }

    let download = version.downloads.as_ref()
        .and_then(|d| d.client.as_ref())
        .ok_or("No client download info in version JSON")?;

    let task = DownloadTask {
        url: download.url.clone(),
        dest: jar_path.clone(),
        expected_sha1: download.sha1.clone(),
        expected_size: download.size,
    };

    crate::services::download::download_file(&crate::util::http::HTTP, &task).await?;

    Ok(jar_path)
}

/// Download asset index and all assets
pub async fn ensure_assets(version: &VersionJson, app: Option<tauri::AppHandle>) -> Result<String, String> {
    let asset_info = version.asset_index.as_ref()
        .ok_or("No asset index in version JSON")?;

    let assets_dir = paths::assets_dir();
    let indexes_dir = assets_dir.join("indexes");
    let objects_dir = assets_dir.join("objects");
    fs::create_dir_all(&indexes_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&objects_dir).map_err(|e| e.to_string())?;

    // Download asset index
    let index_path = indexes_dir.join(format!("{}.json", asset_info.id));
    if !index_path.exists() {
        let task = DownloadTask {
            url: asset_info.url.clone(),
            dest: index_path.clone(),
            expected_sha1: asset_info.sha1.clone(),
            expected_size: asset_info.size,
        };
        crate::services::download::download_file(&crate::util::http::HTTP, &task).await?;
    }

    // Parse asset index and download objects
    let content = fs::read_to_string(&index_path).map_err(|e| e.to_string())?;
    let index: AssetIndex = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let mut tasks = Vec::new();
    for (_name, obj) in &index.objects {
        let prefix = &obj.hash[..2];
        let dest = objects_dir.join(prefix).join(&obj.hash);

        if !dest.exists() {
            tasks.push(DownloadTask {
                url: format!("https://resources.download.minecraft.net/{}/{}", prefix, obj.hash),
                dest,
                expected_sha1: Some(obj.hash.clone()),
                expected_size: Some(obj.size),
            });
        }
    }

    if !tasks.is_empty() {
        download_all(tasks, app).await?;
    }

    // Handle legacy/virtual asset formats (old MC versions need files at specific paths)
    if index.map_to_resources || index.is_virtual {
        // Legacy: copy assets to <assets>/virtual/legacy/<path> or game dir resources/
        let virtual_dir = if index.is_virtual {
            assets_dir.join("virtual").join(&asset_info.id)
        } else {
            assets_dir.join("virtual").join("legacy")
        };

        for (name, obj) in &index.objects {
            let prefix = &obj.hash[..2];
            let src = objects_dir.join(prefix).join(&obj.hash);
            let dest = virtual_dir.join(name);

            if !dest.exists() && src.exists() {
                if let Some(parent) = dest.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::copy(&src, &dest);
            }
        }
    }

    Ok(asset_info.id.clone())
}

/// Determine which Java version is needed for a Minecraft version.
///
/// Mojang's actual matrix (sourced from the version manifests' `javaVersion`
/// field — see `https://launchermeta.mojang.com/mc/game/version_manifest_v2.json`):
///
/// | MC version       | Java required |
/// |------------------|---------------|
/// | ≤ 1.16.5         | Java 8        |
/// | 1.17, 1.17.1     | Java 16       |
/// | 1.18 – 1.20.4    | Java 17       |
/// | 1.20.5+, 1.21.x  | Java 21       |
/// | 26.x+            | Java 25       |
///
/// We map MC 1.17 → Java **17** (not 16) because Java is backward-compatible
/// per major release and Adoptium Temurin no longer ships LTS builds for 16.
/// MC 1.17 class files are version 60 (Java 16), which Java 17 happily loads.
/// This is the standard mapping modern launchers use.
pub fn required_java_version(mc_version: &str) -> u8 {
    let parts: Vec<&str> = mc_version.split('.').collect();

    // New versioning format: 26.1.2, 26.2, etc. (no leading "1.")
    // If first part is >= 26, it's the new format and requires Java 25
    if let Ok(major) = parts[0].parse::<u32>() {
        if major >= 26 {
            return 25; // MC 26.x+ requires Java 25
        }
    }

    // Old versioning format: 1.X.Y
    if parts.len() < 2 { return 21; }
    if parts[0] != "1" { return 25; } // Unknown format, assume latest

    let minor: u32 = parts[1].parse().unwrap_or(21);

    if minor >= 21 { 21 }      // 1.21+ needs Java 21
    else if minor >= 20 {
        // 1.20.5+ needs Java 21, earlier 1.20.x needs Java 17
        if parts.len() >= 3 {
            let patch: u32 = parts[2].parse().unwrap_or(0);
            if patch >= 5 { 21 } else { 17 }
        } else { 17 }
    }
    else if minor >= 17 { 17 } // 1.17–1.19 needs Java 17 (1.17's bytecode is
                               //   class-version 60 / Java 16, but Java 17 LTS
                               //   loads it fine and is what Adoptium ships)
    else { 8 }                 // 1.16 and below needs Java 8
}

/// Download Java from Adoptium if not already present
async fn ensure_java(mc_version: &str) -> Result<PathBuf, String> {
    ensure_java_public(mc_version).await
}

/// Public version of ensure_java for use from other services (e.g. neoforge installer)
pub async fn ensure_java_public(mc_version: &str) -> Result<PathBuf, String> {
    let java_version = required_java_version(mc_version);

    // Honor user-set Java path from Settings → Resources → Java if one is
    // configured for this major. This is the main entry point for "I want to
    // use my own JDK". Falls through to the auto-install flow below if the
    // configured path is gone or no override exists.
    if let Ok(settings) = crate::services::settings_service::load().await {
        if let Some(p) = crate::services::java::resolve_user_path(&settings.java_paths, java_version) {
            return Ok(p);
        }
    }

    let java_dir = paths::java_dir();
    let install_dir = java_dir.join(format!("jdk-{}", java_version));

    // Check if already downloaded
    let java_exe = install_dir.join("bin").join(crate::util::platform::java_exe_name());
    if java_exe.exists() {
        return Ok(java_exe);
    }

    // Also check if there's a nested directory (Adoptium extracts with a version folder)
    if install_dir.exists() {
        // Look for java executable in any subdirectory
        if let Ok(entries) = fs::read_dir(&install_dir) {
            for entry in entries.flatten() {
                let nested_exe = entry.path().join("bin").join(crate::util::platform::java_exe_name());
                if nested_exe.exists() {
                    return Ok(nested_exe);
                }
            }
        }
    }

    // Download from Adoptium
    tracing::debug!("Downloading Java {} from Adoptium...", java_version);

    let url = format!(
        "https://api.adoptium.net/v3/binary/latest/{}/ga/{}/{}/jre/hotspot/normal/eclipse",
        java_version, crate::util::platform::adoptium_os(), crate::util::platform::adoptium_arch()
    );

    let resp = crate::util::http::HTTP.get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to download Java: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Adoptium returned HTTP {}", resp.status()));
    }

    let bytes = resp.bytes().await.map_err(|e| format!("Read Java download: {}", e))?;

    // Save archive
    fs::create_dir_all(&java_dir).map_err(|e| e.to_string())?;
    let archive_path = java_dir.join(format!("jdk-{}{}", java_version, crate::util::platform::java_archive_ext()));
    fs::write(&archive_path, &bytes).map_err(|e| format!("Write archive: {}", e))?;

    // Extract archive
    crate::util::platform::extract_java_archive(&archive_path, &install_dir)?;

    // Clean up archive
    let _ = fs::remove_file(&archive_path);

    // Find java executable in extracted directory
    if let Ok(entries) = fs::read_dir(&install_dir) {
        for entry in entries.flatten() {
            let nested_exe = entry.path().join("bin").join(crate::util::platform::java_exe_name());
            if nested_exe.exists() {
                return Ok(nested_exe);
            }
        }
    }

    // Direct path
    if java_exe.exists() {
        return Ok(java_exe);
    }

    Err("Java downloaded but executable not found in extracted files".to_string())
}

/// Launch Minecraft for an instance
pub async fn launch(instance: &Instance, username: &str, uuid: &str, access_token: &str, window: Option<tauri::WebviewWindow>) -> Result<u32, String> {
    // Create log file early so the frontend poller can show progress
    let game_dir = paths::instances_dir().join(&instance.id).join(".minecraft");
    fs::create_dir_all(&game_dir).map_err(|e| e.to_string())?;
    let log_dir = game_dir.join("logs");
    fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    let log_path = log_dir.join("latest.log");

    // Clear previous log
    let _ = fs::write(&log_path, "");

    // 1. Get version JSON
    let version = get_version_json(&instance.game_version).await?;

    // 2. Ensure all vanilla files are downloaded (fallback if prepare wasn't run)
    let app_handle = window.as_ref().map(|w| w.app_handle().clone());
    let mut classpath_entries = ensure_libraries(&version, app_handle.clone()).await?;
    let client_jar = ensure_client_jar(&version).await?;
    let assets_id = ensure_assets(&version, app_handle).await?;
    ensure_natives(&version, &instance.id).await?;

    // For legacy/virtual assets, copy to instance's resources/ directory
    // (old MC versions look for sounds in <gameDir>/resources/)
    {
        let index_path = paths::assets_dir().join("indexes").join(format!("{}.json", &assets_id));
        if let Ok(content) = fs::read_to_string(&index_path) {
            let is_virtual = content.contains("\"virtual\"") && content.contains("true");
            let is_map_to_resources = content.contains("\"map_to_resources\"") && content.contains("true");

            if is_virtual || is_map_to_resources {
                // Determine where ensure_assets put the virtual files
                let virtual_dir = if is_virtual {
                    paths::assets_dir().join("virtual").join(&assets_id)
                } else {
                    // map_to_resources uses "legacy" as the virtual dir name
                    paths::assets_dir().join("virtual").join("legacy")
                };

                if virtual_dir.exists() {
                    let resources_dir = game_dir.join("resources");
                    // Always copy — check individual files, not directory existence
                    fn copy_recursive(src: &std::path::Path, dest: &std::path::Path) {
                        if let Ok(entries) = fs::read_dir(src) {
                            let _ = fs::create_dir_all(dest);
                            for entry in entries.flatten() {
                                let from = entry.path();
                                let to = dest.join(entry.file_name());
                                if from.is_dir() {
                                    copy_recursive(&from, &to);
                                } else if !to.exists() {
                                    let _ = fs::copy(&from, &to);
                                }
                            }
                        }
                    }
                    copy_recursive(&virtual_dir, &resources_dir);
                }
            }
        }
    }

    classpath_entries.push(client_jar);

    // 3. Find or download Java (do this BEFORE loader setup so NeoForge/Forge installer can reuse it)
    let java = ensure_java(&instance.game_version).await?;

    // 4. Handle mod loader
    let mut extra_jvm_args: Vec<String> = Vec::new();
    let mut extra_game_args: Vec<String> = Vec::new();

    let main_class = match &instance.loader.loader_type {
        crate::models::instance::LoaderType::Fabric => {
            if let Some(ref loader_version) = instance.loader.version {
                let result = crate::services::fabric::ensure_fabric_libraries(
                    &instance.game_version, loader_version,
                ).await;
                let (fabric_main, fabric_libs) = match result {
                    Ok(v) => v,
                    Err(e) => {
                        return Err(e);
                    }
                };
                if let Err(e) = crate::services::fabric::ensure_fabric_natives(
                    &instance.game_version, loader_version, &instance.id,
                ).await {
                    return Err(e);
                }

                // Deduplicate: if the loader provides a library with the same group:artifact
                // as a vanilla one, remove the vanilla version to avoid classpath conflicts.
                // This handles Legacy Fabric's LWJGL override (2.9.4+legacyfabric replaces 2.9.1).
                let loader_ga_keys: Vec<String> = crate::services::fabric::get_profile_library_keys(
                    &instance.game_version, loader_version,
                ).await.unwrap_or_default();

                if !loader_ga_keys.is_empty() {
                    classpath_entries.retain(|p| {
                        let s = p.to_string_lossy().replace('\\', "/");
                        // Check if any loader library has the same group/artifact path prefix
                        for key in &loader_ga_keys {
                            if s.contains(key.as_str()) {
                                return false; // Remove vanilla version, loader version takes precedence
                            }
                        }
                        true
                    });
                }

                let mut new_cp = fabric_libs;
                new_cp.extend(classpath_entries);
                classpath_entries = new_cp;
                fabric_main
            } else { version.main_class.clone() }
        }
        crate::models::instance::LoaderType::Quilt => {
            if let Some(ref loader_version) = instance.loader.version {
                let (quilt_main, quilt_libs) = crate::services::quilt::ensure_quilt_libraries(
                    &instance.game_version, loader_version,
                ).await?;
                let mut new_cp = quilt_libs;
                new_cp.extend(classpath_entries);
                classpath_entries = new_cp;
                quilt_main
            } else { version.main_class.clone() }
        }
        crate::models::instance::LoaderType::Neoforge => {
            if let Some(ref loader_version) = instance.loader.version {
                let (neo_main, neo_libs, neo_jvm, neo_game) = crate::services::neoforge::ensure_neoforge_libraries(
                    &instance.game_version, loader_version, None, &instance.name,
                ).await?;
                let mut new_cp = neo_libs;
                new_cp.extend(classpath_entries);
                // Deduplicate — NeoForge and vanilla share libraries, duplicates cause BootstrapLauncher crash
                let mut seen = std::collections::HashSet::new();
                new_cp.retain(|p| seen.insert(p.clone()));
                classpath_entries = new_cp;
                extra_jvm_args = neo_jvm;
                extra_game_args = neo_game;
                neo_main
            } else { version.main_class.clone() }
        }
        crate::models::instance::LoaderType::Forge => {
            if let Some(ref loader_version) = instance.loader.version {
                let (forge_main, forge_libs, forge_jvm, forge_game) = crate::services::neoforge::ensure_forge_libraries(
                    &instance.game_version, loader_version, None, &instance.name,
                ).await?;
                let mut new_cp = forge_libs;
                new_cp.extend(classpath_entries);
                // Deduplicate — same reason as NeoForge
                let mut seen = std::collections::HashSet::new();
                new_cp.retain(|p| seen.insert(p.clone()));
                classpath_entries = new_cp;
                extra_jvm_args = forge_jvm;
                extra_game_args = forge_game;
                forge_main
            } else { version.main_class.clone() }
        }
        _ => version.main_class.clone(),
    };

    tracing::info!("Launching {} with main class: {}", instance.name, main_class);

    // 5. Build classpath string
    let natives_dir = paths::instances_dir().join(&instance.id).join("natives");
    let cp_sep = crate::util::platform::classpath_separator();
    let classpath = classpath_entries.iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(cp_sep);

    // 6. Build JVM arguments — parse from version.json if available
    let mut jvm_args: Vec<String> = Vec::new();

    // Memory settings first (can be overridden by version args if needed)
    jvm_args.push(format!("-Xmx{}m", instance.java.memory_max_mb));
    jvm_args.push(format!("-Xms{}m", instance.java.memory_min_mb));

    // Parse JVM args from version.json (contains -Djava.library.path, -cp, native dirs, etc.)
    if let Some(ref arguments) = version.arguments {
        if let Some(ref jvm) = arguments.jvm {
            let natives_str = natives_dir.to_string_lossy().to_string();
            let libs_str = paths::libraries_dir().to_string_lossy().to_string();
            let cp = classpath.clone();
            let ver_id = version.id.clone();

            let parsed = parse_versioned_args(jvm, &|token: &str| {
                token
                    .replace("${natives_directory}", &natives_str)
                    .replace("${launcher_name}", crate::util::http::LAUNCHER_NAME)
                    .replace("${launcher_version}", crate::util::http::LAUNCHER_VERSION)
                    .replace("${classpath}", &cp)
                    .replace("${classpath_separator}", crate::util::platform::classpath_separator())
                    .replace("${library_directory}", &libs_str)
                    .replace("${version_name}", &ver_id)
            }, false);
            jvm_args.extend(parsed);
        } else {
            // No JVM args in version.json — use legacy fallback
            jvm_args.push(format!("-Djava.library.path={}", natives_dir.to_string_lossy()));
            jvm_args.push("-cp".to_string());
            jvm_args.push(classpath.clone());
        }
    } else {
        // Legacy version (pre-1.13) — no arguments block at all
        jvm_args.push(format!("-Djava.library.path={}", natives_dir.to_string_lossy()));
        jvm_args.push("-cp".to_string());
        jvm_args.push(classpath.clone());
    }

    // Add loader-specific JVM args (NeoForge/Forge module flags, --add-opens, etc.)
    for arg in &extra_jvm_args {
        let val = arg
            .replace("${library_directory}", &paths::libraries_dir().to_string_lossy())
            .replace("${classpath_separator}", crate::util::platform::classpath_separator())
            .replace("${version_name}", &instance.game_version);
        jvm_args.push(val);
    }

    // Add extra JVM args from instance config (user custom args)
    for arg in &instance.java.extra_args {
        if !arg.is_empty() {
            jvm_args.push(arg.clone());
        }
    }

    // 7. Build game arguments — parse from version.json with rules
    let game_dir = paths::instances_dir().join(&instance.id).join(".minecraft");
    // Always true — every instance has an explicit resolution configured (default 1280x720).
    // This enables the version.json feature-gated --width/--height arguments for modern versions.
    let has_custom_resolution = true;

    let assets_root = {
        let index_path = paths::assets_dir().join("indexes").join(format!("{}.json", &assets_id));
        let is_legacy = if let Ok(content) = fs::read_to_string(&index_path) {
            content.contains("\"virtual\"") && content.contains("true")
                || content.contains("\"map_to_resources\"") && content.contains("true")
        } else {
            false
        };
        if is_legacy {
            let virtual_dir = paths::assets_dir().join("virtual").join(&assets_id);
            if virtual_dir.exists() { virtual_dir } else { paths::assets_dir() }
        } else {
            paths::assets_dir()
        }
    };

    // Resolve window dimensions from global settings, falling back to
    // per-instance values (for backwards compat) and then hard defaults.
    let global_settings = crate::services::settings_service::load().await.ok();
    let global_vs = global_settings.as_ref().map(|s| &s.video_settings);
    let win_fullscreen = global_vs.and_then(|v| v.fullscreen).unwrap_or(instance.window.fullscreen);
    let win_maximized = global_vs.and_then(|v| v.start_maximized).unwrap_or(false);
    // If maximized is enabled (and not fullscreen), detect the launcher's
    // current monitor and use its size minus a margin for window chrome
    // (title bar) and the OS taskbar/menu bar. Minecraft's GLFW window
    // doesn't have a `--maximized` flag — passing absurd dimensions like
    // monitor*2 would push the window off-screen, since MC sizes the
    // window literally. This produces a window that fills the visible
    // work area without going out of bounds.
    let (win_width, win_height) = if win_maximized && !win_fullscreen {
        let monitor_size = window
            .as_ref()
            .and_then(|w| w.current_monitor().ok().flatten())
            .map(|m| {
                let s = m.size();
                (s.width, s.height)
            })
            .unwrap_or((1920, 1080));
        // Reserve space for window chrome + OS bars. ~80px on Windows
        // (Win11 taskbar ~48px + title bar ~32px), ~60px elsewhere.
        let chrome_h: u32 = if cfg!(windows) { 80 } else { 60 };
        let chrome_w: u32 = 0;
        (
            monitor_size.0.saturating_sub(chrome_w).max(640),
            monitor_size.1.saturating_sub(chrome_h).max(480),
        )
    } else {
        let w = global_vs.and_then(|v| v.window_width).unwrap_or(instance.window.width);
        let h = global_vs.and_then(|v| v.window_height).unwrap_or(instance.window.height);
        (w, h)
    };

    let mut game_args: Vec<String> = if let Some(ref arguments) = version.arguments {
        if let Some(ref game) = arguments.game {
            let game_dir_str = game_dir.to_string_lossy().to_string();
            let assets_root_str = assets_root.to_string_lossy().to_string();
            let assets_id_clone = assets_id.clone();
            let ver_id = version.id.clone();
            let uname = username.to_string();
            let uid = uuid.to_string();
            let token = access_token.to_string();
            let w = win_width.to_string();
            let h = win_height.to_string();
            let game_assets_str = paths::assets_dir().join("virtual").join(&assets_id).to_string_lossy().to_string();

            parse_versioned_args(game, &|t: &str| {
                t.replace("${auth_player_name}", &uname)
                    .replace("${version_name}", &ver_id)
                    .replace("${game_directory}", &game_dir_str)
                    .replace("${assets_root}", &assets_root_str)
                    .replace("${game_assets}", &game_assets_str)
                    .replace("${assets_index_name}", &assets_id_clone)
                    .replace("${auth_uuid}", &uid)
                    .replace("${auth_access_token}", &token)
                    .replace("${auth_session}", &token)
                    .replace("${user_type}", if token == "0" { "legacy" } else { "msa" })
                    .replace("${version_type}", "release")
                    .replace("${clientid}", "")
                    .replace("${auth_xuid}", "")
                    .replace("${user_properties}", "{}")
                    .replace("${resolution_width}", &w)
                    .replace("${resolution_height}", &h)
            }, has_custom_resolution)
        } else {
            Vec::new()
        }
    } else if let Some(ref legacy_args) = version.minecraft_arguments {
        // Legacy format (pre-1.13): split by space, interpolate each
        let game_dir_str = game_dir.to_string_lossy().to_string();
        let assets_root_str = assets_root.to_string_lossy().to_string();
        let game_assets_str = paths::assets_dir().join("virtual").join(&assets_id).to_string_lossy().to_string();

        legacy_args.split_whitespace().map(|arg| {
            arg.replace("${auth_player_name}", username)
                .replace("${version_name}", &version.id)
                .replace("${game_directory}", &game_dir_str)
                .replace("${assets_root}", &assets_root_str)
                .replace("${game_assets}", &game_assets_str)
                .replace("${assets_index_name}", &assets_id)
                .replace("${auth_uuid}", uuid)
                .replace("${auth_access_token}", access_token)
                .replace("${auth_session}", access_token)
                .replace("${user_type}", if access_token == "0" { "legacy" } else { "msa" })
                .replace("${version_type}", "release")
                .replace("${clientid}", "")
                .replace("${auth_xuid}", "")
                .replace("${user_properties}", "{}")
        }).collect()
    } else {
        Vec::new()
    };

    // Add loader-specific game args (NeoForge --launchTarget, Forge --fml.forgeVersion, etc.)
    for arg in &extra_game_args {
        game_args.push(arg.clone());
    }

    // Append explicit resolution args for legacy versions (pre-1.13) that don't
    // use the feature-rule system, and always append --fullscreen when enabled.
    // Modern versions (1.13+) get --width/--height from the version.json feature
    // rules when has_custom_resolution is true, but legacy versions need them
    // injected manually.
    if version.minecraft_arguments.is_some() && has_custom_resolution {
        game_args.push("--width".to_string());
        game_args.push(win_width.to_string());
        game_args.push("--height".to_string());
        game_args.push(win_height.to_string());
    }
    if win_fullscreen {
        game_args.push("--fullscreen".to_string());
    }

    // 7b. Patch options.txt with global video settings (if any are configured)
    {
        let options_path = game_dir.join("options.txt");
        if let Ok(settings) = crate::services::settings_service::load().await {
            let vs = &settings.video_settings;
            let has_overrides = vs.max_fps.is_some()
                || vs.vsync.is_some()
                || vs.view_bobbing.is_some()
                || vs.gui_scale.is_some()
                || vs.fov.is_some()
                || vs.fov_effects.is_some()
                || vs.master_volume.is_some()
                || vs.music_volume.is_some();

            if has_overrides {
                let mut content = fs::read_to_string(&options_path).unwrap_or_default();

                let patch = |content: &mut String, key: &str, value: &str| {
                    let line = format!("{}:{}", key, value);
                    let prefix = format!("{}:", key);
                    if let Some(pos) = content.find(&prefix) {
                        // Replace existing line
                        let end = content[pos..].find('\n').map(|i| pos + i).unwrap_or(content.len());
                        content.replace_range(pos..end, &line);
                    } else {
                        // Append new line
                        if !content.is_empty() && !content.ends_with('\n') {
                            content.push('\n');
                        }
                        content.push_str(&line);
                        content.push('\n');
                    }
                };

                if let Some(fps) = vs.max_fps {
                    patch(&mut content, "maxFps", &fps.to_string());
                }
                if let Some(vsync) = vs.vsync {
                    patch(&mut content, "enableVsync", if vsync { "true" } else { "false" });
                }
                if let Some(bob) = vs.view_bobbing {
                    patch(&mut content, "bobView", if bob { "true" } else { "false" });
                }
                if let Some(scale) = vs.gui_scale {
                    patch(&mut content, "guiScale", &scale.to_string());
                }
                if let Some(fov) = vs.fov {
                    patch(&mut content, "fov", &format!("{:.6}", fov));
                }
                if let Some(fov_effects) = vs.fov_effects {
                    patch(&mut content, "fovEffectScale", &format!("{:.6}", fov_effects));
                }
                if let Some(master) = vs.master_volume {
                    patch(&mut content, "soundCategory_master", &format!("{:.6}", master));
                }
                if let Some(music) = vs.music_volume {
                    patch(&mut content, "soundCategory_music", &format!("{:.6}", music));
                }

                let _ = fs::create_dir_all(&game_dir);
                if let Err(e) = fs::write(&options_path, &content) {
                    tracing::error!("Failed to write options.txt: {}", e);
                }
            }
        }

        // Always sync the fullscreen state from the global settings
        // so in-game toggles don't persist unexpectedly across launches.
        let options_path = game_dir.join("options.txt");
        let mut content = fs::read_to_string(&options_path).unwrap_or_default();
        let fullscreen_line = format!("fullscreen:{}", if win_fullscreen { "true" } else { "false" });
        let prefix = "fullscreen:";
        if let Some(pos) = content.find(prefix) {
            let end = content[pos..].find('\n').map(|i| pos + i).unwrap_or(content.len());
            content.replace_range(pos..end, &fullscreen_line);
        } else if !content.is_empty() {
            if !content.ends_with('\n') { content.push('\n'); }
            content.push_str(&fullscreen_line);
            content.push('\n');
        }
        let _ = fs::write(&options_path, &content);
    }

    // 8. Spawn process with stdout/stderr capture
    let mut cmd = Command::new(&java);
    cmd.args(&jvm_args);
    cmd.arg(&main_class);
    cmd.args(&game_args);
    cmd.current_dir(&game_dir);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // Prevent system Java options from interfering with instance settings
    cmd.env_remove("_JAVA_OPTIONS");

    // On Windows, Java is a console-subsystem binary so the OS would normally
    // pop a black console window for the lifetime of the JVM. Suppress it —
    // log capture is already wired up via the piped stdio above.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::services::java::CREATE_NO_WINDOW);
    }

    tracing::debug!("Launching with main class: {}", main_class);

    // Update last_played timestamp
    let meta_path = paths::instances_dir().join(&instance.id).join("instance.json");
    if let Ok(content) = fs::read_to_string(&meta_path) {
        if let Ok(mut inst_data) = serde_json::from_str::<Instance>(&content) {
            inst_data.last_played = Some(chrono::Utc::now().to_rfc3339());
            if let Ok(json) = serde_json::to_string_pretty(&inst_data) {
                let _ = fs::write(&meta_path, json);
            }
        }
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to launch: {}", e))?;
    let pid = child.id();

    // Spawn background task to capture logs and emit them as events
    let instance_id = instance.id.clone();
    let launch_time = std::time::Instant::now();

    tokio::spawn(async move {
        use std::io::{BufRead, BufReader, Write};
        use tauri::Emitter;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // Clone window + instance ID for each reader thread. Each `game-log`
        // event carries the instance ID so the frontend can route lines into
        // a per-instance buffer — without this, switching to a different
        // instance and viewing its Logs tab would show the wrong session's
        // output.
        let win_stdout = window.clone();
        let win_stderr = window.clone();
        let instance_id_stdout = instance_id.clone();
        let instance_id_stderr = instance_id.clone();

        // Spawn a thread to read stdout — emit each line as a game-log event
        let log_path_clone = log_path.clone();
        let stdout_handle = std::thread::spawn(move || {
            if let Some(out) = stdout {
                let mut lf = std::fs::OpenOptions::new().append(true).create(true).open(&log_path_clone).ok();
                let reader = BufReader::new(out);
                for line in reader.lines().flatten() {
                    // Write to log file for persistence
                    if let Some(ref mut f) = lf {
                        let _ = writeln!(f, "{}", line);
                    }
                    // Emit to frontend in real-time
                    if let Some(ref win) = win_stdout {
                        let _ = win.emit(
                            "game-log",
                            GameLogPayload {
                                instance_id: &instance_id_stdout,
                                line: &line,
                            },
                        );
                    }
                }
            }
        });

        // Spawn a thread to read stderr — same pattern
        let log_path_clone2 = log_path.clone();
        let stderr_handle = std::thread::spawn(move || {
            if let Some(err) = stderr {
                let mut lf = std::fs::OpenOptions::new().append(true).create(true).open(&log_path_clone2).ok();
                let reader = BufReader::new(err);
                for line in reader.lines().flatten() {
                    if let Some(ref mut f) = lf {
                        let _ = writeln!(f, "{}", line);
                    }
                    if let Some(ref win) = win_stderr {
                        let _ = win.emit(
                            "game-log",
                            GameLogPayload {
                                instance_id: &instance_id_stderr,
                                line: &line,
                            },
                        );
                    }
                }
            }
        });

        // Wait for process to exit
        let exit_status = child.wait();
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();

        // Check if game crashed (non-zero exit code)
        let crashed = match &exit_status {
            Ok(status) => !status.success(),
            Err(_) => true,
        };

        // Update total play time
        let elapsed_secs = launch_time.elapsed().as_secs();
        let meta_path = paths::instances_dir().join(&instance_id).join("instance.json");
        if let Ok(content) = std::fs::read_to_string(&meta_path) {
            if let Ok(mut inst_data) = serde_json::from_str::<Instance>(&content) {
                inst_data.total_play_seconds += elapsed_secs;
                if let Ok(json) = serde_json::to_string_pretty(&inst_data) {
                    let _ = std::fs::write(&meta_path, json);
                }
            }
        }

        // Game exited — reset Discord RPC to idle
        crate::services::discord::set_stopped();

        // Clear the global PID tracker so stop_instance knows nothing is running.
        crate::commands::launch::GAME_PID.store(0, std::sync::atomic::Ordering::SeqCst);

        // If the user clicked "Stop", treat any non-zero exit code as intentional
        // rather than a crash. The flag is consumed (set to false) so subsequent
        // natural crashes are still detected.
        let user_stopped = crate::commands::launch::take_user_stopped();

        // Game exited — restore window and notify frontend
        if let Some(win) = window {
            let _ = win.show();
            let _ = win.set_focus();
            if crashed && !user_stopped {
                let crash_dir = paths::instances_dir()
                    .join(&instance_id)
                    .join(".minecraft")
                    .join("crash-reports");
                let crash_report = if crash_dir.exists() {
                    std::fs::read_dir(&crash_dir).ok()
                        .and_then(|entries| {
                            entries.flatten()
                                .filter(|e| e.path().extension().map(|ext| ext == "txt").unwrap_or(false))
                                .max_by_key(|e| e.metadata().ok().and_then(|m| m.modified().ok()))
                                .map(|e| e.path().to_string_lossy().to_string())
                        })
                } else { None };
                let _ = win.emit("game-crashed", crash_report);
            } else {
                let _ = win.emit("game-exited", ());
            }
        }
    });

    Ok(pid)
}
