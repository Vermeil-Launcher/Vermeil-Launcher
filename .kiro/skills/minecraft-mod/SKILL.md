---
name: minecraft-mod
description: Work on the Vermeil companion Minecraft mod (Java/Fabric/Mixin) in vermeil-mod/. Use when writing or changing mod code, adding a cape/render feature, hooking the game with a Mixin, resolving mappings, or building/running the mod with Gradle. Relevant terms include fabric, mixin, java, gradle, loom, cape, render, vermeil-mod, genSources, runClient.
---

# Working on the Vermeil Companion Mod

The Vermeil companion mod is a **separate Gradle/Java project** at `vermeil-mod/`
(repo root). It is NOT part of the launcher's Tauri/SolidJS build and must stay
out of the `pnpm` and `cargo` pipelines. It's the general-purpose Vermeil client
mod — capes are its first feature, but it's named/structured so later features
slot in without a rename. Mod id is `vermeil`, package root `com.vermeil`.

## Toolchain (exact, pinned)

These are the real versions this project builds with. Don't substitute from
memory — check `vermeil-mod/gradle.properties` and `build.gradle` for the
current pins.

- **JDK 25** (Temurin/Adoptium). The latest Minecraft (26.1.x) requires Java 25.
  `build.gradle` sets `options.release = 25` and `sourceCompatibility = 25`.
- **Gradle via the project wrapper** (`gradlew` / `gradlew.bat`) — do not rely on
  a system Gradle. Loom drives the Gradle version.
- **Fabric Loom** (`loom_version` in `gradle.properties`).
- **Official Mojang mappings** (deobfuscated real names) — NOT Yarn. Method and
  class names you see in genSources output are the names you use in code.
- **MC / loader / Fabric API** versions are pinned in `gradle.properties`
  (`minecraft_version`, `loader_version`, `fabric_api_version`). Pin exact values
  from the official Fabric "Develop" page (https://fabricmc.net/develop) for the
  target MC version.

## I can build and run this from the agent shell

JDK 25 is on PATH in the dev shell, so the mod CAN be built and smoke-tested here
(unlike the launcher's runtime, which needs a real install). Use it — treat mod
code as **unverified until built and run in-game**.

- Build: `vermeil-mod\gradlew.bat build` → builds the **active** Stonecutter node;
  jar at `vermeil-mod/versions/<node>/build/libs/vermeil-<version>.jar`. Expect
  `BUILD SUCCESSFUL`.
- Build all versions: `vermeil-mod\gradlew.bat chiseledBuild`.
- Run in-game: `vermeil-mod\gradlew.bat runClient` → launches the active node's
  client; confirm the init log lines fire (`Vermeil mod initialized.` / `Vermeil
  client initialized.`) and the feature renders, then exit cleanly with no crash.
- Use `git -C` for git; run `gradlew` directly. PowerShell shell — chain with
  `;`, never `&&`.

## Multi-version (Stonecutter)

The mod is a **Stonecutter** multi-version project (`dev.kikugie.stonecutter`):
one shared source tree in `src/`, one node per Minecraft version under
`versions/<version>/`. Per-node pins (MC / loader / Fabric API / `java_version`)
live in `versions/<version>/gradle.properties`; shared values in root
`gradle.properties`; `settings.gradle` registers the nodes via
`stonecutter { create(rootProject) { versions(...) ; vcsVersion = ... } }`. The
generated `stonecutter.gradle.kts` controller holds the active node. Gate the few
version-specific lines with `//? if <cond> { … }` comments (the cape render hook
differs by era — render-state vs `CapeFeatureRenderer`). `build.gradle` is one
shared script that runs per node; read per-node values via `project.<prop>` and
branch on `stonecutter`/`sc` (e.g. `sc.current.version`). Verify each node against
**its own** genSources — what's true on one version is not assumed on another.

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

The jar does NOT ship inside the launcher exe. Model is **download-on-demand**:
publish per-version/per-loader jars to GitHub releases; the launcher fetches the
matching one into the instance's `mods/`, like it already does for loaders/Java/mods.

## Keep the research docs current

This feature is tracked in `docs/research/ingame-capes/` (`research.md`, `poc.md`,
`progress.md`). They are **living** documents: when a decision, toolchain fact, or
hook target changes, update them in the same change, and add a `progress.md` entry
per milestone. See the research-docs rule in `implementation-process.md`.

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
