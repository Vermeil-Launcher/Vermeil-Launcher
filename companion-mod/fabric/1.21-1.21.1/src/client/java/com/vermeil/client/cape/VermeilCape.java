package com.vermeil.client.cape;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.blaze3d.platform.NativeImage;
import com.vermeil.VermeilMod;
import java.io.IOException;
import java.io.InputStream;
import java.io.Reader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import net.minecraft.resources.ResourceLocation;

/**
 * Manages the launcher's in-game custom cape on the client (Minecraft 1.21.x).
 *
 * <p>The launcher controls the cape through its data dir:
 * <ul>
 *   <li>{@code cape/cape.png} — the cape texture (see {@link VermeilCapeTexture}
 *       for the static-vs-animated frame-strip format), and</li>
 *   <li>{@code vermeil-settings.json} — the mod's settings file; the {@code cape}
 *       object's {@code enabled} (on/off, default true) and {@code frameTimeMs}
 *       (animation speed) drive this feature.</li>
 * </ul>
 *
 * <p>The cape directory is resolved from the {@code vermeil.dataDir} system
 * property when set — the launcher's data directory for this mod, shared across
 * every instance so the cape (and any future mod data) isn't duplicated per
 * instance; the cape files live directly inside it. When the property is absent
 * — e.g. a manual install with no launcher — it falls back to
 * {@code <gameDir>/vermeil/}, keeping the mod usable on its own.
 *
 * <p>The render hook ({@code CapeLayerMixin}) asks {@link #isActive()} and, when
 * active, points the local player's cape at {@link #CAPE_ID}. We poll the files
 * once a second while in a world and reload only when they change, so the
 * launcher can turn the cape on/off or swap the image and have it apply without
 * a game restart (live reload). When disabled or absent, no cape is shown
 * (vanilla behaviour) — there is no placeholder.
 */
public final class VermeilCape {
	/** Identifier the cape texture is registered under and that the cape layer binds. */
	public static final ResourceLocation CAPE_ID = ResourceLocation.fromNamespaceAndPath("vermeil", "cape");

	/** System property the launcher sets to its data directory for this mod. */
	private static final String DATA_DIR_PROPERTY = "vermeil.dataDir";
	/** The mod's settings file (cape on/off + frame timing), under {@link #capeDir()}. */
	private static final String SETTINGS_FILE = "vermeil-settings.json";
	/** Cape texture, in its own subfolder under {@link #capeDir()}. */
	private static final String CAPE_SUBDIR = "cape";
	private static final String CAPE_FILE = "cape.png";

	private static final long DEFAULT_FRAME_TIME_MS = 100L;
	/** Upper bound on decoded animation memory, so a pathological strip can't exhaust the heap. */
	private static final long MAX_TEXTURE_BYTES = 64L * 1024L * 1024L;
	/** How often to re-check the cape files for changes (client ticks; 20 ≈ 1 s). */
	private static final int RELOAD_INTERVAL_TICKS = 20;

	/** Whether a cape texture is currently registered and should be applied. Render thread only. */
	private static boolean active;
	/** Signature of the cape files at the last reload, to detect changes. Render thread only. */
	private static String lastSignature = "";
	private static int tickCounter;

	private VermeilCape() {
	}

	/**
	 * The directory the cape files live in. Prefers the launcher-supplied data
	 * dir ({@code -Dvermeil.dataDir}); falls back to {@code <gameDir>/vermeil/} so
	 * a manual install with no launcher still works.
	 */
	private static Path capeDir() {
		String override = System.getProperty(DATA_DIR_PROPERTY);
		if (override != null && !override.isBlank()) {
			return Path.of(override);
		}
		return FabricLoader.getInstance().getGameDir().resolve("vermeil");
	}

	/** Whether the custom cape is enabled and loaded. */
	public static boolean isActive() {
		return active;
	}

	/**
	 * Polls the cape files for changes and reloads when they differ. Called once
	 * per client tick (render thread, where GPU work is legal); throttled to about
	 * once a second, and only while a local player exists.
	 */
	public static void tickReload(final Minecraft minecraft) {
		if (minecraft.player == null) {
			return;
		}
		if (tickCounter++ % RELOAD_INTERVAL_TICKS != 0) {
			return;
		}
		String signature = currentSignature();
		if (signature.equals(lastSignature)) {
			return;
		}
		lastSignature = signature;
		reload(minecraft);
	}

	/** Loads or releases the cape texture based on the current files and toggle. */
	private static void reload(final Minecraft minecraft) {
		Path capeFile = capeDir().resolve(CAPE_SUBDIR).resolve(CAPE_FILE);
		CapeSettings settings = readSettings();

		if (!settings.enabled() || !Files.isRegularFile(capeFile)) {
			deactivate(minecraft, settings.enabled() ? "no cape file" : "disabled");
			return;
		}

		try (InputStream in = Files.newInputStream(capeFile)) {
			VermeilCapeTexture texture = buildTexture(NativeImage.read(in), settings.frameTimeMs());
			// register() replaces and closes any previously registered cape texture.
			minecraft.getTextureManager().register(CAPE_ID, texture);
			active = true;
		} catch (IOException e) {
			VermeilMod.LOGGER.error("Failed to read custom cape texture from {}; not showing a cape.", capeFile, e);
			deactivate(minecraft, "unreadable cape file");
		}
	}

