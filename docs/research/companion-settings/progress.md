# Progress

## 2026-06-27 · planning + toolchain

- Audited current companion-mod architecture (launcher + 4 active projects);
  findings + settled decisions in `research.md`.
- Confirmed per-instance companion toggle is dead code (no UI caller).
- Installed JDK 21 / 25 / 8 (Adoptium) on the Windows dev box; JDK 21 path
  matches the Fabric projects' pin. All four projects buildable locally.
- No code changed yet. Immediate next step: Phase 1 — launcher decouple
  (`companion_mod_enabled` global toggle drives install).
