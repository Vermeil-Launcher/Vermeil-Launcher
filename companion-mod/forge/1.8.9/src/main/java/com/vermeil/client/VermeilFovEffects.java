package com.vermeil.client;

import com.vermeil.VermeilMod;

/**
 * Runtime configuration for the FOV-effects backport on Minecraft 1.8.9.
 *
 * <p>1.8.9 has no native equivalent of {@code fovEffectScale} (Minecraft 1.16's
 * Accessibility setting). The {@code FOV-effect} contributions — sprint, Speed
 * / Slowness potions, Creative flight, bow draw — are baked directly into
 * {@code AbstractClientPlayer.getFovModifier()}, with no toggle. This class
 * carries the user's chosen scale so the bytecode hook
 * ({@link com.vermeil.asm.VermeilFovTransformer}) can apply it at the method's
 * return site.
 *
 * <p>The scale is supplied by the Vermeil launcher as a JVM system property
 * ({@link #SYSTEM_PROPERTY}) — same channel used for {@code vermeil.dataDir} —
 * read once on first use. Range is clamped to {@code [0.0, 1.0]} to match the
 * 1.16+ vanilla {@code fovEffectScale} range, so a player who later moves to a
 * 1.16+ instance sees the same value behave the same way. {@code 1.0} is
 * vanilla (no change), {@code 0.0} disables FOV effects entirely. Missing,
 * malformed, or out-of-range values fall back to {@code 1.0} — the safe
 * default that preserves vanilla behaviour.
 */
public final class VermeilFovEffects {
	/** JVM system property the launcher uses to pipe the user's slider value in. */
	public static final String SYSTEM_PROPERTY = "vermeil.fovEffectsScale";

	/** Default scale when the property is absent — vanilla behaviour. */
	private static final float DEFAULT_SCALE = 1.0F;

	/**
	 * Cached scale. Volatile so the value is published safely to whichever thread
	 * the FOV calculation runs on (client thread in practice, but the JIT can
	 * reorder otherwise).
	 */
	private static volatile float cachedScale = Float.NaN;

	private VermeilFovEffects() {
	}

	/**
	 * Scales a vanilla FOV multiplier by the user's chosen effect strength. Called
	 * from bytecode at every {@code FRETURN} site in {@code
	 * AbstractClientPlayer.getFovModifier()}.
	 *
	 * <p>Vanilla returns {@code 1.0F} when the player has no active FOV effect
	 * (standing still, no potions, no bow). Each effect deviates from that
	 * baseline (sprint &gt; 1.0, slowness &lt; 1.0, etc.). To preserve the
	 * baseline and only scale the effect contribution, we centre on 1.0:
	 * {@code result = 1.0F + (vanilla - 1.0F) * scale}. At {@code scale = 0} the
	 * method always returns {@code 1.0F}; at {@code scale = 1} it returns the
	 * vanilla value unchanged.
	 *
	 * <p>NaN / infinite inputs fall through unchanged — {@code getFovModifier}
	 * already guards against those upstream, but the JVM shouldn't be made worse
	 * by a hook that introduces new NaN paths.
	 */
	public static float applyScale(final float vanilla) {
		if (Float.isNaN(vanilla) || Float.isInfinite(vanilla)) {
			return vanilla;
		}
		float scale = scale();
		if (scale == 1.0F) {
			return vanilla;
		}
		return 1.0F + (vanilla - 1.0F) * scale;
	}

	/** Returns the current scale, reading and caching the system property on first use. */
	private static float scale() {
		float value = cachedScale;
		if (Float.isNaN(value)) {
			value = readProperty();
			cachedScale = value;
		}
		return value;
	}

	private static float readProperty() {
		String raw = System.getProperty(SYSTEM_PROPERTY);
		if (raw == null || raw.isEmpty()) {
			return DEFAULT_SCALE;
		}
		try {
			float parsed = Float.parseFloat(raw.trim());
			if (Float.isNaN(parsed) || Float.isInfinite(parsed)) {
				VermeilMod.LOGGER.warn("Ignoring non-finite {}={}; using vanilla FOV effects.", SYSTEM_PROPERTY, raw);
				return DEFAULT_SCALE;
			}
			float clamped = Math.max(0.0F, Math.min(1.0F, parsed));
			if (clamped != parsed) {
				VermeilMod.LOGGER.info("Clamped {}={} to {}.", SYSTEM_PROPERTY, raw, clamped);
			}
			VermeilMod.LOGGER.info("FOV effects scale = {} (1.0 = vanilla, 0.0 = disabled).", clamped);
			return clamped;
		} catch (NumberFormatException e) {
			VermeilMod.LOGGER.warn("Ignoring unparseable {}={}; using vanilla FOV effects.", SYSTEM_PROPERTY, raw);
			return DEFAULT_SCALE;
		}
	}
}
