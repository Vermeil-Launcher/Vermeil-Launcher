# In-game capes — progress log

A running, human-readable journal of the in-game custom cape work: what was
done, the key decisions, and how each step was verified. Chronological (oldest
first). Exact diffs live in `git log`; this is the narrative behind them.

---

## Research & decisions

Commits: `9175374`, `e9b5c4f`.

- **Core constraint established.** Vanilla Minecraft only renders Mojang-granted
  capes, so a custom cape in-game needs a **client-side mod**; the launcher's
  job is to install the mod and write the cape texture to a known path.
- **Loader/version landscape verified** from official sources: NeoForge is
  1.20.2+ only; Quilt runs Fabric mods; Legacy Fabric covers 1.8.9; Architectury
  / MultiLoader-Template produce per-loader jars. "All loaders" is achievable
  per version, but the loader *set* is version-bound (1.8.9 has no NeoForge/Quilt).
- **PoC scope locked:** target latest MC + Fabric, static cape first; mod id
  `vermeil` (a general companion mod — capes are its first feature);
  distribution = **download-on-demand**, not bundled in the launcher exe.

## Stage 1 — mod scaffold that builds and loads

Commit: `21f5f66`. Status: **done, verified in-game.**

- **Toolchain reality:** the current Fabric template targets **MC 26.1.x**, which
  needs **Java 25** (the latest version bumped it up from 21). Build stack:
  Gradle 9.4.1 (via the project wrapper), Fabric Loom 1.16.3. The project uses
  **official Mojang mappings** (deobfuscated real names), not Yarn.
- **What I did:** bootstrapped from the official Fabric example-mod template (a
  guaranteed-buildable base that includes the Gradle wrapper), then stripped it
  to a minimal mod — `VermeilMod` (common init) and `VermeilModClient` (client
  init) under `com.vermeil`, a rewritten `fabric.mod.json` (id `vermeil`, MIT,
  MC `~26.1.2`), example mixins and the dead nested CI removed, the icon moved
  to `assets/vermeil/`, an MIT `LICENSE` mirrored from the launcher, and a real
  README.
- **Git hygiene:** kept the subproject `.gitignore` (excludes `build/`,
  `.gradle/`, `run/`); removed the redundant nested `.gitattributes` (the root
  one governs the whole tree); added `*.jar binary` to the root so the wrapper
  jar can't be EOL-munged.
- **Verified:** `gradlew build` → `BUILD SUCCESSFUL`, jar at
  `build/libs/vermeil-0.1.0.jar`. `gradlew runClient` → game launched, log shows
  `vermeil 0.1.0` among 51 loaded mods and both init lines fired, clean exit, no
  crash.
- **Benign warning noted:** a Loom dev-env note about an empty
  `build/resources/client` — it didn't affect loading and resolves once Stage 2
  re-adds a client mixin config.

## Stage 2 — cape rendering (in progress)

Goal: the local player's cape renders from a local PNG, even with no
Mojang-granted cape. Steps:

1. Find the cape render hook in the 26.1.2 Mojang-mapped sources (the one real
   unknown — resolved by generating and reading the decompiled sources, not
   guessing).
2. Client service: load a cape PNG from a fixed local path into a registered
   texture.
3. Mixin into the cape layer so the local player's cape uses our texture; re-add
   `vermeil.client.mixins.json`.
4. Verify with `gradlew build`, then `runClient` to see the cape on the model.

_(entries appended as each step lands)_
