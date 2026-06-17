## 0.5.5

### Changed

- Adaptive RAM's minimum and maximum bounds are now greyed out while it's switched off, since they only apply to the automatic allocator, and the explanation text was reworded for clarity.

### Fixed

- The launcher no longer relaunches off-screen. Window position is now checked against your connected monitors and ignored if it would land out of view, and a minimized or hidden window no longer overwrites the saved position.
- "Minimize to tray on launch" now actually hides the launcher when a game starts, and the setting is off by default on new installs.
- A maximized game window now comes to the front on launch instead of opening behind the launcher window.
