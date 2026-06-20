---
name: release-process
description: Release a new version of Vermeil. Use when shipping, tagging, bumping versions, writing changelogs, or preparing a release. Covers the full release flow from pre-checks to tag push.
---

# Release Process

## Day-to-Day Commit Workflow (Always-On)

Every meaningful change is committed and pushed immediately as its own conventional commit. Do not batch unrelated changes into one commit. Do not wait for a release to push.

After completing any change, verify it builds, then:

1. Stage the change: `git -C <repo> add <files>` (or `-A` if everything in working tree belongs to this change)
2. Commit with a conventional prefix: `git -C <repo> commit -m "<type>(<scope>): <imperative summary>"`
3. Push immediately: `git -C <repo> push`

Never push without an explicit user request? **No** — push is automatic and immediate for normal commits. The exception is `release: X.Y.Z` commits and version tags, which require explicit user approval (see below).

### Conventional Commit Types

| Type | When to use |
|------|-------------|
| `feat:` | New user-visible functionality |
| `fix:` | Bug fix (user-visible defect resolved) |
| `refactor:` | Code restructure, no behavior change |
| `perf:` | Performance improvement, no behavior change |
| `style:` | Formatting, whitespace, lint fixes only |
| `docs:` | Documentation, comments, README, CHANGELOG |
| `chore:` | Dependency bumps, CI, build config, housekeeping |
| `test:` | Adding or updating tests |
| `revert:` | Reverting a prior commit |
| `release:` | Version bump + changelog (only on release flow, requires approval) |

### Scope (optional but encouraged)

Use a short scope in parentheses to indicate the affected area:

- `fix(settings): live slider values during drag`
- `feat(curseforge): modpack name deduplication`
- `refactor(launch): split options.txt patcher into helper`
- `chore(deps): bump tauri to 2.1`

### Commit Message Rules

Keep them short. Most commits are one line — a body is the exception, not the rule.

- Imperative mood: "add X", "fix Y", not "added" or "fixes"
- Subject under 70 chars, lower-case after the prefix, no trailing period
- Lead with the user-visible change, not the implementation detail
- **Body only when it adds something the subject can't carry** — usually a non-obvious *why*, a regression risk, or a follow-up note. If the body just restates what the diff already shows, drop it.
- When a body is needed, keep it to 1–3 short lines. No multi-paragraph rationale, no step-by-step walkthroughs, no quoted code. The diff is the source of truth.
- Never mention other launcher projects by name
- No emojis in subject lines

Good (subject only — the diff speaks for itself):

```
fix(modpack): enrich metadata for resource packs and shaders
```

Good (one-line body for non-obvious why):

```
fix(launch): keep global GC preset live when extras are preset-equal

Stale extras from a previous preset were silently overriding new picks.
```

Bad (long body restating the patch):

```
fix(launch): keep global GC preset live when instance flags are preset-equal

Switching the GC preset in Settings only updated an instance's Java args once.
After that, the editor's blur handler would persist the pre-filled preset
flags into extra_args, and the launch path treats any non-empty extra_args as
a hard override of the global preset — so subsequent preset switches were
silently shadowed.

Add get_known_preset_args, which resolves every preset's flags...
```

## Releasing a New Version

A release happens **only when the user explicitly asks** ("release", "ship", "tag", "push a release", "next version", etc.).

### Pre-Release Checklist

