## 0.2.7

### Added

- Loader auto-bump: modpack installs scan their mods for the loader version they require and update the loader to a compatible build automatically.
- Author names now appear on mod cards, the installed list, download history, and modpacks.

### Changed

- Skins screen redesigned — wider 3D viewer, dedicated actions sidebar, and a horizontal row of saved skins.
- Categories a loader can't use (mods and shaders on Vanilla) are now hidden instead of shown.
- Scrollbars use the accent color so scrollable areas are easier to spot.
- Logs tab: placeholder art clears once output appears, the dock auto-hides while reading (reveals on hover), and auto-scroll follows new lines until you scroll up.

### Fixed

- CurseForge modpacks now install mods whose download URLs are withheld by the API, using a direct CDN fallback.
- Re-installing the same CurseForge modpack now appends "(2)", "(3)" to the instance name and is tracked the same way as Modrinth.
