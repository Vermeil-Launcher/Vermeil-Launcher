---
name: minecraft-mod
description: Work on the Vermeil companion Minecraft mod (Java/Fabric/Mixin) under companion-mod/fabric/. Use when writing or changing mod code, adding a cape/render feature, hooking the game with a Mixin, resolving mappings, or building/running the mod with Gradle. Relevant terms include fabric, mixin, java, gradle, loom, cape, render, companion-mod, genSources, runClient.
---

# Working on the Vermeil Companion Mod

The Vermeil companion mod is a set of **separate Gradle/Java projects** under
`companion-mod/fabric/` (repo root) — one per render-era (see the table below).
They are NOT part of the launcher's Tauri/SolidJS build and must stay out of the
`pnpm` and `cargo` pipelines. It's the general-purpose Vermeil client mod — capes
are its first feature, but it's named/structured so later features slot in
without a rename. Mod id is `vermeil`, package root `com.vermeil`.

## Toolchain (exact, pinned)

These are the real versions each project builds with. Don't substitute from
memory — check that project's `gradle.properties` and `build.gradle` for the
current pins.

- **JDK 25** (Temurin/Adoptium). The latest Minecraft (26.1.x) requires Java 25.
  `build.gradle` sets `options.release = 25` and `sourceCompatibility = 25`.
- **Gradle via the project wrapper** (`gradlew` / `gradlew.bat`) — do not rely on
  a system Gradle. Loom drives the Gradle version.
- **Fabric Loom** (`loom_version` in `gradle.properties`).
- **Official Mojang mappings** (deobfuscated real names) — NOT Yarn. Method and
  class names you see in genSources output are the names you use in code.
