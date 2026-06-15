# Vermeil UI Documentation

This document describes how the Vermeil UI is organized, what CSS modules exist, and what each major component/screen does. It's meant for anyone (including future-you) who needs to find or modify UI code.

## Tech stack

- **Framework:** SolidJS 1.9 (reactive primitives, JSX)
- **Bundler:** Vite 6 (HMR in dev, single-file CSS bundle in prod)
- **Styling:** Plain CSS modules — no Tailwind, no CSS-in-JS, no preprocessors
- **Icons:** SVG components in `Icons.tsx` (Feather Icons, MIT)

## Directory layout

```
Vermeil/src/
├── App.tsx               # Root component + global state (signals, screen routing)
├── index.tsx             # Entry point (loads CSS modules, intercepts external links)
├── components/           # Reusable UI building blocks
├── modals/               # Full-screen modal dialogs
├── screens/              # Top-level page views (Home, Library, etc.)
├── services/             # Frontend-only logic (e.g. updater)
├── styles/               # CSS modules (see "CSS architecture" below)
├── ipc/commands.ts       # Typed wrappers around Tauri invoke() — single source of truth
└── assets/               # SVG logo, etc.
```

## CSS architecture

The CSS is split into 7 focused modules under `Vermeil/src/styles/`. Each module owns a specific layer of the UI. Vite combines them into a single CSS bundle at build time.

| File | Owns | Imported by |
|------|------|-------------|
| `base.css` | Reset, CSS variables (colors, fonts, sizes), `body`, `.app` shell, frameless resize handles, offline banner | `index.tsx` |
| `layout.css` | Generic tooltips, `.main`, `.titlebar` + window buttons, `.titlebar-logo`, `.content` (with bottom padding for dock), `.section-label` | `index.tsx` |
| `dock.css` | Floating bottom-centered dock: `.dock`, `.dock-pill`, `.dock-btn`, `.dock-center` (state-aware play/stop/create), pin row (`.dock-pins`, `.dock-pin`) | `index.tsx` |
| `components.css` | Reusable building blocks: instance cards, badges, buttons, modpack cards, instance context bar, mod list/grid/cards, source tabs, filter hint, search bar, settings rows, downloads grid, account list, install/bulk buttons, modal base, form fields, custom dropdown, choice pills, create-instance choice grid, browse controls, memory slider, page navigation | `index.tsx` |
| `logs.css` | Log viewer (`.log-viewer`, `.log-line`, `.log-ascii-backdrop`), log filter button, toggle switch (`.toggle`), instance settings panel, continue grid (Home), news grid (Home), article detail view | `index.tsx` |
| `notifications.css` | Stop button, content category tabs, download toast, toast notification system, install-progress popup, concurrency slider, installed-content filter row, bulk delete, bulk install toast, dependency-issues modal, mod card tags, update banner | `index.tsx` |
| `modals.css` | Toast action button, crash-report modal, onboarding wizard, java location finder cards | `index.tsx` |
| `screens.css` | Skins screen + 3D canvas, player head avatar, home greeting block, log toolbar, account screen cards, pin-instances modal, instance icon picker, download history cards, modpack browse pagination + filters | `index.tsx` |

### Import order

Order matters. `base.css` and `layout.css` define the foundation; later files can override or extend. The current import order in `index.tsx` is:

```ts
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/components.css";
import "./styles/logs.css";
import "./styles/notifications.css";
import "./styles/modals.css";
import "./styles/screens.css";
import "./styles/dock.css";
```

## Design language

The UI is built on a single hardened token layer — defined as CSS variables in `base.css` under `:root`. Every color, type size, spacing value, radius, border, and shadow used by the component and surface layers resolves to a token defined here. Scales are discrete and finite; consumers reference `var(--token)`, never literals.

The current direction:

