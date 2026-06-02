---
name: dependencies
description: Add, update, or remove Rust crates or npm packages safely. Use when installing a new library, bumping dependency versions, evaluating a crate, or removing unused packages.
---

# Dependency Management

Guidelines for adding, updating, or removing dependencies.

## Before Adding

1. **Check existing deps** — Read `Cargo.toml` and `package.json`. Don't duplicate.
2. **Evaluate:** Maintained? License compatible (MIT/Apache/BSD, not GPL)? Reasonable transitive count?
3. **Prefer ecosystem standards:** `tokio`, `reqwest`, `serde`, `tracing` for Rust. Don't introduce alternatives.
4. **Skip trivial deps** — <20 lines? Write it inline.

## Adding a Rust Dependency

File: `Vermeil/src-tauri/Cargo.toml`

- Use major.minor version (`"0.12"` not `"0.12.4"`)
- Platform-specific → `[target.'cfg(...)'.dependencies]`
- Run `cargo check` immediately

## Adding a Frontend Dependency

```bash
cd Vermeil
pnpm add <package>        # runtime
pnpm add -D <package>     # dev
pnpm build                # verify
```

## Updating

### Rust
```bash
cargo update && cargo check
```
For major bumps: read changelog, update Cargo.toml manually, fix errors.

### Frontend
```bash
pnpm update && pnpm build
```

## Removing

1. Remove from config file
2. Remove all `use` / `import` statements
3. Replace functionality
4. Build both sides
5. Verify zero warnings

## Rules

- Never add deps in release commits (use `feat:` or `chore:`)
- One major bump per commit
- Keep lockfiles committed (`pnpm-lock.yaml`, `Cargo.lock`)
