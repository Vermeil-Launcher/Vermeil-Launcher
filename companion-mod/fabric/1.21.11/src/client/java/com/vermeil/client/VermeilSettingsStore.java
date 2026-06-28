package com.vermeil.client;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.vermeil.VermeilMod;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import net.fabricmc.loader.api.FabricLoader;

/**
 * Read/write access to the mod's settings file
 * ({@code <vermeil.dataDir>/vermeil-settings.json}) for the in-game Vermeil
 * settings screen.
 *
 * <p>The launcher creates the file and is authoritative at launch; this store
 * lets the in-game screen flip the cape on/off mid-session. Writes are
 * read-modify-write on the whole JSON object so keys this code doesn't know about
 * are preserved, and the file stays the single source the cape watcher
 * ({@link com.vermeil.client.cape.VermeilCape}) polls — so a change here applies
 * live and the launcher reads it back on exit. (FOV effects is 1.16+-native, so
 * Fabric only touches the {@code cape} section.)
 */
public final class VermeilSettingsStore {
	private static final String DATA_DIR_PROPERTY = "vermeil.dataDir";
	private static final String SETTINGS_FILE = "vermeil-settings.json";

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

	private static JsonObject capeObject(final JsonObject root) {
		return root.has("cape") && root.get("cape").isJsonObject() ? root.getAsJsonObject("cape") : null;
	}

	private static JsonObject read() {
		Path file = file();
		if (Files.isRegularFile(file)) {
			try (Reader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
				return JsonParser.parseReader(reader).getAsJsonObject();
			} catch (Exception e) {
				VermeilMod.LOGGER.warn("Failed to read {}; starting from empty settings.", file, e);
			}
		}
		return new JsonObject();
	}

	private static void write(final JsonObject root) {
		Path file = file();
		try {
			Files.createDirectories(file.getParent());
			try (Writer writer = Files.newBufferedWriter(file, StandardCharsets.UTF_8)) {
				new GsonBuilder().setPrettyPrinting().create().toJson(root, writer);
			}
		} catch (Exception e) {
			VermeilMod.LOGGER.error("Failed to write {}; in-game change not saved.", file, e);
		}
	}

	private static Path file() {
		String override = System.getProperty(DATA_DIR_PROPERTY);
		Path dir = (override != null && !override.isBlank())
			? Path.of(override)
			: FabricLoader.getInstance().getGameDir().resolve("vermeil");
		return dir.resolve(SETTINGS_FILE);
	}
}
