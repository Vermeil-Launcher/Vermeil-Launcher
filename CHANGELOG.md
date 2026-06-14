## 0.3.1

### Added

- GC presets now actually apply JVM flags at launch (Aikar's G1GC, Generational ZGC, Shenandoah). Previously the setting existed in the UI but was never wired to the launch pipeline.
- Per-instance Java arguments editor with line numbers, one flag per line (space inserts newline). Pre-fills with preset GC flags; user edits override the preset entirely.
- Modpack-installed mods now receive metadata enrichment (title, icon, description, author) via batch API lookups after install completes in the background.
- Source platform badges (Modrinth/CurseForge icons) on instance cards in the Library and instance header. Cross-platform modpacks show both badges.
- Concurrent downloads slider max raised from 10 to 20 for faster installs on capable connections.

### Changed

- Modpack browser shows all supported loader badges per pack (Fabric + Forge etc.), not just the first.
- Installer JAR files are now cached in a shared directory — creating a second instance with the same Forge/NeoForge version skips the 15-40MB re-download.
- Metadata enrichment runs in the background after modpack install instead of blocking the UI. The Library card appears immediately; metadata fills in shortly after.

### Fixed

- Forge/NeoForge installer no longer fails with "The system cannot find the path specified" when caching is enabled.
- Progress text no longer flickers between "Downloading loader libraries" and "Resolving loader libraries" during Forge/NeoForge installation. Message updates are now throttled so only the settled phase shows.
- CurseForge modpack loader filter now correctly applies (selecting "Fabric" narrows results instead of being silently ignored).
