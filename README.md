# Vermeil

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/davekb1976-beep/Vermeil-Launcher?label=Latest)](https://github.com/davekb1976-beep/Vermeil-Launcher/releases/latest)
[![Build](https://img.shields.io/github/actions/workflow/status/davekb1976-beep/Vermeil-Launcher/release.yml?label=Build)](https://github.com/davekb1976-beep/Vermeil-Launcher/actions)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-informational)]()

A lightweight Minecraft: Java Edition launcher for Windows and Linux.

Built with [Tauri 2](https://tauri.app/) (Rust backend) and [SolidJS](https://www.solidjs.com/) (TypeScript frontend).

> **This is an AI-generated codebase.** It may contain bugs, incomplete features, or unexpected behavior. See [DISCLAIMER.md](DISCLAIMER.md) for details. Use at your own risk.

## Features

- Microsoft account authentication
- Multiple account support (including offline)
- Instance management with per-instance settings
- Mod loader support: Fabric, Quilt, NeoForge, Forge
- Mod browsing and installation from Modrinth and CurseForge
- Modpack import (.mrpack and CurseForge zip)
- Automatic Java detection and download
- Discord Rich Presence
- 3D skin viewer with upload, cape, and elytra support
- Auto-updater (Windows and Linux AppImage)
- Global video settings (FPS, VSync, FOV, GUI Scale, View Bobbing, FOV Effects)

## Download

Get the latest release from the [Releases page](https://github.com/davekb1976-beep/Vermeil-Launcher/releases/latest).

### Windows

Download and run the `.exe` installer from the Releases page. Uninstall from Settings > Apps.

### Linux (one-liner install)

```bash
curl -fsSL https://github.com/davekb1976-beep/Vermeil-Launcher/releases/latest/download/install.sh | bash
```

This downloads the AppImage, installs it to `~/.local/bin`, and creates a desktop entry.

### Linux (uninstall)

```bash
vermeil-uninstall
```

Removes the app and optionally deletes all app data (instances, mods, accounts).

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for setup instructions and build commands.

## License

Source code is released under the [MIT License](LICENSE).

The Vermeil logo and app icons are **All Rights Reserved** and may not be reused, modified, or redistributed. See [LICENSES.md](LICENSES.md) for the full breakdown.

## Source Availability

This repository is public for transparency and educational purposes. It is **not** a community project — external code contributions (pull requests, commits) are not accepted. See [CONTRIBUTING.md](CONTRIBUTING.md).

Bug reports and feature suggestions via GitHub Issues are welcome.

## Privacy

Vermeil does not collect, transmit, or store any user data on external servers. All account credentials, settings, and game data remain on your local machine. See [PRIVACY.md](PRIVACY.md) for details.

## AI Disclosure

This project was built entirely with AI assistance (Claude via Kiro IDE). The AI generated the code, documentation, and configuration. The project author directed the architecture, feature choices, and reviewed the output.

**Models used:**
- Claude Opus 4.6 (primary code generation and architecture)
- Claude Opus 4.7 Experimental (code generation and architecture)
- Claude Opus 4.8 Experimental (code generation and architecture)
- Claude Sonnet 4.6 (code generation, debugging, and iteration)

**IDE:** Kiro (AWS AI-native IDE with agent workflows)

This means the codebase has not been manually written line-by-line. Bugs, incomplete implementations, and unexpected behavior are possible. The software is provided as-is under the MIT License with no warranty. See [DISCLAIMER.md](DISCLAIMER.md).
