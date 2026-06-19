package com.vermeil.client.cape;

import com.mojang.blaze3d.platform.NativeImage;
import com.vermeil.VermeilMod;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.core.ClientAsset;
import net.minecraft.resources.Identifier;

/**
 * Owns the launcher's in-game custom cape texture on the client.
 *
 * <p>The cape pixels are read from a PNG the launcher writes to a fixed path
 * inside the game directory ({@code <gameDir>/vermeil/cape.png}) and registered
 * with the game's texture manager under our own {@code vermeil:cape} identifier.
 * The render hook ({@code AvatarRendererMixin}) points the local player's skin at
 * this texture when the account has no Mojang cape. If the file is missing or
 * unreadable we fall back to a generated solid placeholder so the feature still
 * proves out instead of failing silently.
 */
public final class VermeilCape {
	/** Identifier the cape texture is registered under and that the cape layer binds. */
	public static final Identifier CAPE_ID = Identifier.fromNamespaceAndPath("vermeil", "cape");

	/** Cape PNG location, relative to the game directory. The launcher writes here. */
	private static final String CAPE_FILE = "vermeil/cape.png";

	/** Placeholder dimensions (standard Minecraft cape texture size). */
	private static final int WIDTH = 64;
	private static final int HEIGHT = 32;

	/**
	 * The cape handle the render state points at. Its {@code texturePath()} must
	 * equal {@link #CAPE_ID} so {@code CapeLayer} binds the texture we register
	 * below. The vanilla {@link ClientAsset.ResourceTexture} record's canonical
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
	 * needed. Creating a {@link DynamicTexture} talks to the GPU device, so this
	 * must run on the render thread; the render-state extraction that calls it
	 * already does.
	 */
	public static void ensureRegistered() {
		if (registered) {
			return;
		}
		Minecraft minecraft = Minecraft.getInstance();
		if (minecraft == null) {
			return;
		}
		NativeImage image = loadCapeImage();
		minecraft.getTextureManager().register(CAPE_ID, new DynamicTexture(() -> "Vermeil custom cape", image));
		registered = true;
	}

	/**
	 * Reads the launcher-written cape PNG, or returns the placeholder if it's
	 * absent or unreadable. The PNG is external input, so a malformed file is
	 * caught and logged rather than allowed to crash rendering.
	 */
	private static NativeImage loadCapeImage() {
		Path capeFile = FabricLoader.getInstance().getGameDir().resolve(CAPE_FILE);
		if (Files.isRegularFile(capeFile)) {
			try (InputStream in = Files.newInputStream(capeFile)) {
				NativeImage image = NativeImage.read(in);
				VermeilMod.LOGGER.info("Loaded custom cape texture from {} ({}x{}).", capeFile, image.getWidth(), image.getHeight());
				return image;
			} catch (IOException e) {
				VermeilMod.LOGGER.error("Failed to read custom cape texture from {}; using placeholder.", capeFile, e);
			}
		} else {
			VermeilMod.LOGGER.info("No custom cape file at {}; using placeholder.", capeFile);
		}
		return placeholderImage();
	}

	/** A solid Vermeil-red image used when no cape file is available. */
	private static NativeImage placeholderImage() {
		NativeImage image = new NativeImage(WIDTH, HEIGHT, true);
		int color = packAbgr(255, 198, 40, 51);
		for (int y = 0; y < HEIGHT; y++) {
			for (int x = 0; x < WIDTH; x++) {
				image.setPixelABGR(x, y, color);
			}
		}
		return image;
	}

	/** Packs RGBA components into the ABGR integer {@link NativeImage} expects. */
	private static int packAbgr(final int a, final int r, final int g, final int b) {
		return (a << 24) | (b << 16) | (g << 8) | r;
	}
}