	private static void deactivate(final Minecraft minecraft, final String reason) {
		if (active) {
			minecraft.getTextureManager().release(CAPE_ID);
			active = false;
			VermeilMod.LOGGER.info("Custom cape removed ({}).", reason);
		}
	}

	/**
	 * Interprets a decoded image as a static cape or a vertical frame strip and
	 * builds the texture. Takes ownership of {@code sheet}: it is split into frame
	 * copies and closed, or kept as the static frame.
	 */
	private static VermeilCapeTexture buildTexture(final NativeImage sheet, final long frameTimeMs) {
		int width = sheet.getWidth();
		int height = sheet.getHeight();
		int frameCount = (width > 0 && height > width && height % width == 0) ? height / width : 1;

		// A Minecraft cape texture is 2:1 (e.g. 64x32) — the cape model's UVs are
		// normalized to a 64-wide x 32-tall sheet. The launcher bakes the cape atlas
		// into the top of a square slot, so the cape is that top half. Register a 2:1
		// texture (W x W/2): a square one renders only the top portion ("half cape").
		if (frameCount <= 1) {
			// Static. Use the top 2:1 region; tolerates input that is already 2:1
			// (used whole) or square (top half taken).
			int capeHeight = Math.min(height, Math.max(1, width / 2));
			NativeImage frame = cropFrame(sheet, 0, width, capeHeight);
			sheet.close();
			VermeilMod.LOGGER.info("Loaded custom cape texture ({}x{}, static).", width, capeHeight);
			return new VermeilCapeTexture(frame, List.of(), frameTimeMs);
		}

		final int capeHeight = Math.max(1, width / 2);
		// Bound decoded memory: cap the frame count to what fits the budget.
		long perFrameBytes = (long) width * capeHeight * 4L;
		int maxFrames = (int) Math.max(1L, MAX_TEXTURE_BYTES / perFrameBytes);
		if (frameCount > maxFrames) {
			VermeilMod.LOGGER.warn("Cape strip has {} frames; capping to {} to bound memory.", frameCount, maxFrames);
			frameCount = maxFrames;
		}

		List<NativeImage> frames = new ArrayList<>(frameCount);
		for (int f = 0; f < frameCount; f++) {
			frames.add(cropFrame(sheet, f * width, width, capeHeight));
		}
		sheet.close();
		NativeImage activeFrame = new NativeImage(width, capeHeight, false);
		activeFrame.copyFrom(frames.get(0));

		VermeilMod.LOGGER.info("Loaded custom cape texture ({}x{}, {} frames @ {}ms).", width, capeHeight, frameCount, frameTimeMs);
		return new VermeilCapeTexture(activeFrame, frames, frameTimeMs);
	}

	/**
	 * Copies a {@code width x h} region starting at row {@code baseY} into a new
	 * image. Source and destination are both RGBA-format {@link NativeImage}s, so
	 * the packed pixel value is copied raw (no colour-order conversion).
	 */
	private static NativeImage cropFrame(final NativeImage sheet, final int baseY, final int width, final int h) {
		NativeImage frame = new NativeImage(width, h, false);
		for (int y = 0; y < h; y++) {
			for (int x = 0; x < width; x++) {
				frame.setPixelRGBA(x, y, sheet.getPixelRGBA(x, baseY + y));
			}
		}
		return frame;
	}

	/** Reads the cape toggle and animation speed from the mod's settings file. */
	private static CapeSettings readSettings() {
		Path settings = capeDir().resolve(SETTINGS_FILE);
		boolean enabled = true;
		long frameTimeMs = DEFAULT_FRAME_TIME_MS;
		if (Files.isRegularFile(settings)) {
			try (Reader reader = Files.newBufferedReader(settings)) {
				JsonObject root = JsonParser.parseReader(reader).getAsJsonObject();
				JsonObject cape = root.has("cape") ? root.getAsJsonObject("cape") : null;
				if (cape != null) {
					if (cape.has("enabled")) {
						enabled = cape.get("enabled").getAsBoolean();
					}
					if (cape.has("frameTimeMs")) {
						long value = cape.get("frameTimeMs").getAsLong();
						if (value > 0L) {
							frameTimeMs = value;
						}
					}
				}
			} catch (Exception e) {
				VermeilMod.LOGGER.warn("Failed to read Vermeil settings {}; using cape defaults.", settings, e);
			}
		}
		return new CapeSettings(enabled, frameTimeMs);
	}

	/** A short signature of the cape texture + settings file (size + mtime) to detect changes. */
	private static String currentSignature() {
		Path dir = capeDir();
		return fileSignature(dir.resolve(CAPE_SUBDIR).resolve(CAPE_FILE)) + "|" + fileSignature(dir.resolve(SETTINGS_FILE));
	}

	private static String fileSignature(final Path path) {
		if (!Files.isRegularFile(path)) {
			return "-";
		}
		try {
			return Files.size(path) + ":" + Files.getLastModifiedTime(path).toMillis();
		} catch (IOException e) {
			return "?";
		}
	}

	/** Cape toggle and animation speed, parsed from {@code vermeil-settings.json}. */
	private record CapeSettings(boolean enabled, long frameTimeMs) {
	}
}
