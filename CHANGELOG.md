## 0.4.0

### Added

- Adaptive RAM allocation: per-instance Java heap is computed automatically from mod count, loader, and content. Bounds live in Settings → Global Instance → Memory.
- Java install chooser: Detect now opens a picker when more than one JRE matches a major version, instead of silently picking one.
- Delete button on per-major Java slots — only removes Vermeil-downloaded JREs, never your external JDKs.
- Install recommended Java works even when an external path is already set.
- Installed-tab pagination with 12 / 24 / 48 entries per page.

### Changed

- Modpack metadata enrichment is two-phase: titles and icon URLs appear within ~2 s, with local icon caching running in parallel afterwards. Cuts post-install wait from ~20 s to ~3 s on 50-mod packs.
- Java runtime and GC preset moved from General to Resources, next to the per-major Java slots.
- Adaptive RAM bounds use dropdowns (Auto plus standard tiers) and stay visible regardless of toggle state.

### Fixed

- Maximize-on-launch waits up to 120 s and bails early when the game exits, so heavy modpacks (Cobbleverse, ATM10) get auto-maximized after their longer cold start.
- Global GC preset switches now propagate to instances whose Java args matched a known preset.
- Modpack metadata and icons now enrich for resource packs, shader packs, and datapacks, not just mods.
- Java slot delete button appears reliably when multiple JREs share a major; stale Java paths auto-clear when the underlying folder is gone.
