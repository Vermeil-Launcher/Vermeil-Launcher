# Vermeil — Feature Roadmap

Ideas to potentially ship in future releases. Ranked roughly by user impact /
effort. New ideas welcome via GitHub Issues.

---

## Shipped

### 0.1.0 — Initial release
- Multi-loader support: Vanilla, Fabric, Legacy Fabric, Quilt, NeoForge, Forge
- Mod, resource pack, shader, and datapack management with Modrinth integration and automatic dependency resolution
- Modpack install from Modrinth and CurseForge .zip import
- Microsoft account authentication with offline mode fallback
- Skin and cape changer with a local skin library
- Auto-managed Java runtimes (8 / 17 / 21 / 25) via Adoptium
- Multi-instance with isolated game directories, per-instance log buffers
- Discord Rich Presence
- Auto-update via GitHub Releases with signature verification
- First-run onboarding wizard
- Custom NSIS Windows installer with optional user-data cleanup on uninstall

### 0.1.1 — Sidebar pins, custom icons
- Sidebar pins: up to 3 instances as quick-launch shortcuts
- Custom instance icons (pick your own image)
- Mod and modpack icons cached locally for offline display
- Forge / NeoForge installer streams current step into progress popup
- Loader libraries download in parallel after installer completes
- Download history with full cards (icon, loader, game version, category)

### 0.1.2 — Download history, icon fixes
- Download history cards with project icon, loader, game version, category
- Modpack browse cards show loader and version badges
- Icons served as inline data URLs (fixes broken images across the app)
- Cache purge now clears icons, client JARs, and asset indexes

### 0.1.3 — Modpack browser improvements
- Escape key closes modals and exits multi-select mode
- Modpack browse pagination with page indicator
- Modpack browse filters: sort by relevance/downloads/follows/newest/updated, filter by loader

### 0.1.4 — Skin changer polish
- Skin/cape changer rate-limit reduction (profile cache, retry on 429, frontend cooldown)
- Modpack browse modal fixed-size layout (no resize on page change)

### 0.1.5 — CurseForge integration
- CurseForge as a second mod source (toggle in Browse tab)
- Search, browse, and install mods/resource packs/shaders/datapacks from CurseForge
- Automatic dependency resolution for CurseForge installs

### 0.1.6 — Instance card redesign, skin viewer elytra
- Skin viewer elytra toggle with animation
- Variant switch re-uploads skin to Mojang (Classic/Slim takes effect in-game)
- Instance cards redesigned: compact horizontal row with loader-colored icons
- Instance duplicate / clone
- Crash report viewer modal
- Manual content update check button
- Java location finder (per-major-version cards with Install/Detect/Browse)
- Headless loader installer console suppression (no black console flash on Windows)
- Fullscreen launch option working
- Window size settings applied on launch for all versions

### 0.1.7 — Global video settings
- Global video settings: framerate, VSync, view bobbing, GUI scale, FOV
- FOV slider (30–110) and framerate slider (10–260, snaps every 10)
- Settings patch options.txt before each launch

### 0.1.8 — Credential encryption
- DPAPI credential encryption (access tokens + refresh tokens encrypted at rest)
- Transparent migration from plaintext on first launch
- Download history persistence (survives app restarts, capped at 200)

### 0.1.9 — Linux support
- Linux builds (AppImage + .deb)
- Cross-platform Java archive extraction (zip on Windows, tar.gz on Linux)
- OS detection centralized (library rules, natives, classpath, Adoptium downloads)
- Credential encryption graceful degradation on Linux (file permissions)

### 0.2.0 — Custom dropdowns, Ubuntu 24.04
- Custom styled dropdowns in Settings (consistent across platforms)
- Slider fill sync fix
- Fullscreen state always synced from per-instance settings before launch
- Linux AppImage compatibility with Ubuntu 24.04+

### 0.2.1 — Linux polish, pin modal upgrade
- FOV Effects slider in video settings
- Pin instances modal shows icon, RAM, version, loader, and mod count
- Pin modal pagination (for 5+ instances)
- Modrinth/CurseForge source toggle with logos in modpack browser
- Linux install script for one-command setup
- Modpack browser dropdowns match custom dropdown style
- Fixed log placeholder art rendering on Linux
- Fixed app crashing on launch with Wayland

### 0.2.2 — Linux resize, skin library
- Window resize on Linux (frameless window edge/corner resize handles)
- Skin library auto-capture (active skin saved on every profile fetch)

### 0.2.3 — Modpack install fixes
- Modrinth modpack install no longer fails with "error decoding response body" (HTTP status checked before JSON parsing)
- CurseForge modpacks can be installed directly from the modpack browser
- Skin viewer elytra-to-regular animation transition smoothed (300ms ramp)

