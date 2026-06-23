# Legacy LWJGL 2 crash on Linux/Wayland — research

Findings + the why. Terse.

## Symptom
- MC ≤ 1.12.2 crashes on launch on Linux (Wayland/XWayland); modern versions fine.
- `java.lang.ArrayIndexOutOfBoundsException: 0` at
  `org.lwjgl.opengl.LinuxDisplay.getAvailableDisplayModes(LinuxDisplay.java:951)`
  → `LinuxDisplay.init` → `Display.<clinit>`. Before any game/mod code runs.

## Root cause
- MC ≤ 1.12.2 uses **LWJGL 2**. `LinuxDisplay` enumerates display modes via XRandR;
  under XWayland (esp. fractional scaling) it gets an **empty** mode list and indexes
  `[0]` → AIOOBE. Mojang MC-97823 / LWJGL issue #118.
- **Not** the companion mod (crashes with zero coremods) and **not** a missing
  package — it's in `Display.<clinit>`.
- Mojang's own `2.9.4-nightly-20150209` (shipped by 1.8.9–1.12.2) still has it.
- LWJGL 3 (MC ≥ 1.13) handles Wayland fine → unaffected.

## Fix: substitute Legacy Fabric's patched LWJGL 2 (Linux only)
- Legacy Fabric publishes a patched `org.lwjgl.lwjgl:*` at `2.9.4+legacyfabric.N`
  (patched `lwjgl.jar` tolerates an empty mode list; patched natives ship the fixed
  `liblwjgl.so`). These are the **same Maven artifacts a Legacy Fabric instance
  already uses** — which is why Legacy Fabric instances don't crash but vanilla/Forge
  ones do.
- Source: `https://maven.legacyfabric.net/org/lwjgl/lwjgl/{lwjgl,lwjgl_util,lwjgl-platform}/`.
  A public Maven service we already consume — not another launcher's code.
- Version: read `<release>` from each artifact's `maven-metadata.xml` at launch;
  pinned fallback `2.9.4+legacyfabric.17` (live release as of 2026-06-01) for offline grace.

## Key implementation facts
- `services/lwjgl_compat.rs::apply` runs in `launch()` right after the classpath is
  frozen (post-loader), before the `-cp` string is built. Mutates the classpath +
  overwrites the natives `.so` extracted earlier by `ensure_natives`.
- **Loader-agnostic by detection, not by branching:** acts only when a *stock*
  `org.lwjgl.lwjgl` jar is on the classpath. Vanilla/Forge legacy → patched;
  Legacy Fabric → already swapped, no-op; LWJGL 3 → no match, no-op.
- **v2-vs-v3 discriminator:** match path fragment `/org/lwjgl/lwjgl/lwjgl`. LWJGL 2's
  group `org.lwjgl.lwjgl` + artifacts starting `lwjgl` give `org/lwjgl/lwjgl/lwjgl…`;
  LWJGL 3's group `org.lwjgl` gives `org/lwjgl/lwjgl/<version>…` (segment after the
  doubled group is a version, not `lwjgl`). So the fragment hits v2 only.
- **Best-effort:** any metadata/download/IO failure logs and leaves the classpath
  unchanged — never fails the launch (worst case = the pre-existing crash, not worse).
- Natives are only added/overwritten by filename, never deleted, so openal/jinput
  `.so` from the stock extraction survive if the patched jar omits them.
- Linux-only via runtime `cfg!(target_os = "linux")` (not `#[cfg]`), so the module
  still type-checks on the Windows dev shell.
