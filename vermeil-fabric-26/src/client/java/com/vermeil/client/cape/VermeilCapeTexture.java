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
 * the animation: it calls {@link #tick()} once per client tick, on the render
 * thread, which is where GPU uploads must happen. We only re-upload when the
 * frame index actually changes, so a slow animation costs a handful of uploads a
 * second rather than one every tick. A single-frame cape (empty {@code frames})
 * is effectively static — {@link #tick()} is a no-op.
 */
public class VermeilCapeTexture extends DynamicTexture implements TickableTexture {
	private final List<NativeImage> frames;
	private final long frameTimeMs;
	private final long startMs = System.currentTimeMillis();
	private int currentFrame;

	/**
	 * @param active     the live frame buffer uploaded to the GPU (a copy of frame 0)
	 * @param frames     the decoded frames to cycle through; empty or single = static
	 * @param frameTimeMs how long each frame is shown
	 */
	public VermeilCapeTexture(final NativeImage active, final List<NativeImage> frames, final long frameTimeMs) {
		super(() -> "Vermeil custom cape", active);
		// Crisp cape: the default texture sampler magnifies with LINEAR (blurry).
		// Use NEAREST for both min and mag so the cape renders as a sharp pixel
		// grid at the chosen resolution, matching the launcher's editor preview.
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
			getPixels().copyFrom(frames.get(index));
			upload();
		}
	}

	@Override
	public void close() {
		// Closes the live buffer (this.pixels), which is a copy distinct from the frames.
		super.close();
		for (NativeImage frame : frames) {
			frame.close();
		}
	}
}
