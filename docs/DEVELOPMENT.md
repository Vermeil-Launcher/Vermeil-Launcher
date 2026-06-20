# Development

> **Warning:** This codebase is AI-generated. Builds may be unstable, features may be incomplete, and runtime behavior may differ from what documentation describes. If a build fails or the app misbehaves, it may be a code issue rather than an environment issue.

## Prerequisites

The lists below are for building the **launcher**. The companion mod
(under `companion-mod/fabric/`) needs one extra tool — see [Companion mod](#companion-mod-all-platforms).

### Windows

- [Node.js 24 LTS](https://nodejs.org/) (includes npm)
- [pnpm 11](https://pnpm.io/) — `npm install -g pnpm`
- [Rust](https://rustup.rs/) — `rustup default stable`
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (C++ workload)

### Linux (Arch)

```bash
sudo pacman -S nodejs-lts-krypton npm webkit2gtk-4.1 libayatana-appindicator librsvg patchelf base-devel openssl gtk3
npm install -g pnpm
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### Linux (Ubuntu/Debian)

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf build-essential libssl-dev
```

Then install Node 24 and pnpm via [fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm), and Rust via [rustup](https://rustup.rs/).

### Companion mod (all platforms)

Only needed if you build the mod under `companion-mod/fabric/`:

- **JDK 25** — [Temurin/Adoptium](https://adoptium.net/) 25, for the 26.x
  project. The latest Minecraft (26.x) requires Java 25. Confirm with `java -version`.
- **JDK 21** — [Temurin/Adoptium](https://adoptium.net/) 21, for the 1.21.x
  projects (their era's Loom/Gradle doesn't run on 25).

No separate Gradle install is required — each project ships a Gradle wrapper
(`gradlew` / `gradlew.bat`). See [Companion Mod](#companion-mod) below
for build commands.

## Running in Development

### Windows

```powershell
cd Vermeil
pnpm install
pnpm tauri dev
```

### Linux

```bash
cd Vermeil
pnpm install
WEBKIT_DISABLE_DMABUF_RENDERER=1 pnpm tauri dev
```

The `WEBKIT_DISABLE_DMABUF_RENDERER=1` env var works around a WebKit2GTK GBM buffer issue on some GPU/Wayland configurations. If the app launches fine without it, you can omit it.

## Building for Release

```bash
cd Vermeil
pnpm tauri build
```

Outputs:
- **Windows**: `src-tauri/target/release/bundle/nsis/Vermeil_X.Y.Z_x64-setup.exe`
- **Linux**: `src-tauri/target/release/bundle/appimage/Vermeil_X.Y.Z_amd64.AppImage` and `.deb`

## Useful Commands

| Command | Where | What it does |
|---------|-------|--------------|
| `pnpm install` | `Vermeil/` | Install frontend dependencies |
| `pnpm tauri dev` | `Vermeil/` | Run app in dev mode (hot-reload) |
| `pnpm tauri build` | `Vermeil/` | Build release binaries |
| `pnpm build` | `Vermeil/` | Build frontend only (Vite) |
| `cargo check` | `Vermeil/src-tauri/` | Type-check Rust backend |
| `cargo build --release` | `Vermeil/src-tauri/` | Build Rust backend only |

## Companion Mod

The repo includes the **Vermeil companion Minecraft mod** under `companion-mod/fabric/` — a
set of separate Java/Fabric Gradle projects (the general Vermeil client mod; in-game
custom capes are its first feature). They are **not** part of the launcher's
Tauri/SolidJS build and are excluded from the `pnpm` and `cargo` pipelines; they are
built and distributed (download-on-demand) on their own.

### Prerequisites

- **JDK 25** (26.x project) and **JDK 21** (1.21.x projects) — see
  [Companion mod](#companion-mod-all-platforms) under Prerequisites.
- No system Gradle needed — each project ships a Gradle **wrapper**
  (`gradlew` / `gradlew.bat`). Fabric Loom drives the Gradle/Loom versions.

### Multi-version (separate projects per era/loader)

The mod targets multiple Minecraft eras, but **not from one codebase** — the
loader, mappings, Java version, and cape-render API differ too much across eras
to share a toolchain. So each `(era, loader)` is built as its **own standalone
Gradle project** with its own wrapper and pinned toolchain, rather than a
single-source preprocessor tree:

| Project | Minecraft range | Loader | Java | Cape hook era |
|---------|-----------------|--------|------|---------------|
| `companion-mod/fabric/26.1-26.2/` | 26.1–26.2 | Fabric | 25 | render-state (`Avatar*`) |
| `companion-mod/fabric/1.21-1.21.1/` | 1.21–1.21.1 | Fabric | 21 | feature-renderer (`CapeLayer`) |
| `companion-mod/fabric/1.21.2-1.21.4/` | 1.21.2–1.21.4 | Fabric | 21 | render-state (`PlayerRenderer`/`PlayerRenderState`) |
| `companion-mod/fabric/1.21.5-1.21.8/` | 1.21.5–1.21.8 | Fabric | 21 | render-state (`DynamicTexture` label-ctor) |
| `companion-mod/fabric/1.21.9-1.21.10/` | 1.21.9–1.21.10 | Fabric | 21 | render-state (`ResourceLocation`/`setFilter`) |
| `companion-mod/fabric/1.21.11/` | 1.21.11 | Fabric | 21 | render-state (= 26.x client source) |

Each project ships **one jar covering a range** of Minecraft versions (a Fabric
jar is intermediary-remapped, so it runs on every version where its Mixin targets
are unchanged); the folder is named for the lowest version it supports. Both use
**official Mojang mappings** and have **no Fabric API dependency** (loader + Mixins
only). Minecraft / loader / Java pins, plus the `mc_range` (jar-name label) and
`mc_versions` (exact supported list) live in each project's `gradle.properties`.

### Building & running the mod

```powershell
# from repo root, on Windows. Each project builds the same way under its own
# directory; substitute another project folder (e.g. 1.21-1.21.1) for the 26.1-26.2 build.
companion-mod\fabric\26.1-26.2\gradlew.bat build      # build the mod jar -> build/libs/vermeil-<modVersion>+<low>.jar
companion-mod\fabric\26.1-26.2\gradlew.bat runClient  # launch a dev client
companion-mod\fabric\26.1-26.2\gradlew.bat genSources # decompiled Mojang-mapped sources (research)
```

```bash
# on Linux
./companion-mod/fabric/26.1-26.2/gradlew build
./companion-mod/fabric/26.1-26.2/gradlew runClient
```

### Publishing the mod jars (download-on-demand)

The jars are **not** bundled in the launcher and **not** committed to the repo —
they're published as **GitHub release assets** and fetched on demand by the
launcher. Publishing is automated by `.github/workflows/mod-release.yml`:

- Trigger it by pushing a `mod-v*` tag (e.g. `mod-v0.1.0`), or run it manually
  via the Actions tab with a tag input.
- It builds each project (`gradlew build`), then uploads each
  `vermeil-<modVersion>+<mc_range>.jar` plus a generated `companion-manifest.json`
  (lists each jar's supported Minecraft versions, loaders, URL, SHA-1, and size) to
  a release on that tag.
- The mod is versioned independently of the launcher via `mod_version` in each
  project's `gradle.properties` (kept in sync across them).

The launcher reads the manifest, picks the jar matching an instance's Minecraft
version + loader, downloads and SHA-1-verifies it into the instance's `mods/`
(see `services/companion_mod.rs`).

Treat mod code as **unverified until built and run in-game**. Background,
research notes, and the proof-of-concept plan live in
[`docs/research/ingame-capes/`](research/ingame-capes/). Contributor conventions
for the mod (Mixin discipline, mappings research, Java naming) are documented in
the `minecraft-mod` skill under `.kiro/skills/`.

## Project Structure

```
Vermeil-Launcher/             # repo root
├── Vermeil/                  # the launcher (Tauri app)
│   ├── src/                  # SolidJS frontend
│   ├── src-tauri/            # Rust backend (Tauri)
│   │   ├── src/
│   │   │   ├── commands/     # IPC command handlers
│   │   │   ├── services/     # Business logic
│   │   │   ├── models/       # Data types
│   │   │   ├── util/         # Helpers (paths, http)
│   │   │   ├── lib.rs        # Plugin/command registration
│   │   │   └── main.rs       # Entry point
│   │   ├── Cargo.toml
│   │   └── tauri.conf.json   # Tauri config (version, window, plugins)
│   ├── package.json
│   └── vite.config.ts
├── companion-mod/            # companion Minecraft mod (Java/Fabric, separate builds)
│   └── fabric/               #   per-render-era projects: 26.1-26.2/, 1.21-1.21.1/, …
└── docs/                     # project docs + docs/research/ notes
```
