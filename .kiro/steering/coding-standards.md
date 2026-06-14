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
| **Per-platform code** | `#[cfg(windows)]` / `#[cfg(unix)]` branches. Don't fix only one branch unless the bug is platform-specific. |

**Rule:** before considering a change done, ask "what other code does the same thing for a different variant?" Locate every parallel surface, apply the same change, and verify each one before pushing.

If a parallel surface genuinely can't support the feature (e.g. CurseForge has no follower count, so a "follows" sort has no direct equivalent), document the gap with a code comment naming the missing capability — and pick a sensible nearest-equivalent rather than letting the feature silently fail on that surface.

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


