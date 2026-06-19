package com.vermeil.client.cape;

import com.mojang.blaze3d.platform.NativeImage;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.core.ClientAsset;
import net.minecraft.resources.Identifier;

/**
 * Owns the launcher's in-game custom cape texture on the client.
 *
 * <p>Stage 2 proof-of-concept: the cape pixels are generated in code (a solid
 * placeholder) and registered with the game's texture manager under our own
 * {@code vermeil:cape} identifier, so no binary asset has to be authored. The
 * render hook ({@code AvatarRendererMixin}) points the local player's skin at
 * this texture when the account has no Mojang cape. Stage 2b swaps the generated
 * pixels for ones read from the launcher's local cape file.
 */
public final class VermeilCape {
	/** Identifier the cape texture is registered under and that the cape layer binds. */
	public static final Identifier CAPE_ID = Identifier.fromNamespaceAndPath("vermeil", "cape");

	/** Standard Minecraft cape texture dimensions. */
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
	 * Registers the generated cape texture with the texture manager the first
	 * time it's needed. Creating a {@link DynamicTexture} talks to the GPU device,
	 * so this must run on the render thread; the render-state extraction that
	 * calls it already does.
	 */
	public static void ensureRegistered() {
		if (registered) {
			return;
		}
		Minecraft minecraft = Minecraft.getInstance();
		if (minecraft == null) {
			return;
		}
		NativeImage image = new NativeImage(WIDTH, HEIGHT, true);
		paintPlaceholder(image);
		minecraft.getTextureManager().register(CAPE_ID, new DynamicTexture(() -> "Vermeil custom cape", image));
		registered = true;
	}

	/** Fills the image with a solid Vermeil red so the placeholder cape is unmistakably ours. */
	private static void paintPlaceholder(final NativeImage image) {
		int color = packAbgr(255, 198, 40, 51);
		for (int y = 0; y < HEIGHT; y++) {
			for (int x = 0; x < WIDTH; x++) {
				image.setPixelABGR(x, y, color);
			}
		}
	}

	/** Packs RGBA components into the ABGR integer {@link NativeImage} expects. */
	private static int packAbgr(final int a, final int r, final int g, final int b) {
		return (a << 24) | (b << 16) | (g << 8) | r;
	}
}
