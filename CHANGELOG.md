## 0.5.8

### Added

- Newly created instances auto-pin themselves to the floating dock until it's full (up to six pins).

### Changed

- Cleaned up the floating dock's pin selector: fixed-width carousel with centered tiles, Manage button anchored on the left, and a friendly hint when nothing is pinned yet.

### Fixed

- Switching skin variant between Classic and Slim now applies immediately instead of silently snapping back.
- Restored the Beta badge on the Skins screen.
- Toggling between cape and elytra no longer throws the model into a flying pose. The elytra now flutters gently in place, and the wings stay inside the viewport at every spread.
- Mod dependencies show as installed immediately after a single mod install instead of waiting for a refresh.
- Modrinth mod dependencies now respect the version pinned by the parent mod.
- The Linux install script is now attached to every release, so the install command in the README works straight from the latest tag.
