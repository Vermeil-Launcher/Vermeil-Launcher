# In-game capes — progress

Terse journal. Exact diffs in git.

## Mod scaffold + 26.x cape (Fabric, render-state)
- Scaffolded the `vermeil` Fabric mod (now `vermeil-fabric-26/`): JDK 25, Loom 1.16, official Mojang mappings, no Fabric API (loader + Mixins only).
- Hook (verified via genSources): tail of `AvatarRenderer.extractRenderState` — swap `AvatarRenderState.skin.cape()` → `vermeil:cape`, force `showCape`; `CapeLayer.submit` draws it. Local player only; never overrides a real cape.
- Texture: `VermeilCape` loads `<dataDir>/cape.png`; `VermeilCapeTexture` (DynamicTexture + tickable) cycles animation frames; `MinecraftClientMixin` runs a ~1s file watcher off `Minecraft.tick` tail.
- Cape format: square slot per frame → cropped to 2:1 (W×W/2) so it doesn't render as a "half cape".
- Verified in-game: animated cape on the player's back.

## Launcher integration
- Global cape at `<data>/companion/` (`cape.png` + `cape.json` mirroring toggle/frame-time). `-Dvermeil.dataDir` injected at launch for supported instances; running instances live-reload.
- Skins screen: one "Show in-game" toggle. `bakeModCapeStrip()` re-lays the editor atlas into the mod's 64×64 square-slot strip. IPC: set / clear / get / set-enabled.
- Download-on-demand (`companion_mod.rs`): fetch latest non-draft `mod-v*` manifest, pick the `(MC, loader)` jar, SHA-1-verify into `mods/`; remove when off/unsupported. CI `mod-release.yml` builds + publishes jars + `companion-manifest.json`.

## Dropped Stonecutter; locked matrix
- Stonecutter multi-version caused too many problems → **one standalone Gradle project per (era, loader)**.
- Matrix: Fabric 26.x, Fabric 1.21.x, Forge 1.8.x. No classic Forge for 26.x → Fabric-only there.
- Renamed `vermeil-mod/` → `vermeil-fabric-26/`. Dropped Fabric API (its only use was a client-tick event, now `MinecraftClientMixin`).
- Launcher support gate narrowed to the built versions.

## 1.21.1 (Fabric, feature-renderer)
- `vermeil-fabric-1.21/`: Loom 1.7.4, JDK 21, Mojang mappings, no Fabric API.
- Hook (verified via genSources): `@Redirect` `getSkin()` in `CapeLayer.render` → `PlayerSkin` with `capeTexture()` = `vermeil:cape` for the local capeless player. 1.21.1 is pre-render-state; no `isCapeLoaded()` guard.
- 1.21.1 API vs 26.x: `ResourceLocation` (not `Identifier`), `getPixelRGBA`/`setPixelRGBA` raw copy, single-arg `DynamicTexture`, `Tickable`.
- Loom gotcha: fabric-loader must be `modImplementation` (not `implementation`) for Loom to put Mixin on the classpath.
- Verified: builds; `runClient` loads + registers the animated cape in-world, no errors. Eyes-on third-person check pending.


## Cape fixes (post-0.6.2 testing)
- **Crisp render:** the cape texture defaulted to LINEAR magnification → blurry. Now NEAREST. 26.x: reassign `AbstractTexture.sampler` to NEAREST/NEAREST (`RenderSystem.getSamplerCache().getSampler(...)`); 1.21.1: `setFilter(false, false)` (default mag was GL_LINEAR; `prepareImage` doesn't set it). Verified vs each version's genSources.
- **Overrides Mojang cape:** the custom cape now wins even when the account has a real cape (both mixins; was an early-return guard). Enabling = "use this".
- **Click-to-equip + sync (Skins.tsx):** clicking a custom cape equips it (viewer + bakes/sets in-game) like a normal cape; clicking it again or selecting a Mojang/"No cape" turns it off; on entering Skins the selection is restored from the saved in-game state, fixing the "nothing selected but still enabled" desync. Removed the separate "Show in-game" toggle.
