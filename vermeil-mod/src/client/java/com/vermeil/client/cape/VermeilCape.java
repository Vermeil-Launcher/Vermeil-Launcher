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
import net.minecraft.core.ClientAsset;
import net.minecraft.resources.Identifier;

/**
 * Manages the launcher's in-game custom cape on the client.
 *
 * <p>The launcher controls the cape through two files in the game directory,
 * which the launcher writes into the instance:
 * <ul>
 *   <li>{@code vermeil/cape.png} — the cape texture (see {@link VermeilCapeTexture}
 *       for the static-vs-animated frame-strip format), and</li>
 *   <li>{@code vermeil/cape.json} (optional) — {@code {"enabled": bool,
 *       "frameTimeMs": int}}. {@code enabled} is the on/off toggle (default true
 *       when absent); {@code frameTimeMs} is the animation speed.</li>
 * </ul>
 *
 * <p>The render hook ({@code AvatarRendererMixin}) asks {@link #isActive()} and,
 * when active, points the local player's skin at {@link #capeTexture()}. We poll
 * the files once a second while in a world and reload only when they change, so
 * the launcher can turn the cape on/off or swap the image and have it apply
 * without a game restart (live reload). When disabled or absent, no cape is shown
 * (vanilla behaviour) — there is no placeholder.
 */
public final class VermeilCape {
	/** Identifier the cape texture is registered under and that the cape layer binds. */
	public static final Identifier CAPE_ID = Identifier.fromNamespaceAndPath("vermeil", "cape");

	/** Cape texture and metadata locations, relative to the game directory. */
	private static final String CAPE_FILE = "vermeil/cape.png";
	private static final String CAPE_META = "vermeil/cape.json";

	private static final long DEFAULT_FRAME_TIME_MS = 100L;
	/** Upper bound on decoded animation memory, so a pathological strip can't exhaust the heap. */
	private static final long MAX_TEXTURE_BYTES = 64L * 1024L * 1024L;
	/** How often to re-check the cape files for changes (client ticks; 20 ≈ 1 s). */
	private static final int RELOAD_INTERVAL_TICKS = 20;

	/**
	 * The cape handle the render state points at. Its {@code texturePath()} must
	 * equal {@link #CAPE_ID} so {@code CapeLayer} binds the texture we register.
	 */
	private static final ClientAsset.Texture CAPE_TEXTURE = new ClientAsset.ResourceTexture(CAPE_ID, CAPE_ID);

	/** Whether a cape texture is currently registered and should be applied. Render thread only. */
	private static boolean active;
	/** Signature of the cape files at the last reload, to detect changes. Render thread only. */
	private static String lastSignature = "";
	private static int tickCounter;

	private VermeilCape() {
	}

	/** The cape texture handle to place into a player skin. */
	public static ClientAsset.Texture capeTexture() {
		return CAPE_TEXTURE;
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
		Path capeFile = FabricLoader.getInstance().getGameDir().resolve(CAPE_FILE);
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

		if (frameCount <= 1) {
			VermeilMod.LOGGER.info("Loaded custom cape texture ({}x{}, static).", width, height);
			return new VermeilCapeTexture(sheet, List.of(), frameTimeMs);
		}

		// Bound decoded memory: cap the frame count to what fits the budget.
		long perFrameBytes = (long) width * width * 4L;
		int maxFrames = (int) Math.max(1L, MAX_TEXTURE_BYTES / perFrameBytes);
		if (frameCount > maxFrames) {
			VermeilMod.LOGGER.warn("Cape strip has {} frames; capping to {} to bound memory.", frameCount, maxFrames);
			frameCount = maxFrames;
		}

		List<NativeImage> frames = splitFrames(sheet, frameCount, width);
		sheet.close();
		NativeImage activeFrame = new NativeImage(width, width, false);
		activeFrame.copyFrom(frames.get(0));

		VermeilMod.LOGGER.info("Loaded custom cape texture ({}x{}, {} frames @ {}ms).", width, width, frameCount, frameTimeMs);
		return new VermeilCapeTexture(activeFrame, frames, frameTimeMs);
	}

	/** Splits a vertical strip into {@code frameCount} square frames of {@code frameSize}. */
	private static List<NativeImage> splitFrames(final NativeImage sheet, final int frameCount, final int frameSize) {
		List<NativeImage> frames = new ArrayList<>(frameCount);
		for (int f = 0; f < frameCount; f++) {
			NativeImage frame = new NativeImage(frameSize, frameSize, false);
			int baseY = f * frameSize;
			for (int y = 0; y < frameSize; y++) {
				for (int x = 0; x < frameSize; x++) {
					frame.setPixelABGR(x, y, argbToAbgr(sheet.getPixel(x, baseY + y)));
				}
			}
			frames.add(frame);
		}
		return frames;
	}

	/** Reads the toggle and animation speed from the optional metadata file. */
	private static CapeSettings readSettings() {
		Path meta = FabricLoader.getInstance().getGameDir().resolve(CAPE_META);
		boolean enabled = true;
		long frameTimeMs = DEFAULT_FRAME_TIME_MS;
		if (Files.isRegularFile(meta)) {
			try (Reader reader = Files.newBufferedReader(meta)) {
				JsonObject obj = JsonParser.parseReader(reader).getAsJsonObject();
				if (obj.has("enabled")) {
					enabled = obj.get("enabled").getAsBoolean();
				}
				if (obj.has("frameTimeMs")) {
					long value = obj.get("frameTimeMs").getAsLong();
					if (value > 0L) {
						frameTimeMs = value;
					}
				}
			} catch (Exception e) {
				VermeilMod.LOGGER.warn("Failed to read cape metadata {}; using defaults.", meta, e);
			}
		}
		return new CapeSettings(enabled, frameTimeMs);
	}

	/** A short signature of the cape files (path presence + size + mtime) to detect changes. */
	private static String currentSignature() {
		Path dir = FabricLoader.getInstance().getGameDir();
		return fileSignature(dir.resolve(CAPE_FILE)) + "|" + fileSignature(dir.resolve(CAPE_META));
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

	/** Converts an ARGB pixel (as returned by {@code NativeImage.getPixel}) to ABGR. */
	private static int argbToAbgr(final int argb) {
		int a = (argb >>> 24) & 0xFF;
		int r = (argb >> 16) & 0xFF;
		int g = (argb >> 8) & 0xFF;
		int b = argb & 0xFF;
		return (a << 24) | (b << 16) | (g << 8) | r;
	}

	/** Cape toggle and animation speed, parsed from {@code cape.json}. */
	private record CapeSettings(boolean enabled, long frameTimeMs) {
	}
}
