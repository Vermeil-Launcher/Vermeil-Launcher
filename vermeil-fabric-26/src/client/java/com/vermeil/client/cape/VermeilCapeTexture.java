package com.vermeil.client.cape;

import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.textures.AddressMode;
import com.mojang.blaze3d.textures.FilterMode;
import java.util.List;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.client.renderer.texture.TickableTexture;

/**
 * A cape texture that cycles through pre-decoded frames.
 *
 * <p>Implementing {@link TickableTexture} lets the game's texture manager drive
 * the animation: it calls {@link #tick()} once per client tick (render thread).
 *
 * <h3>Filtering</h3>
 *
 * <p>NEAREST for both min and mag, with **no mipmaps** (sampler {@code mipmaps=false}).
 * The cape's detail lives in a small 10×16-texel panel scaled up by the chosen
 * resolution, and the cape renders small in the world — mipmapping picks a
 * heavily-downsampled level at that size, throwing away the very detail an HD
 * cape is for. Plain NEAREST keeps the full baked resolution on screen (matching
 * the launcher's crisp preview); the trade-off is some shimmer when moving.
 */
public class VermeilCapeTexture extends DynamicTexture implements TickableTexture {
	private final List<NativeImage> frames;
	private final long frameTimeMs;
	private final long startMs = System.currentTimeMillis();
	private int currentFrame;

	public VermeilCapeTexture(final NativeImage active, final List<NativeImage> frames, final long frameTimeMs) {
		super(() -> "Vermeil custom cape", active);
		// NEAREST min+mag, no mipmaps — full-res crisp, matches the editor preview.
		this.sampler = RenderSystem.getSamplerCache()
			.getSampler(AddressMode.REPEAT, AddressMode.REPEAT, FilterMode.NEAREST, FilterMode.NEAREST, false);
		this.frames = frames;
		this.frameTimeMs = Math.max(1L, frameTimeMs);
	}

	@Override
	public void tick() {
		if (frames.size() <= 1) {
			return;
		}
		long elapsed = System.currentTimeMillis() - startMs;
		int index = (int) ((elapsed / frameTimeMs) % frames.size());
		if (index != currentFrame) {
			currentFrame = index;
			NativeImage pixels = getPixels();
			if (pixels != null) {
				pixels.copyFrom(frames.get(index));
				upload();
			}
		}
	}

	@Override
	public void close() {
		super.close();
		for (NativeImage frame : frames) {
			frame.close();
		}
	}
}
