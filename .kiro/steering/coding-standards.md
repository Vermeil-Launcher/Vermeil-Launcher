---
inclusion: always
---

# Coding Standards

These rules apply to every change in this project. They are non-negotiable.

## Project Structure

```
Vermeil/
├── src/                          # SolidJS frontend
│   ├── components/               # Reusable UI components
│   ├── screens/                  # Full-page views
│   ├── modals/                   # Modal dialogs
│   ├── ipc/commands.ts           # ALL Tauri invoke wrappers (single source of truth)
│   ├── services/                 # Frontend-only logic (updater, etc.)
│   ├── styles/global.css         # All CSS (variables, reset, components)
│   ├── App.tsx                   # Root component, global state, screen routing
│   └── index.tsx                 # Entry point
├── src-tauri/
│   └── src/
│       ├── commands/             # Tauri command handlers (thin layer)
│       ├── services/             # Business logic (heavy lifting)
│       ├── models/               # Data structures and types
│       ├── util/                 # Shared helpers (paths, http, etc.)
│       ├── lib.rs                # Plugin/command registration
│       └── main.rs               # Entry point
```

## Rust Backend Rules

### Commands
- Every command uses `#[tauri::command]` and is `pub async fn`
- Commands are thin — they validate input, call a service, and return the result
- Commands return `Result<T, String>` (migrating to `Result<T, AppError>`)
- Register every new command in `lib.rs` → `invoke_handler` array

### Services
- All heavy logic lives in `src-tauri/src/services/`
- Services are `pub async fn` and accept specific parameters (not whole structs when only one field is needed)
- Services do NOT depend on Tauri types unless they need `AppHandle` for events
- Use `tracing::info!` / `tracing::error!` / `tracing::debug!` for logging — never `println!`

### HTTP
- Use the shared `reqwest::Client` from Tauri managed state
- Always set `User-Agent: "Vermeil/{version}"`
- Verify downloads with SHA-1 hash when available
- Use `.part` files for downloads — rename to final path only after verification
- Retry failed downloads up to 3 times with 500ms delay
- **API vs CDN concurrency.** Distinguish two traffic shapes:
  - **APIs** (`api.modrinth.com`, `api.curseforge.com`, Mojang profile/auth endpoints) are rate-limited and ToS-bound. Modrinth caps at 300 req/min; CurseForge per-key limits can revoke a key for abusive patterns. Always batch (`POST /v1/mods` with up to 50 IDs, `/v2/version_files` with hashes, `/v2/projects?ids=[…]`). Don't parallelize sequential API calls just because they look serial — the rate-limit budget is the constraint, not wall-clock.
  - **CDNs** (`cdn.modrinth.com`, `media.forgecdn.net`, Mojang asset/library mirrors) are static-asset hosts and tolerate concurrent fetches like any browser does. Use bounded parallel here for speed.
  - The user-tunable `concurrent_downloads` / `concurrent_writes` settings govern *install-blocking* download batches via `services::download::download_all` — fetch capped at `MAX_FETCH=20`, write at `MAX_WRITE=50`. Background/cosmetic work (e.g. icon caching during enrichment) uses a fixed internal concurrency, not the user setting, so a user lowering the slider doesn't make polish work crawl and raising it doesn't pointlessly hammer a CDN.

