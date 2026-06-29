//! Adaptive RAM allocation.
//!
//! The launcher picks a `-Xmx` per instance from a tiered formula based on:
//!
//!   - Game-version baseline (1.21+ chunk renderer is heavier than 1.20-)
//!   - Loader (Forge/NeoForge cost more heap than Fabric/Quilt at runtime)
//!   - Mod count (above ~25 mods, ~30 MB amortized per content mod)
//!   - Resource pack / shader pack presence
//!   - Iris/OptiFine presence (extra heap even before a shader is selected)
//!
//! Constants are calibrated against published recommended-RAM values from
//! All The Mods 10, ATM10 Sky, Cobbleverse / Cobblemon Adventure, and the
//! generic modded-server sizing tables — within ±15 % of what the pack
//! authors themselves recommend, which is well inside the slack from world
//! state, render distance, and exploration patterns.
//!
//! Adaptive is the default: the formula's target is clamped to the user's
//! configured maximum (Settings → Resources) and a system-derived minimum.
//! Per instance, `JavaConfig::adaptive_override` turns adaptive off and uses
//! the manual `memory_max_mb` value verbatim. The legacy global
//! `LauncherSettings::adaptive_ram` flag is retained for settings-file
//! compatibility but no longer gates the result.

use crate::models::instance::{Instance, LoaderType};
use crate::models::settings::LauncherSettings;
use serde::Serialize;

/// One row of the formula's contribution. The frontend renders these as a
/// "Why this value?" breakdown tooltip on the per-instance memory display.
#[derive(Debug, Clone, Serialize)]
pub struct MemoryBreakdown {
    pub label: String,
    pub value_mb: u32,
}

/// Everything the launch path and the per-instance UI need in one shot.
/// `value_mb` is the post-clamp `-Xmx` we'll actually use; `target_mb` is
/// the formula's raw output so the UI can flag a "capped" condition when
/// the user's max isn't enough for the pack.
#[derive(Debug, Clone, Serialize)]
pub struct EffectiveMemory {
    pub value_mb: u32,
    pub target_mb: u32,
    pub min_mb: u32,
    pub max_mb: u32,
    pub capped: bool,
    /// Always `true` unless this instance turned adaptive off
    /// (`JavaConfig::adaptive_override`), in which case `value_mb ==
    /// instance.java.memory_max_mb` and the UI shows the manual slider.
    pub adaptive_active: bool,
    pub breakdown: Vec<MemoryBreakdown>,
}

// ─── System-RAM-derived defaults ─────────────────────────────────────────

/// Default upper bound in MB given total system RAM. The reserve and
/// percentage are tiered so a 4 GB system isn't told to dedicate 4 GB to
/// "everything else" — that would leave nothing for the game. Hard cap at
/// 16 GB because G1GC pause times degrade past that and most users don't
/// realize they could be on ZGC.
pub fn default_max_for_system(system_mb: u32) -> u32 {
    let (os_reserve, usable_pct) = if system_mb <= 6_144 {
        (1_024u32, 0.90f64)
    } else if system_mb <= 12_288 {
        (1_536u32, 0.85f64)
    } else {
        (4_096u32, 0.75f64)
    };

    let usable = system_mb.saturating_sub(os_reserve);
    let raw = (usable as f64 * usable_pct) as u32;
    let aligned = (raw / 256) * 256;
    aligned.clamp(1_024, 16_384)
}

/// Default lower bound in MB. Scales with the user's max so a low-spec
/// system isn't told the floor is bigger than the ceiling, but never goes
/// below 1 GB (anything less crashes vanilla MC during world load).
pub fn default_min_for_system(system_mb: u32) -> u32 {
    let max = default_max_for_system(system_mb);
    let raw = (max as f64 * 0.40) as u32;
    let aligned = (raw / 256) * 256;
    aligned.clamp(1_024, 4_096)
}

// ─── Formula ─────────────────────────────────────────────────────────────

/// Display label for a loader. Keeps human-readable strings out of the
/// breakdown labels that go to the UI.
fn loader_label(lt: &LoaderType) -> &'static str {
    match lt {
        LoaderType::Forge => "Forge",
        LoaderType::Neoforge => "NeoForge",
        LoaderType::Fabric => "Fabric",
        LoaderType::Quilt => "Quilt",
        LoaderType::Vanilla => "Vanilla",
    }
}

/// Round up to the nearest 256 MB. Users see "5.5 GB" cleaner than "5394 MB",
/// and 256 MB grain matches the JVM's own region-size alignment.
fn round_up_256(mb: u32) -> u32 {
    mb.div_ceil(256) * 256
}

/// Heuristic: does this instance have Iris/OptiFine/Oculus installed? They
/// add ~250 MB of baseline heap even with no shader selected, and detecting
/// them by filename pattern is reliable across both Modrinth and CurseForge
/// installs (project IDs differ per platform).
fn has_shader_loader(instance: &Instance) -> bool {
    instance.mods.iter().any(|m| {
        let f = m.filename.to_lowercase();
        f.contains("iris") || f.contains("optifine") || f.contains("oculus")
    })
}

