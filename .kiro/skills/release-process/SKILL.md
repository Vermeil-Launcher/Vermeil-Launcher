---
name: release-process
description: Release a new version of Vermeil. Use when shipping, tagging, bumping versions, writing changelogs, or preparing a release. Covers the full release flow from pre-checks to tag push.
---

# Release Process

When the user asks to push an update, release a new version, or bump the version, follow this exact process.

## Files to Update Before Tagging

Both files MUST have matching version numbers:

1. `Vermeil/package.json` → `"version"` field
2. `Vermeil/src-tauri/tauri.conf.json` → `"version"` field

## Version Increment Rules (semver)

- **PATCH** (`0.1.0` → `0.1.1`): Bug fixes only, no new features, no breaking changes
- **MINOR** (`0.1.5` → `0.2.0`): New features, backwards compatible
- **MAJOR** (`0.9.0` → `1.0.0`): Breaking changes, migration required

While in pre-1.0 development, anything goes — use MINOR for any meaningful change. Reserve `1.0.0` for production-ready milestone.

## Commit Message Convention

| Type | Format | When to use |
|------|--------|-------------|
| Release | `release: X.Y.Z` | Version bump + changelog commit (the one that gets tagged) |
| Feature | `feat: short description` | New user-visible functionality |
| Fix | `fix: short description` | Bug fix |
| Chore | `chore: short description` | Housekeeping, deps, CI changes |
| Docs | `docs: short description` | Documentation only |
| Refactor | `refactor: short description` | Code restructure, no behavior change |

## Pre-Release Checklist

1. Frontend builds clean: `pnpm run build` from `Vermeil/`
2. Rust compiles clean (zero warnings): `cargo check` from `Vermeil/src-tauri/`
3. No diagnostics errors on key files
4. Recent changes were committed and pushed
5. Auto-updater endpoint URL in `tauri.conf.json` is correct
6. Updater pubkey in `tauri.conf.json` matches the signing key used in CI

## Step-by-Step Release Flow

1. Check git status — confirm working tree is clean
2. If uncommitted changes exist — stage and commit with appropriate prefix
3. Bump version in both files
4. Write `CHANGELOG.md` — replace contents with the new release section
5. Commit: `release: X.Y.Z`
6. Push
7. Tag: `git tag vX.Y.Z`
8. Push tag: `git push origin vX.Y.Z`

## Changelog Format

- Replace file contents each release (don't prepend)
- `## X.Y.Z` header + `### Added` / `### Changed` / `### Fixed` / `### Notes`
- One line per bullet. Lead with user-visible change, not implementation.
- No marketing language, no emojis, no other launcher mentions.

## Version Cadence

- Single-digit patches only: `0.X.0` → `0.X.9` → `0.(X+1).0`
- Never use four-segment versions (Tauri rejects them)

## Tagging Rules

- Always `v` prefix: `v0.2.3`
- Never bump/tag without explicit user approval
- Tags are immutable — never reuse