### File I/O
- Use `crate::util::paths` for all data directory paths — never hardcode
- Create parent directories before writing: `fs::create_dir_all(parent)`
- Use `serde_json::to_string_pretty` for human-readable JSON files (instance.json, settings.json, accounts.json)
- When surfacing a path to the frontend on Windows, **strip the Windows `\\?\` extended-length prefix** before serializing. `Path::canonicalize()` returns this NT-style form on Windows; the user expects `C:\Users\...`. Use `services::java::strip_extended_prefix` (or the same logic) on every path that crosses the IPC boundary. On Linux this is a no-op (canonicalize returns normal paths).

### Error Handling
- Prefer descriptive error messages: `format!("Failed to download {}: {}", url, e)` not just `e.to_string()`
- Log errors at the point of origin with `tracing::error!`
- Don't swallow errors silently — if you use `let _ =`, add a comment explaining why

## TypeScript Frontend Rules

### IPC
- ALL Tauri `invoke()` calls go through `src/ipc/commands.ts` — never call `invoke` directly from components
- Every command wrapper has a typed return: `invoke<ReturnType>("command_name", { params })`
- Define interfaces for all IPC return types in `commands.ts`

### State Management
- Global state uses SolidJS signals defined at module level in `App.tsx`
- Export signals and their setters for use in child components
- Use `createResource` for async data that loads once
- Use `createSignal` for UI state that changes frequently

### Components
- Screens go in `src/screens/` — one file per screen
- Modals go in `src/modals/` — one file per modal
- Reusable UI goes in `src/components/`
- Each component is a `const ComponentName: Component = () => { ... }`

### Icons
- **Never use emoji or unicode glyphs as button/UI icons** (`⤓ 🔍 📂 ⚙ 📦 🌐` etc.). They render inconsistently across fonts and platforms and look unprofessional next to vector text.
- Use SVG icons from `src/components/Icons.tsx`. Add new ones from a permissively-licensed open-source icon set — preferably **Feather Icons (MIT)** to match what's already there.
- When adding a new icon, include a comment with the source attribution: `// Icon name — Feather Icons (MIT). https://github.com/feathericons/feather`.
- Each icon component follows the same pattern: `viewBox="0 0 24 24"`, `stroke="currentColor"`, `stroke-width="1.8"` (or 1.6 / 2.0 to match neighbors), `stroke-linecap="round"`, `stroke-linejoin="round"`. Filled icons use `fill="currentColor"`.
- The `.btn` class already styles SVG children to `13×13`. Buttons render `<IconName />` then text — no manual sizing needed.
- Emoji is fine in *content* (toast titles, modal copy, comments, log lines) — just not in interactive UI affordances.

### Events
- Subscribe to Tauri events with `listen()` from `@tauri-apps/api/event`
- Always store the unlisten function and call it in cleanup
- Event names use kebab-case: `download-progress`, `game-exited`, `game-crashed`

### External Links
- Never use `window.open()` or `<a href>` for external URLs
- Always use `openUrl()` from `@tauri-apps/plugin-opener`
- Intercept clicks on rendered HTML content (news articles, mod descriptions) to prevent webview navigation

## Naming Conventions

| Context | Convention | Example |
|---------|-----------|---------|
| Rust functions/variables | snake_case | `get_game_versions` |
| Rust types/structs/enums | PascalCase | `LoaderType`, `Instance` |
| Rust constants | SCREAMING_SNAKE | `MAX_CONCURRENT` |
| TypeScript functions/variables | camelCase | `getGameVersions` |
| TypeScript types/interfaces | PascalCase | `GameVersion`, `ModHit` |
| TypeScript components | PascalCase | `InstanceCard`, `Sidebar` |
| Tauri commands | snake_case | `launch_instance` |
| Tauri events | kebab-case | `download-progress` |
| CSS variables | kebab-case with `--` | `--bg1`, `--accent`, `--muted` |
| CSS classes | kebab-case | `.instance-card`, `.play-btn` |
| File names (Rust) | snake_case | `mod_install.rs` |
| File names (TypeScript) | PascalCase for components, camelCase for utils | `Home.tsx`, `commands.ts` |

## Adding a New Feature (Checklist)

When adding a new backend-to-frontend feature, complete ALL of these:

1. ☐ Service logic in `src-tauri/src/services/<module>.rs`
2. ☐ Command handler in `src-tauri/src/commands/<module>.rs`
3. ☐ Command registered in `lib.rs` invoke_handler array
4. ☐ TypeScript interface for return type in `src/ipc/commands.ts`
5. ☐ Typed wrapper function in `src/ipc/commands.ts`
6. ☐ Frontend component calls the wrapper (never raw `invoke`)

When adding a new screen:

1. ☐ Component in `src/screens/<Name>.tsx`
2. ☐ Screen name added to `Screen` type union in `App.tsx`
3. ☐ `<Show when={activeScreen() === "name"}>` added in App.tsx content area
4. ☐ Title added to `screenTitles` record
5. ☐ Sidebar entry added (if applicable)

## Parallel Implementations (Feature Parity)

Many features in this project have **two or more parallel implementations** of the same logical concept. When you change one, the others almost always need the same change. Skipping a parallel surface is one of the easiest ways to ship a bug.

