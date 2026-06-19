# In-game capes — proof of concept

Smallest thing that proves the mechanism end to end, before investing in the
full version × loader matrix.

## Target for the PoC

- **Minecraft: the current stable release** (e.g. 1.21.x). Modern render system,
  best-documented APIs, easiest tooling — the fastest path to validating the
  idea. (1.8.9 PvP support is the *second* milestone, once the mechanism is
  proven; it needs a separate legacy toolchain.)
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

## Shape of the mod (Fabric)

- A standard Fabric mod: `build.gradle` (Fabric Loom), `fabric.mod.json`, a
  client entrypoint, and a Mixin into the player cape rendering.
- The Mixin makes the cape layer use our registered texture for the local
  player and forces the cape part to render when our texture is present.
- Cape file location for the PoC: a fixed path under the game/instance dir
  (final location is an open question in `research.md`).

## Still to verify before writing the Mixin

- The exact class/method the cape layer renders through on the target version,
  and vanilla's "no cape texture → skip" branch — resolved against **official
  Yarn mappings** for that version. This is the one real unknown; it must be
  confirmed from the mappings, not assumed.

## Build / test reality

This can't be built or run in the launcher's dev environment — a Minecraft mod
needs a JDK + Gradle and an actual game client to test in. So the PoC mod is
developed and tested separately (build with Gradle, drop into a Fabric instance,
launch, look at the player's back). Treat any mod code as **unverified until
built and run in-game**.

## Where it lives

A separate Gradle project (its own folder, e.g. `cape-mod/` at the repo root, or
a dedicated repo). It is not part of the Tauri/SolidJS build and must stay out
of the launcher's `pnpm`/`cargo` pipelines.

## After the PoC

In rough order: animation → NeoForge/Forge builds (multiloader) → 1.8.9 legacy
project → launcher-side support matrix + auto-install + cape-file writing.
