//! Instance preparation service — downloads all files needed to launch an instance.
//!
//! Emits `install-progress` events with a SINGLE section (the instance name).
//! ALL downloads (game files + loader + Java + optional modpack content) are
//! combined into one batch with a unified file count for smooth 0→100% progress.
//!
//! If everything is already cached AND there is no extra work, no events are
//! emitted (popup never shows).

use crate::models::instance::Instance;
use crate::services::download::{DownloadTask, download_all, download_file, file_valid};
use crate::services::launch::{AssetIndex, ensure_natives, get_version_json, library_allowed, required_java_version};
use crate::util::paths;
use serde::Serialize;
use std::fs;
use std::future::Future;
use std::pin::Pin;
use tauri::Emitter;
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
pub struct InstallProgressPayload {
    /// Section identifier (always "game" — single unified section)
    pub section: String,
    /// Human-readable title (instance name)
    pub title: String,
    /// Human-readable status message
    pub message: String,
    /// 0.0 to 1.0 progress
    pub fraction: f64,
    /// Whether skipped (cached)
    pub skipped: bool,
}

/// Type alias for a "post-download" closure that can extract overrides, etc.
/// Runs after all downloads complete but before native extraction / final "Ready".
pub type PostAction =
    Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send>;

/// Prepare an instance with no extra tasks (used by custom-instance creation).
pub async fn prepare(
    instance: &Instance,
    window: Option<tauri::WebviewWindow>,
) -> Result<(), String> {
    prepare_with_extras(instance, Vec::new(), None, window).await
}

