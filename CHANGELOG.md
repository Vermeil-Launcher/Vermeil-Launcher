## 0.3.0

### Added

- Window options (fullscreen, maximized, resolution) moved out of per-instance settings into Global Instance Settings. Resolution offers dropdown presets from 720p through 4K.
- Official Modrinth and CurseForge brand marks now appear on the source toggle, with each button surface tinted in the matching brand color.

### Changed

- Stop button now closes the game gracefully — sends WM_CLOSE on Windows / SIGTERM elsewhere so worlds save and chunks flush before exit. The "game crashed" toast no longer fires for user-initiated stops.
- Logs clear automatically when re-launching an instance, instead of appending to the previous session's output.
- Source toggle button restyled so the brand-colored icon fills the button without a constraining inner badge.

### Fixed

- Maximize toggle now properly maximizes the Minecraft window via Win32 `ShowWindow(SW_MAXIMIZE)` once the GLFW window appears, instead of pushing it off-screen with absurd dimensions.
- CurseForge icons render correctly when only the full-size `url` field is populated (some projects leave `thumbnailUrl` empty).
- CurseForge CDN domains (`edge.forgecdn.net`, `mediafilez.forgecdn.net`) added to CSP `img-src` so all icon URLs load.
- CurseForge loader filter now applies to modpack search — selecting "Fabric" actually narrows the results instead of being silently ignored.
- "Follows" sort on CurseForge now maps to popularity sort instead of falling through to relevance (CurseForge has no follower count concept).
