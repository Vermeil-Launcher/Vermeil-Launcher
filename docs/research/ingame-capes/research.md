# In-game custom cape rendering — research

Goal: show a user's local custom cape **inside the game** (not only our 3D
viewer), targeting the versions where it matters most — **1.8.9** (PvP) and the
**latest release** — on as many mod loaders as each version supports.

All findings below are from official docs/specs (cited inline). No other
launcher/client/mod source was consulted. Any implementation is written from
scratch against the official modding APIs.

## Hard constraint

Vanilla Minecraft only renders a cape the account was actually granted
(Mojang-hosted). There is no vanilla path for an arbitrary local texture. So an
in-game custom cape requires a **client-side mod** that hooks player cape
rendering. The launcher's role is only: install the right mod into the instance
and write the cape texture where the mod reads it.

## Loader / version reality (verified)

- **NeoForge**: recommended for Minecraft **1.20.2+** only (NeoForge docs:
  https://docs.neoforged.net/). It cannot target 1.8.9 — a hard limit of the
  loader, not a choice.
- **Quilt**: a Fabric superset that runs almost all Fabric mods
  (https://quiltmc.org/). So a Fabric build generally also covers Quilt. Modern
  versions only.
- **Legacy Fabric**: community project providing a Fabric loader + API backport
  for **1.8.9** and other legacy versions (Legacy-Fabric on GitHub; Legacy
  Fabric API on Modrinth/CurseForge). This is how Fabric-style mods run on 1.8.9.
- **Forge**: exists for both 1.8.9 and modern versions.
- **Multiloader builds**: Architectury Loom / the MultiLoader-Template are the
  standard way to share one codebase and emit per-loader jars
  (https://docs.architectury.dev/; jaredlll08/MultiLoader-Template). NeoForge
  uses official Mojang mappings (no SRG intermediary).

### Available loaders per target version

| Version | Loaders that exist |
|---------|--------------------|
| 1.8.9 (PvP) | Forge, Legacy Fabric |
| Latest (e.g. 1.21.x) | Fabric, Quilt (Fabric compat), NeoForge, Forge |

So "works on **all** loaders" is achievable **per version**, but the loader
*set* is version-bound: 1.8.9 simply has no NeoForge or Quilt. We document this
gap rather than implying universal coverage.

## Rendering mechanism (concept — to implement originally)

1. The launcher writes our baked cape PNG (the same atlas the editor produces)
   to a known local path.
2. The mod loads it as a dynamic/native texture registered under our own
   resource identifier with the game's texture manager.
3. The mod hooks player cape rendering so the local player's cape draws with our
   texture even when the account has no Mojang cape (vanilla skips the cape part
   when there's no cape texture). The exact hook target (class/method) is
   **version-specific** and resolved against official mappings. (Our PoC pins
   **official Mojang mappings** even on Fabric — Loom supports this — so the
   decompiled names match the code; see `progress.md`.)
4. Animation: the on-disk cape is a **vertical frame strip** of square frames
   (PNG only — the game's texture decoder is PNG-only), with an optional
   `cape.json` for frame time. The mod decodes the strip into frames and cycles
   them by implementing the game's `TickableTexture` (the texture manager ticks
   it on the render thread), uploading the next frame only when it changes. The
   launcher bakes its editor's animation into the strip; the source format
   (GIF/APNG/WebP) is decoded launcher-side, not by the mod.

Notes:
- In-game cape geometry/UV is the standard cape model — the same atlas layout
  the editor already bakes to — so our texture is directly reusable.
- Multiplayer: a client mod only renders our cape **locally** (and for others
  running the same mod). Other players won't see it otherwise. Inherent to a
  client-side, no-server approach.

## Launcher integration

- Maintain a **support matrix** = the `(version, loader)` pairs we ship a
  renderer for.
- On enabling in-game view for a supported instance: drop the matching jar into
  `mods/` and write the cape texture (+ frames) to the agreed path.
- Unsupported instances (including vanilla / no loader): viewer-only, as today.
- Per-loader jars are launcher-agnostic — a Fabric jar runs under any launcher
  that loads Fabric — so the launcher just places the file.

## Build-structure thought

Likely **two** mod projects, not one:
- **Modern** multiloader project (latest version → Fabric/Quilt/NeoForge/Forge)
  via Architectury / MultiLoader-Template.
- **Legacy** project for 1.8.9 (Forge 1.8.9 + Legacy Fabric) — old toolchain,
  probably can't share the modern build setup.

## Open questions (verify before building)

- Exact cape render hook on 1.8.9 vs latest, resolved against official mappings;
  confirm vanilla's "no cape texture → skip cape" branch so we can override it.
- Does 1.8.9 (Legacy Fabric + Forge 1.8.9) fit a shared multiloader project, or
  need a separate legacy project? (Likely separate.)
- Where to write the cape file (instance dir vs a shared launcher dir) and how
  the mod locates it (config or fixed path). *(Settled: one shared launcher dir
  for the mod's data. The mod resolves it from the `vermeil.dataDir` system
  property when set, falling back to `<gameDir>/vermeil/` for a launcher-less
  manual install. The launcher stores the cape once under `<data>/companion/`
  (`cape.png` + `cape.json`) — the mod's data home generally, not cape-specific —
  and injects `-Dvermeil.dataDir=<that dir>` at launch for supported instances, so
  the cape isn't duplicated per instance and every instance type behaves
  identically.)*
- Per-frame animation cost in-game at high resolution. *(Mitigated: frames are
  decoded once and capped to a memory budget; uploads happen only on frame change,
  not every tick. Revisit if very high-res HD strips prove costly.)*

## Target version matrix (decided)

Shipped versions: **26.x (Fabric)**, **1.21.x (Fabric)**, **1.8.x (Forge)**. All
are achievable — a client mod can render a custom cape on each — but **not from
one jar or one codebase**: the loader, mappings, Java version, and cape-render
API differ across Minecraft's eras. The exact hook names per version are
confirmed at build time from that version's decompiled sources (genSources /
MCP), not assumed here; what's fixed is the *era* each version belongs to.

(Earlier drafts also listed 1.20.1 and 1.12.2; both were **dropped** to keep the
matrix to the three the user ships. Forge does **not** exist for the 26.x
versioning scheme — verified against files.minecraftforge.net, whose newest build
is 1.21.x — so 26.x is Fabric-only and that's not a closable gap; NeoForge was
not adopted there.)

| Version | Loader | Java | Mappings | Cape render era | Cape texture |
|---------|--------|------|----------|-----------------|--------------|
| 26.x | Fabric (Quilt rides free) | 25 | Mojang | render-state (`AvatarRenderer.extractRenderState`, `CapeLayer.submit`, `PlayerSkin`) — **built/verified on 26.2** | 64×64 |
| 1.21.x | Fabric (Quilt rides free) | 21 | Mojang/Yarn | sub-version dependent: 1.21.2+ = render-state (`Player*`); 1.21.0–1.21.1 = feature-renderer (`CapeFeatureRenderer`) | 64×64 |
| 1.8.x | Forge | 8 | MCP/SRG | legacy (`LayerCape`, `AbstractClientPlayer.getLocationCape()`) | 64×32 |

### The porting families

1. **Modern Fabric (render-state)** — 26.x + 1.21.2+. Closest to what's built; the
   current hook nearly transfers (note 26.x renamed `Player*` → `Avatar*`, so the
   class names differ even within this family). Mostly version bumps + mapping tweaks.
2. **Mid Fabric (feature-renderer)** — only if a 1.21.0/1.21.1 sub-version is pinned:
   a different hook, `CapeFeatureRenderer` instead of `CapeLayer.submit`.
3. **Legacy Forge** — 1.8.x. Separate project: Forge (not Fabric), MCP/SRG
   mappings, Java 8, ancient ForgeGradle toolchain, `LayerCape` hook, and
   **64×32** cape textures. Heaviest lift; 1.8.x is the PvP target.

### Ripples into the launcher

- The cape baker already produces both 64×32 (editor/skinview3d) and 64×64 (mod).
  Legacy targets want 64×32, modern want 64×64 → the launcher picks the layout per
  target version.
- `instance_cape::is_supported` / `version_supported` grow from "26.x only" into a
  real `(version range, loader)` table, and download-on-demand fetches the matching
  per-version jar.

### Build order (easiest-reusing-first)

1. **26.x Fabric** — render-state family. ✓ built (the current `vermeil-mod/`).
2. **1.21.x Fabric** — render-state if a 1.21.2+ sub-version is pinned (reuse the
   hook with `Player*` names), or feature-renderer if 1.21.0–1.21.1 is pinned.
3. **1.8.x Forge** — legacy `LayerCape`, separate Java-8 ForgeGradle project.

Build system: **separate standalone Gradle projects per era/loader** — Stonecutter
was tried and dropped (see below).


## Loader scope — decided (Plan A)

We ship **two loader families**, not four. Quilt and NeoForge are dropped as
explicit targets:

- **Quilt** — never needs its own build: Quilt loads Fabric mods through its
  Fabric-compat layer, so the Fabric jar covers Quilt for free.
- **NeoForge** — dropped to keep scope manageable. (Note for the record: on
  *modern* versions NeoForge is actually the dominant Forge-family loader and
  classic Forge is the fading one — so this is a deliberate reach-vs-effort
  tradeoff, not "NeoForge is unpopular." Revisit if modern Forge-side demand
  appears; Plan B in the chat history adds it.)

Plan A target set:

1. **Fabric for the modern versions** — one toolchain family, the biggest reach for
   the least work. Fabric for 1.21.x and 26.x; Quilt covered free.
2. **Classic Forge, legacy only** — 1.8.x, where classic Forge is the relevant
   loader (NeoForge didn't exist then, and Legacy Fabric for 1.8.x is a niche
   backport not worth the separate toolchain — Forge only).

So the shipped `(version, loader)` jars under Plan A:

| Version | Fabric jar | Forge jar |
|---------|------------|-----------|
| 26.x    | Fabric (✓ built) | — (no Forge for 26.x) |
| 1.21.x  | Fabric     | —         |
| 1.8.x   | — (no Legacy Fabric) | Forge |

Build-system decision (locked): **separate standalone Gradle projects per
era/loader** — each with its own wrapper and pinned toolchain. Stonecutter (a
single-source multi-version preprocessor) was tried and **dropped**; see the next
section.


## Build structure: separate projects per era/loader (Stonecutter dropped)

Stonecutter (`dev.kikugie.stonecutter`, a single-source multi-version preprocessor)
was set up and built two 26.x nodes, then **dropped** — it caused too many problems
in practice. The replacement is simpler and more robust: **each `(era, loader)` is
its own standalone Gradle project** with its own wrapper and pinned toolchain. No
shared `src/` with `//? if` comment toggling, no generated `versions/<node>/` tree,
no per-node controller.

Why separate projects is the right call here (not a step back):
- The eras genuinely **can't share a toolchain**: 26.x is Java 25 / Loom 1.16 /
  Mojang mappings; 1.8.x is Java 8 / ancient ForgeGradle / MCP-SRG. ForgeGradle for
  1.8.x won't even run under the Gradle 9 the 26.x build needs. A preprocessor can't
  paper over two incompatible Gradle/Java/loader stacks.
- With only three targets across three different render eras, there's little shared
  source to factor out — the cape hook differs per era anyway. The preprocessor's
  upside (one source, many jars) barely applies, while its downsides (toggling noise,
  VCS-version discipline, tooling friction) all bite.
- Each project stays a plain, conventional Fabric/Forge mod — easy to read, build,
  and verify against its own genSources, with no preprocessor layer in between.

Planned layout (the 26.x project exists today as `vermeil-mod/`; siblings are added
as their own projects):

| Project | MC | Loader | Java | Toolchain | Cape hook |
|---------|----|--------|------|-----------|-----------|
| Fabric 26.x (built) | 26.x | Fabric | 25 | Loom 1.16, Mojang mappings | render-state (`AvatarRenderer.extractRenderState`, `CapeLayer.submit`, `AvatarRenderState`) |
| Fabric 1.21.x | 1.21.x | Fabric | 21 | Loom, Mojang/Yarn | render-state (`PlayerRenderer`/`PlayerRenderState`) if 1.21.2+ pinned; `CapeFeatureRenderer` if 1.21.0–1.21.1 |
| Forge 1.8.x | 1.8.x | Forge | 8 | ForgeGradle, MCP/SRG | legacy `LayerCape` + `AbstractClientPlayer.getLocationCape()`, 64×32 texture |

Each project's cape-render hook is verified against **that version's own**
genSources/decompiled sources (verify-don't-guess, per the minecraft-mod skill) —
what's true on one era is never assumed on another. The shared *concept* (load a
local cape PNG → register a texture → force the local player's cape to use it) is
re-implemented per era against that era's API, not shared as code.

**Build order:** 26.x Fabric (done) → 1.21.x Fabric (closest reuse) → 1.8.x Forge
(heaviest lift, new toolchain). Each ships its `vermeil-<modVersion>+<mc>.jar` to
the same `mod-v*` GitHub release; the manifest tags each jar with its loader, and
the launcher picks by `(version, loader)`.

