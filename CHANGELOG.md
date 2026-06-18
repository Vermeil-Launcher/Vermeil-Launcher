## 0.5.9

### Added

- The Linux installer's desktop-shortcut prompt now adapts to the detected desktop environment — placed automatically on KDE, Xfce, Cinnamon, and friends; explained on GNOME (needs the DING extension); skipped on tiling compositors that have no desktop surface.

### Fixed

- The launcher window can no longer be dragged below its minimum size on Linux compositors that don't enforce size hints for frameless windows. Undersized geometry never gets persisted across launches either.
- Toggling between Modrinth and CurseForge in Browse Modpacks (and the in-instance Browse tab) no longer leaves the card list empty when responses come back out of order. Failed searches now surface a toast instead of silently rendering nothing.
- The elytra idle pose is now a subtle continuous breath in time with the rest of the body, instead of a constant full-spread cycle.