### 0.2.4 — Forge legacy, Discord Linux, skin avatars
- Old Forge versions (pre-1.13) install correctly via legacy Maven URL fallback
- Failed modpack installs clean up partial instance directories and temp files
- Discord Rich Presence connects reliably on Linux (discord-presence v3, Unix socket fixes)
- Saved skins library no longer creates duplicate entries from Mojang's PNG re-encoding
- Saved skins grid renders front-facing player avatars instead of unwrapped texture sheets

### 0.2.5 — Pin limit, card redesign, Forge filter
- Forge versions for MC below 1.5.2 filtered out (no installer JARs exist for them)
- Failed custom instance preparation cleans up broken instance directory
- Toast notifications pause auto-close timer while window is unfocused
- Sidebar pin limit increased from 3 to 5; checkbox removed (click row to toggle)
- CurseForge modpack installs now fetch and cache the project icon
- Loader switch in Custom Setup resets MC version to first supported version
- Instance cards redesigned: compact layout, version number as badge
- Modal box-shadow reduced for cleaner appearance
- Task Manager subprocess icon fixed (BMP-DIB format ICO)
- Sidebar tooltips no longer hidden behind 3D skin viewer

### 0.2.6 — Floating dock, keybinds
- Floating bottom-centered dock replaces the left sidebar with a state-aware center button
- Pin selector carousel opens via Ctrl+P (rebindable)
- Settings → Keybinds tab for customizing keyboard shortcuts
- Modal overlays fill the full viewport; logo moved to the titlebar

### 0.2.7 — Loader auto-bump, skins redesign, modpack fixes
- Loader auto-bump scans modpack mods and updates the loader to a compatible build on install
- Author names shown on mod cards, installed list, download history, and modpacks
- Skins screen redesigned with a wider 3D viewer, actions sidebar, and horizontal saved-skins row
- Categories a loader can't use (mods/shaders on Vanilla) are hidden instead of shown
- Scrollbars use the accent color across all screens
- Logs tab: placeholder clears on output, dock auto-hides while reading, auto-scroll follows new lines until you scroll up
- CurseForge modpacks install mods with withheld download URLs via a direct CDN fallback
- Re-installing a CurseForge modpack appends "(2)", "(3)" and is tracked like Modrinth

### 0.2.8 — Dock pagination, CF content fix
- iOS-style dot pagination island above the dock with scroll-wheel navigation and hold-to-type page jump
- CurseForge shaders, resource packs, and datapacks install correctly (loader filter skipped for non-mod content)
- Center FAB centered within the dock pill with glow-scale hover effect
- Pin carousel compacted (smaller tiles, hidden scrollbar, edge fade mask)
- Browse mode no longer auto-scrolls to top on page change

---

## Planned

### Tier 1 — High impact, low/medium effort

**Drag-and-drop install**
Drop a `.jar` from Downloads onto an instance card for instant install. Drop a
`.mrpack` onto the Library screen to create a new instance. Tauri exposes
`onDrop` natively.

**Theme system (light / OLED)**
CSS variables are already centralized; swapping them is mechanical. OLED is a
real sell for laptop-on-battery users.

**Quick instance switcher in titlebar**
Dropdown next to the window title showing recent instances; click to jump
straight to that instance's Mods/Logs tab without going through Library.

**Background pre-fetch of Forge / NeoForge installers**
While the user is on onboarding step 4, silently pre-fetch the latest Forge +
NeoForge installers for the newest stable MC release into the global cache.

### Tier 2 — Quality-of-life

**World screenshots / preview thumbnails**
Read `icon.png` from each save folder (Minecraft writes one for the world's
first scene) and display in the Worlds tab.

**Per-instance environment variables and JVM args UI**
Backend already supports `extra_args` on `JavaConfig`. Surface it in
Settings as a key=value list editor.

**Search across all installed mods (cross-instance)**
"Which instance has Sodium 0.6 installed?" — a global mod search indexing
all `instance.json` files.

**Resource pack browser within a world's perspective**
Show which resource packs a world's `level.dat` references and toggle them
on/off without launching the game. Needs NBT parsing.

### Tier 3 — Architectural

**Snapshot before/after instance changes**
Before applying mod updates or modpack installs, snapshot `mods/` for easy
rollback.

**Settings export/import**
JSON export of settings + instance metadata (minus tokens) for migrating to a
new machine.

### Long-term

- `.mrpack` export — export instances as shareable modpacks
- Import from Prism / MultiMC — read `instance.cfg` + `mmc-pack.json`
- `Result<T, String>` to `AppError` migration — typed errors everywhere
