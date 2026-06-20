---
name: dependencies
description: Add, update, or remove dependencies and toolchain/system prerequisites safely, covering Rust crates, npm packages, Gradle/Java mod deps, and required tools like JDK or Build Tools. Use when installing a library, bumping versions, adding a build tool, evaluating a crate, or removing unused packages. Always ripples the change into the docs that list dependencies.
---

# Dependency Management

Guidelines for adding, updating, or removing dependencies — including the
**system prerequisites/toolchain** that don't live in a manifest file.

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

## System Prerequisites & Toolchain

Some dependencies aren't a line in `Cargo.toml`/`package.json`/`gradle.properties`
— they're a tool the contributor must install (a JDK, a Build Tools workload, a
package-manager system lib). These are the easiest to forget because no manifest
forces them.

- **Mod deps** (`vermeil-fabric-26/`) live in `gradle.properties` (MC, Fabric loader,
  Fabric API, Loom) and `build.gradle`. Pin exact versions from the official
  Fabric "Develop" page. See the `minecraft-mod` skill.
- **System tools** (JDK version, Gradle, MSVC Build Tools, WebKitGTK/system libs)
  aren't in any manifest. When a change starts requiring one — or bumps the
  required version — it is **not done** until the prerequisite is documented.

## Keep Dependency Docs in Sync (required, not optional)

Adding, removing, or version-bumping any dependency or tool **must** ripple into
the places that tell a contributor what to install. Treat this as part of the
change, in the same commit — a stale prerequisite list is a bug. Check and update:

- `docs/DEVELOPMENT.md` → **Prerequisites** (per-OS) and the relevant build
  section. This is the canonical "what you need installed" list.
- The matching **skill** if the tool has one (e.g. `minecraft-mod` for the mod
  toolchain) so its pinned versions match reality.
- Any setup script or CI workflow that installs the tool.
- The manifest/lockfile itself (`Cargo.toml` + `Cargo.lock`, `package.json` +
  `pnpm-lock.yaml`, `gradle.properties`).

If you bump a required *version* (e.g. JDK 21 → 25), update every place that
names the old version, not just the manifest.

## Rules

- Never add deps in release commits (use `feat:` or `chore:`)
- One major bump per commit
- Keep lockfiles committed (`pnpm-lock.yaml`, `Cargo.lock`)
