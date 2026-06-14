use crate::services::download::{DownloadTask, download_all, download_file};
use crate::util::paths;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const NEOFORGE_MAVEN: &str = "https://maven.neoforged.net/releases";
const FORGE_MAVEN: &str = "https://maven.minecraftforge.net";

/// Maven coordinate to file path
fn maven_to_path(coordinate: &str) -> String {
    let parts: Vec<&str> = coordinate.split(':').collect();
    if parts.len() < 3 { return coordinate.to_string(); }
    let group = parts[0].replace('.', "/");
    let artifact = parts[1];
    let version = parts[2];

    // Handle classifier with optional extension (e.g. "name@zip" or "classifier@ext")
    let (last, ext) = if parts.len() >= 4 {
        let p = parts[3];
        if let Some(idx) = p.find('@') {
            (Some(&p[..idx]), &p[idx + 1..])
        } else {
            (Some(p), "jar")
        }
    } else {
        // version may also contain @ext
        let v_parts: Vec<&str> = version.split('@').collect();
        if v_parts.len() == 2 {
            return format!("{}/{}/{}/{}-{}.{}", group, artifact, v_parts[0], artifact, v_parts[0], v_parts[1]);
        }
        (None, "jar")
    };

    let actual_version = version.split('@').next().unwrap_or(version);

    if let Some(classifier) = last {
        format!("{}/{}/{}/{}-{}-{}.{}", group, artifact, actual_version, artifact, actual_version, classifier, ext)
    } else {
        format!("{}/{}/{}/{}-{}.{}", group, artifact, actual_version, artifact, actual_version, ext)
    }
}

/// Emit a progress event with the current installer phase. Used by the
/// streaming-stdout reader so the UI shows the actual processor name
/// instead of sitting frozen at "Running NeoForge installer".
fn emit_phase(app: Option<&tauri::AppHandle>, instance_name: &str, message: &str) {
    if let Some(handle) = app {
        let _ = handle.emit(
            "install-progress",
            crate::services::prepare::InstallProgressPayload {
                section: "game".to_string(),
                title: instance_name.to_string(),
                message: message.to_string(),
                fraction: 0.99,
                skipped: false,
            },
        );
    }
}

/// Best-effort phase mapping from a single line of installer stdout.
///
/// The Forge / NeoForge installer logs each step it's about to take. We
/// don't try to parse every variant — just match a few high-signal
/// keywords and translate them to user-friendly progress text. Lines
/// that don't match return `None` and we keep the previous phase up.
fn classify_installer_line(line: &str) -> Option<&'static str> {
    let lower = line.to_lowercase();
    if lower.contains("downloading") && lower.contains("librar") {
        Some("Downloading loader libraries")
    } else if lower.contains("considering library") {
        Some("Resolving loader libraries")
    } else if lower.contains("binarypatcher") {
        Some("Patching client (BinaryPatcher)")
    } else if lower.contains("jarsplitter") {
        Some("Splitting client jar (JarSplitter)")
    } else if lower.contains("specialsource") {
        Some("Remapping client (SpecialSource)")
    } else if lower.contains("mergemappings") || lower.contains("merge mappings") {
        Some("Merging mappings")
    } else if lower.contains("processor")
        && (lower.contains("running") || lower.contains("execute"))
    {
        Some("Running loader processor")
    } else if lower.contains("installing client") {
        Some("Installing client")
    } else if lower.contains("extracting") {
        Some("Extracting installer payload")
    } else {
        None
    }
}

