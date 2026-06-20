# Development

> **Warning:** This codebase is AI-generated. Builds may be unstable, features may be incomplete, and runtime behavior may differ from what documentation describes. If a build fails or the app misbehaves, it may be a code issue rather than an environment issue.

## Prerequisites

The lists below are for building the **launcher**. The companion mod
(`vermeil-mod/`) needs one extra tool — see [Companion mod](#companion-mod-all-platforms).

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

Only needed if you build the mod in `vermeil-mod/`:

- **JDK 25** — [Temurin/Adoptium](https://adoptium.net/) 25. The latest
  Minecraft (26.1.x) requires Java 25. Confirm with `java -version`.

No separate Gradle install is required — the mod ships a Gradle wrapper
(`gradlew` / `gradlew.bat`). See [Companion Mod](#companion-mod-vermeil-mod) below
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

## Companion Mod (`vermeil-mod/`)

The repo includes the **Vermeil companion Minecraft mod** at `vermeil-mod/` — a
separate Java/Fabric Gradle project (the general Vermeil client mod; in-game
custom capes are its first feature). It is **not** part of the launcher's
Tauri/SolidJS build and is excluded from the `pnpm` and `cargo` pipelines; it is
built and distributed (download-on-demand) on its own.

### Prerequisites

- **JDK 25** — see [Companion mod](#companion-mod-all-platforms) under Prerequisites.
- No system Gradle needed — the project ships a Gradle **wrapper**
  (`gradlew` / `gradlew.bat`). Fabric Loom drives the Gradle/Loom versions.

### Multi-version (Stonecutter)

The mod targets multiple Minecraft versions via **Stonecutter**
(`dev.kikugie.stonecutter`): one shared source tree in `vermeil-mod/src/`, one
"node" per version under `vermeil-mod/versions/<version>/`. Per-node pins
(Minecraft, Fabric loader, Fabric API, `java_version`) live in
`versions/<version>/gradle.properties`; shared values (mod version, Loom) in the
root `gradle.properties`. The project uses **official Mojang mappings**. The few
version-specific lines are gated with `//? if <version>` Stonecutter comments.

### Building & running the mod

```powershell
# from repo root, on Windows
vermeil-mod\gradlew.bat build           # build the ACTIVE node -> versions/<node>/build/libs/
vermeil-mod\gradlew.bat chiseledBuild   # build EVERY node (all versions)
vermeil-mod\gradlew.bat runClient       # launch a dev client for the active node
vermeil-mod\gradlew.bat genSources      # decompiled Mojang-mapped sources (research)
```

Switch the active node via the Gradle `stonecutter` task group (e.g. a generated
`Set active project to <version>` task). Each node compiles to its own Java
release (26.x → 25, 1.21.x → 21, 1.20.1 → 17).
```

```bash
# on Linux
./vermeil-mod/gradlew build
./vermeil-mod/gradlew runClient
```

### Publishing the mod jars (download-on-demand)

The jars are **not** bundled in the launcher and **not** committed to the repo —
they're published as **GitHub release assets** and fetched on demand by the
launcher. Publishing is automated by `.github/workflows/mod-release.yml`:

- Trigger it by pushing a `mod-v*` tag (e.g. `mod-v0.1.0`), or run it manually
  via the Actions tab with a tag input.
- It builds every node (`chiseledBuild`), then uploads each
  `vermeil-<modVersion>+<mcVersion>.jar` plus a generated `companion-manifest.json`
  (lists each jar's Minecraft version, loaders, URL, SHA-1, and size) to a release
  on that tag.
- The mod is versioned independently of the launcher via `mod_version` in
  `vermeil-mod/gradle.properties`.

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
├── vermeil-mod/              # companion Minecraft mod (Java/Fabric, separate build)
└── docs/                     # project docs + docs/research/ notes
```