- **Sharp edges everywhere.** Every `--radius-*` token is `0`. Cards, modals, buttons, badges, fields, tabs, the dock, the FAB, status dots, slider thumbs — all blocky. A global override block at the bottom of `base.css` zeroes the few literal `border-radius: 50%` / `999px` rules that don't go through tokens (spinners, traffic lights, toggle thumb, FAB, etc.).
- **Flat surfaces with hairline borders.** No bevels, no embossed highlights. Depth comes from contrast (panel vs base) and a single shadow scale, nothing else. The bevel tokens (`--panel-bevel`, `--well-bevel`) exist but resolve to `none` so any straggling references compile to a no-op.
- **Dark gray + purple.** Cool dark surface ramp + a single purple accent. Decorative tokens for gold / teal / emerald exist but are unused — purple and neutrals carry the whole design.
- **No ornament.** The `.panel--bracketed` corner-bracket overlay is `display: none`. The bracket-size tokens are `0` / `transparent`. No glowing ticks on section labels, no text-shadow drops on display headings, no gradient backgrounds on panels.
- **Display font for HUD headers.** Oswald (OFL) handles page titles and section labels (heavy uppercase). DM Sans handles body text. DM Mono handles technical text (versions, paths, mod stats).

> When you add a new token (or a new CSS module), update this document in the same change.

### Surfaces (deepest → raised)

| Variable | Value | Use for |
|----------|-------|---------|
| `--surface-base` | `#15141a` | Deepest page background |
| `--surface-sunken` | `#0f0e13` | Recessed wells / inset areas |
| `--surface-panel` | `#1d1b24` | Elevated panels and cards |
| `--surface-raised` | `#28252f` | Hover surfaces / raised controls |
| `--surface-glass` | `rgba(29, 27, 36, 0.85)` | Translucent dark glass (dock) |
| `--surface-glass-strong` | `rgba(29, 27, 36, 0.92)` | Stronger glass (pagination island) |

### Borders

| Variable | Value | Use for |
|----------|-------|---------|
| `--border` | `#322f3d` | Default hairline border |
| `--border-strong` | `#45414f` | Framed-panel frame |
| `--border-hover` | `#5b5570` | Hovered/focused border |

### Text

| Variable | Value | Use for |
|----------|-------|---------|
| `--text` | `#ece9f2` | Primary body text |
| `--text-muted` | `#a6a1b5` | Secondary text (kept ≥ 4.5:1 contrast) |
| `--text-faint` | `#6f6a7e` | Tertiary / disabled-ish text, placeholders |

### Accent (brand purple)

| Variable | Value | Use for |
|----------|-------|---------|
| `--accent` | `#8b5cf6` | Primary purple — active states, links, focus rings, primary fills |
| `--accent-strong` | `#7c4dde` | Deeper purple hover |
| `--accent-soft` | `#1a1428` | Deep purple tint for active backgrounds |
| `--accent-contrast` | `#ffffff` | Light label/icon color on accent fills |

### Semantic state (+ soft tints)

| Variable | Value | Soft tint |
|----------|-------|-----------|
| `--danger` | `#e05656` | `--danger-soft` `#3a1818` |
| `--warn` | `#e8a23a` | `--warn-soft` `#322512` |
| `--success` | `#4caf72` | `--success-soft` `#16291d` |
| `--info` | `#5b8af0` | `--info-soft` `#16203a` |

### Typography

Font sizes are a fluid `clamp()`-based scale (they grow within bounds as the viewport widens):

| Variable | Range | Use for |
|----------|-------|---------|
| `--fs-2xs` | `0.625rem → 0.6875rem` | Micro labels, badges |
| `--fs-xs` | `0.6875rem → 0.75rem` | Meta text |
| `--fs-sm` | `0.75rem → 0.8125rem` | Controls, secondary text |
| `--fs-md` | `0.8125rem → 0.875rem` | Body |
| `--fs-lg` | `0.9375rem → 1rem` | Emphasis |
| `--fs-xl` | `1.125rem → 1.375rem` | Headings |
| `--fs-2xl` | `1.375rem → 1.75rem` | Display |

