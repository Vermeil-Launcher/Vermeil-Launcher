package com.vermeil.client;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.vermeil.VermeilMod;
import java.io.File;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import net.minecraft.client.Minecraft;

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
 * <p>The scale is read from the mod's settings file
 * {@code <vermeil.dataDir>/vermeil-settings.json} (top-level
 * {@code fovEffectsScale}), which the Vermeil launcher writes and the in-game
 * Vermeil settings screen edits. The file is re-read at most once per second
 * (not every frame), so a change made in-game or in the launcher applies live
 * without a restart and without hitting disk on the render hot path. Range is
 * clamped to {@code [0.0, 1.0]} to match the 1.16+ vanilla range. {@code 1.0} is
 * vanilla (no change), {@code 0.0} disables FOV effects entirely. A missing /
 * malformed / out-of-range value falls back to {@code 1.0}.
 */
public final class VermeilFovEffects {
	/** System property the launcher sets to the mod's shared data dir. */
	private static final String DATA_DIR_PROPERTY = "vermeil.dataDir";
	/** The mod's settings file, under the data dir. */
	private static final String SETTINGS_FILE = "vermeil-settings.json";
	/** Default scale when the value is absent — vanilla behaviour. */
	private static final float DEFAULT_SCALE = 1.0F;
	/**
	 * Re-read the settings file at most this often (ms). The hook calls
	 * {@link #applyScale(float)} every frame; throttling the disk read keeps the
	 * value live (an in-game or launcher change lands within a second) without a
	 * per-frame file read. ponytail: 1 s poll, same cadence as the cape watcher.
	 */
	private static final long REFRESH_INTERVAL_MS = 1000L;

	/** Cached scale, published across threads (the FOV calc runs on the render thread). */
	private static volatile float cachedScale = DEFAULT_SCALE;
	/** When the file was last read (ms), to throttle re-reads. */
	private static volatile long lastReadMs;

	private VermeilFovEffects() {
	}

	/**
	 * Scales a vanilla FOV multiplier by the user's chosen effect strength. Called
	 * from bytecode at every {@code FRETURN} site in {@code
	 * AbstractClientPlayer.getFovModifier()}.
	 *
	 * <p>Vanilla returns {@code 1.0F} when the player has no active FOV effect.
	 * Each effect deviates from that baseline (sprint &gt; 1.0, slowness &lt; 1.0,
	 * etc.). To preserve the baseline and only scale the effect contribution, we
	 * centre on 1.0: {@code result = 1.0F + (vanilla - 1.0F) * scale}. At
	 * {@code scale = 0} the method always returns {@code 1.0F}; at {@code scale =
	 * 1} it returns the vanilla value unchanged.
	 *
	 * <p>NaN / infinite inputs fall through unchanged.
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

	/** Current scale, re-reading the settings file at most once per interval. */
	private static float scale() {
		long now = System.currentTimeMillis();
		if (now - lastReadMs >= REFRESH_INTERVAL_MS) {
			lastReadMs = now;
			cachedScale = readScale();
		}
		return cachedScale;
	}

	private static float readScale() {
		File settings = new File(dataDir(), SETTINGS_FILE);
		if (!settings.isFile()) {
			return DEFAULT_SCALE;
		}
		try (Reader reader = Files.newBufferedReader(settings.toPath(), StandardCharsets.UTF_8)) {
			JsonObject root = new JsonParser().parse(reader).getAsJsonObject();
			if (!root.has("fovEffectsScale")) {
				return DEFAULT_SCALE;
			}
			float parsed = root.get("fovEffectsScale").getAsFloat();
			if (Float.isNaN(parsed) || Float.isInfinite(parsed)) {
				return DEFAULT_SCALE;
			}
			return Math.max(0.0F, Math.min(1.0F, parsed));
		} catch (Exception e) {
			VermeilMod.LOGGER.warn("Failed to read fovEffectsScale from {}; using vanilla FOV effects.", settings, e);
			return DEFAULT_SCALE;
		}
	}

	/**
	 * The mod's data dir: the launcher-supplied {@code -Dvermeil.dataDir}, or
	 * {@code <gameDir>/vermeil/} when absent (manual install).
	 */
	private static File dataDir() {
		String override = System.getProperty(DATA_DIR_PROPERTY);
		if (override != null && !override.trim().isEmpty()) {
			return new File(override);
		}
		return new File(Minecraft.getMinecraft().mcDataDir, "vermeil");
	}
}
