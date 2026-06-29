# Vermeil UI

How the SolidJS frontend (`Vermeil/src/`) is organized and the conventions to follow. Design tokens are the source of truth in `styles/base.css`; this doc points at them rather than duplicating the tables.

## Stack

- **SolidJS 1.9** — signals + JSX, fine-grained reactivity (no virtual DOM).
- **Vite 6** — HMR in dev, single CSS bundle in prod.
- **Plain CSS** — no Tailwind, no CSS-in-JS. Tokens as CSS variables.
- **Icons** — SVG components in `components/Icons.tsx` (Feather, MIT). Never emoji/glyphs in UI.

## Layout

```
Vermeil/src/
├── App.tsx          # Root + global signals + screen routing
├── index.tsx        # Entry: imports CSS, intercepts external links, renders App or LogsPopout
├── components/      # Reusable building blocks
├── modals/          # Modal dialogs + create/import pseudo-screens
├── screens/         # Top-level views
├── lib/             # Pure helpers (cape, keybinds, contentVersion)
├── services/        # Frontend-only logic (updater)
├── ipc/commands.ts  # Typed Tauri invoke() wrappers — single source of truth
└── styles/          # 9 CSS modules (below)
```

## CSS modules

Nine modules, combined by Vite. Import order in `index.tsx` matters — earlier files are the foundation, later ones override:

`base.css` → `layout.css` → `components.css` → `logs.css` → `notifications.css` → `modals.css` → `screens.css` → `dock.css` → `splash.css`

| File | Owns |
|------|------|
| `base.css` | Reset, **all tokens** (`:root`), `body`, `.app` shell, resize handles, offline banner, scrollbars |
| `layout.css` | `.main`, `.titlebar`, `.content`, `.page-title`, `.section-label`, tooltips |
| `components.css` | Canonical vocabulary: `.btn`, `.card`, `.card-grid`, `.badge`, `.field-control`, `.tab`, `.panel`, `.toggle`, modal base, search/filter, settings rows |
| `logs.css` | Log viewer, Home continue/news grids, article reader |
| `notifications.css` | Toasts, install-progress popup, dependency-issues modal, mod-card tags, update banner |
| `modals.css` | Crash modal, onboarding wizard, Java chooser |
| `screens.css` | Skins + 3D canvas, account cards, download-history cards, modpack pagination |
| `dock.css` | Floating dock: pills, center action, pin row |
| `splash.css` | Boot splash (cube + wordmark + progress bar) |

## Design language

Defined entirely as tokens in `base.css :root` — reference `var(--token)`, never literals. Summary:

- **Sharp edges.** All `--radius-*` are `0`. Keep referencing the tokens so radius can return cohesively later.
- **Flat surfaces, hairline borders.** Depth from contrast + one shadow scale. Bevel tokens resolve to `none`.
- **Dark gray + purple.** Surface ramp + single `--accent` purple. Gold/teal/emerald tokens exist but are unused — don't reach for them.
- **No ornament.** `.panel--bracketed` is a no-op (`display:none`).
- **Fonts:** `--font-display` (Oswald, uppercase headers), `--font` (DM Sans, body), `--font-mono` (DM Mono, versions/paths).

Token groups (see `base.css` for values): surfaces (`--surface-*`), borders (`--border*`), text (`--text*`), accent (`--accent*`), semantic state (`--danger/warn/success/info` + `*-soft`), type scale (`--fs-*`, `--fw-*`), spacing (`--space-0..8`, 4px scale), control heights (`--control-height-*`), card tracks (`--card-track`, `--card-track-compact`), shadows, loader/source brand hues.

## Canonical component vocabulary

`components.css` defines one class per role. Compose these; don't invent bespoke styles. **Modifiers use BEM-style `--`** (`.btn--primary`, `.card--inst`, `.badge--version`). State modifiers are unprefixed (`.active`, `.selected`, `.on`).

| Role | Class | Key variants |
|------|-------|--------------|
| Button | `.btn` | `--sm/--md/--lg`, `--primary/--neutral/--ghost/--danger`, `--block` |
| Card | `.card` | `--inst`, `--mod`, `--media`, `--compact` |
| Card grid | `.card-grid` | `--compact`. `auto-fit minmax(track,1fr)` — reflows, fills rows evenly |
| Badge | `.badge` | `--loader` (+ per-loader), `--version`, `--vnum` (content version), `--source` |
| Field | `.field-control` | `--text`, `--select`, `--search` |
| Tab | `.tab` (in `.tab-strip`) | `.active`, `:disabled` |
| Panel | `.panel` | `--sunken`. (`--bracketed` is a no-op) |
| Toggle | `.toggle` (+ `.on`) | two-half plate + thumb |

> Legacy classes (`.inst-card`, `.mod-card`, `.ctx-badge`, `.src-tab`, `.btn-accent`, `.control-select`) still exist in InstanceMods, Account, and BrowseModpacks. **New code uses the canonical classes above**; migrate legacy markup when you touch it.