Weights: `--fw-regular` (400), `--fw-medium` (500), `--fw-semibold` (600), `--fw-bold` (700).
Families: `--font-display` (`'Oswald', 'DM Sans', system-ui, sans-serif` — heavy uppercase HUD headers), `--font` (`'DM Sans', system-ui, sans-serif` — body), `--font-mono` (`'DM Mono', monospace` — technical).

The standard heading patterns are defined in `layout.css`:

- `.page-title` — 28px Oswald 700, uppercase, sharp. The big screen header (e.g. "LIBRARY").
- `.section-label` — 12px Oswald 600, uppercase, with a thin bottom border rule. The section-header pattern.

### Spacing (discrete 4px scale)

`--space-0` (0), `--space-1` (4px), `--space-2` (8px), `--space-3` (12px), `--space-4` (16px), `--space-5` (20px), `--space-6` (24px), `--space-8` (32px). Reference padding, margin, and gap exclusively from this scale.

### Border-radius scale

`--radius-xs`, `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`, `--radius-pill` — **all `0`** in the current design. Keep referencing these tokens (instead of hardcoding `0`) so the radius scale can be re-introduced cohesively in the future without hunting every consumer.

### Borders (widths + composed shorthands)

| Variable | Value | Notes |
|----------|-------|-------|
| `--bw-hairline` | `1px` | Hairline width |
| `--bw-frame` | `1px` | Frame width (same as hairline in the current redesign) |
| `--border-line` | `1px solid var(--border)` | Default hairline border shorthand |
| `--border-frame` | `1px solid var(--border-strong)` | Framed-panel border shorthand |

### Shadows

| Variable | Use for |
|----------|---------|
| `--shadow-sm` | Subtle lift |
| `--shadow-md` | Cards, raised controls |
| `--shadow-lg` | Overlays / popups |
| `--shadow-inset-frame` | `none` (kept defined for compatibility) |
| `--glow-accent` | Focus/active accent glow ring (`0 0 0 2px rgba(139,92,246,0.25)`) |

### Decorative / theme tokens

| Variable | Value | Use for |
|----------|-------|---------|
| `--bracket-size` | `0` | Disabled in the redesign |
| `--bracket-thickness` | `0` | Disabled in the redesign |
| `--bracket-color` | `transparent` | Disabled in the redesign |
| `--frame-bg` | `var(--surface-panel)` | Panel surface alias |
| `--control-height-sm` | `26px` | Small control fixed height |
| `--control-height-md` | `32px` | Medium control fixed height (default) |
| `--control-height-lg` | `40px` | Large control fixed height |
| `--card-track` | `240px` | Minimum card width for the shared grid |
| `--card-track-compact` | `180px` | Minimum card width for dense grids |
| `--content-min` | `480px` | Minimum supported content width (see below) |
| `--vignette` | `var(--surface-base)` | Page canvas (flat in the redesign) |
| `--bevel-light` / `--bevel-dark` | `transparent` | Disabled |
| `--panel-bevel` / `--well-bevel` | `none` | Disabled |
| `--dock-pin-center-offset` | `40px` | Half the dock FAB footprint; centers the pin carousel track |

### Decorative gradient tokens

One-off decorative gradients used for the colored instance-icon blocks (Library cards, Account avatars) and the loader-tinted sidebar/dock pin tiles. They have no spacing/color-scale equivalent, so the literal stops live here in the token layer and the consuming layers reference `var(--grad-*)`. The instance-icon `quilt` and `purple` tints share the same stops and both reference `--grad-inst-quilt`.

