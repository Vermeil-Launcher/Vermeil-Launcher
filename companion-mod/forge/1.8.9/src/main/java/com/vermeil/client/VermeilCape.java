package com.vermeil.client;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.vermeil.VermeilMod;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import javax.imageio.ImageIO;
import net.minecraft.client.Minecraft;
import net.minecraft.client.entity.AbstractClientPlayer;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.util.ResourceLocation;
import net.minecraftforge.fml.common.eventhandler.SubscribeEvent;
import net.minecraftforge.fml.common.gameevent.TickEvent;

/**
 * Manages the launcher's in-game custom cape on the client (Minecraft 1.8.9).
 *
 * <p>This is the 1.8.9 counterpart of the Fabric projects' {@code VermeilCape}.
 * The behaviour and the launcher contract are identical — only the rendering
 * seam differs. On 1.8.9 the cape is rendered by vanilla {@code LayerCape},
 * which binds whatever {@code AbstractClientPlayer.getLocationCape()} returns. A
 * coremod transformer ({@code com.vermeil.asm.VermeilCapeTransformer}) redirects
 * that method for the local player to {@link #CAPE_ID} when a cape is active, so
 * vanilla draws our texture with its own cape geometry (no reimplemented
 * rendering). Like the Fabric variants, this relies on the player's "Cape" skin
 * model part being enabled (vanilla {@code LayerCape} also gates on it) — that's
 * on by default.
 *
 * <p>The launcher controls the cape through its data dir:
 * <ul>
 *   <li>{@code cape/cape.png} — the cape texture: a square frame, or a vertical
 *       strip of square frames for an animation ({@code height == width * frames}).
 *       The cape's 2:1 region is the top half ({@code width × width/2}) of each
 *       square frame, matching the launcher's bake layout.</li>
 *   <li>{@code vermeil-settings.json} — the mod's settings file; the {@code cape}
 *       object's {@code enabled} (on/off, default true) and {@code frameTimeMs}
 *       (animation speed) drive this feature.</li>
 * </ul>
 *
 * <p>The directory is resolved from the {@code vermeil.dataDir} system property
 * the launcher sets (shared across instances, no per-instance copies); absent
 * that, it falls back to {@code <gameDir>/vermeil/} so a manual install still
 * works. The files are polled about once a second while in a world and reloaded
 * only on change, so the launcher can toggle/swap the cape with live reload.
 */
public final class VermeilCape {
	/** Singleton so the coremod-injected hook can reach the live state statically. */
	public static final VermeilCape INSTANCE = new VermeilCape();

	/** Identifier the cape texture is registered under and that the cape layer binds. */
	public static final ResourceLocation CAPE_ID = new ResourceLocation("vermeil", "cape");

	private static final String DATA_DIR_PROPERTY = "vermeil.dataDir";
	private static final String SETTINGS_FILE = "vermeil-settings.json";
	private static final String CAPE_SUBDIR = "cape";
	private static final String CAPE_FILE = "cape.png";

	private static final long DEFAULT_FRAME_TIME_MS = 100L;
	/** Largest cape file we'll read off disk — bounds an untrusted/baked PNG. */
	private static final long MAX_FILE_BYTES = 32L * 1024L * 1024L;
	/** Largest single-frame edge (an HD cape frame is 64×N; 2048 = 32× of 64). */
	private static final int MAX_FRAME_SIZE = 2048;
	/** Upper bound on decoded animation memory, so a pathological strip can't exhaust the heap. */
	private static final long MAX_TEXTURE_BYTES = 64L * 1024L * 1024L;
	/** How often to re-check the cape files for changes (client ticks; 20 ≈ 1 s). */
	private static final int RELOAD_INTERVAL_TICKS = 20;

	/** Whether a cape texture is currently registered and should be applied. Client thread only. */
	private volatile boolean active;
	/** Decoded animation frames (ARGB, {@code width × capeHeight} each). Client thread only. */
	private int[][] frames;
	private int frameWidth;
	private int frameHeight;
	private long frameTimeMs = DEFAULT_FRAME_TIME_MS;
	private long animStartMs;
	private int currentFrame;
	/** Signature of the cape files at the last reload, to detect changes. */
	private String lastSignature = "";
	private int tickCounter;

	private VermeilCape() {
	}