/// Run the Forge/NeoForge installer JAR in headless client-install mode.
/// This makes the installer perform all processor steps itself (BinaryPatcher, JarSplitter, etc).
/// For old Forge (pre-1.13), reads install_profile.json from the jar directly.
///
/// `app` is used to stream phase updates into the UI's install progress
/// popup. `instance_name` is the title shown next to the phase text. Both
/// are optional — if not supplied the install runs silently as before.
async fn run_installer_headless(
    installer_path: &Path,
    instance_dir: &Path,
    java_exe: &Path,
    app: Option<&tauri::AppHandle>,
    instance_name: &str,
) -> Result<(), String> {
    // The Forge/NeoForge installer expects a launcher_profiles.json to exist in its target dir.
    let stub = instance_dir.join("launcher_profiles.json");
    if !stub.exists() {
        fs::create_dir_all(instance_dir).map_err(|e| format!("Create instance dir: {}", e))?;
        let mut f = fs::File::create(&stub).map_err(|e| format!("Create stub launcher_profiles: {}", e))?;
        f.write_all(b"{\"profiles\":{},\"settings\":{},\"version\":3}")
            .map_err(|e| format!("Write stub: {}", e))?;
    }

    tracing::debug!("Running installer headless: {}", installer_path.display());

    // Try modern mode first (--installClient).
    //
    // We use `tokio::process::Command::spawn` (not `output`) so we can
    // stream the installer's stdout line-by-line into the progress popup
    // in real time. Without this the UI shows a single "Running installer"
    // string for the entire 30-60s install and the user thinks the app
    // hung. Stderr is still buffered for the error path.
    emit_phase(app, instance_name, "Starting loader installer");

    let mut cmd = Command::new(java_exe);
    cmd.arg("-jar")
        .arg(installer_path)
        .arg("--installClient")
        .arg(instance_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Hide the console window the JVM would otherwise spawn on Windows.
    // `tokio::process::Command` provides `creation_flags` directly on
    // Windows targets without needing the `CommandExt` import.
    #[cfg(windows)]
    {
        cmd.creation_flags(crate::services::java::CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Spawn installer: {}", e))?;

    // Capture stdout for phase classification + a buffered tail in case the
    // installer fails. We keep the last ~40 stdout lines around so the error
    // message has context, mirroring the previous `output()` behavior.
    let mut tail: Vec<String> = Vec::with_capacity(40);

    if let Some(stdout) = child.stdout.take() {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(phase) = classify_installer_line(&line) {
                emit_phase(app, instance_name, phase);
            }
            tracing::trace!("installer stdout: {}", line);
            tail.push(line);
            if tail.len() > 40 {
                tail.remove(0);
            }
        }
    }

    // Now wait for the process to exit and collect the exit status + stderr.
    let stderr_buf = if let Some(mut stderr) = child.stderr.take() {
        let mut buf = String::new();
        let _ = tokio::io::AsyncReadExt::read_to_string(&mut stderr, &mut buf).await;
        buf
    } else {
        String::new()
    };

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Wait for installer: {}", e))?;

    if status.success() {
        emit_phase(app, instance_name, "Loader installer finished");
        return Ok(());
    }

    // If the installer doesn't recognize --installClient, it's old Forge.
    // For old Forge, we extract install_profile.json from the jar and write it
    // as a version JSON so the rest of the pipeline can use it.
    if stderr_buf.contains("not a recognized option") || stderr_buf.contains("installClient") {
        tracing::debug!("Old Forge installer detected, extracting profile from jar");
        emit_phase(app, instance_name, "Reading legacy Forge profile");
        extract_old_forge_profile(installer_path, instance_dir)?;
        return Ok(());
    }

    Err(format!(
        "Installer failed (exit {}):\nstdout (tail): {}\nstderr: {}",
        status,
        tail.join("\n"),
        stderr_buf.lines().take(20).collect::<Vec<_>>().join("\n")
    ))
}

/// Extract the install_profile.json from an old Forge installer jar and convert
/// its versionInfo into a version JSON that our pipeline can use.
fn extract_old_forge_profile(installer_path: &Path, instance_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(installer_path).map_err(|e| format!("Open installer: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Open zip: {}", e))?;

    // Read install_profile.json from the jar
    let profile_json = {
        let mut entry = archive.by_name("install_profile.json")
            .map_err(|e| format!("No install_profile.json in installer: {}", e))?;
        let mut content = String::new();
        std::io::Read::read_to_string(&mut entry, &mut content)
            .map_err(|e| format!("Read install_profile.json: {}", e))?;
        content
    };

    let profile: serde_json::Value = serde_json::from_str(&profile_json)
        .map_err(|e| format!("Parse install_profile.json: {}", e))?;

    // The old format has "versionInfo" which is essentially a version JSON
    let version_info = profile.get("versionInfo")
        .ok_or("No versionInfo in install_profile.json")?;

    // Get the version ID
    let version_id = version_info.get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("forge");

    // Write it as a version JSON in the versions directory
    let versions_dir = instance_dir.join("versions").join(version_id);
    fs::create_dir_all(&versions_dir).map_err(|e| format!("Create versions dir: {}", e))?;

    let version_path = versions_dir.join(format!("{}.json", version_id));
    let json_str = serde_json::to_string_pretty(version_info)
        .map_err(|e| format!("Serialize version info: {}", e))?;
    fs::write(&version_path, json_str).map_err(|e| format!("Write version json: {}", e))?;

    // Also extract the universal jar from the installer if present
    // Old installers contain the forge universal jar inside
    let install_info = profile.get("install");
    if let Some(info) = install_info {
        if let Some(file_path) = info.get("filePath").and_then(|v| v.as_str()) {
            // Try to extract the universal jar
            if let Ok(mut jar_entry) = archive.by_name(file_path) {
                let libs_dir = paths::libraries_dir();
                // Determine the library path from the "path" field
                if let Some(maven_path) = info.get("path").and_then(|v| v.as_str()) {
                    let rel_path = maven_to_path(maven_path);
                    let dest = libs_dir.join(&rel_path);
                    if !dest.exists() {
                        if let Some(parent) = dest.parent() {
                            let _ = fs::create_dir_all(parent);
                        }
                        let mut outfile = fs::File::create(&dest)
                            .map_err(|e| format!("Create universal jar: {}", e))?;
                        std::io::copy(&mut jar_entry, &mut outfile)
                            .map_err(|e| format!("Extract universal jar: {}", e))?;
                    }
                }
            }
        }
    }

    Ok(())
}

/// Find the version.json the installer wrote into instance_dir/versions/<id>/<id>.json
/// Prefers the loader-specific version (not vanilla) by checking for inheritsFrom field
fn find_version_json(instance_dir: &Path) -> Result<(String, serde_json::Value), String> {
    let versions_dir = instance_dir.join("versions");
    if !versions_dir.exists() {
        return Err("Installer did not create versions/ directory".to_string());
    }

    let entries = fs::read_dir(&versions_dir)
        .map_err(|e| format!("Read versions/: {}", e))?;

    let mut candidates: Vec<(String, serde_json::Value)> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        let id = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let json_path = path.join(format!("{}.json", id));
        if json_path.exists() {
            if let Ok(content) = fs::read_to_string(&json_path) {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                    candidates.push((id, parsed));
                }
            }
        }
    }

    // Prefer the version that has inheritsFrom (that's the loader version, not vanilla)
    if let Some(loader_ver) = candidates.iter().find(|(_, v)| v.get("inheritsFrom").is_some()) {
        return Ok(loader_ver.clone());
    }

    // Fallback to any version found
    candidates.into_iter().next()
        .ok_or("No version.json found in instance versions/ directory".to_string())
}