| Variable | Use for |
|----------|---------|
| `--grad-avatar` | Account / account-row avatar block |
| `--grad-inst-green` / `--grad-inst-fabric` / `--grad-inst-blue` / `--grad-inst-orange` / `--grad-inst-quilt` | Library instance-card icon blocks (by loader tint) |
| `--grad-loader-vanilla` / `--grad-loader-fabric` / `--grad-loader-quilt` / `--grad-loader-forge` / `--grad-loader-neoforge` | Sidebar `.nav-pin-icon` and dock `.dock-pin-tile` loader-tinted tiles |

### Window-control traffic-light colors

Fixed macOS-style affordance hues for the titlebar close / minimize / maximize buttons. Each keeps a distinct hover shade so hover feedback is preserved; they are not part of the theme color scale.

| Variable | Value | Variable (hover) | Value |
|----------|-------|------------------|-------|
| `--win-close` | `#ed6a5e` | `--win-close-hover` | `#e5453a` |
| `--win-minimize` | `#f4bf4f` | `--win-minimize-hover` | `#e0a520` |
| `--win-maximize` | `#61c554` | `--win-maximize-hover` | `#4aad3d` |

### Brand colors (intentional literal exceptions)

Loader-identity and content-source brand hues are fixed brand values, not theme tokens, so they're allowed to carry literal hex values:

- Loaders: `--loader-fabric`, `--loader-forge`, `--loader-neoforge`, `--loader-quilt`, `--loader-vanilla` (each with a matching `*-soft` tint).
- Sources: `--source-modrinth`, `--source-curseforge` (each with a matching `*-soft` tint).

### Decorative palette (defined but unused)

`--gold`, `--teal`, `--emerald` (and their `*-soft` companions), plus `--rarity-common` / `--rarity-rare` / `--rarity-unique` / `--rarity-enchanted` are kept defined so any straggling references resolve, but the redesign uses purple + neutrals only. Don't reach for these in new code — if you need a non-purple accent, surface a discussion first.

### Legacy aliases

A block of legacy names (`--bg`, `--bg2`, `--bg3`, `--bg4`, `--muted`, `--accent2`, `--accent-tint`, `--accent-cyan`, `--blue`, `--orange`, `--purple`, `--yellow`, `--sidebar`, `--radius`) is aliased to the new token layer so older markup retints cohesively without structural change. New code should reference the canonical tokens above.

## Canonical component vocabulary

`components.css` defines one canonical class per element role. Every screen and modal composes these instead of bespoke styles. Each variant's radius, padding, border, background, and font-size resolve to tokens.

| Role | Base class | Variants |
|------|-----------|----------|
| Button | `.btn` | Size: `.btn--sm` / `.btn--md` (default) / `.btn--lg` (fixed heights from `--control-height-*`). Intent: `.btn--primary` (solid purple) / `.btn--neutral` (default) / `.btn--ghost` / `.btn--danger`. Width: `.btn--fixed` (label-independent via `--btn-fixed-width`) / `.btn--block` (full width). Labels nowrap + ellipsis so width never tracks text. |
| Tab | `.tab` inside `.tab-strip` | States: default (inactive), `.active` (accent label + accent underline drawn by `::after` with identical geometry), `:hover` (inactive only), `:disabled` / `.disabled`. Applied to all three tab strips (instance context bar, content source tabs, settings tabs). |
| Card | `.card` | `.card--inst` (icon + content row), `.card--mod` (vertical, min-height floor), `.card--media` (banner on top), `.card--compact` (denser). All variants share `--surface-panel` + `--border-frame`; `overflow:hidden` clips content. Sub-elements: `.card-media`, `.card-body`, `.card-title`, `.card-sub`, `.card-text`. |
| Card grid | `.card-grid` | `.card-grid--compact` (uses `--card-track-compact`). `repeat(auto-fill, minmax(track, 1fr))` policy, so cards fill the row evenly and don't clump in the top-left. |
| Badge | `.badge` | `.badge--loader` (+ `.badge--fabric` / `--forge` / `--neoforge` / `--quilt` / `--vanilla`), `.badge--version` (monospace), `.badge--source` (+ `.badge--modrinth` / `--curseforge`). |
| Form field | `.field-control` | `.field-control--text`, `.field-control--select` (token-drawn caret), `.field-control--search` (reserves leading icon space). Shared surface/border/height/focus treatment. |
| Framed panel | `.panel` | `.panel--sunken` (recessed well). `.panel--bracketed` is kept as a no-op class; its decorative `::before` is `display: none` in the redesign. |
| Toggle | `.toggle` (+ `.on`) | Two-half plate: solid track (dark sunken when off, accent purple when on) with a 1px border, plus a 20×22 white thumb (`::after`) carrying a 3px inset under-shadow that reads as the dark base of a raised plate. The thumb covers exactly half the track, so each state shows one solid colored half + one raised white half. |