/// Prepare an instance, folding extra download tasks (e.g. modpack mod files)
/// into the unified batch. After all downloads complete, runs `post_action`
/// (e.g. extract overrides) before the final "Ready" emit.
///
/// One progress popup, one monotonic 0→100% bar, regardless of the source
/// (custom instance, Modrinth modpack, CurseForge import).
pub async fn prepare_with_extras(
    instance: &Instance,
    extra_tasks: Vec<DownloadTask>,
    post_action: Option<PostAction>,
    window: Option<tauri::WebviewWindow>,
) -> Result<(), String> {
    let instance_name = instance.name.clone();
    let win = window.clone();

    let emit = move |section: &str, title: &str, message: &str, fraction: f64, skipped: bool| {
        if let Some(ref w) = win {
            let _ = w.emit(
                "install-progress",
                InstallProgressPayload {
                    section: section.to_string(),
                    title: title.to_string(),
                    message: message.to_string(),
                    fraction,
                    skipped,
                },
            );
        }
    };

    let app_handle = window.as_ref().map(|w| w.app_handle().clone());

    // Show popup immediately while we fetch metadata
    emit("game", &instance_name, "Preparing...", 0.0, false);

    // === Determine what needs downloading ===
    let java_version = required_java_version(&instance.game_version);
    let java_dir = paths::java_dir();
    let install_dir = java_dir.join(format!("jdk-{}", java_version));
    let java_cached = install_dir.exists() && has_java_exe(&install_dir);

    // Fetch version metadata + loader-library list in parallel. These are
    // independent network calls; running them sequentially adds 200-800ms of
    // dead time before downloads can start.
    let (version, loader_tasks) = tokio::join!(
        get_version_json(&instance.game_version),
        collect_loader_tasks(instance),
    );
    let version = version?;

    // === Collect ALL download tasks into a single batch ===
    // Order is intentional: game files first (so the "first files" the user sees
    // downloading are the Minecraft instance files), then Java, then modpack mods.
    let mut all_tasks: Vec<DownloadTask> = Vec::new();

    // 1. Libraries
    let libs_dir = paths::libraries_dir();
    for lib in &version.libraries {
        if !library_allowed(lib) {
            continue;
        }
        if let Some(ref downloads) = lib.downloads {
            if let Some(ref artifact) = downloads.artifact {
                let dest = libs_dir.join(&artifact.path);
                all_tasks.push(DownloadTask {
                    url: artifact.url.clone(),
                    dest,
                    expected_sha1: artifact.sha1.clone(),
                    expected_size: artifact.size,
                });
            }
        }
    }

    // 2. Client jar
    if let Some(ref downloads) = version.downloads {
        if let Some(ref client) = downloads.client {
            let versions_dir = paths::data_dir().join("versions");
            let jar_path = versions_dir.join(format!("{}.jar", version.id));
            all_tasks.push(DownloadTask {
                url: client.url.clone(),
                dest: jar_path,
                expected_sha1: client.sha1.clone(),
                expected_size: client.size,
            });
        }
    }

    // 3. Assets
    if let Some(ref asset_info) = version.asset_index {
        let assets_dir = paths::assets_dir();
        let indexes_dir = assets_dir.join("indexes");
        let objects_dir = assets_dir.join("objects");
        let _ = fs::create_dir_all(&indexes_dir);
        let _ = fs::create_dir_all(&objects_dir);

        // Download asset index first (small file, needed to enumerate assets)
        let index_path = indexes_dir.join(format!("{}.json", asset_info.id));
        if !index_path.exists() {
            let task = DownloadTask {
                url: asset_info.url.clone(),
                dest: index_path.clone(),
                expected_sha1: asset_info.sha1.clone(),
                expected_size: asset_info.size,
            };
            download_file(&crate::util::http::HTTP, &task).await?;
        }

        // Parse asset index and add all asset objects to the batch
        if let Ok(content) = fs::read_to_string(&index_path) {
            if let Ok(index) = serde_json::from_str::<AssetIndex>(&content) {
                for (_name, obj) in &index.objects {
                    let prefix = &obj.hash[..2];
                    let dest = objects_dir.join(prefix).join(&obj.hash);
                    all_tasks.push(DownloadTask {
                        url: format!(
                            "https://resources.download.minecraft.net/{}/{}",
                            prefix, obj.hash
                        ),
                        dest,
                        expected_sha1: Some(obj.hash.clone()),
                        expected_size: Some(obj.size),
                    });
                }
            }
        }
    }

    // 4. Loader libraries (Fabric/Quilt) — already collected in parallel above
    all_tasks.extend(loader_tasks);

    // 5. Java runtime (as a download task — if not cached)
    let java_archive_path = java_dir.join(format!("jdk-{}{}", java_version, crate::util::platform::java_archive_ext()));
    if !java_cached {
        let adoptium_url = format!(
            "https://api.adoptium.net/v3/binary/latest/{}/ga/{}/{}/jre/hotspot/normal/eclipse",
            java_version, crate::util::platform::adoptium_os(), crate::util::platform::adoptium_arch()
        );
        all_tasks.push(DownloadTask {
            url: adoptium_url,
            dest: java_archive_path.clone(),
            expected_sha1: None,
            expected_size: None,
        });
    }

    // 6. Extra tasks (modpack mods, CurseForge mods, etc.) — added LAST so they
    // appear after game files in the file counter.
    let extras_count = extra_tasks.len();
    all_tasks.extend(extra_tasks);

    // === Filter out already-cached files ===
    // Run on a blocking thread because we may call fs::exists/metadata on
    // 1000+ paths (asset objects). Doing that on the async runtime stalls all
    // other tasks (including event emission) for the duration.
    let tasks_needing_download: Vec<DownloadTask> = tokio::task::spawn_blocking(move || {
        all_tasks
            .into_iter()
            .filter(|t| !file_valid(&t.dest, &t.expected_sha1, &t.expected_size))
            .collect()
    })
    .await
    .map_err(|e| format!("Filter task panicked: {}", e))?;

    let needs_download = !tasks_needing_download.is_empty();

    // Check if NeoForge/Forge installer needs to run
    let forge_needs_setup = matches!(
        &instance.loader.loader_type,
        crate::models::instance::LoaderType::Neoforge | crate::models::instance::LoaderType::Forge
    ) && instance.loader.version.is_some();

    let has_post_action = post_action.is_some();

    // If everything is cached and there's no extra work, close the popup and return
    if !needs_download && !forge_needs_setup && !has_post_action {
        emit("game", &instance_name, "Ready", 1.0, false);
        emit("done", "", "Already installed", 1.0, false);
        return Ok(());
    }

    // === Single unified download section ===
    let total = tasks_needing_download.len();
    let header = if extras_count > 0 {
        format!("Downloading {} files (game + content)", total)
    } else {
        format!("Downloading {} files", total)
    };
    emit("game", &instance_name, &header, 0.0, false);

    // Single download_all call — emits download-progress with monotonic completed/total
    if !tasks_needing_download.is_empty() {
        download_all(tasks_needing_download, app_handle.clone()).await?;
    }

    // === Post-download processing ===

    // Extract Java archive if we just downloaded it
    if !java_cached && java_archive_path.exists() {
        emit("game", &instance_name, "Extracting Java", 0.97, false);
        crate::util::platform::extract_java_archive(&java_archive_path, &install_dir)?;
        let _ = fs::remove_file(&java_archive_path);
    }

    // Extract natives
    emit("game", &instance_name, "Extracting natives", 0.98, false);
    ensure_natives(&version, &instance.id).await?;

    // Run any post action (e.g. extract modpack overrides)
    if let Some(action) = post_action {
        emit("game", &instance_name, "Extracting content", 0.985, false);
        action().await?;
    }

    // Loader post-processing
    match &instance.loader.loader_type {
        crate::models::instance::LoaderType::Fabric => {
            if let Some(ref ver) = instance.loader.version {
                crate::services::fabric::ensure_fabric_natives(
                    &instance.game_version,
                    ver,
                    &instance.id,
                )
                .await?;
            }
        }
        crate::models::instance::LoaderType::Neoforge => {
            if let Some(ref ver) = instance.loader.version {
                emit("game", &instance_name, "Running NeoForge installer", 0.99, false);
                crate::services::neoforge::ensure_neoforge_libraries(
                    &instance.game_version,
                    ver,
                    app_handle.as_ref(),
                    &instance_name,
                )
                .await?;
            }
        }
        crate::models::instance::LoaderType::Forge => {
            if let Some(ref ver) = instance.loader.version {
                emit("game", &instance_name, "Running Forge installer", 0.99, false);
                crate::services::neoforge::ensure_forge_libraries(
                    &instance.game_version,
                    ver,
                    app_handle.as_ref(),
                    &instance_name,
                )
                .await?;
            }
        }
        _ => {}
    }

    // Done
    emit("game", &instance_name, "Ready", 1.0, false);
    emit("done", "", "Installation complete", 1.0, false);
    Ok(())
}

