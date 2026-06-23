# Legacy LWJGL 2 / Linux — progress

Terse journal. Exact diffs in git.

## Patched-LWJGL substitution (Linux)
- New `services/lwjgl_compat.rs`: on Linux, swaps stock LWJGL 2 for Legacy Fabric's
  patched `2.9.4+legacyfabric.N` (jars on classpath + natives `.so` overwrite).
  Called from `launch.rs` after the classpath is frozen, before the `-cp` join.
- Loader-agnostic via stock-LWJGL-2 detection (`/org/lwjgl/lwjgl/lwjgl` fragment,
  excludes LWJGL 3 + already-legacyfabric). Best-effort: failures leave classpath
  untouched, never fail the launch.
- Version from each artifact's Maven `<release>`; fallback `2.9.4+legacyfabric.17`.
- Verified: `cargo check` clean (module type-checks on Windows; runtime-gated to Linux).
- **Needs a Linux/Wayland smoke-test**: launch vanilla 1.8.9 (and a Forge 1.12.2) on a
  Wayland session with fractional scaling — confirm it reaches the title screen instead
  of the `getAvailableDisplayModes` AIOOBE, and that 1.13+ (LWJGL 3) is unaffected.