> Legacy class names (e.g. `.btn-accent`, `.src-tab`, `.ctx-tab`, `.inst-card`, `.mod-card`, `.inst-badge`, `.field-input`) remain in place until the migration cleanup task removes them. New code should use the canonical classes above.

## Responsive layout and the minimum content width

The layout rules live in `base.css` (token layer) and `layout.css` (the `.content` container + responsive guards). The key contract:

- **`--content-min` is `480px` — the minimum supported content width.** At and above 480px the content area renders every screen within its bounds with no horizontal scrollbar and no element past the left or right edge (covering both ≥720px and the 480–719px band).
- Card grids reflow through the shared `.card-grid` `auto-fill / minmax` rule. Because the minimum card track (`--card-track` 240px / `--card-track-compact` 180px) is narrower than `--content-min`, grids drop columns down to 480px without clipping. With `1fr` as the max track, cards expand to fill the row evenly instead of clumping in the top-left.
- **Below `--content-min`, full scaling is no longer guaranteed**, but content keeps rendering without controls overlapping: `.content > *` carries `max-width:100%` + `min-width:0`, and embedded `img` / `video` / `canvas` are capped at `max-width:100%`, so nothing extends past the edges or forces a horizontal scrollbar even below the 480px floor.

## Framed panels (no ornament)

`.panel` is the canonical framed-panel primitive: a visible bordered frame (`--border-frame`) over the elevated panel surface (`--surface-panel`), deliberately distinct from the deepest page background (`--surface-base`) so every primary container reads as a framed panel. It carries the same surface, frame, and `border-radius: 0` as `.card`. Composing `.panel` onto `.modal`, `.settings-group`, or `.card` frames that surface with identical tokens.

`.panel--sunken` inverts the surface (`--surface-sunken`) for recessed wells.

`.panel--bracketed` is **kept as a no-op class** in the current redesign — its `::before` overlay is `display: none`, so applying it has no visual effect. The decorative corner-bracket vocabulary may return in the future; until then, the class stays defined so existing markup compiles, but new code should not rely on it for a visual outcome.

## Global state (App.tsx)

`App.tsx` defines all module-level signals that are shared across the UI. The pattern: signal + setter exported from `App.tsx`, imported wherever needed.

| Signal | Type | Purpose |
|--------|------|---------|
| `activeScreen` / `setActiveScreen` | `Screen` | Current top-level view (`home`, `library`, etc.) |
| `activeInstanceId` / `setActiveInstanceId` | `string \| null` | Currently selected instance for the Mods screen |
| `initialInstanceTab` / `setInitialInstanceTab` | `string` | Tab to open when navigating to an instance (`content`, `logs`, etc.) |
| `gameLaunched` / `setGameLaunched` | `boolean` | "Launch was triggered" flag (UI feedback) |
| `gameRunning` / `setGameRunning` | `boolean` | Updated by `game-exited` / `game-crashed` events |
| `instances` / `refetchInstances` | resource | Instance list from `listInstances()` |
| `account` / `refetchAccount` | resource | Active Microsoft profile |
| `pinnedInstanceIds` | signal | Sidebar pin list (mirrored from settings for reactivity) |
| `pinSelectorOpen` / `setPinSelectorOpen` | `boolean` | When true, the floating dock transforms into the pin carousel. Toggled by the `toggle_pin_selector` keybind |
| `activeSkinUrl` | signal | Cached active skin texture URL for avatars |
| `gameLogs` | record | Per-instance log line buffers (keyed by instance ID) |
| `downloads` | array | Download history shown in the Downloads screen |
| `bulkBatchSize` | signal | Tracks bulk install progress |
| `updateAvailable` | signal | Auto-updater state (drives `<UpdateBanner />`) |
| `offline` | signal | Network status (driven by `online`/`offline` events) |

