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

## 2026-06-27 · Phase 3 — mod consumes vermeil-settings.json + dir reorg (done)

- Schema regrouped: `{ cape: { enabled, frameTimeMs }, fovEffectsScale? }`. Cape
  texture moved to `companion/cape/cape.png`; `cape.json` dropped. New
  `companion_settings::update_cape` does live (non-launch) cape writes for Skins
  toggles; `clear_ingame_cape` now removes only `cape/` + cape settings, leaving
  FOV intact.
- instance_cape.rs: cape png path → `cape/cape.png`; cape on/off + frame timing
  mirrored into vermeil-settings.json (not cape.json) for live reload.
- All 4 mod projects: VermeilCape reads cape on/off + frameTimeMs from
  vermeil-settings.json (`cape` object) and texture from `cape/cape.png`; polls
  the settings file. 1.8.9 VermeilFovEffects reads `fovEffectsScale` from the file,
  re-read ~1×/s (live) — replaces the frozen JVM-prop read; `-Dvermeil.fovEffectsScale`
  removed from launch.rs. video_options comments fixed (mod reads its own file now).
- Verified: `cargo check` clean (0 warnings); all 4 mod projects `gradlew build`
  → BUILD SUCCESSFUL (1.21.11 / 1.21-1.21.1 JDK 21, 26.1-26.2 JDK 25, forge/1.8.9 JDK 8).
- No migration (per decision): existing flat `companion/cape.png` / `cape.json`
  are orphaned; user re-sets the cape. Archived 1.21.x projects still use the old
  cape.json format — out of build path; update them only if restored.
- End-to-end cape/FOV behaviour needs a new mod release (Phase 5) or dev runClient,
  since the launcher installs the *released* jar.
- Next: Phase 4 — in-game settings screen (pause-menu button) across the projects.

## 2026-06-27 · scaffold up front + FOV key always present

- `companion_settings::ensure_scaffold()` runs at launcher startup (lib.rs setup):
  creates `companion/` + `companion/cape/` and writes a default vermeil-settings.json
  (full schema) if absent — layout + settings exist before any cape is set.
- `fovEffectsScale` is now **always present** in the file (f64, default 1.0),
  reversing the earlier pre-1.16-only omission. Only the 1.8.9 mod reads it and
  only pre-1.16 syncs it back (1.16+ FOV still round-trips via options.txt), so
  no clobber. `write_for_launch` no longer takes/needs the version flag.
- Launcher-only change; mod readers unaffected (fovEffectsScale still top-level,
  cape object unchanged). `cargo check` clean.


## 2026-06-27 · Phase 4 (1.8.9) — in-game settings screen (done)

- Forge 1.8.9: pause-menu "Vermeil" button via Forge GUI events (no ASM) —
  `VermeilSettingsHook` (InitGuiEvent.Post adds the button to GuiIngameMenu;
  ActionPerformedEvent.Pre opens the screen), registered on the event bus in
  VermeilMod.init.
- `VermeilSettingsScreen` (GuiScreen): categories Cosmetics (cape ON/OFF toggle)
  + Visuals (FOV-effects slider). `VermeilSlider` is a self-contained GuiButton
  subclass (classic 1.8.9 handle-render pattern; no GuiResponder wiring).
- `VermeilSettingsStore`: read-modify-write of vermeil-settings.json (preserves
  unknown keys); cape toggle writes immediately (cape watcher live-reloads), FOV
  persists on screen close. Launcher reads both back on exit.
- Button placed top-left corner (collision-free at any GUI scale); closing returns
  to the pause menu, vanilla menu untouched.
- Verified: `gradlew build` (JDK 8) BUILD SUCCESSFUL — compiles against MCP
  mappings (validates GuiButton/GuiScreen/GuiScreenEvent names). In-game visual
  check pending via runClient / a mod release.
- Next: Fabric projects (1.21-1.21.1, 1.21.11, 26.1-26.2) — cape-toggle screen
  only (1.16+ FOV is native). No Fabric API in these, so the pause-menu button is
  a Mixin into the pause screen, not an event.

## 2026-06-27 · Phase 4 (1.8.9) — button polish

- Pause-menu button replaced with a compact 20×20 logo button anchored right of
  the quit button (found by vanilla id: 1 on pause, 4 on title), added to BOTH
  GuiIngameMenu and GuiMainMenu. Closing returns to the originating screen.
- Real Vermeil logo: launcher `public/logo.png` downscaled to 64×64 →
  `assets/vermeil/textures/gui/logo.png` (the copied mod-icon was a placeholder).
  Rendered via drawScaledCustomSizeModalRect into a centred 16×16.
