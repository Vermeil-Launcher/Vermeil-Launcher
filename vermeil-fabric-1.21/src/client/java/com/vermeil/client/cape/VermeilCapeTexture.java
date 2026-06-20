package com.vermeil.client.cape;

import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.blaze3d.platform.TextureUtil;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.client.renderer.texture.Tickable;

/**
 * A cape texture that cycles through pre-decoded frames.
 *
 * <p>Implementing {@link Tickable} lets the game's texture manager drive the
 * animation: it calls {@link #tick()} once per client tick, on the render
 * thread, which is where GPU uploads must happen.
 *
 * <h3>Mipmaps</h3>
 *
 * <p>The cape is registered with a full mipmap chain (level 0 = base, then 2×
 * downsamples until 1×1) and configured for {@code GL_NEAREST_MIPMAP_LINEAR}
 * minification + {@code GL_NEAREST} magnification — the "fix shimmering without
 * losing blockiness" pattern from the OpenGL community thread. Without this, an
 * HD cape (1024×512 at 16×) sampled with plain {@code GL_NEAREST} aliases at
 * viewing distance: each screen pixel covers many texels and picks one,
 * producing shimmer that reads as "lower-res/pixelated noise" — the same gap
 * documented for Minecraft HD resource packs by the TextWeaks mod.
 *
 * <p>Generating + uploading the chain happens here on construction, on the
 * render thread (GPU calls). For animated capes, every frame change re-uploads
 * the chain; an HD strip with many frames is bounded upstream by
 * {@link VermeilCape#MAX_TEXTURE_BYTES}, so the per-tick cost stays reasonable.
 *
 * <p>Single-frame ({@link #tick()}) → no-op.
 */
public class VermeilCapeTexture extends DynamicTexture implements Tickable {
	/** Per-frame mip chain. Index 0 = base texture (= the active live frame). */
	private final List<List<NativeImage>> framePyramids;
	private final long frameTimeMs;
	private final long startMs = System.currentTimeMillis();
	private int currentFrame;

	public VermeilCapeTexture(final NativeImage active, final List<NativeImage> frames, final long frameTimeMs) {
		super(active);
		this.frameTimeMs = Math.max(1L, frameTimeMs);

		// Allocate the texture object with the full mip chain and upload all
		// levels of frame 0. The base level was already uploaded by the super
		// constructor; reallocating with a maxLevel > 0 is what allows mipmap
		// sampling to find non-zero levels.
		int width = active.getWidth();
		int height = active.getHeight();
		int maxLevel = mipLevelsFor(width, height);
		List<NativeImage> activePyramid = buildPyramid(active, maxLevel);
		uploadPyramid(activePyramid, maxLevel);

		// Build pyramids for every other frame so tick() can swap in O(uploads).
		// (`frames` is empty for a static cape; the live `active` covers it.)
		this.framePyramids = new ArrayList<>(Math.max(1, frames.size()));
		if (frames.isEmpty()) {
			this.framePyramids.add(activePyramid);
		} else {
			for (int i = 0; i < frames.size(); i++) {
				NativeImage frame = frames.get(i);
				if (i == 0) {
					// Reuse the active pyramid — its base is already this frame
					// (per the upstream contract that `active` is a copy of frame 0).
					this.framePyramids.add(activePyramid);
				} else {
					this.framePyramids.add(buildPyramid(frame, maxLevel));
				}
			}
		}

		// Switch to NEAREST mag + NEAREST_MIPMAP_LINEAR min. setFilter only
		// works after the texture object has its mip levels allocated above.
		this.setFilter(false, true);
	}

	/**
	 * Mip levels above the base. Based on the **smaller** dimension: Minecraft's
	 * {@code prepareImage} sizes each level with a raw {@code dim >> level} (no
	 * clamp to 1), so for a non-square cape (e.g. 1024×512) going by the larger
	 * side would drive the smaller side to 0 at the last level → GL_INVALID_VALUE.
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
		// Take a copy as level 0 so the chain owns its memory independently from
		// any caller-held NativeImage we shouldn't free.
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
				dst.setPixelRGBA(x, y, avg4(
					src.getPixelRGBA(sx0, sy0),
					src.getPixelRGBA(sx1, sy0),
					src.getPixelRGBA(sx0, sy1),
					src.getPixelRGBA(sx1, sy1)
				));
			}
		}
		return dst;
	}

	/** Per-channel average of 4 packed RGBA pixels. */
	private static int avg4(final int p0, final int p1, final int p2, final int p3) {
		int r = ((p0 & 0xFF) + (p1 & 0xFF) + (p2 & 0xFF) + (p3 & 0xFF)) >>> 2;
		int g = (((p0 >>> 8) & 0xFF) + ((p1 >>> 8) & 0xFF) + ((p2 >>> 8) & 0xFF) + ((p3 >>> 8) & 0xFF)) >>> 2;
		int b = (((p0 >>> 16) & 0xFF) + ((p1 >>> 16) & 0xFF) + ((p2 >>> 16) & 0xFF) + ((p3 >>> 16) & 0xFF)) >>> 2;
		int a = (((p0 >>> 24) & 0xFF) + ((p1 >>> 24) & 0xFF) + ((p2 >>> 24) & 0xFF) + ((p3 >>> 24) & 0xFF)) >>> 2;
		return r | (g << 8) | (b << 16) | (a << 24);
	}

	/**
	 * Allocate texture storage with `maxLevel + 1` mip levels and upload every
	 * level of `pyramid`. Reallocates the GL texture object — the base level the
	 * super constructor uploaded is overwritten here.
	 */
	private void uploadPyramid(final List<NativeImage> pyramid, final int maxLevel) {
		NativeImage base = pyramid.get(0);
		TextureUtil.prepareImage(NativeImage.InternalGlFormat.RGBA, this.getId(), maxLevel, base.getWidth(), base.getHeight());
		for (int level = 0; level <= maxLevel && level < pyramid.size(); level++) {
			pyramid.get(level).upload(level, 0, 0, false);
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
			List<NativeImage> pyramid = framePyramids.get(index);
			// Bind THIS texture first — NativeImage.upload writes to the currently
			// bound GL texture, so without this the frames would upload to whatever
			// happens to be bound and the cape wouldn't animate.
			this.bind();
			// Re-upload all mip levels (not just level 0) so distant views see the
			// new frame instead of the previous frame's mip pyramid.
			for (int level = 0; level < pyramid.size(); level++) {
				pyramid.get(level).upload(level, 0, 0, false);
			}
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
