# Vermeil — Project Summary

## What Is This

Vermeil is a custom Minecraft: Java Edition launcher built with **Rust (Tauri 2)** backend and **SolidJS + TypeScript** frontend. It's a desktop app for Windows and Linux that manages Minecraft instances, mods, accounts, and game launches.

**Repository:** https://github.com/davekb1976-beep/Vermeil-Launcher
**Author:** davekb1976-beep
**License:** MIT
**Current Version:** 0.2.2

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Rust, Tauri 2 |
| Frontend | SolidJS, TypeScript, Vite |
| Styling | Single global CSS file (dark theme, custom design system) |
| Package manager | pnpm |
| Build system | Tauri CLI + Vite |
| CI/CD | GitHub Actions (Windows + Linux matrix) |
| Installer | NSIS (Windows), .deb + .AppImage (Linux) |
| Auto-updater | Tauri updater plugin (Windows NSIS + Linux AppImage) |

---

## Project Structure

```
Vermeil-Launcher/               # Repo root
├── .github/workflows/          # CI/CD (release.yml)
├── .kiro/                      # AI steering files
│   └── steering/               # Coding standards, implementation process, etc.
├── Vermeil/                  # The actual app
│   ├── src/                    # SolidJS frontend
│   │   ├── components/         # Reusable UI (Sidebar, Titlebar, Icons, Dropdown, etc.)
│   │   ├── screens/            # Full-page views (Home, Library, Settings, Skins, etc.)
│   │   ├── modals/             # Modal dialogs (CreateCustom, BrowseModpacks, etc.)
│   │   ├── ipc/commands.ts     # ALL Tauri invoke wrappers (single source of truth)
│   │   ├── services/           # Frontend-only logic (updater)
│   │   ├── styles/global.css   # All CSS
│   │   ├── App.tsx             # Root component, global state, routing
│   │   └── index.tsx           # Entry point
│   ├── src-tauri/              # Rust backend
│   │   ├── src/
│   │   │   ├── commands/       # Tauri command handlers (thin layer)
│   │   │   ├── services/       # Business logic (launch, auth, mods, etc.)
│   │   │   ├── models/         # Data structures (Instance, Settings, etc.)
│   │   │   ├── util/           # Helpers (paths, http, credentials, platform)
│   │   │   ├── lib.rs          # Plugin/command registration
│   │   │   └── main.rs         # Entry point
│   │   ├── Cargo.toml          # Rust dependencies
│   │   ├── tauri.conf.json     # Tauri config (window, bundle, updater)
│   │   └── icons/              # App icons (all sizes)
│   ├── public/                 # Static assets (logo)
│   └── package.json            # Frontend deps + scripts
├── docs/                       # Documentation
├── CHANGELOG.md                # Current release notes only
└── README.md                   # Public-facing readme
```

---

## Features Implemented (as of v0.2.2)

