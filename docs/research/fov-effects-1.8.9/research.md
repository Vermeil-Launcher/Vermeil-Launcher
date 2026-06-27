# FOV Effects backport — Minecraft 1.8.9 (companion mod)

Backport of 1.16's `fovEffectScale` accessibility setting to the legacy
Forge 1.8.9 PvP era, via the existing Vermeil companion mod (Forge coremod).

## Problem

1.16+ has a vanilla `fovEffectScale` slider (Accessibility) that scales the
FOV contribution of sprint, Speed/Slowness potions, Creative flight and bow
draw. 1.8.9 has no equivalent — the math is hard-coded with no toggle, and
Mojang dropped any `fovEffectScale` line from the file on save.

Launcher already gates the options.txt write of `fovEffectScale` to MC >= 1.16
(see `launch.rs` section 7b), so on 1.8.9 the user's slider was a no-op.

## Seam

`AbstractClientPlayer.getFovModifier()` (returns `float`, descriptor `()F`):

- MCP name (dev): `getFovModifier`
- SRG name (prod): `func_175156_o`
- Verified from `forgeSrc-1.8.9-11.15.1.2318-1.8.9-sources.jar` (MCP `stable_22`)
  and `mcp_stable/22/methods.csv`.

Vanilla returns a multiplier centred on `1.0F` (1.0 = no effect; >1.0 sprint /
speed / flying; <1.0 slowness / bow draw). All effect contributions go through
this one method, then `EntityRenderer.updateFovModifierHand()` smooths it and
`EntityRenderer.getFOVModifier()` applies it to the user's FOV setting. Source
is the cleanest seam — touch it once, every effect path scales uniformly.

Single `FRETURN` at the tail (`return ForgeHooksClient.getOffsetFOV(this, f)`).
Transformer iterates defensively in case a future recompile produces more.

## Transform

At every `FRETURN` in the target method, insert one instruction:

```
INVOKESTATIC com/vermeil/client/VermeilFovEffects.applyScale(F)F
```

Pure stack shape-preserving (pop float, push float) — `COMPUTE_MAXS` alone is
sufficient, no `COMPUTE_FRAMES`, no stack-map frame edits, no risk of
mid-transform classloading.

Scale math, in the static helper:

```
result = 1.0F + (vanilla - 1.0F) * scale
```

- `scale = 0.0` → method always returns `1.0F` (no FOV change ever)
- `scale = 1.0` → vanilla behaviour, returned unchanged (fast-path)
- `scale = 0.5` → effects half-strength

NaN / infinite vanilla values are returned unchanged — `getFovModifier` already
guards those upstream, but the hook doesn't introduce new NaN paths either.

## Value plumbing

Read from the mod's settings file `<vermeil.dataDir>/vermeil-settings.json`,
top-level `fovEffectsScale` (written by the launcher only for pre-1.16 instances;
1.16+ uses the vanilla options.txt key directly). `VermeilFovEffects` re-reads the
file at most once per second (throttled — the hook is called per frame), clamps to
`[0.0, 1.0]`, and caches between reads, so an in-game or launcher change applies
live without a restart. Missing / malformed / non-finite → default `1.0` (vanilla).

(Superseded the earlier `-Dvermeil.fovEffectsScale` JVM-property channel, which
was read once and frozen — removed from `launch.rs` in the companion-settings
overhaul. See `docs/research/companion-settings/`.)

## Files

- Mod: `com.vermeil.asm.VermeilFovTransformer`, `com.vermeil.client.VermeilFovEffects`
- Plugin registration: `com.vermeil.asm.VermeilLoadingPlugin.getASMTransformerClass()`
- Launcher: `services/launch.rs` JVM-args block, conditional on
  `mc_version_at_least(version, 1, 16) == false`
- Frontend hint: `screens/Settings.tsx` Video section header note

## Verification

- `gradlew build` → `BUILD SUCCESSFUL`, no new warnings, jar reobfuscated to
  `build/libs/vermeil-0.1.7+1.8.9.jar`.
- `cargo check` and `pnpm run build` clean.
- Static checks confirm bytecode insertion targets are correct (MCP/SRG names
  verified from genSources output).
- In-game playtest pending — needs `gradlew runClient` on 1.8.9 with the
  property set to a non-1.0 value, sprinting / bow-drawing to confirm the
  FOV delta scales as expected.
