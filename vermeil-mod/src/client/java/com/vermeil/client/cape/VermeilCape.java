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
 * Owns the launcher's in-game custom cape texture on the client.
 *
 * <p>The cape is read from a PNG the launcher writes to a fixed path inside the
 * game directory ({@code <gameDir>/vermeil/cape.png}) and registered with the
 * game's texture manager under our own {@code vermeil:cape} identifier. The
 * render hook ({@code AvatarRendererMixin}) points the local player's skin at
 * this texture when the account has no Mojang cape.
 *
 * <p><b>Format.</b> The cape texture is square (Minecraft's cape layout is 64×64,
 * scaled up for HD). A square PNG is a static cape. A vertical strip whose height
 * is a whole multiple of its width is an animation: each {@code width × width}
 * block is one frame, top to bottom. Optional {@code <gameDir>/vermeil/cape.json}
 * carries {@code {"frameTimeMs": N}} for playback speed (default 100 ms).
 *
 * <p>If the file is missing or unreadable we fall back to a generated solid
 * placeholder so the feature still proves out instead of failing silently.
 */
public final class VermeilCape {
	/** Identifier the cape texture is registered under and that the cape layer binds. */
	public static final Identifier CAPE_ID = Identifier.fromNamespaceAndPath("vermeil", "cape");

	/** Cape PNG location, relative to the game directory. The launcher writes here. */
	private static final String CAPE_FILE = "vermeil/cape.png";
	/** Optional animation metadata, relative to the game directory. */
	private static final String CAPE_META = "vermeil/cape.json";

	/** Placeholder dimensions (Minecraft's cape texture is 64×64). */
	private static final int PLACEHOLDER_SIZE = 64;
	/** Default per-frame duration when no metadata is supplied. */
	private static final long DEFAULT_FRAME_TIME_MS = 100L;
	/** Upper bound on decoded animation memory, so a pathological strip can't exhaust the heap. */
	private static final long MAX_TEXTURE_BYTES = 64L * 1024L * 1024L;

	/**
	 * The cape handle the render state points at. Its {@code texturePath()} must
	 * equal {@link #CAPE_ID} so {@code CapeLayer} binds the texture we register.
	 * The vanilla {@link ClientAsset.ResourceTexture} record's canonical
	 * (two-argument) constructor returns the path unchanged.
	 */
	private static final ClientAsset.Texture CAPE_TEXTURE = new ClientAsset.ResourceTexture(CAPE_ID, CAPE_ID);

	private static boolean registered;

	private VermeilCape() {
	}

	/** The cape texture handle to place into a player skin. */
	public static ClientAsset.Texture capeTexture() {
		return CAPE_TEXTURE;
	}

	/**
	 * Registers the cape texture with the texture manager the first time it's
	 * needed. Creating the texture talks to the GPU device, so this must run on
	 * the render thread; the render-state extraction that calls it already does.
	 */
	public static void ensureRegistered() {
		if (registered) {
			return;
		}
		Minecraft minecraft = Minecraft.getInstance();
		if (minecraft == null) {
			return;
		}
		minecraft.getTextureManager().register(CAPE_ID, loadCapeTexture());
		registered = true;
	}

	/**
	 * Reads the launcher-written cape PNG into a (possibly animated) texture, or
	 * returns the placeholder if it's absent or unreadable. The PNG is external
	 * input, so a malformed file is caught and logged rather than allowed to crash
	 * rendering.
	 */
	private static VermeilCapeTexture loadCapeTexture() {
		Path capeFile = FabricLoader.getInstance().getGameDir().resolve(CAPE_FILE);
		if (Files.isRegularFile(capeFile)) {
			try (InputStream in = Files.newInputStream(capeFile)) {
				return buildTexture(NativeImage.read(in));
			} catch (IOException e) {
				VermeilMod.LOGGER.error("Failed to read custom cape texture from {}; using placeholder.", capeFile, e);
			}
		} else {
			VermeilMod.LOGGER.info("No custom cape file at {}; using placeholder.", capeFile);
		}
		return placeholderTexture();
	}

	/**
	 * Interprets a decoded image as a static cape or a vertical frame strip and
	 * builds the texture. Takes ownership of {@code sheet}: it is split into frame
	 * copies and closed, or kept as the static frame.
	 */
	private static VermeilCapeTexture buildTexture(final NativeImage sheet) {
		int width = sheet.getWidth();
		int height = sheet.getHeight();
		int frameCount = (width > 0 && height > width && height % width == 0) ? height / width : 1;

		if (frameCount <= 1) {
			VermeilMod.LOGGER.info("Loaded custom cape texture ({}x{}, static).", width, height);
			return new VermeilCapeTexture(sheet, List.of(), DEFAULT_FRAME_TIME_MS);
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
		NativeImage active = new NativeImage(width, width, false);
		active.copyFrom(frames.get(0));

		long frameTimeMs = readFrameTimeMs();
		VermeilMod.LOGGER.info("Loaded custom cape texture ({}x{}, {} frames @ {}ms).", width, width, frameCount, frameTimeMs);
		return new VermeilCapeTexture(active, frames, frameTimeMs);
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

	/** Reads the optional animation frame time, defaulting when absent or invalid. */
	private static long readFrameTimeMs() {
		Path meta = FabricLoader.getInstance().getGameDir().resolve(CAPE_META);
		if (Files.isRegularFile(meta)) {
			try (Reader reader = Files.newBufferedReader(meta)) {
				JsonObject obj = JsonParser.parseReader(reader).getAsJsonObject();
				if (obj.has("frameTimeMs")) {
					long value = obj.get("frameTimeMs").getAsLong();
					if (value > 0L) {
						return value;
					}
				}
			} catch (Exception e) {
				VermeilMod.LOGGER.warn("Failed to read cape metadata {}; using default frame time.", meta, e);
			}
		}
		return DEFAULT_FRAME_TIME_MS;
	}

	/** A solid Vermeil-red cape used when no cape file is available. */
	private static VermeilCapeTexture placeholderTexture() {
		NativeImage image = new NativeImage(PLACEHOLDER_SIZE, PLACEHOLDER_SIZE, true);
		int color = packAbgr(255, 198, 40, 51);
		for (int y = 0; y < PLACEHOLDER_SIZE; y++) {
			for (int x = 0; x < PLACEHOLDER_SIZE; x++) {
				image.setPixelABGR(x, y, color);
			}
		}
		return new VermeilCapeTexture(image, List.of(), DEFAULT_FRAME_TIME_MS);
	}

	/** Converts an ARGB pixel (as returned by {@code NativeImage.getPixel}) to ABGR. */
	private static int argbToAbgr(final int argb) {
		int a = (argb >>> 24) & 0xFF;
		int r = (argb >> 16) & 0xFF;
		int g = (argb >> 8) & 0xFF;
		int b = argb & 0xFF;
		return packAbgr(a, r, g, b);
	}

	/** Packs RGBA components into the ABGR integer {@link NativeImage} expects. */
	private static int packAbgr(final int a, final int r, final int g, final int b) {
		return (a << 24) | (b << 16) | (g << 8) | r;
	}
}