/// After the installer runs, libraries are at <instance>/libraries.
/// We MOVE them to the shared libraries dir to avoid duplication across instances.
fn migrate_installer_libraries(instance_dir: &Path) -> Result<(), String> {
    let src = instance_dir.join("libraries");
    if !src.exists() { return Ok(()); }

    let dest = paths::libraries_dir();
    fs::create_dir_all(&dest).map_err(|e| format!("Create libs dir: {}", e))?;

    copy_dir_merge(&src, &dest)?;
    let _ = fs::remove_dir_all(&src);
    Ok(())
}

fn copy_dir_merge(src: &Path, dest: &Path) -> Result<(), String> {
    if !src.is_dir() { return Ok(()); }
    fs::create_dir_all(dest).map_err(|e| format!("Create dir: {}", e))?;

    for entry in fs::read_dir(src).map_err(|e| format!("Read dir: {}", e))?.flatten() {
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_dir_merge(&from, &to)?;
        } else if !to.exists() {
            fs::copy(&from, &to).map_err(|e| format!("Copy file: {}", e))?;
        }
    }
    Ok(())
}

/// Resolve all libraries listed in the installer's version.json to actual paths,
/// downloading any that aren't yet in the shared libraries dir.
///
/// **Concurrency:** all missing libraries are batched into a single
/// `download_all` call. Vanilla / Fabric / Quilt all use the parallel
/// batcher already; Forge / NeoForge previously didn't, which made the
/// post-installer "verify libs" pass several times slower than it needed
/// to be. Routing through the same batcher means Forge benefits from the
/// `concurrent_downloads` setting (default 8) like every other source.
async fn resolve_libraries(
    version_json: &serde_json::Value,
    app: Option<&tauri::AppHandle>,
) -> Result<Vec<PathBuf>, String> {
    let libs_dir = paths::libraries_dir();
    let mut paths_out = Vec::new();
    let mut tasks: Vec<DownloadTask> = Vec::new();

    let libraries = match version_json.get("libraries").and_then(|v| v.as_array()) {
        Some(l) => l,
        None => return Ok(paths_out),
    };

    for lib in libraries {
        // Skip libraries with natives (they're handled by ensure_natives in launch.rs)
        if lib.get("natives").is_some() { continue; }

        if let Some(artifact) = lib.get("downloads").and_then(|d| d.get("artifact")) {
            // Modern format: has downloads.artifact with path and url
            let path = artifact.get("path").and_then(|p| p.as_str()).unwrap_or("");
            if path.is_empty() { continue; }

            let dest = libs_dir.join(path);
            if !dest.exists() {
                if let Some(url) = artifact.get("url").and_then(|u| u.as_str()) {
                    if !url.is_empty() {
                        tasks.push(DownloadTask {
                            url: url.to_string(),
                            dest: dest.clone(),
                            expected_sha1: artifact.get("sha1").and_then(|s| s.as_str()).map(|s| s.to_string()),
                            expected_size: artifact.get("size").and_then(|s| s.as_u64()),
                        });
                    }
                }
            }
            paths_out.push(dest);
        } else if let Some(name) = lib.get("name").and_then(|n| n.as_str()) {
            // Old format: has name and optional url (Maven base URL)
            let rel_path = maven_to_path(name);
            let dest = libs_dir.join(&rel_path);

            if !dest.exists() {
                // Determine the download URL
                let base_url = lib.get("url")
                    .and_then(|u| u.as_str())
                    .unwrap_or("https://libraries.minecraft.net/");

                // Normalize: ensure base URL ends with /
                let base = if base_url.ends_with('/') {
                    base_url.to_string()
                } else {
                    format!("{}/", base_url)
                };

                // Replace http:// with https:// for security
                let base = base.replace("http://", "https://");

                let url = format!("{}{}", base, rel_path);
                tasks.push(DownloadTask {
                    url,
                    dest: dest.clone(),
                    expected_sha1: None,
                    expected_size: None,
                });
            }

            paths_out.push(dest);
        }
    }

    // Single parallel batch for everything that's missing. The batch
    // honors the user's `concurrent_downloads` setting and emits the same
    // `download-progress` events the vanilla flow uses, so the popup
    // shows real progress instead of a frozen percentage.
    if !tasks.is_empty() {
        download_all(tasks, app.cloned()).await?;
    }

    // Filter out anything that still doesn't exist on disk (download
    // failures fall through silently here so the installer can decide
    // whether the missing lib is actually required for launch).
    paths_out.retain(|p| p.exists());

    Ok(paths_out)
}