- Compatibility: we only append our button (never touch others'); anchor follows
  the quit button's live position; if the quit button is absent we skip. Added
  `freeY` collision avoidance — nudges our button down past any button already in
  the list so it won't overlap another mod's. (Can't cover a mod that adds after
  us; non-destructive if so.)
- Verified: gradlew build (JDK 8) BUILD SUCCESSFUL; runClient smoke-tested in-game
  (button + logo render on both screens, settings screen opens/closes).


## 2026-06-27 · Phase 4 (1.8.9) — custom themed UI + DM Sans (baseline)

- `VermeilFont`: custom TTF renderer for 1.8.9 (no native TTF pre-1.13). Loads
  bundled DM Sans (OFL), rasterizes printable-ASCII glyphs via AWT into a GL
  texture atlas (linear filtered), draws batched textured quads per glyph tinted
  by colour. `drawString` / `width` / `lineHeight`; falls back to vanilla font if
  load fails. Verified in-game: crisp, correct spacing/colour.
- DM Sans Regular TTF + OFL.txt bundled at assets/vermeil/font/ (from
  googlefonts/dm-fonts; downscaled launcher logo already at textures/gui/logo.png).
- `VermeilSettingsScreen` rebuilt as a fully custom-drawn UI in the launcher
  palette (panel #1d1b24 / border #322f3d / accent #8b5cf6, sharp edges): logo +
  VERMEIL header w/ accent underline, Cosmetics/Visuals tabs, square cape toggle,
  purple-fill FOV slider w/ % readout, Done button. No vanilla widgets; manual
  hit-testing (mouseClicked/ClickMove/Released, Esc→parent). Writes live to
  vermeil-settings.json. Removed VermeilSlider (GuiButton-based, now unused).
- Verified: gradlew build (JDK 8) BUILD SUCCESSFUL; runClient smoke-tested.
  Baseline design — polish/layout iteration to follow (hover states, spacing,
  possible sidebar+content layout as features grow).
- Still TODO: port to the 3 Fabric projects (DM Sans via vanilla font provider
  there; cape toggle only).


## 2026-06-27 · Phase 4 (1.8.9) — UI redesign locked

- Dropped the custom DM Sans renderer + TTF/OFL + procedural icons (distorted,
  didn't fit). Use the **vanilla pixel font**, GL-scaled per size — gamey look,
  no scaling artifacts.
- Redesigned VermeilSettingsScreen to a client-settings layout: left sidebar
  (logo + "Vermeil v<ver>" + text categories, active = solid-accent button),
  a **search bar** (click-to-focus, blinking caret, filters rows), and setting
  rows (name + desc + ON/OFF pill toggle, or slider+% for FOV). Sharp, dark,
  purple; sized to ~70% of screen with margins.
- Background uses `drawDefaultBackground()` — vanilla dirt on the title screen,
  dimmed gradient in-world. (1.8.9 shows dirt behind sub-screens, not the live
  panorama, same as vanilla Options; live panorama would need re-rendering the
  skybox — deferred.)
- Verified via runClient across iterations; build clean (JDK 8).
- Next: port this layout to the 3 Fabric projects (pixel font there too; cape
  toggle only — 1.16+ FOV is native; pause/title button via Mixin, no Fabric API).

## 2026-06-27 · Phase 4 (Fabric 1.21.11) — settings screen + logo button (done)

- Ported the 1.8.9 design to fabric/1.21.11 (cape-only — 1.16+ FOV is native, so
  single "Cosmetics" category, no Visuals tab). New `VermeilSettingsStore` (NIO,
  cape on/off only), `gui/VermeilSettingsScreen` (sidebar + search + ON/OFF pill,
  vanilla pixel font, GL-scaled), `gui/VermeilLogoButton`, `mixin/VermeilMenuButtonMixin`.
- API verified from genSources (not guessed) — 1.21.11 input refactor:
  `mouseClicked(MouseButtonEvent, boolean)`, `keyPressed(KeyEvent)`,
  `charTyped(CharacterEvent)`; `GuiGraphics.pose()` returns JOML `Matrix3x2fStack`
  (`pushMatrix`/`popMatrix`/`scale(x,y)`); `AbstractButton` needs
  `updateWidgetNarration`. Mod version via `FabricLoader` (`VermeilMod.version()`),
  no constant.
- `render()` must NOT call `renderBackground()` — the engine already draws it in
  `renderWithTooltipAndSubtitles`; calling again double-blurs → crash. Fixed.
- Button placement anchors to the screens' own widgets (no hardcoded coords):
  pause menu → right of the lowest full-width button; title screen → past the
  accessibility button (found via `menu.quit`), so it never overlaps the vanilla
  language/accessibility side cluster. Skips cleanly when the anchor is absent.
- Logo texture: a mod asset blit via resource-pack id does NOT resolve in a
  split-sourceset dev run (`Missing resource`). Switched to the cape's proven
  pattern — read `logo.png` from the classpath and register a `DynamicTexture`
  once on first render; works in dev and packaged. logo.png (64×64) lives in the
  client sourceset (`src/client/resources/assets/vermeil/textures/gui/`).
- Verified: `gradlew build` clean (JDK 21); runClient smoke-tested — button +
  logo render on title + pause, settings screen opens (no crash), search focuses
  with caret, cape pill toggles.
- Next: replicate to fabric/1.21-1.21.1 and fabric/26.1-26.2 (26.x needs JDK 25;
  may have a further API delta), then Phase 5 (mod release).
