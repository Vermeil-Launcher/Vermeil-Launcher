# Changelog

## 0.7.2

### Added

- Bidirectional sync for video settings (FOV, Max FPS, VSync, view bobbing, GUI scale, FOV Effects, master/music volume): in-game changes flow back to the launcher sliders when you quit, and launcher changes apply on next launch.
- Vermeil companion mod has a dedicated toggle in Settings → General and shows up as a managed entry on supported instances' Installed mods tab.

### Changed

- Video settings no longer have a "Default" state — every slider shows a concrete value (Mojang's vanilla default until you change it), matching how Minecraft's own screens work.

### Fixed

- Settings → Resources shows the real per-platform app directory instead of a hardcoded Windows path.
- Keybind reset button icon renders correctly instead of an empty box.
- Typing in a text input no longer triggers global app keybinds.