/// Run the Forge/NeoForge installer if not already done for this instance.
/// Returns (main_class, classpath libs, extra JVM args, extra game args)
async fn ensure_installer_ran(
    installer_url: &str,
    instance_dir: &Path,
    java_exe: &Path,
    marker_name: &str,
    app: Option<&tauri::AppHandle>,
    instance_name: &str,
) -> Result<(String, Vec<PathBuf>, Vec<String>, Vec<String>), String> {
    let marker = instance_dir.join(format!(".{}-installed", marker_name));

    if !marker.exists() {
        // Download installer to a shared cache so multiple instances using
        // the same loader version don't re-download the 15-40MB JAR.
        let cache_dir = paths::data_dir().join("cache").join("installers");
        fs::create_dir_all(&cache_dir).map_err(|e| format!("Create installer cache dir: {}", e))?;
        // Use the installer URL's filename as the cache key (e.g. "neoforge-21.4.148-installer.jar")
        let cache_filename = installer_url
            .rsplit('/')
            .next()
            .unwrap_or("loader-installer.jar")
            .to_string();
        let cached_installer = cache_dir.join(&cache_filename);

        if !cached_installer.exists() {
            let task = DownloadTask {
                url: installer_url.to_string(),
                dest: cached_installer.clone(),
                expected_sha1: None,
                expected_size: None,
            };
            download_file(&crate::util::http::HTTP, &task).await?;
        } else {
            tracing::info!("Using cached installer: {}", cached_installer.display());
        }

        // Copy to instance dir for the installer to use (it writes files
        // relative to its own directory)
        let installer_path = instance_dir.join("loader-installer.jar");
        fs::copy(&cached_installer, &installer_path)
            .map_err(|e| format!("Copy cached installer: {}", e))?;

        // The installer needs the vanilla client jar in versions/<mc_version>/<mc_version>.jar
        // Copy it from our shared versions cache if available
        let versions_dir = instance_dir.join("versions");
        fs::create_dir_all(&versions_dir).map_err(|e| format!("Create versions dir: {}", e))?;

        // Run it headless — streams installer phases into the progress UI
        // through the `app` handle (or runs silent if `app` is `None`).
        run_installer_headless(&installer_path, instance_dir, java_exe, app, instance_name).await?;

        // Move libraries to shared dir
        migrate_installer_libraries(instance_dir)?;

        // Cleanup installer jar
        let _ = fs::remove_file(&installer_path);

        // Mark as done
        let _ = fs::write(&marker, "");
    }

    // Read the version.json the installer produced
    let (_id, version_json) = find_version_json(instance_dir)?;

    let main_class = version_json.get("mainClass")
        .and_then(|v| v.as_str())
        .ok_or("No mainClass in installer version.json")?
        .to_string();

    emit_phase(app, instance_name, "Verifying loader libraries");
    let libs = resolve_libraries(&version_json, app).await?;

    // JVM args
    let mut jvm_args = Vec::new();
    if let Some(args) = version_json.get("arguments").and_then(|a| a.get("jvm")).and_then(|j| j.as_array()) {
        for arg in args {
            if let Some(s) = arg.as_str() {
                jvm_args.push(s.to_string());
            }
        }
    }

    // Game args — handle both modern (arguments.game array) and old (minecraftArguments string) formats
    let mut game_args = Vec::new();
    if let Some(args) = version_json.get("arguments").and_then(|a| a.get("game")).and_then(|g| g.as_array()) {
        for arg in args {
            if let Some(s) = arg.as_str() {
                game_args.push(s.to_string());
            }
        }
    } else if let Some(mc_args) = version_json.get("minecraftArguments").and_then(|v| v.as_str()) {
        // Old format: extract only the --tweakClass arguments (the rest are vanilla args
        // that launch.rs already provides via build_game_args)
        let parts: Vec<&str> = mc_args.split_whitespace().collect();
        let mut i = 0;
        while i < parts.len() {
            if parts[i] == "--tweakClass" && i + 1 < parts.len() {
                game_args.push("--tweakClass".to_string());
                game_args.push(parts[i + 1].to_string());
                i += 2;
            } else {
                i += 1;
            }
        }
    }

    Ok((main_class, libs, jvm_args, game_args))
}

