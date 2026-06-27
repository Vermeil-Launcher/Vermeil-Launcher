# Companion mod settings overhaul

Decouple the Vermeil companion mod's *install* from the cape, and move
everything the mod *does* into one mod-owned settings file with an in-game
settings screen. Applies across all active companion projects.

## Goal

- Launcher owns exactly one thing: a global toggle "is the Vermeil mod installed
  (on supported instances)".
- Everything the mod does (cape on/off, FOV effects, future features) lives in a
  single mod-owned `vermeil-settings.json`, editable in-game and persistent
  across every supported MC version.

## Current state (what IS, before the change)

- `settings.ingame_cape.enabled` is overloaded: it means BOTH "render the cape"
  AND "install the companion mod". Root of the tangle.
- `companion_mod.rs::ensure_installed` gate: `ingame_cape.enabled &&
  instance.companion_enabled && is_supported`. No cape set → no jar → no FOV, no
  settings host.
- `instance_cape.rs::jvm_property` injects `-Dvermeil.dataDir=<companion dir>`
  only when `companion_enabled && is_supported && cape.png exists`.
- Settings → General "Vermeil companion mod" toggle is bound to
  `ingame_cape.enabled` and greyed out (`pointer-events:none`) until a cape is
  set; backend `set_ingame_cape_enabled` errors without a `cape_id`.
- Per-instance `instance.companion_enabled` (+ `set_instance_companion_enabled`
  command + `setInstanceCompanionEnabled` IPC wrapper) exists but is **dead** —
  no UI calls it; always defaults true.
- Installed-tab companion card is **read-only** (status + "Manage" → Settings),
  no toggle.
- Setting channels are inconsistent: cape = polled file (`cape.json`, live
  reload); FOV (1.8.9) = JVM property `vermeil.fovEffectsScale` read once and
  frozen. video_options.rs mirrors `fovEffectScale` in options.txt both ways but
  the mod never reads options.txt.
- Companion dir `<data>/companion/` is shared across all instances/versions (no
  per-instance copies) — already the right home for shared settings.

## Feature matrix (active projects)

| Project | MC | Loader | Java | Cape | FOV effects | In-game UI |
|---|---|---|---|---|---|---|
| fabric/26.1-26.2 | 26.1–26.2 | Fabric | 25 | yes | native | none |
| fabric/1.21.11 | 1.21.11 | Fabric | 21 | yes | native | none |
| fabric/1.21-1.21.1 | 1.21–1.21.1 | Fabric | 21 | yes | native | none |
| forge/1.8.9 | 1.8.9 | Forge | 8 | yes | backport | none |

FOV-effects backport is 1.8.9-only and correct (1.16+ native). Cape at parity.
In-game settings UI exists nowhere yet.

## Decisions (settled)

- **Control = per-instance toggle**, not a global master switch. Lives on the
  managed-mod card in the Installed tab (the UI that was always missing). Default
  ON for supported instances. Gate: `instance.companion_enabled && is_supported`.
  Unsupported never installs (unchanged guarantee). Rationale: matches the rest
  of the mod list's per-mod on/off; lets a user opt one supported instance out;
  no global thrash across all instances.
  - (Considered a global master switch first; rejected — too blunt, churns every
    instance at once.)
- **Disable in place, don't delete** → toggling off renames the managed jar
  `vermeil-…jar` → `…jar.disabled` (loaders ignore it; `sync_manual_mods` already
  skips both forms). Toggling on renames it back — no re-download. Pruning still
  deletes *old-version* managed jars. Reconcile happens at launch in
  `companion_mod::ensure_installed`.
- **Description copy is feature-agnostic** — "Vermeil's custom in-game features",
  never cape-specific, since features are growing.
- **Companion dir layout** (folded into Phase 3) → settings live in one file at
  the root, bulk/asset data in per-feature subfolders:
  ```
  companion/
    vermeil-settings.json   # all settings, grouped by feature
    cape/cape.png           # texture (the only binary)
  ```
  `cape.json` is dropped; its `enabled` + `frameTimeMs` fold into
  `vermeil-settings.json` under a `cape` object. Schema groups multi-field
  features into objects, leaves single scalars flat until they grow:
  `{ "cape": { "enabled", "frameTimeMs" }, "fovEffectsScale" }`. Convention for
  future features: `companion/<feature>/` for assets + a `"<feature>"` section in
  the settings file.
- **No migration** — still in active dev; existing capes may reset on the
  reorg/upgrade, that's acceptable. Don't add migration code.
- **`vermeil-settings.json`** in `<data>/companion/` is the single mod-owned
  store for all feature settings. Start: `{ capeEnabled: bool, fovEffectsScale:
  number }`; extensible. Mod reads at startup, applies live, writes on change;
  launcher reads back after exit.
- **Cape on/off authority** moves to `vermeil-settings.json.capeEnabled`
  (default true). Skins still picks/bakes the texture; `cape.json` keeps only
  `frameTimeMs`. Nothing renders without a texture (harmless).
- **`dataDir` injection** → for `companion_mod_enabled && is_supported`,
  regardless of cape (mod needs its dir for settings/FOV).
- **Installed-tab card** stays read-only; show-condition →
  `ingame_cape_supported && companion_mod_enabled`; Manage → Settings → General.
- **In-game settings screen** → pause-menu button → Vermeil screen, categories:
  Cosmetics (cape toggle), Visuals (FOV slider, 1.8.9 only). Forge 1.8.9 uses
  GUI events + GuiScreen (no ASM); Fabric eras use the Screen API (differs per
  era — verify each from genSources).

## Phase scope (agreed)

1. Launcher decouple (Rust + small frontend; mod untouched, still works).
2. `vermeil-settings.json` schema + launcher write/read-back.
3. Mod consumes the file (all 4 projects): cape reads `capeEnabled`; 1.8.9 FOV
   reads `fovEffectsScale` live (unfrozen).
4. In-game settings screen (all 4 projects).
5. Docs + mod release.

## Toolchain (verified present on the Windows dev box)

- JDK 21 `C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot` — matches the
  Fabric projects' `org.gradle.java.home` pin exactly (no edit needed).
- JDK 25 `…\jdk-25.0.3.9-hotspot` — for fabric/26.1-26.2.
- JDK 8 `…\jdk-8.0.492.9-hotspot` — for forge/1.8.9 (set JAVA_HOME to it).
