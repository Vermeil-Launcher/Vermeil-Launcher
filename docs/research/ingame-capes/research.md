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
4. Animation: upload the next frame's pixels to the dynamic texture each client
   tick, driven by the same per-frame data the viewer uses. Static first;
   animation is a follow-up.

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
  the mod locates it (config or fixed path). *(Provisionally settled: the mod
  reads a fixed `<gameDir>/vermeil/cape.png` — the instance dir at runtime — via
  Fabric's game-dir API. Revisit if a shared/per-account location is needed.)*
- Per-frame animation cost in-game at high resolution.
