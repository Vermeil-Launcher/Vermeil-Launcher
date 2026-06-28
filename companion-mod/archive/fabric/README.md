# Archived companion-mod projects

These are fully built, compile-verified Fabric projects for **older 1.21.x eras**
that the launcher no longer ships:

| Project | Minecraft range | Cape hook |
|---------|-----------------|-----------|
| `1.21-1.21.1/` | 1.21–1.21.1 | feature-renderer, `@Redirect` `getSkin()` in `CapeLayer.render` |
| `1.21.2-1.21.4/` | 1.21.2–1.21.4 | render-state, `ResourceLocation` + single-arg `DynamicTexture` |
| `1.21.5-1.21.8/` | 1.21.5–1.21.8 | render-state, `DynamicTexture` label-ctor |
| `1.21.9-1.21.10/` | 1.21.9–1.21.10 | 26.x-shaped hook, `ResourceLocation` + `setFilter` + `Tickable` |

## Why they're here

Each render-era is its own source variant, so every new mod feature that touches
the render/texture API has to be ported into each one. To keep that surface small,
the launcher actively supports only two Fabric eras — `1.21.11` (= 26.x source)
and `26.1-26.2` — plus the legacy Forge `1.8.9`. These older eras were moved out
of `companion-mod/fabric/` so they're not built by CI, not advertised by the
launcher, and not listed in the published manifest — but the source is kept,
verified, ready to bring back.

They live under `companion-mod/archive/` (not `companion-mod/fabric/`) on purpose:
the CI manifest builder globs `companion-mod/fabric/*/`, so anything here is
invisible to it.

## Restoring one

1. Move it back: `git mv companion-mod/archive/fabric/<proj> companion-mod/fabric/<proj>`
2. Re-add it to CI: in `.github/workflows/mod-release.yml`, add its `gradlew` to the
   `chmod` line and add the matching `sed` + `(cd … && ./gradlew build)` step (JDK 21).
3. Re-add its versions to the launcher gate: `FABRIC_SUPPORTED` in
   `Vermeil/src-tauri/src/services/instance_cape.rs` (use the project's `mc_versions`).
4. Add its row back to the tables in `docs/DEVELOPMENT.md` and the `minecraft-mod` skill.
5. Build to confirm it still compiles against current mappings:
   `.\companion-mod\fabric\<proj>\gradlew.bat -p companion-mod\fabric\<proj> build`

The manifest entry is automatic once the project is back under `companion-mod/fabric/`.