### Helper functions

- `appendGameLog(id, line)` / `clearGameLogs(id)` / `gameLogsFor(id)` — Per-instance log routing
- `trackDownload(name, category, meta)` → returns ID — Start tracking a download
- `completeDownload(id)` / `failDownload(id)` — Update download state
- `startBulkBatch(total)` / `endBulkBatch()` — Bulk install progress tracking
- `clearDownloadHistory()` — Wipes downloads (used by Downloads screen)
- `refreshPinnedInstanceIds()` — Re-reads pin list from settings (call after pin changes)
- `refreshActiveSkin()` — Re-fetches active Microsoft skin URL
- `ensureAccountOrPrompt()` → boolean — Pre-launch check; shows `<NoAccountModal />` if no account

## Screens

Each screen is a single SolidJS component in `src/screens/`. Switching screens is done via `setActiveScreen(name)`. Routing is just `<Show when={activeScreen() === "name"}>` blocks in `App.tsx`.

| Screen | File | What it does |
|--------|------|--------------|
| `home` | `Home.tsx` | Greeting, recent worlds carousel, Mojang Java news feed with article reader |
| `library` | `Library.tsx` | Instance grid + multi-select + drag-select. "+ New instance" card opens `create-choose` |
| `mods` | `InstanceMods.tsx` | Single-instance view with Content / Browse / Files / Worlds / Logs tabs (~big file) |
| `settings` | `Settings.tsx` | Tabs: General / Resources / Global Instance. Java path finder, GC presets, RPC, video settings |
| `account` | `Account.tsx` | Account list, Microsoft sign-in, offline account, remove account |
| `skins` | `Skins.tsx` | Lazy-loaded (skinview3d is ~500 KB). 3D viewer, upload, cape equip, library |
| `downloads` | `Downloads.tsx` | Persistent download history with cards |

### Pseudo-screens (modal overlays disguised as screens)

These are rendered in the content area but behave like modals:

| Screen | File | Triggers |
|--------|------|----------|
| `create-choose` | `CreateChoose.tsx` | Library "+" card / Ctrl+N |
| `create-custom` | `CreateCustom.tsx` | Choose → Custom setup |
| `create-modpack` | `BrowseModpacks.tsx` | Choose → Install modpack |
| `create-import` | `ImportCurseForge.tsx` | Choose → Import |

Escape key closes them all (handled in `App.tsx`).

## Modals

True modals are mounted at the App level (always present in DOM, controlled by signal). They render an overlay + centered card.

| Component | Trigger | What it does |
|-----------|---------|--------------|
| `<NoAccountModal />` | `ensureAccountOrPrompt()` returns false | Prompts user to sign in before launching |
| `<InstallProgress />` | `install-progress` event from backend | Real-time download progress popup (top-right) |
| `<BulkInstallToast />` | `startBulkBatch()` | Aggregate progress for bulk mod installs (bottom-right) |
| `<DependencyIssuesModal />` | Mod install resolves missing deps | Shows missing/conflicting dependencies after install |
| `<UpdateBanner />` | `services/updater.ts` finds a new version | Top-right banner with "Update available" CTA |
| `<CrashReportModal />` | `showCrashReport(path)` (from `game-crashed` toast action) | Renders the full crash log file |
| `<OnboardingWizard />` | First-run gate in `App.tsx` (`!settings.onboarded && instances.length === 0`) | Multi-step welcome → instance creation flow |
| `<PinInstancesModal />` | Sidebar "+" / pin-toggle button | Picker for sidebar pinned instances (max 5) |
| `<Toasts />` | `showToast({title, message, type, ...})` | Stack of dismissible toast notifications |