## Responsive contract

`--content-min` (480px) is the minimum fully-supported content width. Card grids reflow via `.card-grid` (track narrower than 480px, so columns drop without clipping). Below 480px, `.content > *` carries `max-width:100%` + `min-width:0` and media is capped, so nothing overflows. **Don't override the grid template inline** — let `.card-grid` do the reflow.

## Global state (`App.tsx`)

Module-level signals, exported with their setters and imported where needed. Resources: `instances`, `account`. Signals: `activeScreen`, `activeInstanceId`, `initialInstanceTab`, `gameRunning`, `pinnedInstanceIds`, `pinSelectorOpen`, `activeSkinUrl`, `gameLogs`, `downloads`, `offline`, `updateAvailable`.

Helpers: `appendGameLog`/`clearGameLogs`/`gameLogsFor`, `trackDownload`/`completeDownload`/`failDownload`, `startBulkBatch`/`endBulkBatch`, `refreshPinnedInstanceIds`, `refreshActiveSkin`, `ensureAccountOrPrompt`.

## Screens (`screens/`)

Routing is `<Show when={activeScreen() === "name"}>` in `App.tsx`; switch via `setActiveScreen(name)`.

| Screen | File | Purpose |
|--------|------|---------|
| home | `Home.tsx` | Greeting, recent-worlds carousel, Mojang Java news + reader |
| library | `Library.tsx` | Instance grid, multi/drag-select, "+ New instance" card |
| mods | `InstanceMods.tsx` | One instance: Content / Browse / Files / Worlds / Logs tabs (large file) |
| settings | `Settings.tsx` | General / Resources / Global Instance tabs, Java, GC presets, keybinds |
| account | `Account.tsx` | Account list, Microsoft sign-in, offline account |
| skins | `Skins.tsx` | Lazy-loaded 3D viewer, upload, cape equip/editor |
| downloads | `Downloads.tsx` | Persistent download history |
| (logs window) | `LogsPopout.tsx` | Standalone log viewer rendered when window label is `logs` |

**Create/import pseudo-screens** (rendered in content area, Escape closes): `create-choose` (`CreateChoose.tsx`), `create-custom` (`CreateCustom.tsx`), `create-modpack` (`BrowseModpacks.tsx`), `create-import` (`ImportCurseForge.tsx`).

## Modals (`modals/` + a few in `components/`)

Mounted at App level, controlled by signal. `OnboardingWizard`, `PinInstancesModal`, `JavaChooserModal`, `CustomCapeEditor` (modals/); `NoAccountModal`, `InstallProgress`, `BulkInstallToast`, `DependencyIssuesModal`, `UpdateBanner`, `CrashReportModal`, `Toasts` (components/).

## Components (`components/`)

`FloatingDock` (bottom nav: nav pills + state-aware center play/stop/create + pin row — **this is the nav, there is no Sidebar**), `Titlebar` (window controls, logo, title, account pill), `Dropdown` (styled select), `Icons` (all SVGs), `PlayerHead`/`SkinAvatar`/`CapeChipThumb` (skin/cape renders), `PageSlider`, `JavaPathInput`, `KeybindCapture`, `ResizeHandles`, `Splash`, plus the modal/toast components listed above.

## Conventions

- **IPC:** every backend call goes through a typed wrapper in `ipc/commands.ts`. Never call `invoke()` directly in a component.
- **Events:** `listen()` from `@tauri-apps/api/event`; store the unlisten fn and call it in `onCleanup`. Event names are kebab-case.
- **External links:** `openUrl()` from `@tauri-apps/plugin-opener` — never `window.open()`/`<a href>`. (A global click interceptor in `index.tsx` handles rendered HTML.)
- **Naming:** components/screens/modals `PascalCase`; helpers/services `camelCase`; CSS classes `kebab-case`.
- **Inline `style=`** is fine for true one-offs; promote to a class once reused. Don't hardcode colors/sizes — use tokens.
- **Animations:** reuse `fadeIn 0.15s ease`. **Empty states:** a helper card explaining the emptiness. **Errors:** toasts (`type:"error"`). **Loading:** `<Show>` with a muted "Loading…" fallback, no skeletons.

## Keybinds

Defined in `lib/keybinds.ts` (`KEYBINDS`); user overrides in `LauncherSettings.keybinds`. Add an entry there, react in the `App.tsx` keydown handler via `matchesKeybind`/`resolveBinding`; the Settings → Keybinds tab renders rows automatically. Settings fires `vermeil-keybinds-changed` to refresh the handler's cache. Escape is hardcoded (universal "back out"). `toggle_pin_selector` (default Ctrl+P) morphs the dock into the pinned-instance carousel.

## Don't

- Call `invoke()` directly from a component.
- Hardcode colors/sizes instead of tokens.
- Use emoji/Unicode glyphs as icons — use `Icons.tsx`.
- Override a `.card-grid` template inline.
- Add a CSS module without updating `index.tsx` and this doc.
