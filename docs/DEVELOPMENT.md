# Development

> **Warning:** This codebase is AI-generated. Builds may be unstable, features may be incomplete, and runtime behavior may differ from what documentation describes. If a build fails or the app misbehaves, it may be a code issue rather than an environment issue.

## Prerequisites

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

## Project Structure

```
Vermeil/
├── src/                  # SolidJS frontend
├── src-tauri/            # Rust backend (Tauri)
│   ├── src/
│   │   ├── commands/     # IPC command handlers
│   │   ├── services/     # Business logic
│   │   ├── models/       # Data types
│   │   ├── util/         # Helpers (paths, http)
│   │   ├── lib.rs        # Plugin/command registration
│   │   └── main.rs       # Entry point
│   ├── Cargo.toml
│   └── tauri.conf.json   # Tauri config (version, window, plugins)
├── package.json
└── vite.config.ts
```
