---
inclusion: always
---

# Content Source Parity (Modrinth ↔ CurseForge)

When implementing or modifying any feature that flows through both **Modrinth** and **CurseForge** (search, browse, install, update checks, metadata fetches), the two APIs are similar but never identical. Treating them as interchangeable is how features quietly break for one of the two sources.

This document is the rule for cross-source work. Read it before touching anything in `services/modrinth.rs`, `services/curseforge.rs`, `services/cf_*.rs`, `commands/mods.rs`, `BrowseModpacks.tsx`, or the Browse tab in `InstanceMods.tsx`.

## The Rule

When you change behavior on one source, **immediately verify the equivalent behavior on the other source** before considering the change done. Concretely:

- New filter / sort option on the Modrinth path → check that CurseForge path applies it correctly, or document why it can't.
- New field exposed in `ModHit` → both `services/modrinth.rs` and `services/curseforge.rs` must populate it (or explicitly set `None` with a comment explaining why).
- New search parameter → make sure both backends translate it correctly to their respective API conventions.
- Bug fix on one source → check whether the same defect exists on the sibling source.

If the two APIs genuinely don't support equivalent behavior, document the gap in code with a comment naming the missing capability — don't pretend the feature works for both.

## Known API Differences (cheat sheet)

This list is non-exhaustive. Update it whenever you discover a new mismatch.

### Loader filtering

- **Modrinth**: facets-based. Pass `categories=fabric` etc. in the `facets` array.
- **CurseForge**: `modLoaderType` query parameter with numeric IDs (1=Forge, 4=Fabric, 5=Quilt, 6=NeoForge).
- **Project types affected**: mods AND modpacks have a primary loader. Resource packs, shaders, and datapacks are loader-agnostic on both sources — applying a loader filter to those returns zero results on CurseForge.

### Sort fields

- **Modrinth**: `relevance`, `downloads`, `follows`, `newest`, `updated`.
- **CurseForge**: `1=Featured`, `2=Popularity`, `3=Updated`, `4=Name`, `6=Downloads`, `11=Newest`.
- **CurseForge has no "follows"** — there's no follower count concept. We map our `follows` sort to `popularity` (id 2) since that's the closest social-proof signal.

### Game version filtering

- **Modrinth**: `versions=["1.20.1"]` facet.
- **CurseForge**: `gameVersion=1.20.1` query param. Single value only.

### Project type / class

- **Modrinth**: `project_type` facet — `"mod"`, `"modpack"`, `"resourcepack"`, `"shader"`, `"datapack"`, `"plugin"`.
- **CurseForge**: numeric `classId` — 6=Mods, 4471=Modpacks, 12=Resource Packs, 6552=Shaders, 6945=Data Packs.

### Icon / thumbnail URL

- **Modrinth**: single `icon_url` field (always set when an icon exists).
- **CurseForge**: `logo` object with `thumbnailUrl` AND `url`. Some projects only populate `url` — fall back to it when `thumbnailUrl` is empty.

### Author

- **Modrinth**: search hit's `author` field directly.
- **CurseForge**: first entry of the project's `authors[]` array (must be fetched separately on a single-project lookup; not present in search hits).

### Followers / "social" counts

- **Modrinth**: `follows` count.
- **CurseForge**: `thumbsUpCount` (closest equivalent — represented as "followers" in our UI for parity).

### Modpack file format

- **Modrinth**: `.mrpack` (zip with `modrinth.index.json`). Mod files are URLs; we download them.
- **CurseForge**: zip with `manifest.json`. Mod files are referenced by `(projectID, fileID)` pairs; we resolve each via the API.

### Cross-CDN file hosting

- **Modrinth**: `cdn.modrinth.com` (single CDN).
- **CurseForge**: `media.forgecdn.net`, `edge.forgecdn.net`, `mediafilez.forgecdn.net` — all three serve content. Whitelist all three in CSP `img-src` and `connect-src`.

### Authentication

- **Modrinth**: no auth required for read-only API.
- **CurseForge**: requires an API key in `x-api-key` header. We ship a default key; users can override.

## Implementation Workflow

When working on a cross-source feature, follow this sequence:

1. **Identify the parallel surfaces.** What's the Modrinth code? What's the CurseForge code? They probably live in separate `services/` files or different match arms.
2. **Check the API docs for both.** Don't assume — actually verify the parameter name, format, and capability.
   - Modrinth: https://docs.modrinth.com/api/
   - CurseForge: https://docs.curseforge.com/rest-api/
3. **Implement on both sides simultaneously.** Don't ship the Modrinth half and circle back later.
4. **Test on both.** Open the Browse tab, toggle to CurseForge, run the same search/filter you tested on Modrinth.
5. **Update this document** if you discovered a new API difference worth recording.

## Frontend rule

UI controls that drive cross-source behavior (sort dropdowns, loader filters, etc.) must work on **whichever source is currently selected**. The toggle button in the Browse tab is the source-of-truth. If a control's option doesn't translate, the backend should map it to the closest equivalent — never silently fall through to a default that ignores the user's choice.

If a control fundamentally can't apply to one source (e.g. "follows" sort on a source with no follower count), the backend should still produce a coherent result by mapping to a near-equivalent, AND the mapping should be documented in code.
