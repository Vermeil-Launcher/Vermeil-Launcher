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

## Design tokens

All colors, fonts, and key sizes are defined as CSS variables in `base.css` under `:root`. Use these instead of hardcoded values.

### Backgrounds (4-level system)

| Variable | Value | Use for |
|----------|-------|---------|
| `--bg` | `#111214` | Sidebar, titlebar, app frame |
| `--bg2` | `#18191c` | Main content area |
| `--bg3` | `#1e2024` | Cards, surfaces, modals |
| `--bg4` | `#25272c` | Hover states, elevated buttons, dropdowns |

### Text

| Variable | Value | Use for |
|----------|-------|---------|
| `--text` | `#e3e5e8` | Primary text |
| `--muted` | `#8b8f98` | Secondary text, labels, meta info |

### Accent

| Variable | Value | Use for |
|----------|-------|---------|
| `--accent` | `#8B5CF6` (purple) | Active states, primary buttons, focus rings, links |
| `--accent2` | `#7C4DDE` | Hover variant of accent |
| `--accent-tint` | `#1a1428` | Subtle background tint when something is active |
| `--accent-cyan` | `#38BDF8` | Secondary accent (sidebar active icon, vanilla badge) |

### Loader identity (badges only)

| Variable | Use for |
|----------|---------|
| `--blue` (`#5b8af0`) | NeoForge |
| `--orange` (`#e8834a`) | Forge |
| `--purple` (`#c084e8`) | Quilt |
| `--yellow` (`#f4d04f`) | Warning states |

### Other

| Variable | Value | Notes |
|----------|-------|-------|
| `--border` | `#2e3035` | All 1px borders |
| `--sidebar` | `52px` | Sidebar width |
| `--radius` | `10px` | Default border-radius |
| `--font` | `'DM Sans', system-ui, sans-serif` | Body text |
| `--font-mono` | `'DM Mono', monospace` | Code, paths, numbers |

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