/// Collect download tasks for loader libraries without downloading them.
async fn collect_loader_tasks(instance: &Instance) -> Vec<DownloadTask> {
    let mut tasks = Vec::new();

    match &instance.loader.loader_type {
        crate::models::instance::LoaderType::Fabric => {
            if let Some(ref ver) = instance.loader.version {
                if let Ok(profile) = crate::services::fabric::get_fabric_profile(&instance.game_version, ver).await {
                    let libs_dir = paths::libraries_dir();
                    for lib in &profile.libraries {
                        if let Some(rules) = &lib.rules {
                            if rules.iter().any(|r| r.action == "disallow") { continue; }
                        }
                        let base_url = match &lib.url {
                            Some(u) => u.as_str(),
                            None => continue,
                        };
                        if lib.natives.is_some() {
                            if let Some(natives_map) = &lib.natives {
                                if let Some(classifier) = natives_map.get(crate::util::platform::natives_map_key()) {
                                    let rel_path = maven_to_path_classified(&lib.name, classifier);
                                    let dest = libs_dir.join(&rel_path);
                                    let url = format!("{}{}", base_url, rel_path);
                                    tasks.push(DownloadTask { url, dest, expected_sha1: None, expected_size: None });
                                }
                            }
                            continue;
                        }
                        let rel_path = maven_to_path(&lib.name);
                        let dest = libs_dir.join(&rel_path);
                        let url = format!("{}{}", base_url, rel_path);
                        tasks.push(DownloadTask { url, dest, expected_sha1: None, expected_size: None });
                    }
                }
            }
        }
        crate::models::instance::LoaderType::Quilt => {
            if let Some(ref ver) = instance.loader.version {
                if let Ok(profile) = crate::services::quilt::get_quilt_profile(&instance.game_version, ver).await {
                    let libs_dir = paths::libraries_dir();
                    for lib in &profile.libraries {
                        let rel_path = maven_to_path(&lib.name);
                        let dest = libs_dir.join(&rel_path);
                        let url = format!("{}{}", lib.url, rel_path);
                        tasks.push(DownloadTask { url, dest, expected_sha1: None, expected_size: None });
                    }
                }
            }
        }
        _ => {}
    }

    tasks
}

/// Convert a Maven coordinate to a file path
fn maven_to_path(coordinate: &str) -> String {
    let parts: Vec<&str> = coordinate.split(':').collect();
    if parts.len() < 3 { return coordinate.to_string(); }
    let group = parts[0].replace('.', "/");
    let artifact = parts[1];
    let version = parts[2];
    format!("{}/{}/{}/{}-{}.jar", group, artifact, version, artifact, version)
}

/// Convert a Maven coordinate + classifier to a file path
fn maven_to_path_classified(coordinate: &str, classifier: &str) -> String {
    let parts: Vec<&str> = coordinate.split(':').collect();
    if parts.len() < 3 { return coordinate.to_string(); }
    let group = parts[0].replace('.', "/");
    let artifact = parts[1];
    let version = parts[2];
    format!("{}/{}/{}/{}-{}-{}.jar", group, artifact, version, artifact, version, classifier)
}

/// Check if a java executable exists in the directory (or nested subdirectory)
fn has_java_exe(dir: &std::path::Path) -> bool {
    let exe = crate::util::platform::java_exe_name();
    if dir.join("bin").join(exe).exists() { return true; }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.path().join("bin").join(exe).exists() { return true; }
        }
    }
    false
}
