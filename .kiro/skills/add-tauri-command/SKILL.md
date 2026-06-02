---
name: add-tauri-command
description: Add a new Tauri IPC command connecting the Rust backend to the SolidJS frontend. Use when creating a new invoke command, adding backend functionality, or wiring a new API endpoint through IPC.
---

# Adding a New Tauri Command

Follow this exact sequence. Every step is required.

## 1. Implement the Service Logic

File: `src-tauri/src/services/<module>.rs`

```rust
pub async fn do_something(param: &str) -> Result<ReturnType, String> {
    tracing::debug!("Doing something with {}", param);
    Ok(result)
}
```

Rules: `pub async fn`, returns `Result<T, String>`, uses shared HTTP client, no Tauri types unless emitting events.

## 2. Create the Command Handler

File: `src-tauri/src/commands/<module>.rs`

```rust
#[tauri::command]
pub async fn do_something(param: String) -> Result<ReturnType, String> {
    crate::services::<module>::do_something(&param).await
}
```

Rules: thin layer, parameter names match frontend exactly.

## 3. Export from Commands Module

File: `src-tauri/src/commands/mod.rs` — add `pub mod <module>;`

## 4. Register in lib.rs

Add to `invoke_handler` array in alphabetical order within its section.

## 5. Add TypeScript Wrapper

File: `src/ipc/commands.ts`

```typescript
export interface SomethingResult { field: string; }
export const doSomething = (param: string) =>
  invoke<SomethingResult>("do_something", { param });
```

## 6. Use in Frontend

```typescript
import { doSomething } from "../ipc/commands";
const result = await doSomething("value");
```

## Verification

- `cargo check` passes
- `pnpm build` passes
- Command callable from frontend without runtime errors

## Common Mistakes

- Parameter name mismatch (Tauri is case-sensitive)
- Forgetting `lib.rs` registration (command silently doesn't exist)
- Return type missing `Serialize` derive
