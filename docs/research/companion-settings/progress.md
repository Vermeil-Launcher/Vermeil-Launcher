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