	/**
	 * The cape location to use for {@code player}, or {@code null} to fall through
	 * to vanilla. Called from the coremod-injected head of
	 * {@code AbstractClientPlayer.getLocationCape()} — only the local player is
	 * overridden, so other players keep their real Mojang capes.
	 */
	public static ResourceLocation overrideCapeLocation(final AbstractClientPlayer player) {
		return INSTANCE.capeFor(player);
	}

	private ResourceLocation capeFor(final AbstractClientPlayer player) {
		if (!active) {
			return null;
		}
		Minecraft mc = Minecraft.getMinecraft();
		if (mc == null || player != mc.thePlayer) {
			return null;
		}
		return CAPE_ID;
	}

	/**
	 * Drives file polling (throttled to ~1 s) and the animation. Runs once per
	 * client tick on the main/render thread, where GL uploads are legal.
	 */
	@SubscribeEvent
	public void onClientTick(final TickEvent.ClientTickEvent event) {
		if (event.phase != TickEvent.Phase.END) {
			return;
		}
		Minecraft mc = Minecraft.getMinecraft();
		if (mc == null || mc.thePlayer == null) {
			return;
		}
		if (tickCounter++ % RELOAD_INTERVAL_TICKS == 0) {
			String signature = currentSignature();
			if (!signature.equals(lastSignature)) {
				lastSignature = signature;
				reload(mc);
			}
		}
		advanceAnimation(mc);
	}

	/** Loads or releases the cape texture based on the current files and toggle. */
	private void reload(final Minecraft mc) {
		File capeFile = new File(new File(capeDir(), CAPE_SUBDIR), CAPE_FILE);
		CapeSettings settings = readSettings();

		if (!settings.enabled || !capeFile.isFile()) {
			deactivate(mc, settings.enabled ? "no cape file" : "disabled");
			return;
		}
		if (capeFile.length() > MAX_FILE_BYTES) {
			VermeilMod.LOGGER.warn("Cape file {} is too large ({} bytes); not showing a cape.", capeFile, capeFile.length());
			deactivate(mc, "cape file too large");
			return;
		}

		try (InputStream in = Files.newInputStream(capeFile.toPath())) {
			BufferedImage image = ImageIO.read(in);
			if (image == null) {
				throw new IOException("not a readable image");
			}
			if (!buildFrames(image, settings.frameTimeMs)) {
				deactivate(mc, "invalid cape image");
				return;
			}
			registerTexture(mc);
			active = true;
		} catch (IOException e) {
			VermeilMod.LOGGER.error("Failed to read custom cape texture from {}; not showing a cape.", capeFile, e);
			deactivate(mc, "unreadable cape file");
		}
	}

	private void deactivate(final Minecraft mc, final String reason) {
		if (active) {
			mc.getTextureManager().deleteTexture(CAPE_ID);
			active = false;
			frames = null;
			VermeilMod.LOGGER.info("Custom cape removed ({}).", reason);
		}
	}

	/**
	 * Interprets the decoded image as a static cape or a vertical frame strip and
	 * stores the frames (each the top {@code width × width/2} 2:1 region of a
	 * square frame). Returns false if the dimensions are out of range.
	 */
	private boolean buildFrames(final BufferedImage image, final long frameTime) {
		int width = image.getWidth();
		int height = image.getHeight();
		if (width <= 0 || height <= 0 || width > MAX_FRAME_SIZE || height > MAX_FRAME_SIZE * MAX_FRAME_SIZE) {
			return false;
		}

		int frameCount = (height > width && height % width == 0) ? height / width : 1;
		int capeHeight;
		if (frameCount <= 1) {
			// Static. Use the top 2:1 region; tolerates input already 2:1 or square.
			capeHeight = Math.min(height, Math.max(1, width / 2));
			frameCount = 1;
		} else {
			capeHeight = Math.max(1, width / 2);
			// Bound decoded memory: cap the frame count to what fits the budget.
			long perFrameBytes = (long) width * capeHeight * 4L;
			int maxFrames = (int) Math.max(1L, MAX_TEXTURE_BYTES / Math.max(1L, perFrameBytes));
			if (frameCount > maxFrames) {
				VermeilMod.LOGGER.warn("Cape strip has {} frames; capping to {} to bound memory.", frameCount, maxFrames);
				frameCount = maxFrames;
			}
		}

		int[][] decoded = new int[frameCount][];
		for (int f = 0; f < frameCount; f++) {
			int[] data = new int[width * capeHeight];
			// Each square frame occupies rows [f*width, f*width+width); the cape's
			// 2:1 panel is the top capeHeight rows of it.
			image.getRGB(0, f * width, width, capeHeight, data, 0, width);
			decoded[f] = data;
		}

		this.frames = decoded;
		this.frameWidth = width;
		this.frameHeight = capeHeight;
		this.frameTimeMs = Math.max(1L, frameTime);
		this.animStartMs = System.currentTimeMillis();
		this.currentFrame = 0;
		VermeilMod.LOGGER.info("Loaded custom cape texture ({}x{}, {} frame(s) @ {}ms).", width, capeHeight, frameCount, this.frameTimeMs);
		return true;
	}

