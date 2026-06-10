## 0.2.8

### Added

- Dock pagination island: iOS-style dot indicator above the dock shows page state, with scroll-wheel navigation and hold-to-type page jump.
- CurseForge shaders, resource packs, and datapacks now install correctly (loader filter skipped for loader-agnostic content).

### Changed

- Center FAB moved from raised above the dock to vertically centered within it; hover scales with a glow ring instead of lifting.
- Pin carousel made more compact (smaller tiles, narrower width, hidden scrollbar, edge fade mask).
- Page controls removed from inline screens and moved into the dock pagination island.

### Fixed

- Pin carousel close button no longer clipped by the dock pill.
- Browse mode no longer auto-scrolls to the top on page change.