## Reusable components

Located in `src/components/`. Most are presentational (no global state).

| Component | Purpose |
|-----------|---------|
| `FloatingDock.tsx` | Bottom-centered floating dock navigation. Three pills: left nav (Home/Library/Skins), state-aware center action button (play/stop/create), right nav (Downloads/Settings/Account). Pinned instances appear in a separate row above when present |
| `Titlebar.tsx` | Top bar: window controls, logo, page title, account pill |
| `ResizeHandles.tsx` | Invisible edge zones for frameless window resizing on Linux |
| `Icons.tsx` | All SVG icons (Feather Icons). Each export is a `<svg>` component |
| `Dropdown.tsx` | Custom styled select (since native `<select>` looks bad on Linux) |
| `JavaPathInput.tsx` | Settings → Resources → Java row (detect / install / browse) |
| `PageSlider.tsx` | Page indicator with prev/next buttons |
| `PlayerHead.tsx` | Renders the 8×8 face block of a Minecraft skin (used in greeting, avatars) |
| `SkinAvatar.tsx` | Larger skin display (used on Account screen) |
| `Toasts.tsx` | Toast container component + `showToast()` export |
| `InstallProgress.tsx` | The install progress popup (rendered by App.tsx) |
| `BulkInstallToast.tsx` | Bulk install aggregate toast |
| `CrashReportModal.tsx` | Crash log viewer + `showCrashReport()` export |
| `DependencyIssuesModal.tsx` | Mod install dependency conflicts |
| `NoAccountModal.tsx` | "Sign in first" prompt |
| `UpdateBanner.tsx` | Auto-update prompt |

## Component conventions

### File template

```tsx
import { Component, createSignal, Show } from "solid-js";
import { someSignal } from "../App";
import { someCommand } from "../ipc/commands";

const MyComponent: Component = () => {
  const [localState, setLocalState] = createSignal("");

  return (
    <div class="my-component">
      <Show when={someSignal()}>
        {/* ... */}
      </Show>
    </div>
  );
};

export default MyComponent;
```

### Naming

- Components: `PascalCase` filename matching the export
- Screens / modals: same
- Utility files (hooks, services): `camelCase`
- Tauri commands: `snake_case` in Rust → `camelCase` wrapper in `commands.ts`
- CSS classes: `kebab-case`, scoped by visual grouping (e.g. `.inst-card`, `.inst-name`, `.inst-meta`)

### CSS class conventions

- **Component classes** match the component name when possible: `.modal`, `.inst-card`, `.toast-item`
- **Variant modifiers** are space-separated, not BEM: `<div class="btn btn-accent">` not `<div class="btn btn--accent">`
- **State modifiers** are unprefixed: `.active`, `.selected`, `.disabled`, `.checked`, `.on`
- **Inline `style=`** is acceptable for one-offs (font-size tweaks, single-component layouts) but the rule of thumb is: if you reuse it twice, promote to a class

### IPC pattern

```tsx
// commands.ts (single source of truth)
export const launchInstance = (id: string) =>
  invoke<number>("launch_instance", { instanceId: id });

// In a component
import { launchInstance } from "../ipc/commands";
await launchInstance(instance.id);
```

Never call `invoke()` directly in a component.

### Event subscriptions

```tsx
import { listen } from "@tauri-apps/api/event";

onMount(() => {
  const unlisten = listen<PayloadType>("event-name", (event) => {
    // ...
  });
  onCleanup(() => unlisten.then(fn => fn()));
});
```

