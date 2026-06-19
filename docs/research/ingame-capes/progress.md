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

### Stage 2 investigation — cape pipeline on 26.1.2 (resolved from decompiled evidence)

Done by `genSources` + inspecting the Mojang-mapped classes with `javap` (no
guessing). The 26.1.x renderer uses the modern *render-state* pipeline, which is
more abstracted than older versions:

- **Renderer:** `net.minecraft.client.renderer.entity.player.AvatarRenderer`
  (the player renderer was renamed "Avatar" in 26.x). It has
  `extractRenderState(Avatar, AvatarRenderState, float)` and a private
  `extractCapeState(Avatar, AvatarRenderState, float)`.
- **Render state:** `AvatarRenderState` carries `PlayerSkin skin` and a
  `boolean showCape` (plus `capeFlap/capeLean` animation). There is no bare
  cape-`Identifier` field — the cape lives inside `skin`.
- **Skin:** `net.minecraft.world.entity.player.PlayerSkin` is a record
  `(ClientAsset.Texture body, cape, elytra; PlayerModelType model; boolean
  secure)` with a public constructor and `with(PlayerSkin.Patch)`.
- **Texture handle:** `ClientAsset.Texture` is an interface exposing
  `texturePath()` → `Identifier` (`Identifier` is the renamed `ResourceLocation`
  in 26.x). The cape layer binds that identifier.
- **Layer:** `CapeLayer` renders via the new `submit(PoseStack,
  SubmitNodeCollector, int, AvatarRenderState, …)` API.

**Chosen hook:** Mixin the tail of the avatar render-state extraction — when the
player has no cape (`skin.cape() == null`) and our custom cape is active, set
`showCape = true` and replace `skin` with one whose `cape()` points at our
texture. The vanilla `CapeLayer` then renders it through the normal path.

**Texture source (incremental):** first prove the hook with a procedurally
generated `DynamicTexture` registered under a `vermeil:cape` identifier (no
binary asset to author, fully code). Once the cape visibly renders, swap the
texture's pixels for ones read from the launcher's local cape file.

Implementation lands next (mixin + client init + re-added
`vermeil.client.mixins.json`), build-verified here, then `runClient` to confirm
the cape shows on the player's back.

## Process & tooling — mod standards captured (before Stage 2 impl)

- Added a `minecraft-mod` skill (`.kiro/skills/minecraft-mod/SKILL.md`) capturing
  the mod's real toolchain (JDK 25, Gradle wrapper, Loom, official Mojang
  mappings), the build/`runClient` verify loop, the genSources/`javap`
  "verify mappings, never guess" research discipline, Mixin conventions, Java
  naming, distribution model, and the originality rule — so this knowledge isn't
  re-derived each time.
- Added a "Research Docs Are Living" rule to `implementation-process.md`:
  `docs/research/<feature>/` notes are updated in the same change that makes a
  decision real, with a `progress.md` entry per milestone. This entry is the rule
  applied to itself.
- Registered `vermeil-mod/` in `coding-standards.md` and documented the mod's
  build/prereqs in `docs/DEVELOPMENT.md`.
- **Doc-currency fix:** reconciled `poc.md` / `research.md` with reality — they
  still named JDK 21, Gradle 8.x, Yarn mappings, MC 1.21.x and claimed the mod
  couldn't be built in the dev shell. Updated to JDK 25, the Gradle wrapper,
  official Mojang mappings, latest MC, and the fact the mod builds/runs here.
