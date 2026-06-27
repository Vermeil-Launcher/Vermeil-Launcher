package com.vermeil.client;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.vermeil.VermeilMod;
import java.io.File;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import net.minecraft.client.Minecraft;

/**
 * Read/write access to the mod's settings file
 * ({@code <vermeil.dataDir>/vermeil-settings.json}) for the in-game Vermeil
 * settings screen.
 *
 * <p>The launcher creates the file with the full default schema and is
 * authoritative at launch; this store lets the in-game screen change values
 * mid-session. Writes are read-modify-write on the whole JSON object so keys
 * this code doesn't know about are preserved, and the file stays the single
 * source the cape watcher ({@link VermeilCape}) and FOV hook
 * ({@link VermeilFovEffects}) poll — so a change here applies live and the
 * launcher reads it back on exit.
 *
 * <p>Best-effort: a missing/unreadable file yields defaults; a failed write is
 * logged, never thrown.
 */
public final class VermeilSettingsStore {
	private static final String DATA_DIR_PROPERTY = "vermeil.dataDir";
	private static final String SETTINGS_FILE = "vermeil-settings.json";
	private static final float DEFAULT_FOV_EFFECTS = 1.0F;

	private VermeilSettingsStore() {
	}

	/** Whether the cape is enabled (default true when unset). */
	public static boolean isCapeEnabled() {
		JsonObject cape = capeObject(read());
		return cape == null || !cape.has("enabled") || cape.get("enabled").getAsBoolean();
	}

	/** Set the cape on/off, preserving the rest of the file. */
	public static void setCapeEnabled(final boolean enabled) {
		JsonObject root = read();
		JsonObject cape = capeObject(root);
		if (cape == null) {
			cape = new JsonObject();
		}
		cape.addProperty("enabled", enabled);
		root.add("cape", cape);
		write(root);
	}

	/** FOV-effects scale in {@code [0, 1]} (default 1.0 = vanilla). */
	public static float getFovEffectsScale() {
		JsonObject root = read();
		if (root.has("fovEffectsScale")) {
			try {
				return clamp(root.get("fovEffectsScale").getAsFloat());
			} catch (RuntimeException ignored) {
				// fall through to default
			}
		}
		return DEFAULT_FOV_EFFECTS;
	}

	/** Set the FOV-effects scale, preserving the rest of the file. */
	public static void setFovEffectsScale(final float scale) {
		JsonObject root = read();
		root.addProperty("fovEffectsScale", clamp(scale));
		write(root);
	}

	private static JsonObject capeObject(final JsonObject root) {
		return root.has("cape") && root.get("cape").isJsonObject() ? root.getAsJsonObject("cape") : null;
	}

	private static float clamp(final float v) {
		return Math.max(0.0F, Math.min(1.0F, v));
	}

	private static JsonObject read() {
		File file = file();
		if (file.isFile()) {
			try (Reader reader = Files.newBufferedReader(file.toPath(), StandardCharsets.UTF_8)) {
				return new JsonParser().parse(reader).getAsJsonObject();
			} catch (Exception e) {
				VermeilMod.LOGGER.warn("Failed to read {}; starting from empty settings.", file, e);
			}
		}
		return new JsonObject();
	}

	private static void write(final JsonObject root) {
		File file = file();
		File parent = file.getParentFile();
		if (parent != null) {
			parent.mkdirs();
		}
		try (Writer writer = Files.newBufferedWriter(file.toPath(), StandardCharsets.UTF_8)) {
			new GsonBuilder().setPrettyPrinting().create().toJson(root, writer);
		} catch (Exception e) {
			VermeilMod.LOGGER.error("Failed to write {}; in-game change not saved.", file, e);
		}
	}

	private static File file() {
		String override = System.getProperty(DATA_DIR_PROPERTY);
		File dir = (override != null && !override.trim().isEmpty())
			? new File(override)
			: new File(Minecraft.getMinecraft().mcDataDir, "vermeil");
		return new File(dir, SETTINGS_FILE);
	}
}