## Adding a new UI element

| You want to add... | Where to put it |
|--------------------|-----------------|
| A reusable button variant | `components/Icons.tsx` (if SVG) or new component in `components/` |
| A new screen | `screens/<Name>.tsx`, then add to `Screen` union + routing in `App.tsx` |
| A new modal | `modals/<Name>.tsx` if it's modal-like, or `components/` if it's a notification-style overlay. Mount in `App.tsx` |
| A new sidebar nav item | Edit `components/Sidebar.tsx`, add corresponding screen |
| New CSS for something existing | Find the right module from the table above; add styles there |
| New CSS for a brand-new feature | Most likely `components.css` (if reusable) or `screens.css` (if specific to a screen) |
| A new icon | `components/Icons.tsx`, follow the existing pattern (Feather, MIT, attributed in comment) |
| A toast notification | `showToast({ title, message, type })` from `components/Toasts.tsx` |

## Keybinds

All customizable keyboard shortcuts are defined in `Vermeil/src/lib/keybinds.ts`. The user-customized bindings are stored in `LauncherSettings.keybinds` (a `Record<string, string>` of action ID → key combo). Missing entries fall back to the action's default.

### Adding a new keybind

1. Add an entry to `KEYBINDS` in `lib/keybinds.ts`:
   ```ts
   {
     id: "toggle_my_thing",     // stable ID, persisted in settings
     label: "Toggle my thing",  // shown in Settings → Keybinds
     description: "...",         // optional sub-text
     default: "Ctrl+T",
   }
   ```
2. In `App.tsx` keydown handler (or wherever you want to react to it):
   ```ts
   if (matchesKeybind(e, resolveBinding("toggle_my_thing", userBindings))) {
     e.preventDefault();
     // ...your action
   }
   ```
3. The Settings → Keybinds tab automatically renders a row for the new action.

### Settings cache invalidation

The keydown handler caches `settings.keybinds` to avoid re-reading on every keypress. When the user changes a binding, Settings.tsx fires a `vermeil-keybinds-changed` window event; App.tsx listens for it and refreshes the cache.

### Pin selector

Pressing the `toggle_pin_selector` keybind (default `Ctrl+P`) flips the `pinSelectorOpen` signal. The `<FloatingDock />` watches that signal and morphs from the standard nav layout into a horizontal scrollable carousel of pinned instances. Click a pin to open the instance and close the selector. Press the keybind again, Escape, or click the center FAB (which becomes a "✕" close button) to dismiss.

### Hardcoded keybinds

Escape is intentionally not user-rebindable. It's a universal "back out" key for closing modals and overlays — remapping it would brick recovery from a stuck modal.



- **Animations:** Use `animation: fadeIn 0.15s ease` (defined in `components.css`). Don't add new keyframes for one-off entrances.
- **Scrollbars:** All scrollable containers should have the 4px webkit scrollbar styling. The global rule in `base.css` covers most of it; component-specific scroll areas use the same colors.
- **Loading states:** Use `<Show when={resource()}>` with a fallback like `<div class="muted">Loading...</div>`. Don't render skeletons.
- **Empty states:** Render a helper card explaining why the area is empty (see Library, Continue section on Home, Skins library).
- **Error display:** Use toasts with `type: "error"`. Don't render errors in-place unless the whole feature is unusable.

## Patterns to avoid

- ❌ Calling `invoke()` directly from a component
- ❌ Hardcoding colors or sizes (always use CSS variables)
- ❌ Using emoji or Unicode glyphs as button icons (use SVGs from `Icons.tsx`)
- ❌ Adding a new CSS file without updating this doc and `index.tsx`
- ❌ Using `window.open()` or `<a href>` for external links — use `openUrl()` from `@tauri-apps/plugin-opener`
- ❌ Adding global state outside of `App.tsx` (component-local signals are fine)
