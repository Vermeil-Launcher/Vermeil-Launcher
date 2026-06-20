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
- Built: `companion-mod/fabric/26.1/` (26.1–26.2), `companion-mod/fabric/1.21/` (1.21–1.21.1). Each: official Mojang mappings, no Fabric API (loader + Mixins only). One jar per project covering its version range.
- Fabric covers Quilt for free. No classic Forge exists for 26.x → Fabric-only there.

## Per-era cape hook (verified from each version's genSources)
- **26.x — render-state:** tail of `AvatarRenderer.extractRenderState`; swap `AvatarRenderState.skin` for one whose `cape()` = `vermeil:cape` and force `showCape`. `CapeLayer.submit` renders it.
- **1.21.1 — feature-renderer:** `@Redirect` the `getSkin()` call in `CapeLayer.render` to return a `PlayerSkin` with `capeTexture()` = `vermeil:cape`. Local capeless player only; no `isCapeLoaded()` guard in 1.21.1.
- Both: never override an account's real cape; local player only.

## Texture filtering / HD aliasing
- Cape texture filter must match skinview3d: editor uses `magFilter = minFilter = NEAREST` (Three.js source). The mod sets the same: 26.x reassigns `AbstractTexture.sampler` to `(NEAREST, NEAREST)` via the new `GpuSampler` cache; 1.21.1 calls `AbstractTexture.setFilter(false, false)` (the default mag is `GL_LINEAR` — blurry — because `TextureUtil.prepareImage` doesn't set it).
- **Why not mipmaps (tried, reverted).** NEAREST minification on an HD cape *does* alias/shimmer at distance ([Khronos OpenGL ES ref](https://registry.khronos.org/OpenGL-Refpages/es3.0/html/glSamplerParameter.xhtml); the same gap [TextWeaks](https://modrinth.com/mod/textweaks) fixes for HD resource packs). We added a full mip chain (`GL_NEAREST_MIPMAP_LINEAR`) and it removed the shimmer — but it **also removed the detail**: the cape's content lives in a tiny 10×16-texel panel and the cape renders small in-world, so the GPU lands on a heavily-downsampled mip level and the HD image collapses to ~16 px. That's the opposite of what an HD cape is for, and it's why in-game looked far worse than the launcher model (which renders large with no mipmaps). So mipmaps were reverted.
- **Decision: plain NEAREST, no mipmaps**, matching skinview3d's editor preview exactly. Full baked resolution always reaches the screen; the trade-off is some shimmer in motion, which is preferable to a blurry/low-detail cape. If shimmer ever needs addressing without losing detail, **anisotropic filtering** (not mipmaps) is the route — keeps level-0 detail while filtering the oblique/min case.
- **Inherent ceiling.** The cape's visible art is a 10×16-texel base panel × the chosen res, so max detail is `10·res × 16·res` (res 32 → 320×512). The launcher 3D model looks sharper only because it's rendered large; in-world the cape is a small object, so even at max res a photo reads as a small, blocky image. This is a property of the cape model, not a bug.

(Content rephrased from the cited sources; see them for the canonical wording.)
