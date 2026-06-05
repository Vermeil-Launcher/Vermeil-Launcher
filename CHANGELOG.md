## 0.2.4

### Fixed

- Modpack installs with old Forge versions (pre-1.13, like 1.8.9) no longer fail with HTTP 404. The installer URL now falls back to the legacy Maven artifact format when the standard format isn't found.
- Failed modpack installs (Modrinth or CurseForge) now clean up the partial instance directory and any temp files instead of leaving broken instances in the library.
- Discord Rich Presence now connects reliably on Linux. Upgraded the underlying library to v3 which fixes Unix socket timeouts and discovers Discord IPC sockets at any path index, including Snap and Flatpak installs.
- Saved skins library no longer creates duplicate entries when uploading. Mojang re-encodes uploaded PNGs which changed their hash and caused auto-capture to save a second copy.

### Changed

- Saved skins grid now renders each skin as a static front-facing player avatar instead of the unwrapped texture atlas.
