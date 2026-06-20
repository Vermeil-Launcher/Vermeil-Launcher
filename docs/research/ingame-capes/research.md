# In-game custom capes — research

Goal: render a user's local custom cape **in-game**, not just in the launcher's 3D viewer.

## Constraint
- Vanilla only renders Mojang-granted capes → a custom cape needs a **client-side mod**.
- Launcher's job: install the mod into the instance + write the cape file where the mod reads it.

## Mechanism
- Launcher writes the baked cape PNG; mod loads it as a registered texture and hooks player cape rendering so the local player's cape uses it even with no Mojang cape.
- Texture is the standard 2:1 (64×32) cape layout.
- Animation: cape PNG is a vertical strip of square frames (the game's decoder is PNG-only) + optional `cape.json` `{enabled, frameTimeMs}`. Mod cycles frames via the game's tickable-texture path. Source format (GIF/etc.) is decoded launcher-side into the strip.
- Multiplayer: client-side only — others see it only if they run the mod too.

## Cape file location
- Mod reads `<dataDir>/cape.png` + `cape.json`, where `dataDir` = `-Dvermeil.dataDir` system property, else `<gameDir>/vermeil/`.
- Launcher keeps one global copy at `<data>/companion/` and injects `-Dvermeil.dataDir` at launch for supported instances (no per-instance copies; live-reload).

## Build structure
- **One standalone Gradle project per (era, loader)** — eras can't share a toolchain (Java 25 Fabric vs Java 8 Forge can't even share a Gradle). Stonecutter (single-source multi-version) was tried and dropped.
- Built: `vermeil-fabric-26/` (26.x), `vermeil-fabric-1.21/` (1.21.1). Each: official Mojang mappings, no Fabric API (loader + Mixins only).
- Fabric covers Quilt for free. No classic Forge exists for 26.x → Fabric-only there.

## Per-era cape hook (verified from each version's genSources)
- **26.x — render-state:** tail of `AvatarRenderer.extractRenderState`; swap `AvatarRenderState.skin` for one whose `cape()` = `vermeil:cape` and force `showCape`. `CapeLayer.submit` renders it.
- **1.21.1 — feature-renderer:** `@Redirect` the `getSkin()` call in `CapeLayer.render` to return a `PlayerSkin` with `capeTexture()` = `vermeil:cape`. Local capeless player only; no `isCapeLoaded()` guard in 1.21.1.
- Both: never override an account's real cape; local player only.
