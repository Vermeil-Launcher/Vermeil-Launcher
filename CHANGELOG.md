## 0.6.0

### Added

- Custom cape editor — create local capes from your own images, positioned and previewed on the 3D model in the skin viewer.
- Animated custom capes (GIF, APNG, WebP) that play in the skin viewer.
- Cape resolution picker, from standard up to HD.
- Experimental: in-game custom capes via the Vermeil companion mod (Fabric, Minecraft 26.1.x and 26.2), toggled with "Show in-game" on the Skins screen. Experimental for now — it requires the companion mod to be installed manually; automatic install isn't available yet.

### Changed

- Launcher data now lives in your local app data (`%LOCALAPPDATA%\Vermeil` on Windows, `~/.local/share/Vermeil` on Linux) instead of the roaming profile.

### Fixed

- Browse search retries transient Modrinth and CurseForge failures instead of surfacing an error toast.
- The game window is brought to the front on launch even when it isn't maximized.
- Several custom cape editor rendering fixes: face wrapping, nearest-neighbour filtering, animated frame decoding, background handling, and the resolution dropdown overflow.