- **MC / loader** versions are pinned in `gradle.properties`
  (`minecraft_version`, `loader_version`). Pin exact values
  from the official Fabric "Develop" page (https://fabricmc.net/develop) for the
  target MC version. The mod intentionally has **no Fabric API dependency** — it
  uses only the loader plus Mixins (a client-tick Mixin drives the cape
  watcher), so it builds across MC eras on one Loom without Fabric API's
  access-widener remapping getting in the way.

## I can build and run this from the agent shell

JDK 25 is on PATH in the dev shell, so the mod CAN be built and smoke-tested here
(unlike the launcher's runtime, which needs a real install). Use it — treat mod
code as **unverified until built and run in-game**.

Gradle resolves the project from the **current working directory**, not from where
`gradlew` lives — so always pass `-p <project-dir>`. Running the wrapper by path
alone from the repo root fails with "does not contain a Gradle build".

- Build: `.\companion-mod\fabric\26.1-26.2\gradlew.bat -p companion-mod\fabric\26.1-26.2 build`
  → builds the mod jar at
  `companion-mod/fabric/26.1-26.2/build/libs/vermeil-<modVersion>+<low>.jar`. Expect `BUILD SUCCESSFUL`.
- Run in-game: `.\companion-mod\fabric\26.1-26.2\gradlew.bat -p companion-mod\fabric\26.1-26.2 runClient`
  → launches a dev client; confirm the init log lines fire (`Vermeil mod initialized.` /
  `Vermeil client initialized.`) and the feature renders, then exit cleanly with no crash.
  (Swap `26.1-26.2` for another project folder, e.g. `1.21-1.21.1`, in both places.)
- Use `git -C` for git; run `gradlew` with `-p`. PowerShell shell — chain with
  `;`, never `&&`.

## Multi-version (separate projects per era/loader)

Stonecutter was tried and **dropped** — it caused too many problems. The mod
targets multiple Minecraft eras, but **not from one codebase**: loader, mappings,
Java version, and cape-render API differ too much to share a toolchain (Java 25
Fabric vs Java 8 Forge can't even share a Gradle). So each `(era, loader)` is its
**own standalone Gradle project** with its own wrapper and pinned toolchain.

Built projects:

| Project | Minecraft range | Loader | Java | Cape hook |
|---------|-----------------|--------|------|-----------|
| `companion-mod/fabric/26.1-26.2/` | 26.1–26.2 | Fabric | 25 | render-state (`AvatarRenderer.extractRenderState`, `CapeLayer.submit`) |
| `companion-mod/fabric/1.21-1.21.1/` | 1.21–1.21.1 | Fabric | 21 | feature-renderer (`@Redirect` `getSkin()` in `CapeLayer.render`) |
| `companion-mod/fabric/1.21.11/` | 1.21.11 | Fabric | 21 | render-state (= 26.x client source: `Identifier` + sampler) |

Three intermediate 1.21.x render-state eras — **1.21.2–1.21.4**, **1.21.5–1.21.8**,
**1.21.9–1.21.10** — are built and compile-verified but **archived** under
`companion-mod/archive/fabric/` to keep the active maintenance surface small (a new
mod feature would otherwise have to be ported into every era). They're out of CI,
the launcher support gate, and the manifest. To restore one, see the README in
`companion-mod/archive/`.

Each is plain Fabric, MC/loader/Java pins in `gradle.properties`, official Mojang
mappings, **no Fabric API** (loader + Mixins only) — no preprocessor comments, no
`versions/` nodes. Verify every project against **its own** genSources; what's true
on one version is not assumed on another. Note: the 1.21.1-era Loom needs
fabric-loader as `modImplementation` (not `implementation`) to put Mixin on the
classpath; the 26.x-era Loom doesn't.

### One jar per render-era, named with its range

A project covers a **range** of Minecraft versions with a **single jar**, because
a Fabric jar (shipped in intermediary mappings) runs on every version where the
members its Mixins target are unchanged. The boundary between projects is a
**render-pipeline change**, not a version number — e.g. 1.21.2 switched from the
feature-renderer to the render-state cape path, so `1.21`–`1.21.1` and `1.21.2`+
can't share a jar even though both are "1.21.x".

Each `gradle.properties` carries:
- `minecraft_version` — the *representative* version the jar compiles against (the
  newest in the range, for the freshest mappings).
- `mc_range` — the supported span as `<low>-<high>`; `build.gradle` derives the
  `fabric.mod.json` `depends.minecraft` predicate from it (`26.1-26.2` →
  `>=26.1 <=26.2`). The **jar name uses only the low end** (the lowest supported
  version): `vermeil-<modVer>+<low>.jar` (e.g. `vermeil-0.1.4+26.1.jar`), so the
  filename stays short. The **folder** is named by the full range (`26.1-26.2/`),
  so folder and jar label intentionally differ.
- `mc_versions` — the exact comma-separated versions the jar supports. CI emits one
  `companion-manifest.json` entry per project with `minecraftVersions: [<list>]`,
  and the launcher matches an instance's exact version against that list.

**Confirm a range is really one jar by compiling against both endpoints** (low and
high) — if both build, the targeted members exist across the span. If an endpoint
fails, the era isn't uniform and must be split into a new project. The launcher's
`instance_cape::version_supported` allow-list must stay in lockstep with the union
of every project's `mc_versions`.

## Research before hooking: verify mappings, never guess

The hard unknown in mod work is always **the exact class/method the game renders
through on a specific version**. Resolve it from evidence, not memory:

1. `gradlew.bat genSources` to generate decompiled, Mojang-mapped sources.
2. Inspect the relevant classes — read the decompiled source and/or `javap` the
   compiled classes to confirm method names, descriptors, field types, and
   record/constructor shapes.
3. When a method has multiple overloads (bridge methods), confirm the exact
   descriptor you're targeting so the Mixin binds the right one.
4. Only then write the Mixin against names you've verified exist.

Mapping/API details differ between versions; what's true for 26.1.x is not
assumed true for 1.8.9. Re-verify per target version.

## Mixin conventions

- Client-side mixins go in a client mixin config (e.g. `vermeil.client.mixins.json`),
  wired into `fabric.mod.json` under `"mixins"`. Add the config back when you add
  the first client mixin — Loom warns about an empty client resources dir until
  then; that warning is benign.
- Hook the narrowest seam that achieves the goal (a render-state extraction tail,
  not a wholesale renderer override). Preserve vanilla behavior for every case
  your feature doesn't own.
- Prefer code-generated/`DynamicTexture` resources registered under a `vermeil:`
  identifier over shipping binary assets, when practical.

## Java code conventions

| Context | Convention | Example |
|---------|-----------|---------|
| Packages | lowercase, `com.vermeil[.client]` | `com.vermeil.client` |
| Classes | PascalCase | `VermeilModClient` |
| Methods/fields/vars | camelCase | `onInitializeClient` |
| Constants | SCREAMING_SNAKE | `MOD_ID` |

- Common (both-environment) init in `com.vermeil.VermeilMod`; client-only init in
  `com.vermeil.client.VermeilModClient`. Keep client-only code in the `client`
  source set.
- Log with the mod's SLF4J `LOGGER` (`VermeilMod.LOGGER`), not `System.out`.
- Javadoc the entrypoints and any non-obvious hook with *what our code does* —
  never frame it as derived from another mod/client (see Originality below).

## Cross-platform note

The mod is a JVM `.jar` — platform-agnostic by nature, so the Windows↔Linux
parity rule that governs the launcher doesn't bite the same way here. The launcher
side that installs/places the jar and writes the cape file still must work on both
platforms; verify that part per the launcher's Cross-Platform Parity rule.

## Distribution

The jar does NOT ship inside the launcher exe or get committed to the repo. Model
is **download-on-demand**: `.github/workflows/mod-release.yml` (triggered by a
`mod-v*` tag or manual dispatch) builds every project and uploads each
`vermeil-<modVersion>+<low>.jar` plus a generated `companion-manifest.json`
to a GitHub release. The mod is versioned independently of the launcher
(`mod_version` in each project's `gradle.properties`; kept in sync across them).
manifest and fetches the matching jar (SHA-1-verified) into the instance's
`mods/`, like it does for loaders/Java/mods — see `services/companion_mod.rs`.
The jar filename is set by `base.archivesName = 'vermeil'` + `version =
"<modVersion>+<low>"` in `build.gradle` (where `<low>` is the lowest supported
version, split from the `mc_range` property).

## Keep the research docs current

Tracked in `docs/research/ingame-capes/` (`research.md`, `poc.md`, `progress.md`) —
living docs. Update in the same change that makes a decision/toolchain/hook real;
add a terse `progress.md` milestone bullet. **Keep them token-cheap: bullets not
prose, what IS not what's planned.** See the research-docs rule in
`implementation-process.md`.

## Originality (strict)

All mod code, comments, commits, and research notes describe what **our** code
does. Never reference, compare to, or reimplement another launcher's, client's, or
mod's source. Research only from official sources: Fabric/Quilt/NeoForge/Forge
docs, Mojang mappings, the Minecraft Wiki, Architectury. Third-party services and
APIs (Modrinth, CurseForge, Mojang endpoints) may be named normally.

## Verification checklist

- `gradlew.bat build` → `BUILD SUCCESSFUL`.
- `gradlew.bat runClient` → loads with no crash; feature visible; clean exit.
- Zero new warnings you introduced (Loom's empty-client-resources note pre-first-mixin excepted).
- Mappings/hook targets confirmed from genSources/`javap`, not memory.
- Research docs updated; `progress.md` milestone entry added.
- Committed and pushed (Conventional Commits, scope e.g. `mod`).
