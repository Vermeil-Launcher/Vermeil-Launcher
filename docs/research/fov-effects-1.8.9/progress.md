# Progress — FOV Effects backport, 1.8.9

## 2026-06-24

- Hook chosen: `AbstractClientPlayer.getFovModifier()` (MCP `getFovModifier` /
  SRG `func_175156_o`, `()F`). One seam covers sprint, Speed/Slowness potions,
  Creative flight and bow draw.
- Transform: `INVOKESTATIC com/vermeil/client/VermeilFovEffects.applyScale(F)F`
  inserted before every `FRETURN`. Stack-shape preserving; `COMPUTE_MAXS` only.
- Math: `result = 1.0F + (vanilla - 1.0F) * scale`, scale clamped to `[0,1]`.
- Value channel: JVM property `vermeil.fovEffectsScale`, written by
  `launch.rs` for pre-1.16 instances. 1.16+ continues to use vanilla
  `fovEffectScale` via options.txt.
- Mod bumped to `0.1.7`. `gradlew build` clean.
- Cross-platform: also dropped the per-machine `org.gradle.java.home` pin in
  `gradle.properties` so Linux contributors can build with `JAVA_HOME` set.
- In-game playtest pending (`runClient` on 1.8.9, sprint with non-1.0 scale).
