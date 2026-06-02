//! Platform-detection helpers used across the launcher.
//!
//! Centralizes OS-specific constants so individual services don't need to
//! repeat `cfg!(windows)` / `cfg!(target_os = "linux")` checks inline.

/// The OS name as Mojang uses it in version.json rules (`os.name` field).
/// Returns `"windows"`, `"linux"`, or `"osx"`.
pub fn os_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

/// The classpath separator for the current platform.
/// Windows uses `;`, everything else uses `:`.
pub fn classpath_separator() -> &'static str {
    if cfg!(windows) { ";" } else { ":" }
}

/// The Java executable name for the current platform.
/// Windows: `java.exe`. Linux/macOS: `java`.
pub fn java_exe_name() -> &'static str {
    if cfg!(windows) { "java.exe" } else { "java" }
}

/// The OS segment for Adoptium API URLs.
/// Returns `"windows"`, `"linux"`, or `"mac"`.
pub fn adoptium_os() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    }
}

/// The architecture segment for Adoptium API URLs.
/// Returns `"x64"` or `"aarch64"`.
pub fn adoptium_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x64"
    }
}

/// The natives map key used in version.json formats.
/// Returns `"windows"`, `"linux"`, or `"osx"`.
pub fn natives_map_key() -> &'static str {
    os_name()
}

/// The file extension for Java runtime archives from Adoptium.
/// Windows: `.zip`. Linux/macOS: `.tar.gz`.
pub fn java_archive_ext() -> &'static str {
    if cfg!(windows) { ".zip" } else { ".tar.gz" }
}

/// Extract a Java runtime archive to the given directory.
/// Handles `.zip` on Windows and `.tar.gz` on Linux/macOS.
pub fn extract_java_archive(archive_path: &std::path::Path, dest_dir: &std::path::Path) -> Result<(), String> {
    use std::fs;
    use std::io;

    fs::create_dir_all(dest_dir).map_err(|e| format!("Create dir: {}", e))?;

    if cfg!(windows) {
        // ZIP extraction
        let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Open zip: {}", e))?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| format!("Zip entry: {}", e))?;
            let outpath = dest_dir.join(entry.name());
            if entry.is_dir() {
                fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
            } else {
                if let Some(parent) = outpath.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let mut outfile = fs::File::create(&outpath).map_err(|e| e.to_string())?;
                io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
            }
        }
    } else {
        // tar.gz extraction
        let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
        let gz = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(gz);
        archive.unpack(dest_dir).map_err(|e| format!("Extract tar.gz: {}", e))?;
    }

    Ok(())
}