### Core Launcher
- Microsoft account authentication (Xbox SISU/XSTS flow)
- Multiple account support (switch between accounts)
- Offline account support
- Instance creation (custom version + loader selection)
- Instance launching with full JVM argument construction
- Automatic Java detection and download (Adoptium Temurin)
- Java version matrix: Java 8, 17, 21, 25 (auto-selected per MC version)
- Game log capture and real-time display
- Crash report detection and display
- Discord Rich Presence (shows what you're playing)
- Auto-updater (Windows NSIS, Linux AppImage)
- System tray with minimize-to-tray on game launch

### Mod Loaders
- Fabric (all versions including Legacy Fabric)
- Quilt
- NeoForge (with installer processor support)
- Forge (with installer processor support)
- Parallel library downloads with progress streaming

### Mod Management
- Modrinth API integration (search, install, dependencies)
- CurseForge API integration (search, install, dependencies)
- Toggle between Modrinth/CurseForge in Browse tab
- Content types: mods, resource packs, shaders, datapacks
- Automatic dependency resolution
- Mod update checking and one-click updates
- Bulk select and install
- Enable/disable mods without deleting

### Modpack Support
- Browse modpacks modal with pagination, sort, loader filter
- Modrinth .mrpack import
- CurseForge zip import (manifest.json parsing)

### Instance Management
- Compact horizontal card layout with loader-colored icons
- Per-instance settings (memory, resolution, fullscreen, Java args)
- Custom instance icons (data URL cached)
- Instance cloning
- Multi-select with drag-select for bulk delete
- Rename on double-click
- Sidebar pins (up to 3 quick-launch shortcuts)

### Skin Management
- 3D skin viewer (skinview3d / three.js)
- Skin upload to Mojang
- Variant switch (Classic/Slim)
- Elytra toggle with animation
- Cape equip/unequip
- Local skin library

### Settings
- Global Instance tab with video settings (FPS, VSync, FOV, GUI Scale, View Bobbing)
- Video settings patch options.txt before each launch
- Java runtime management (detect, install, browse per major version)
- Concurrent download/write controls
- GC preset selection (G1GC, ZGC, Shenandoah)
- Force delete toggle, show snapshots, Discord RPC toggle
- Cache purge

### Security
- DPAPI credential encryption on Windows (access_token, refresh_token)
- Transparent migration from plaintext on first launch
- Linux: file permissions protection

### UI/UX
- Custom dark theme with accent colors
- Frameless window with custom titlebar
- Custom styled dropdowns (cross-platform consistent)
- Slider controls for FPS, FOV, memory
- Toast notification system
- Install progress popup with real-time streaming
- Onboarding wizard for first-run
- Escape key closes modals/tools
- News feed from Mojang launcher content API

### Download History
- Persisted to disk (survives app restarts)
- Capped at 200 entries
- Shows icon, loader, game version, category

### Cross-Platform
- Windows: NSIS installer, auto-update
- Linux: .deb package, .AppImage (auto-update)
- Platform-aware: Java exe names, classpath separators, Adoptium URLs, natives, OS rules
- Centralized platform helpers (util/platform.rs)

---

## Release History

| Version | Highlights |
|---------|-----------|
| 0.1.0 | Initial release — basic launcher, Fabric support |
| 0.1.1 | Sidebar pins, custom icons, download history |
| 0.1.2 | Forge/NeoForge install progress, escape key, cache purge |
| 0.1.3 | Modpack browser improvements (pagination, filters) |
| 0.1.4 | Skin changer rate limit fix, modpack browser polish |
| 0.1.5 | CurseForge integration (search, install, dependencies) |
| 0.1.6 | Instance card redesign, fullscreen fix, skin viewer elytra, new icon |
| 0.1.7 | Global video settings (FPS, VSync, FOV, GUI Scale, View Bobbing) |
| 0.1.8 | DPAPI credential encryption, download history persistence |
| 0.1.9 | Linux support (platform helpers, cross-platform code) |
| 0.2.0 | Custom dropdowns, slider fix, fullscreen sync, Ubuntu 24.04 build |
| 0.2.1 | FOV Effects slider, pin modal upgrade, Linux install script |
| 0.2.2 | Linux window resize, skin library auto-capture |

---

## Key Architecture Decisions

1. **Single IPC file** — All Tauri invoke wrappers live in `src/ipc/commands.ts`. Components never call `invoke()` directly.
2. **Thin commands, heavy services** — `commands/*.rs` validate and delegate. `services/*.rs` do the work.
3. **Shared HTTP client** — One `reqwest::Client` in `util/http.rs`, never create new ones.
4. **Platform module** — `util/platform.rs` centralizes all OS detection (exe names, paths, URLs, separators).
5. **Credential encryption** — DPAPI on Windows, plaintext with file permissions on Linux.
6. **options.txt patching** — Global video settings written to each instance's options.txt before launch.
7. **Zero-warning builds** — Never suppress warnings. Fix or remove unused code.

---

## Development Setup

See [DEVELOPMENT.md](DEVELOPMENT.md) for full prerequisites and build instructions.

---

## Important Files to Know

| File | Purpose |
|------|---------|
| `Vermeil/src/App.tsx` | Global state, screen routing, download tracking |
| `Vermeil/src/ipc/commands.ts` | ALL backend communication |
| `Vermeil/src-tauri/src/lib.rs` | Command registration, plugin setup |
| `Vermeil/src-tauri/src/services/launch.rs` | Game launching (biggest file) |
| `Vermeil/src-tauri/src/services/auth.rs` | Microsoft/Xbox/Minecraft auth |
| `Vermeil/src-tauri/src/util/platform.rs` | Cross-platform helpers |
| `Vermeil/src-tauri/src/util/credentials.rs` | DPAPI encryption |
| `Vermeil/src-tauri/src/models/instance.rs` | Instance data model |
| `Vermeil/src-tauri/src/models/settings.rs` | Launcher settings + video settings |
| `.github/workflows/release.yml` | CI/CD pipeline |

---

## Git Conventions

- **Branch:** `main` only
- **Commits:** `release: X.Y.Z` for releases, `feat:` / `fix:` / `chore:` / `docs:` for everything else
- **Tags:** `vX.Y.Z` (triggers CI)
- **Version cadence:** 0.X.0 through 0.X.9, then roll to 0.(X+1).0 (single-digit patches only)
- **Never** commit without explicit approval for releases
