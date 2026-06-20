# Development

> **Warning:** This codebase is AI-generated. Builds may be unstable, features may be incomplete, and runtime behavior may differ from what documentation describes. If a build fails or the app misbehaves, it may be a code issue rather than an environment issue.

## Prerequisites

The lists below are for building the **launcher**. The companion mod
(`vermeil-fabric-26/`) needs one extra tool — see [Companion mod](#companion-mod-all-platforms).

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

Only needed if you build the mod in `vermeil-fabric-26/`:

- **JDK 25** — [Temurin/Adoptium](https://adoptium.net/) 25. The latest
  Minecraft (26.1.x) requires Java 25. Confirm with `java -version`.

No separate Gradle install is required — the mod ships a Gradle wrapper
(`gradlew` / `gradlew.bat`). See [Companion Mod](#companion-mod-vermeil-fabric-26) below
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

## Companion Mod (`vermeil-fabric-26/`)

The repo includes the **Vermeil companion Minecraft mod** at `vermeil-fabric-26/` — a
separate Java/Fabric Gradle project (the general Vermeil client mod; in-game
custom capes are its first feature). It is **not** part of the launcher's
Tauri/SolidJS build and is excluded from the `pnpm` and `cargo` pipelines; it is
built and distributed (download-on-demand) on its own.

### Prerequisites

- **JDK 25** — see [Companion mod](#companion-mod-all-platforms) under Prerequisites.
- No system Gradle needed — the project ships a Gradle **wrapper**
  (`gradlew` / `gradlew.bat`). Fabric Loom drives the Gradle/Loom versions.

### Multi-version (separate projects per era/loader)

The mod targets multiple Minecraft eras, but **not from one codebase** — the
loader, mappings, Java version, and cape-render API differ too much across eras
to share a toolchain. So each `(era, loader)` is built as its **own standalone
Gradle project** with its own wrapper and pinned toolchain, rather than a
single-source preprocessor tree:

| Project | Minecraft | Loader | Java | Cape hook era |
|---------|-----------|--------|------|---------------|
| `vermeil-fabric-26/` (current) | 26.x | Fabric | 25 | render-state (`Avatar*`) |
| Fabric 1.21.x (planned) | 1.21.x | Fabric | 21 | render-state (`Player*`) / feature-renderer |
| Forge 1.8.x (planned) | 1.8.x | Forge | 8 | legacy (`LayerCape`) |

The build that exists today is the **Fabric 26.x** project at `vermeil-fabric-26/`. It
uses **official Mojang mappings** and has **no Fabric API dependency** (loader +
Mixins only). Minecraft / loader / Java pins live in `vermeil-fabric-26/gradle.properties`.
The full matrix and per-era hook details are in
`docs/research/ingame-capes/research.md`.

### Building & running the mod

```powershell
# from repo root, on Windows
vermeil-fabric-26\gradlew.bat build           # build the mod jar -> build/libs/vermeil-<modVersion>+<mc>.jar
vermeil-fabric-26\gradlew.bat runClient       # launch a dev client
vermeil-fabric-26\gradlew.bat genSources      # decompiled Mojang-mapped sources (research)
```

```bash
# on Linux
./vermeil-fabric-26/gradlew build
./vermeil-fabric-26/gradlew runClient
```

### Publishing the mod jars (download-on-demand)

The jars are **not** bundled in the launcher and **not** committed to the repo —
they're published as **GitHub release assets** and fetched on demand by the
launcher. Publishing is automated by `.github/workflows/mod-release.yml`:

- Trigger it by pushing a `mod-v*` tag (e.g. `mod-v0.1.0`), or run it manually
  via the Actions tab with a tag input.
- It builds the mod (`gradlew build`), then uploads each
  `vermeil-<modVersion>+<mcVersion>.jar` plus a generated `companion-manifest.json`
  (lists each jar's Minecraft version, loaders, URL, SHA-1, and size) to a release
  on that tag. As the per-era/loader projects land, each is built and staged here.
- The mod is versioned independently of the launcher via `mod_version` in
  `vermeil-fabric-26/gradle.properties`.

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
├── vermeil-fabric-26/              # companion Minecraft mod (Java/Fabric, separate build)
└── docs/                     # project docs + docs/research/ notes
```