/// Public: ensure NeoForge libraries and processor outputs are ready.
///
/// `app` and `instance_name` thread the live AppHandle through the install
/// flow so we can stream phase updates ("Patching client", "Splitting client
/// jar", etc.) into the progress popup instead of leaving it stuck at
/// "Running NeoForge installer" for the duration. Both are optional —
/// callers from non-UI paths can pass `None`/`""` and the install runs
/// silent.
pub async fn ensure_neoforge_libraries(
    _game_version: &str,
    loader_version: &str,
    app: Option<&tauri::AppHandle>,
    instance_name: &str,
) -> Result<(String, Vec<PathBuf>, Vec<String>, Vec<String>), String> {
    let installer_url = format!(
        "{}/net/neoforged/neoforge/{}/neoforge-{}-installer.jar",
        NEOFORGE_MAVEN, loader_version, loader_version
    );

    // We run the installer with the instance's .minecraft as the target.
    // For now, use a temporary scratch dir per instance for the installer to operate in.
    // The instance ID isn't easily available here; the instance_dir comes from launch.rs
    // through a per-call context. To keep this simple we reuse a scratch under data/.
    let scratch = paths::data_dir().join("loader-scratch").join(format!("neoforge-{}", loader_version));

    // Ensure Java is available (uses MC 1.21+ Java 21 by default for modern NeoForge)
    let java_exe = ensure_java_for_loader().await?;

    ensure_installer_ran(&installer_url, &scratch, &java_exe, "neoforge", app, instance_name).await
}

