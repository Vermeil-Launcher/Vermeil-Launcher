---
name: add-mod-loader
description: Add support for a new Minecraft mod loader (like a new Forge fork or new loader project). Use when implementing a new loader backend, adding loader version fetching, or wiring a loader into the launch pipeline.
---

# Adding a New Mod Loader

Follow this sequence when adding support for a new mod loader.

## 1. Add to LoaderType Enum

File: `src-tauri/src/models/instance.rs`

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoaderType {
    Vanilla,
    Fabric,
    Forge,
    Neoforge,
    Quilt,
    NewLoader,  // ← add here
}
```

## 2. Create the Loader Service

File: `src-tauri/src/services/new_loader.rs`

Implement: `get_loader_versions`, `get_game_versions`, `ensure_loader_libraries`.

Rules: use shared HTTP client, cache metadata in `paths::meta_dir()`, return main class + library paths + JVM args + game args.

## 3. Register in Services Module

File: `src-tauri/src/services/mod.rs` — add `pub mod new_loader;`

## 4. Add to Launch Pipeline

File: `src-tauri/src/services/launch.rs` — add match arm in the loader type block.

## 5. Add Meta Commands

File: `src-tauri/src/commands/meta.rs` — add version/game-version fetch commands. Register in `lib.rs`.

## 6. Add TypeScript Wrappers

File: `src/ipc/commands.ts` — typed wrappers for the new meta commands.

## 7. Update Create Instance UI

File: `src/modals/CreateCustom.tsx` — add loader to selection, fetch versions.

## 8. Update Mod Search

Ensure loader name matches what the mod search APIs expect.

## Verification

- Can create an instance with the new loader
- Loader libraries download correctly
- Game launches with correct main class
- Mods searchable and installable
- Existing loaders still work
