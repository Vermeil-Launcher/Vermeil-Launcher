# Progress

## 2026-06-27 · planning + toolchain

- Audited current companion-mod architecture (launcher + 4 active projects);
  findings + settled decisions in `research.md`.
- Confirmed per-instance companion toggle is dead code (no UI caller).
- Installed JDK 21 / 25 / 8 (Adoptium) on the Windows dev box; JDK 21 path
  matches the Fabric projects' pin. All four projects buildable locally.
- No code changed yet. Immediate next step: Phase 1 — launcher decouple
  (`companion_mod_enabled` global toggle drives install).

## 2026-06-27 · Phase 1 — launcher decouple (done)

- New global `companion_mod_enabled` (Option<bool>) in launcher settings;
  migrated on load from old `ingame_cape.enabled` (no surprise for existing
  users); new installs default `Some(true)`. Command `set_companion_mod_enabled`.
- Install gate now `companion_mod_enabled && is_supported` (companion_mod.rs);
  cape no longer required. `jvm_property` is async, gates on the same, and
  injects `-Dvermeil.dataDir` regardless of whether a cape exists.
- Removed dead per-instance code: `instance.companion_enabled`,
  `set_instance_companion_enabled` (+ lib.rs reg + `setInstanceCompanionEnabled`
  wrapper), and `companion_enabled: true` at all 4 creation sites. Old
  instance.json still loads (serde ignores the dropped field).
- list_instances now computes `companion_installed` (global toggle && supported);
  Installed-tab managed card shows on that. Settings → General toggle rebound to
  the master switch, always interactive (no cape requirement).
- Verified: `cargo check` clean (0 warnings), `pnpm run build` clean. Mod
  untouched — still works as before.
- Next: Phase 2 — `vermeil-settings.json` schema + launcher write/read-back.

## 2026-06-27 · Phase 1 revised — per-instance toggle (done)

- Pivoted from the global master switch to a **per-instance** toggle on the
  Installed-tab managed-mod card (default on, supported instances only). Reverted
  the global `companion_mod_enabled` field/command/migration added earlier.
- Gate is now `instance.companion_enabled && is_supported`; cape-decoupling kept
  (no cape required to install).
- Toggling off **disables the jar in place** (rename `.disabled`), not delete;
  on re-enables via rename — no re-download. Old-version jars still pruned.
  `companion_mod.rs` reconcile rewritten accordingly (disable_managed /
  reenable_existing / prune_managed_except).
- Card copy made feature-agnostic ("Vermeil's custom in-game features").
- Verified: `cargo check` clean (0 warnings), `pnpm run build` clean.
- Next: Phase 2 — `vermeil-settings.json` schema + launcher write/read-back.

## 2026-06-27 · Phase 2 — vermeil-settings.json (launcher side, done)

- New `services/companion_settings.rs`: `VermeilSettings { capeEnabled,
  fovEffectsScale }` (camelCase JSON, per-field defaults). `write_for_launch`
  writes `<data>/companion/vermeil-settings.json` from launcher settings;
  `read_back` parses it after exit. Best-effort, atomic write.
- launch.rs: writes the file in the pre-launch options.txt block (authoritative
  at launch, same model as options.txt). Exit handler reads it back —
  `capeEnabled` → `ingame_cape.enabled` (cross-version); `fovEffectsScale` →
  `video_settings.fov_effects` **only pre-1.16** (1.16+ FOV round-trips via
  options.txt; reading both would clobber with a stale value). Captured
  `instance_version` for the gate.
- Non-breaking: cape.json (`enabled`) and the `-Dvermeil.fovEffectsScale` JVM
  prop stay for the current mod; vermeil-settings.json is additive. Phase 3
  switches the mod to read it, then those two are dropped.
- Verified: `cargo check` clean (0 warnings). Backend-only, no frontend change.
- Next: Phase 3 — mod reads vermeil-settings.json across the 4 projects
  (cape `capeEnabled`; 1.8.9 FOV live from `fovEffectsScale`).