1. Frontend builds clean: `pnpm run build` from `Vermeil/`
2. Rust compiles clean (zero warnings): `cargo check` from `Vermeil/src-tauri/`
3. No diagnostics errors on key files
4. All recent changes already committed and pushed (they should be — that's the daily workflow)
5. Auto-updater endpoint URL in `tauri.conf.json` is correct
6. Updater pubkey in `tauri.conf.json` matches the signing key used in CI

### Files to Update Before Tagging

All three files MUST have matching version numbers — Cargo.toml drives the
User-Agent and the `${launcher_version}` token in Minecraft launch args via
`CARGO_PKG_VERSION`, so missing it leaves the launcher advertising the wrong
version on every outbound request:

1. `Vermeil/package.json` → `"version"` field
2. `Vermeil/src-tauri/tauri.conf.json` → `"version"` field
3. `Vermeil/src-tauri/Cargo.toml` → `version = "..."` under `[package]`

### Version Increment Rules (semver)

- **PATCH** (`0.1.0` → `0.1.1`): Bug fixes only, no new features, no breaking changes
- **MINOR** (`0.1.5` → `0.2.0`): New features, backwards compatible
- **MAJOR** (`0.9.0` → `1.0.0`): Breaking changes, migration required

While in pre-1.0 development, anything goes — use MINOR for any meaningful change. Reserve `1.0.0` for production-ready milestone.

### Step-by-Step Release Flow

1. Confirm working tree is clean and pushed (`git status`, `git log origin/main..HEAD` should be empty)
2. Bump version in `Vermeil/package.json` and `Vermeil/src-tauri/tauri.conf.json`
3. Generate `CHANGELOG.md` from the conventional commits since the last tag:
   - Run `git log <last-tag>..HEAD --oneline` to list commits
   - Group by type into `### Added` (feat), `### Changed` (refactor/perf), `### Fixed` (fix)
   - Replace `CHANGELOG.md` contents with the new section (don't prepend)
4. Commit: `release: X.Y.Z` (this is the one commit that uses the `release:` prefix)
5. Push: `git push`
6. Tag: `git tag vX.Y.Z`
7. Push tag: `git push origin vX.Y.Z`
8. Mark the release **pre-release + EXPERIMENTAL** — this is the current standing
   default (see below). Don't make it a full "latest" release unless the user
   explicitly says to.

### Changelog Generation Rules

When generating the changelog from conventional commits since the last tag:

- Map `feat:` → `### Added`
- Map `fix:` → `### Fixed`
- Map `refactor:` / `perf:` → `### Changed`
- Skip `chore:`, `style:`, `docs:` unless user-visible (e.g. user-facing docs)
- Rewrite the summary to be user-facing (no implementation jargon)
- One line per bullet
- No marketing language, no emojis, no other launcher mentions

### Changelog Format

```markdown
## X.Y.Z

### Added

- New user-visible thing (from feat: commits)

### Changed

- Behavior tweak (from refactor:/perf: commits)

### Fixed

- Bug fix (from fix: commits)
```

Replace file contents on each release. Don't prepend.

## Version Cadence

- Single-digit patches only: `0.X.0` → `0.X.9` → `0.(X+1).0`
- Never use four-segment versions (Tauri rejects them)

## Tagging Rules

- Always `v` prefix: `v0.2.3`
- Never bump/tag without explicit user approval (the `release:` commit requires confirmation)
- Tags are immutable — never reuse a tag once pushed

## Experimental / Build-Test Releases

## Experimental Releases — current standing policy

**Until the user explicitly says to fully release (their words: "fully release as
is"), EVERY `v*` release ships as a pre-release titled `vX.Y.Z EXPERIMENTAL`.**
This holds through the `0.7.0` run and beyond until lifted — it is the default for
every tag, not a special case.

Why: a normal (non-prerelease) release becomes "latest", and the launcher's
auto-updater serves that release's `latest.json` to every user — so a full release
ships itself to everyone. Pre-release is excluded from `releases/latest`, so the
updater skips it.

Right after pushing the tag (before any user can update):

- `gh release edit vX.Y.Z --prerelease --title "vX.Y.Z EXPERIMENTAL" --repo <repo>`

When the user says to fully release a given version, promote that one:

- `gh release edit vX.Y.Z --prerelease=false --latest --title "Vermeil vX.Y.Z"`

Mod releases (`mod-v*`): the launcher fetches the latest **non-draft** `mod-v*`
release (it does not skip prereleases), so an experimental mod build must be a
**draft** until verified — `gh release edit mod-vX.Y.Z --draft`.
