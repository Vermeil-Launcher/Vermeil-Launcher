use crate::models::instance::*;
use crate::util::paths;
use std::fs;
use uuid::Uuid;

pub async fn list_all() -> Result<Vec<Instance>, Box<dyn std::error::Error + Send + Sync>> {
    let instances_dir = paths::instances_dir();

    if !instances_dir.exists() {
        fs::create_dir_all(&instances_dir)?;
        return Ok(Vec::new());
    }

    let mut instances = Vec::new();

    for entry in fs::read_dir(&instances_dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            let meta_path = path.join("instance.json");
            if meta_path.exists() {
                let content = fs::read_to_string(&meta_path)?;
                if let Ok(instance) = serde_json::from_str::<Instance>(&content) {
                    instances.push(instance);
                }
            }
        }
    }

    // Sort by last_played (most recent first)
    instances.sort_by(|a, b| {
        b.last_played.cmp(&a.last_played)
    });

    Ok(instances)
}

pub async fn create(config: CreateInstanceConfig) -> Result<Instance, Box<dyn std::error::Error + Send + Sync>> {
    let id = Uuid::new_v4().to_string();
    let instances_dir = paths::instances_dir();
    let instance_dir = instances_dir.join(&id);

    // Create instance directory structure
    fs::create_dir_all(instance_dir.join(".minecraft").join("mods"))?;
    fs::create_dir_all(instance_dir.join(".minecraft").join("config"))?;
    fs::create_dir_all(instance_dir.join(".minecraft").join("saves"))?;
    fs::create_dir_all(instance_dir.join(".minecraft").join("resourcepacks"))?;
    fs::create_dir_all(instance_dir.join(".minecraft").join("logs"))?;

    let now = chrono::Utc::now().to_rfc3339();

    let instance = Instance {
        format_version: 1,
        id: id.clone(),
        name: config.name,
        icon: config.icon.unwrap_or_else(|| "cube".to_string()),
        icon_custom: None,
        created_at: now,
        last_played: None,
        total_play_seconds: 0,
        game_version: config.game_version,
        loader: LoaderConfig {
            loader_type: config.loader_type,
            version: config.loader_version,
        },
        java: JavaConfig {
            memory_max_mb: config.memory_max_mb.unwrap_or(4096),
            ..Default::default()
        },
        window: WindowConfig::default(),
        mods: Vec::new(),
        source_project_id: None,
        source_platforms: Vec::new(),
    };

    // Write instance.json
    let json = serde_json::to_string_pretty(&instance)?;
    fs::write(instance_dir.join("instance.json"), json)?;

    Ok(instance)
}

pub async fn get_by_id(id: &str) -> Result<Instance, Box<dyn std::error::Error + Send + Sync>> {
    let instances_dir = paths::instances_dir();
    let meta_path = instances_dir.join(id).join("instance.json");

    if !meta_path.exists() {
        return Err(format!("Instance '{}' not found", id).into());
    }

    let content = fs::read_to_string(&meta_path)?;
    let instance: Instance = serde_json::from_str(&content)?;
    Ok(instance)
}

/// Duplicate an existing instance, copying every file under its `.minecraft/`
/// directory (mods, configs, worlds, resource packs, shader packs, etc.)
/// to a new instance with a fresh UUID and a unique name.
///
/// `last_played` and `total_play_seconds` reset on the clone — the user is
/// effectively starting fresh with the same setup. `mods` array is copied
/// as-is so the Installed-tab view shows the same content immediately.
pub async fn clone_instance(
    source_id: &str,
    new_name: Option<String>,
) -> Result<Instance, Box<dyn std::error::Error + Send + Sync>> {
    let source = get_by_id(source_id).await?;
    let instances_dir = paths::instances_dir();
    let source_dir = instances_dir.join(source_id);
    if !source_dir.exists() {
        return Err(format!("Source instance dir missing: {}", source_dir.display()).into());
    }

    let new_id = Uuid::new_v4().to_string();
    let new_dir = instances_dir.join(&new_id);

    // Resolve a unique display name. Default to "<original> (copy)"; on
    // collision append " 2", " 3", etc. until we land on something free.
    let base_name = new_name.unwrap_or_else(|| format!("{} (copy)", source.name));
    let final_name = unique_instance_name(&base_name)?;

    // Recursive copy of the source instance directory. We copy the entire
    // tree (including .minecraft/) so worlds, configs, and any custom files
    // come along — Minecraft launchers without this feature force users to
    // manually shovel folders, which always loses something.
    copy_dir_all(&source_dir, &new_dir)?;

    // Rewrite instance.json with the new id, name, and reset play stats.
    let mut cloned = source.clone();
    cloned.id = new_id.clone();
    cloned.name = final_name;
    cloned.created_at = chrono::Utc::now().to_rfc3339();
    cloned.last_played = None;
    cloned.total_play_seconds = 0;

    let json = serde_json::to_string_pretty(&cloned)?;
    fs::write(new_dir.join("instance.json"), json)?;

    Ok(cloned)
}

/// Resolve a non-conflicting display name. Appends " 2", " 3", etc. until a
/// free slot is found.
fn unique_instance_name(base: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let instances_dir = paths::instances_dir();
    if !instances_dir.exists() {
        return Ok(base.to_string());
    }

    let existing: Vec<String> = fs::read_dir(&instances_dir)?
        .flatten()
        .filter_map(|entry| {
            let meta = entry.path().join("instance.json");
            if !meta.exists() {
                return None;
            }
            let content = fs::read_to_string(&meta).ok()?;
            let inst: Instance = serde_json::from_str(&content).ok()?;
            Some(inst.name)
        })
        .collect();

    if !existing.iter().any(|n| n == base) {
        return Ok(base.to_string());
    }

    let mut n: u32 = 2;
    loop {
        let candidate = format!("{} {}", base, n);
        if !existing.iter().any(|x| x == &candidate) {
            return Ok(candidate);
        }
        n += 1;
    }
}

/// Recursively copy a directory tree. `std::fs::copy` only handles single
/// files, so we walk and re-create. We deliberately *don't* preserve file
/// permissions or symlinks — instances are user content, not system files.
fn copy_dir_all(
    src: &std::path::Path,
    dst: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst_path)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), &dst_path)?;
        }
        // Symlinks are skipped — none of Minecraft's writes produce them on
        // Windows, and on Unix preserving them across instance copies would
        // accidentally share state between two supposedly-independent setups.
    }
    Ok(())
}
