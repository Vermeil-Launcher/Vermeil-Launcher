## 0.2.5

### Fixed

- Forge versions for MC below 1.5.2 no longer appear in the loader dropdown. These ancient versions predate the Forge installer system and always failed with HTTP 404.
- Forge installer URL construction correctly strips legacy Maven suffixes for pre-1.13 versions, preventing double-suffixed URLs that 404.
- Failed instance preparation (download errors, unsupported loader) now cleans up the partial instance directory instead of leaving a broken entry in the library.
- Toast notifications no longer disappear while the window is unfocused (alt-tab). The auto-close timer now pauses when the app isn't visible.
- Sidebar pin tooltips no longer render behind the 3D skin viewer canvas.
- Switching mod loaders in the Custom Setup modal now resets the MC version selection to the first supported version for the new loader.
- CurseForge modpack installs now fetch and cache the project icon, matching Modrinth modpack behavior.
- Pin instances modal placeholder now shows the instance's first letter instead of a blank square for instances without a custom icon.
- Task Manager subprocess icon no longer shows distorted black bars (rebuilt ICO with BMP-DIB format for Windows compatibility).

### Changed

- Sidebar pin limit increased from 3 to 5.
- Pin instances modal no longer uses checkboxes — click the row to toggle selection (highlighted with accent tint when selected).
- Instance cards are more compact: smaller icon, tighter padding, version number is now a badge alongside loader and RAM.
- "New instance" card matches instance card height instead of being oversized.
- Modal box-shadow reduced for a cleaner look (less visible haze around modal edges).
- Icon assets regenerated with high-quality LANCZOS downscaling and proper transparency.
