use std::path::PathBuf;

/// Returns the root data directory for the launcher.
///
/// This is **local** (non-roaming) app data: the launcher's data is large
/// (instances, Java runtimes, libraries, the Minecraft asset cache) and
/// machine-specific, so it must not roam across machines in a domain profile.
///
/// - Windows: `%LOCALAPPDATA%/Vermeil`
/// - macOS: `~/Library/Application Support/Vermeil`
/// - Linux: `~/.local/share/Vermeil`
pub fn data_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("Vermeil")
}

/// Returns the instances directory.
pub fn instances_dir() -> PathBuf {
    data_dir().join("instances")
}

/// Returns the shared assets directory.
pub fn assets_dir() -> PathBuf {
    data_dir().join("assets")
}

/// Returns the shared libraries directory.
pub fn libraries_dir() -> PathBuf {
    data_dir().join("libraries")
}

/// Returns the Java runtimes directory.
pub fn java_dir() -> PathBuf {
    data_dir().join("java")
}

/// Returns the metadata cache directory.
pub fn meta_dir() -> PathBuf {
    data_dir().join("meta")
}

/// Atomically write `contents` to `path`.
///
/// Writes to a sibling `<path>.tmp` first, then renames into place. On POSIX
/// and modern Windows, `rename` is atomic — readers either see the old file
/// or the new one, never a half-written state.
///
/// This matters for files that are written from multiple async paths (e.g.
/// `instance.json` updated by the UI on every slider drag). `std::fs::write`
/// truncates first then writes, so a concurrent reader can hit the empty
/// window and fail with `EOF while parsing`.
pub fn atomic_write<P: AsRef<std::path::Path>>(path: P, contents: &[u8]) -> std::io::Result<()> {
    let path = path.as_ref();
    let parent = path.parent().ok_or_else(|| std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        "atomic_write: path has no parent directory",
    ))?;
    std::fs::create_dir_all(parent)?;

    // Use a unique temp name to avoid collisions when multiple writes race.
    // The OS's rename is atomic, but we still don't want two writers fighting
    // over the same `.tmp` file mid-flight.
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("tmp.{}.{}", pid, nanos));

    std::fs::write(&tmp, contents)?;

    // On Windows, `rename` fails if the target exists. Use a remove-then-rename
    // dance — there's a brief window where the file is missing, but readers
    // that fail can retry, which is far better than getting a truncated file.
    #[cfg(windows)]
    {
        if path.exists() {
            // Best-effort: if remove fails (e.g. another writer already replaced
            // it), the rename below will fail and we'll surface that error.
            let _ = std::fs::remove_file(path);
        }
    }

    std::fs::rename(&tmp, path)?;
    Ok(())
}
