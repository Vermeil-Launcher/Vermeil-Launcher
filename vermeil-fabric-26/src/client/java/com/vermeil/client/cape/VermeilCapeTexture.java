package com.vermeil.client.cape;

import com.mojang.blaze3d.GpuFormat;
import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.blaze3d.systems.GpuDevice;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.textures.FilterMode;
import com.mojang.blaze3d.textures.GpuTexture;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.client.renderer.texture.TickableTexture;

/**
 * A cape texture that cycles through pre-decoded frames.
 *
 * <p>Implementing {@link TickableTexture} lets the game's texture manager drive
 * the animation: it calls {@link #tick()} once per client tick, on the render
 * thread, which is where GPU uploads must happen.
 *
 * <h3>Mipmaps</h3>
 *
 * <p>The cape is registered with a full mipmap chain (level 0 = base, then 2×
 * downsamples until 1×1) and a sampler with mipmaps enabled (NEAREST within
 * levels, linear blend across levels). Without this, an HD cape (1024×512 at
 * 16×) sampled with plain NEAREST aliases at viewing distance: each screen
 * pixel covers many texels and picks one, producing shimmer that reads as
 * "lower-res/pixelated noise" — the same gap documented for HD resource packs
 * by mods like TextWeaks.
 *
 * <p>26.x renders through the unified {@link GpuDevice} / {@link GpuTexture}
 * abstraction (OpenGL or Vulkan backend). {@link DynamicTexture}'s default
 * {@code createTexture(..., mipLevels=1)} can't host a mip chain, so the parent
 * texture is closed and rebuilt here with the proper level count, then every
 * level is uploaded via the command encoder. Generation + upload runs on the
 * render thread.
 *
 * <p>For animated capes, every frame change re-uploads the chain; an HD strip
 * with many frames is bounded upstream by {@link VermeilCape#MAX_TEXTURE_BYTES}.
 * Single-frame ({@link #tick()}) → no-op.
 */
public class VermeilCapeTexture extends DynamicTexture implements TickableTexture {
	/** Per-frame mip chain. Index 0 = base texture (= the active live frame). */
	private final List<List<NativeImage>> framePyramids;
	private final long frameTimeMs;
	private final long startMs = System.currentTimeMillis();
	private int currentFrame;
	private final int mipLevels;

	public VermeilCapeTexture(final NativeImage active, final List<NativeImage> frames, final long frameTimeMs) {
		super(() -> "Vermeil custom cape", active);
		this.frameTimeMs = Math.max(1L, frameTimeMs);

		int width = active.getWidth();
		int height = active.getHeight();
		int maxLevel = mipLevelsFor(width, height);
		this.mipLevels = maxLevel + 1;

		// DynamicTexture allocated a 1-level texture. Close it and re-create
		// with the full mip chain so the GPU has somewhere to put levels > 0.
		this.releaseTextures();
		GpuDevice device = RenderSystem.getDevice();
		this.texture = device.createTexture(() -> "Vermeil custom cape", 5, GpuFormat.RGBA8_UNORM, width, height, 1, this.mipLevels);
		this.textureView = device.createTextureView(this.texture);

		// Build pyramids for every frame and upload frame 0's now.
		List<NativeImage> activePyramid = buildPyramid(active, maxLevel);
		uploadPyramid(activePyramid);
		this.framePyramids = new ArrayList<>(Math.max(1, frames.size()));
		if (frames.isEmpty()) {
			this.framePyramids.add(activePyramid);
		} else {
			for (int i = 0; i < frames.size(); i++) {
				if (i == 0) {
					this.framePyramids.add(activePyramid);
				} else {
					this.framePyramids.add(buildPyramid(frames.get(i), maxLevel));
				}
			}
		}

		// Crisp cape with no aliasing at distance: NEAREST within a level (so
		// the look stays "Minecraft pixelated"), with mipmaps enabled so the
		// GPU picks the right level for the on-screen size.
		this.sampler = RenderSystem.getSamplerCache().getRepeat(FilterMode.NEAREST, true);
	}

