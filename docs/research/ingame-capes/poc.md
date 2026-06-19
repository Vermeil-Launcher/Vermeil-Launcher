# In-game capes — proof of concept

Smallest thing that proves the mechanism end to end, before investing in the
full version × loader matrix.

## Target for the PoC

- **Minecraft: the current stable release.** We locked onto the latest version
  (26.1.x at scaffold time). Modern render system, best-documented APIs, latest
  tooling — the fastest path to validating the idea. (1.8.9 PvP support is the
  *second* milestone, once the mechanism is proven; it needs a separate legacy
  toolchain.)
- **Loader: Fabric.** Simplest dev setup, and a Fabric jar also runs on Quilt
  via its compatibility layer, so one build covers two loaders for free.
- **Static cape only.** Animation comes after the static path works.

## What the PoC must demonstrate

1. The mod reads a cape PNG from a fixed local path.
2. It registers that PNG as a texture with the game.
3. The local player's cape renders with it **even though the account has no
   Mojang cape**, using the standard cape model.
4. Reloading with a different PNG shows the new cape.

If that works, every later piece (other loaders, 1.8.9, animation, launcher
auto-install) is an extension of a proven core.

## Naming & scope

The mod id is **`vermeil`**; the project folder is **`vermeil-mod/`**. It's the
general-purpose Vermeil client mod — capes are its first feature, but it's named
and structured so later features slot in without a rename.

## Distribution (does it ship with the exe?)

No. The mod is a separate Java **`.jar`**, built with a different toolchain; it
is not compiled into the launcher binary. Chosen model: **download on demand** —
publish the per-version/per-loader jars to our GitHub releases and have the
launcher fetch the matching one and drop it into the instance's `mods/`, the
same way it already pulls loaders, Java, and mods. (Bundling the jars in the
installer is the offline fallback, at the cost of installer size and tying mod
updates to launcher releases.)

## Tooling (to build/test the mod)

- **JDK 25** (Temurin/Adoptium) — the latest Minecraft (26.1.x) requires Java 25.
- The project's **Gradle wrapper** (`gradlew`); Fabric Loom drives the Gradle and
  Loom versions, so no separate Gradle install is needed.
- A Fabric dev client (`gradlew runClient`) to launch and inspect the result.

Exact pins (MC, Fabric loader, Fabric API, Loom, mod version) live in
`vermeil-mod/gradle.properties`, taken from the official Fabric "Develop" page
for the target MC version. The project uses **official Mojang mappings**, not
Yarn.

## Shape of the mod (Fabric)

- A standard Fabric mod: `build.gradle` (Fabric Loom), `fabric.mod.json`, a
  client entrypoint, and a Mixin into the player cape rendering.
- The Mixin makes the cape layer use our registered texture for the local
  player and forces the cape part to render when our texture is present.
- Cape file location for the PoC: a fixed path under the game/instance dir
  (final location is an open question in `research.md`).

## Still to verify before writing the Mixin

- The exact class/method the cape layer renders through on the target version,
  and vanilla's "no cape texture → skip" branch — resolved against the **official
  Mojang-mapped** decompiled sources for that version (via `genSources` +
  `javap`). This is the one real unknown; it must be confirmed from the mappings,
  not assumed. *(Resolved for 26.1.x — see `progress.md` Stage 2 investigation.)*

## Build / test reality

The mod needs a JDK + Gradle and an actual game client to build and test —
separate from the launcher's Tauri/SolidJS toolchain. In the current dev shell
JDK 25 is on PATH, so the mod **can** be built (`gradlew build`) and smoke-tested
(`gradlew runClient`) here. Even so, treat any mod code as **unverified until
built and run in-game** — a clean compile is not proof the feature renders.

## Where it lives

A separate Gradle project at **`vermeil-mod/`** (repo root) — the general
Vermeil client mod. It is **not** part of the Tauri/SolidJS build and must stay
out of the launcher's `pnpm`/`cargo` pipelines.

## After the PoC

In rough order: animation → NeoForge/Forge builds (multiloader) → 1.8.9 legacy
project → launcher-side support matrix + auto-install + cape-file writing.