/// Public: ensure Forge libraries and processor outputs are ready.
pub async fn ensure_forge_libraries(
    game_version: &str,
    loader_version: &str,
    app: Option<&tauri::AppHandle>,
    instance_name: &str,
) -> Result<(String, Vec<PathBuf>, Vec<String>, Vec<String>), String> {
    // The Forge maven uses the full coord `{game_version}-{forge_version}` (e.g. `1.20.1-47.4.10`).
    // Custom instances pass that full string, but Modrinth/CurseForge modpack manifests give just
    // the forge-side number (`47.4.10` / `forge-47.4.10`). Normalize so all sources work.
    //
    // The version from `get_forge_versions` may already be in legacy format with the MC version
    // repeated at the end (e.g. `1.1-1.3.2.1-1.1`). We detect that to avoid double-suffixing.
    let full_version = if loader_version.starts_with(&format!("{}-", game_version)) {
        // Already prefixed. Strip a trailing `-{game_version}` if present (legacy format from
        // the Maven metadata) to get the canonical `{mc}-{forge}` form for the standard URL.
        let suffix = format!("-{}", game_version);
        if loader_version.ends_with(&suffix) && loader_version.len() > suffix.len() + game_version.len() + 1 {
            // It's something like "1.8.9-11.15.1.2318-1.8.9" → strip to "1.8.9-11.15.1.2318"
            loader_version[..loader_version.len() - suffix.len()].to_string()
        } else {
            loader_version.to_string()
        }
    } else {
        format!("{}-{}", game_version, loader_version)
    };

    // Try the standard URL first (works for Forge 1.13+).
    // Old Forge (pre-1.13) uses a legacy format with the MC version repeated at the end:
    // e.g. `forge-1.8.9-11.15.1.2318-1.8.9-installer.jar` instead of
    //       `forge-1.8.9-11.15.1.2318-installer.jar`.
    // We probe with a HEAD request and fall back to the legacy format on 404.
    let standard_url = format!(
        "{}/net/minecraftforge/forge/{}/forge-{}-installer.jar",
        FORGE_MAVEN, full_version, full_version
    );

    let installer_url = match crate::util::http::HTTP.head(&standard_url).send().await {
        Ok(resp) if resp.status().is_success() => standard_url,
        _ => {
            // Legacy format: {mc}-{forge}-{mc} (e.g. 1.8.9-11.15.1.2318-1.8.9)
            let legacy_version = format!("{}-{}", full_version, game_version);
            let legacy_url = format!(
                "{}/net/minecraftforge/forge/{}/forge-{}-installer.jar",
                FORGE_MAVEN, legacy_version, legacy_version
            );
            tracing::info!(
                "Forge standard URL not found, trying legacy format: {}",
                legacy_url
            );
            legacy_url
        }
    };

    let scratch = paths::data_dir().join("loader-scratch").join(format!("forge-{}", full_version));
    let java_exe = ensure_java_for_loader().await?;

    ensure_installer_ran(&installer_url, &scratch, &java_exe, "forge", app, instance_name).await
}

/// Get a Java executable suitable for running the installer.
/// We pick whichever java the launcher already has installed; the installer itself
/// is fairly tolerant of Java versions for the install step.
async fn ensure_java_for_loader() -> Result<PathBuf, String> {
    let java_dir = paths::java_dir();

    // Try existing Java installs — prefer higher versions first since
    // the game likely already downloaded Java 25 or 21
    for v in &[25u8, 21, 17, 8] {
        let install_dir = java_dir.join(format!("jdk-{}", v));
        if install_dir.exists() {
            if let Ok(entries) = fs::read_dir(&install_dir) {
                for entry in entries.flatten() {
                    let nested_exe = entry.path().join("bin").join(crate::util::platform::java_exe_name());
                    if nested_exe.exists() {
                        return Ok(nested_exe);
                    }
                }
            }
            let direct = install_dir.join("bin").join(crate::util::platform::java_exe_name());
            if direct.exists() {
                return Ok(direct);
            }
        }
    }

    // Fallback: trigger Adoptium download via launch::ensure_java for MC 1.21
    crate::services::launch::ensure_java_public("1.21.5").await
}