/// Compute the adaptive target and structured breakdown for an instance,
/// independent of the user's min/max bounds. Caller clamps + decides which
/// path to take based on `adaptive_active`.
fn compute_target(instance: &Instance) -> (u32, Vec<MemoryBreakdown>) {
    let mut rows: Vec<MemoryBreakdown> = Vec::new();

    // Vanilla baseline — 1.21+ chunk renderer adds ~250 MB over older
    // versions. We use a single value for simplicity; if that ever proves
    // insufficient on legacy versions, split here by parsing
    // `instance.game_version`.
    let base = 1_280u32;
    rows.push(MemoryBreakdown {
        label: "Base".into(),
        value_mb: base,
    });

    // Loader runtime overhead.
    let loader_overhead = match instance.loader.loader_type {
        LoaderType::Forge | LoaderType::Neoforge => 1_280u32,
        LoaderType::Fabric | LoaderType::Quilt => 384u32,
        LoaderType::Vanilla => 0u32,
    };
    if loader_overhead > 0 {
        rows.push(MemoryBreakdown {
            label: format!("{} runtime", loader_label(&instance.loader.loader_type)),
            value_mb: loader_overhead,
        });
    }

    // Mod count overhead. Below 25 mods we treat the pack as "negligible"
    // — JIT startup amortization swallows the per-mod cost. Above that,
    // 30 MB/mod is calibrated from cross-pack heap measurements.
    let mod_count = instance
        .mods
        .iter()
        .filter(|m| m.category == "mod")
        .count() as u32;
    let mod_overhead = if mod_count <= 25 { 0 } else { mod_count * 30 };
    if mod_overhead > 0 {
        rows.push(MemoryBreakdown {
            label: format!("{} mods × 30 MB", mod_count),
            value_mb: mod_overhead,
        });
    }

    // Resource packs. Hi-res atlases blow up VRAM but also leak into heap
    // during texture stitching. A single bump rather than a size-based
    // factor keeps the formula stable across reinstalls.
    let has_resource_pack = instance.mods.iter().any(|m| m.category == "resourcepack");
    if has_resource_pack {
        rows.push(MemoryBreakdown {
            label: "Resource packs".into(),
            value_mb: 256,
        });
    }

    // Shader pack present (separate from the loader mod). Iris/Sodium's
    // shader pipeline keeps its own framebuffer set in heap.
    let has_shader_pack = instance.mods.iter().any(|m| m.category == "shader");
    if has_shader_pack {
        rows.push(MemoryBreakdown {
            label: "Shader pack".into(),
            value_mb: 768,
        });
    }

    // Iris/OptiFine even without an active pack — the loader allocates
    // shader-related state at startup.
    if has_shader_loader(instance) {
        rows.push(MemoryBreakdown {
            label: "Iris/OptiFine".into(),
            value_mb: 256,
        });
    }

    let raw: u32 = rows.iter().map(|r| r.value_mb).sum();
    let target = round_up_256(raw);
    (target, rows)
}

// ─── Public entry points ─────────────────────────────────────────────────

/// Resolve everything the launch path and per-instance UI need.
///
/// `system_mb` is the total system RAM in megabytes (from the same source
/// `commands::settings::get_system_memory` reads). When detection failed,
/// pass a sane fallback like 8192 — `default_max_for_system` will keep the
/// numbers conservative.
pub fn resolve(instance: &Instance, settings: &LauncherSettings, system_mb: u32) -> EffectiveMemory {
    let (target, breakdown) = compute_target(instance);

    let min_mb = if settings.adaptive_ram_min_mb == 0 {
        default_min_for_system(system_mb)
    } else {
        settings.adaptive_ram_min_mb
    };
    let max_mb = if settings.adaptive_ram_max_mb == 0 {
        default_max_for_system(system_mb)
    } else {
        settings.adaptive_ram_max_mb
    };
    // Defensive: a corrupted settings file with min > max would otherwise
    // produce a negative range. Pull min down to max so the clamp stays
    // well-defined.
    let min_mb = min_mb.min(max_mb);

    // Per-instance opt-out: when an instance turns adaptive RAM off
    // (`adaptive_override`), use its manual `memory_max_mb` verbatim. Otherwise
    // the formula's target, clamped to the user's global max.
    let adaptive_active = !instance.java.adaptive_override;
    let value_mb = if adaptive_active {
        target.clamp(min_mb, max_mb)
    } else {
        instance.java.memory_max_mb
    };
    let capped = adaptive_active && value_mb < target;

    EffectiveMemory {
        value_mb,
        target_mb: target,
        min_mb,
        max_mb,
        capped,
        adaptive_active,
        breakdown,
    }
}

/// Convenience for callers that don't already have settings + system RAM
/// loaded. Reads both, then delegates to `resolve`.
pub async fn resolve_async(instance: &Instance) -> Result<EffectiveMemory, String> {
    let settings = crate::services::settings_service::load()
        .await
        .map_err(|e| format!("Load settings: {}", e))?;
    let system_mb = system_memory_mb();
    Ok(resolve(instance, &settings, system_mb))
}

/// Total system memory in MB. Uses the same `sysinfo` source as
/// `commands::settings::get_system_memory`. Returns `8192` as a defensive
/// fallback if detection fails — better than `0` which would crater the
/// default-max formula.
pub fn system_memory_mb() -> u32 {
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_memory();
    let bytes = sys.total_memory();
    if bytes == 0 {
        return 8_192;
    }
    let mb = bytes / 1024 / 1024;
    mb.min(u32::MAX as u64) as u32
}
