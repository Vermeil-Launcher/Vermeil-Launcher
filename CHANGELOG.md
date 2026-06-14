## 0.2.9

### Added

- Sound settings in global instance options: master and music volume sliders applied to options.txt before launch.

### Changed

- Global instance settings redesigned into a responsive grid that auto-flows into 1, 2, or 3 columns based on window width.
- Skin & cape changer redesigned: slimmer 3D viewport, capes and saved skins fit without scrolling, wider canvas so elytra wings don't clip at any rotation angle.
- Individual "Reset" buttons in global instance settings consolidated into a single "Reset All" button.

### Fixed

- Slider values across the launcher (memory, FPS, FOV, volume, concurrency) now update live during drag with no visual lag or thumb distortion.
- Memory slider in per-instance settings no longer triggers "EOF while parsing" errors when scrubbed quickly.
- Instance settings JSON writes are now atomic, preventing race-induced corruption from concurrent saves.

### Notes

- Dependency hygiene: pinned esbuild ≥ 0.28.1 to address GHSA-gv7w-rqvm-qjhr (Deno-only RCE; Vermeil's Node-based build was never exposed). All Rust crates updated to latest compatible versions.