Recognize these parallel groups before making changes:

| Parallel group | Surfaces |
|----------------|----------|
| **Mod content sources** | `services/modrinth.rs`, `services/curseforge.rs`, `services/cf_*.rs`. See the `content-source-parity` skill for the full API differences cheat sheet. |
| **Mod loaders** | `services/fabric.rs`, `services/quilt.rs`, `services/neoforge.rs` (handles Forge too). Adding a feature to one loader's installer? The others need the same. |
| **Account types** | Microsoft (online) and offline accounts. New profile field → both paths must populate it. |
| **Launch entry points** | `Home.tsx` and `FloatingDock.tsx` both call `launchInstance`. State setup before launch (clearing logs, setting flags, ensuring account) must match between them. |
| **IPC contracts** | Every Rust `#[tauri::command]` has a TypeScript wrapper in `ipc/commands.ts`. Change the Rust signature → update the wrapper. New return field → update the TypeScript interface. |
| **Tauri events** | Every backend `emit()` has a frontend `listen()`. Rename or add an event → update all subscribers. |
| **Per-platform code** | `#[cfg(windows)]` / `#[cfg(unix)]` branches. Don't fix only one branch unless the bug is platform-specific. See the **Cross-Platform Parity** section below — it covers the harder case where a behavior exists on one platform and is missing entirely on the other. |

**Rule:** before considering a change done, ask "what other code does the same thing for a different variant?" Locate every parallel surface, apply the same change, and verify each one before pushing.

If a parallel surface genuinely can't support the feature (e.g. CurseForge has no follower count, so a "follows" sort has no direct equivalent), document the gap with a code comment naming the missing capability — and pick a sensible nearest-equivalent rather than letting the feature silently fail on that surface.

## Cross-Platform Parity (Windows ↔ Linux)

This app ships on **both Windows and Linux**. Every user-facing behavior must work on both. This is a stronger requirement than the "Per-platform code" row above: that row is about keeping two existing `#[cfg]` branches in sync, but the bug that bites hardest is a behavior that exists on one platform and is **absent or unenforced on the other** — there's no second branch to "keep in sync," so a naive parallel-surface scan misses it. Most Linux-only regressions in this project have been exactly this shape.

The two platforms differ in ways that silently change behavior:

