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

## Texture filtering / HD aliasing
- Cape texture filter must match skinview3d: editor uses `magFilter = minFilter = NEAREST` (Three.js source). The mod sets the same: 26.x reassigns `AbstractTexture.sampler` to `(NEAREST, NEAREST)` via the new `GpuSampler` cache; 1.21.1 calls `AbstractTexture.setFilter(false, false)` (the default mag is `GL_LINEAR` — blurry — because `TextureUtil.prepareImage` doesn't set it).
- **HD textures alias at distance with NEAREST minification.** Vanilla cape is 64×32, so each screen pixel maps to ~1 texel and there's nothing to alias. A 16× cape (1024×512) maps each screen pixel to ~30 texels at typical third-person distance; with `GL_NEAREST` the chosen texel jumps with sub-pixel motion → shimmering that reads as "lower-res/pixelated noise". This matches the [Khronos OpenGL ES reference](https://registry.khronos.org/OpenGL-Refpages/es3.0/html/glSamplerParameter.xhtml): non-mipmap minification "use[s] the nearest one or nearest four texture elements". Documented in Minecraft itself by mods like [TextWeaks](https://modrinth.com/mod/textweaks) — high-res resource packs without complete mip chains are "significantly more aliased than normal".
- **Fix path:** generate the mip chain on save and use `GL_NEAREST_MIPMAP_LINEAR` (or `LINEAR_MIPMAP_LINEAR`) for minification, keeping mag `NEAREST`. `DynamicTexture` only allocates level 0 by default — needs explicit mip-level uploads. Pattern recommended on the [Khronos forum](https://community.khronos.org/t/fix-shimmering-without-losing-blockiness/70776). 1.21.1 hint: `setFilter(false, true)` selects `GL_NEAREST_MIPMAP_LINEAR` for min, but only works once levels >0 are uploaded.

(Content rephrased from the cited sources; see them for the canonical wording.)