	/**
	 * Mip levels above the base, based on the **smaller** dimension. {@link GpuTexture}
	 * sizes each level with a raw {@code dim >> level} (no clamp to 1), so for a
	 * non-square cape (e.g. 1024×512) counting by the larger side would drive the
	 * smaller side to 0 at the last level — an invalid level the upload rejects.
	 * Stopping when the smaller side reaches 1 keeps every level valid.
	 */
	private static int mipLevelsFor(final int width, final int height) {
		int min = Math.min(width, height);
		int levels = 0;
		while (min > 1) {
			min >>= 1;
			levels++;
		}
		return levels;
	}

	/** Box-downsample the base image to a chain of `maxLevel + 1` mip levels. */
	private static List<NativeImage> buildPyramid(final NativeImage base, final int maxLevel) {
		List<NativeImage> chain = new ArrayList<>(maxLevel + 1);
		// Level 0 is a copy so the chain owns its memory independently from the
		// caller-held NativeImage.
		NativeImage level0 = new NativeImage(base.getWidth(), base.getHeight(), false);
		level0.copyFrom(base);
		chain.add(level0);
		NativeImage prev = level0;
		for (int i = 1; i <= maxLevel; i++) {
			NativeImage next = downsample2x(prev);
			chain.add(next);
			prev = next;
		}
		return chain;
	}

	/** 2×2 → 1 box filter. Dimensions clamp to 1 so a 1×N or N×1 still halves cleanly. */
	private static NativeImage downsample2x(final NativeImage src) {
		int sw = src.getWidth();
		int sh = src.getHeight();
		int dw = Math.max(1, sw / 2);
		int dh = Math.max(1, sh / 2);
		NativeImage dst = new NativeImage(dw, dh, false);
		for (int y = 0; y < dh; y++) {
			int sy0 = Math.min(y * 2, sh - 1);
			int sy1 = Math.min(sy0 + 1, sh - 1);
			for (int x = 0; x < dw; x++) {
				int sx0 = Math.min(x * 2, sw - 1);
				int sx1 = Math.min(sx0 + 1, sw - 1);
				dst.setPixelABGR(x, y, avg4Argb(
					src.getPixel(sx0, sy0),
					src.getPixel(sx1, sy0),
					src.getPixel(sx0, sy1),
					src.getPixel(sx1, sy1)
				));
			}
		}
		return dst;
	}

	/**
	 * Per-channel average of 4 ARGB-packed pixels (as returned by
	 * {@link NativeImage#getPixel(int, int)}), returned as ABGR (the byte order
	 * {@link NativeImage#setPixelABGR(int, int, int)} expects).
	 */
	private static int avg4Argb(final int p0, final int p1, final int p2, final int p3) {
		int a = (((p0 >>> 24) & 0xFF) + ((p1 >>> 24) & 0xFF) + ((p2 >>> 24) & 0xFF) + ((p3 >>> 24) & 0xFF)) >>> 2;
		int r = (((p0 >>> 16) & 0xFF) + ((p1 >>> 16) & 0xFF) + ((p2 >>> 16) & 0xFF) + ((p3 >>> 16) & 0xFF)) >>> 2;
		int g = (((p0 >>> 8) & 0xFF) + ((p1 >>> 8) & 0xFF) + ((p2 >>> 8) & 0xFF) + ((p3 >>> 8) & 0xFF)) >>> 2;
		int b = ((p0 & 0xFF) + (p1 & 0xFF) + (p2 & 0xFF) + (p3 & 0xFF)) >>> 2;
		return (a << 24) | (b << 16) | (g << 8) | r;
	}

	/** Write every level of `pyramid` into the GpuTexture. */
	private void uploadPyramid(final List<NativeImage> pyramid) {
		GpuDevice device = RenderSystem.getDevice();
		var encoder = device.createCommandEncoder();
		for (int level = 0; level < pyramid.size() && level < this.mipLevels; level++) {
			encoder.writeToTexture(this.texture, pyramid.get(level), level, 0, 0, 0);
		}
	}

	@Override
	public void tick() {
		if (framePyramids.size() <= 1) {
			return;
		}
		long elapsed = System.currentTimeMillis() - startMs;
		int index = (int) ((elapsed / frameTimeMs) % framePyramids.size());
		if (index != currentFrame) {
			currentFrame = index;
			uploadPyramid(framePyramids.get(index));
		}
	}

	@Override
	public void close() {
		super.close();
		for (List<NativeImage> pyramid : framePyramids) {
			for (NativeImage level : pyramid) {
				level.close();
			}
		}
	}
}