- **Windowing.** Windows uses Win32/DWM; Linux uses an X11 or Wayland WM/compositor. Things Windows enforces for you (min window size, focus, z-order, rounded corners) a Linux compositor may treat as advisory or ignore — especially for our frameless (`decorations: false`, client-side-decorated) window. Don't assume a window hint is obeyed; enforce it in app code if the behavior matters.
- **Webview.** Windows runs WebView2 (Chromium); Linux runs WebKitGTK. They diverge on JS timing/microtask ordering, CSS support, and network/TLS stack (schannel vs system OpenSSL). A frontend behavior that "just works" on WebView2 can break on WebKitGTK.
- **OS services.** Focus-stealing prevention, process APIs, filesystem semantics (`\\?\` prefix, path separators, case sensitivity), and credential storage (DPAPI vs the Linux fallback) all differ.

### The Rule

When you add or change any user-facing behavior, **confirm it works on both Windows and Linux before calling it done.** Specifically:

- If the behavior is implemented in platform-specific code (`#[cfg(...)]`, a Win32/DWM call, a `navigator.userAgent` branch), provide the equivalent on the other platform — or document in a code comment why it legitimately can't exist there and what the user experiences instead.
- If the behavior leans on the OS or WM to enforce something (window sizing, focus, z-order, file locking), don't trust the platform to do it uniformly. Verify the Linux compositor / WebKitGTK actually honors it; if it might not, enforce it in app code so the result is the same everywhere.
- A feature is not "missing on Linux is fine" by default. Absence on one platform is a gap to be closed or explicitly justified, never a silent default.

### Can't physically verify the other platform?

The dev shell is Windows, so you usually can't run the Linux build yourself. When you can't:

- Reason explicitly about the Linux path (WM/compositor, WebKitGTK, OpenSSL) in your analysis, and prefer app-level enforcement over trusting platform behavior.
- Call out in the change summary that the behavior needs a Linux smoke-test, and what specifically to check.
- Never assume Windows-passing means Linux-passing. State the assumption so it can be tested.

## Security & Performance

These apply to the whole app — backend and frontend, every feature and code path — not just new windows or one screen. Weigh them against the work at hand; don't gold-plate, but don't skip them either. The examples are illustrative, not the limit of where the rule applies.

### Security
- **Treat everything from outside the app as untrusted** — network responses (Modrinth/CurseForge/Mojang/Adoptium), files on disk, game and mod output, and user-entered values. Validate type and range, escape, and bound it before it flows into logic, the UI, or storage.
- **Render untrusted content as escaped text, never `innerHTML`.** Solid's `{value}` interpolation escapes — rely on that for anything originating outside the app.
- **Validate at the boundary before building a path, command, or URL.** Anything that becomes a filesystem path, process argument, or request URL must be sanitized first — reject traversal (`..`), separators, and malformed input rather than trusting the caller.
- **Least privilege, everywhere.** Tauri window capabilities, asset-protocol scope, and permission grants expose only what's actually used. Default to the narrowest scope and widen only when a real need appears.
- **Guard secrets.** Tokens and credentials stay encrypted at rest and never get logged, serialized to plaintext, or sent to the frontend. On auth/permission/validation failure, deny rather than proceed.

### Performance
- **Bound anything that grows with use or time.** Buffers, caches, lists, histories (logs, event streams, in-memory metadata) get a cap or eviction policy so a long session can't balloon memory or the DOM. Apply the same bound across parallel surfaces.
- **Keep the UI and the IPC path responsive.** Heavy work runs async/in the background, never blocking the webview; avoid redundant IPC round-trips and re-fetches; memoize derived state instead of recomputing it each render.
- **Do work proportional to need.** Batch rate-limited API calls (see the API-vs-CDN model above), lazy-load heavy resources, and don't parallelize what the rate-limit budget — not wall-clock — actually constrains.
- **Scale across devices.** Layouts and windows stay usable on small laptops and high-DPI panels, following the app's existing fixed-px + webview-scale convention; set sane minimum sizes.

## Things That Are Never Acceptable

- Creating a new `reqwest::Client` instead of using the shared one
- Calling `invoke()` directly in a component instead of through `commands.ts`
- Hardcoding file paths instead of using `util/paths.rs`
- Using `unwrap()` in production code paths (use `?` or handle the error)
- Leaving `TODO` comments without a linked issue or explanation
- Silently catching and discarding errors without logging
- Adding dependencies without checking if an existing one already covers the need
- Using emoji or unicode glyphs as button or other UI icons (use SVGs from `Icons.tsx` instead)
- Returning a Windows `\\?\`-prefixed path to the frontend on Windows builds (strip it before serializing)
- Rendering untrusted content (logs, mod data, network responses) via `innerHTML` instead of escaped text
- Joining a frontend-supplied ID into a filesystem path without validating it first
- Shipping a user-facing behavior that works on only one of Windows/Linux without either providing the cross-platform equivalent or documenting why it can't exist (see **Cross-Platform Parity**)
- Adding a new window to the `default` capability instead of giving it a scoped, least-privilege one
- **Suppressing compiler warnings instead of fixing them.** Never use `#[allow(dead_code)]`, `#[allow(unused_imports)]`, or `#[allow(unused_variables)]` to silence warnings. If a field, function, or import triggers a warning, the correct response is to either use it or remove it — not hide it. The build must be zero-warning at all times. If a struct field exists only for future use, don't add it until the code that reads it is written in the same commit.

## Releases

See the `release-process` skill for version bumping, changelog format, and tagging rules.

### Original work

This is an original project. All code is written from scratch using official documentation, public API specs, and protocol references.

Rules for all written output (code comments, commits, changelogs, docs):

- Describe what **our code** does. Never frame it as derived from, inspired by, or compared to another launcher.
- Never reference other launcher codebases by name. We don't use reference folders, vendored source, or study-then-reimplement workflows.
- Third-party **services and APIs** we integrate with can be named normally: "Modrinth API", "CurseForge API", "Mojang's profile endpoint", "Adoptium API", ".mrpack format". These are services, not source code.
- When implementing a feature, research from official documentation and specs. Not from other launchers' source code.