	/** Registers (or replaces) the cape texture with frame 0 uploaded. */
	private void registerTexture(final Minecraft mc) {
		DynamicTexture texture = new DynamicTexture(frameWidth, frameHeight);
		System.arraycopy(frames[0], 0, texture.getTextureData(), 0, frames[0].length);
		texture.updateDynamicTexture();
		// loadTexture replaces and deletes any previously registered texture here.
		mc.getTextureManager().loadTexture(CAPE_ID, texture);
	}

	/** Advances to the current animation frame and re-uploads it when it changes. */
	private void advanceAnimation(final Minecraft mc) {
		if (!active || frames == null || frames.length <= 1) {
			return;
		}
		long elapsed = System.currentTimeMillis() - animStartMs;
		int index = (int) ((elapsed / frameTimeMs) % frames.length);
		if (index == currentFrame) {
			return;
		}
		currentFrame = index;
		net.minecraft.client.renderer.texture.ITextureObject obj = mc.getTextureManager().getTexture(CAPE_ID);
		if (obj instanceof DynamicTexture) {
			DynamicTexture texture = (DynamicTexture) obj;
			System.arraycopy(frames[index], 0, texture.getTextureData(), 0, frames[index].length);
			texture.updateDynamicTexture();
		}
	}

	/** The directory the cape files live in (launcher-supplied or fallback). */
	private File capeDir() {
		String override = System.getProperty(DATA_DIR_PROPERTY);
		if (override != null && !override.trim().isEmpty()) {
			return new File(override);
		}
		return new File(Minecraft.getMinecraft().mcDataDir, "vermeil");
	}

	/** Reads the cape toggle and animation speed from the mod's settings file. */
	private CapeSettings readSettings() {
		File settings = new File(capeDir(), SETTINGS_FILE);
		boolean enabled = true;
		long frameTime = DEFAULT_FRAME_TIME_MS;
		if (settings.isFile()) {
			try (Reader reader = Files.newBufferedReader(settings.toPath(), StandardCharsets.UTF_8)) {
				JsonObject root = new JsonParser().parse(reader).getAsJsonObject();
				JsonObject cape = root.has("cape") ? root.getAsJsonObject("cape") : null;
				if (cape != null) {
					if (cape.has("enabled")) {
						enabled = cape.get("enabled").getAsBoolean();
					}
					if (cape.has("frameTimeMs")) {
						long value = cape.get("frameTimeMs").getAsLong();
						if (value > 0L) {
							frameTime = value;
						}
					}
				}
			} catch (Exception e) {
				VermeilMod.LOGGER.warn("Failed to read Vermeil settings {}; using cape defaults.", settings, e);
			}
		}
		return new CapeSettings(enabled, frameTime);
	}

	/** A short signature of the cape texture + settings file (size + mtime) to detect changes. */
	private String currentSignature() {
		File dir = capeDir();
		return fileSignature(new File(new File(dir, CAPE_SUBDIR), CAPE_FILE)) + "|" + fileSignature(new File(dir, SETTINGS_FILE));
	}

	private String fileSignature(final File file) {
		if (!file.isFile()) {
			return "-";
		}
		return file.length() + ":" + file.lastModified();
	}

	/** Cape toggle and animation speed, parsed from {@code vermeil-settings.json}. */
	private static final class CapeSettings {
		private final boolean enabled;
		private final long frameTimeMs;

		private CapeSettings(final boolean enabled, final long frameTimeMs) {
			this.enabled = enabled;
			this.frameTimeMs = frameTimeMs;
		}
	}
}
