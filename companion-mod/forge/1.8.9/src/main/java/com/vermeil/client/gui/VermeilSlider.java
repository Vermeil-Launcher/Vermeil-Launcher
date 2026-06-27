package com.vermeil.client.gui;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiButton;
import net.minecraft.client.renderer.GlStateManager;

/**
 * A horizontal value slider for the Vermeil settings screen on Minecraft 1.8.9.
 *
 * <p>1.8.9's vanilla {@code GuiSlider} requires a {@code GuiResponder} +
 * {@code FormatHelper} wiring; this is the self-contained classic approach — a
 * {@link GuiButton} subclass that renders the slider handle in {@link
 * #mouseDragged} (which the base {@code drawButton} calls each frame) and updates
 * its value from the cursor while dragged. The value is a normalized
 * {@code [0, 1]} float.
 */
public class VermeilSlider extends GuiButton {
	/** Normalized slider position in {@code [0, 1]}. */
	public float sliderValue;
	/** True while the handle is being dragged. */
	public boolean dragging;
	private final String label;

	public VermeilSlider(final int id, final int x, final int y, final int width, final String label, final float initial) {
		super(id, x, y, width, 20, "");
		this.label = label;
		this.sliderValue = clamp(initial);
		updateDisplayString();
	}

	private static float clamp(final float v) {
		return v < 0.0F ? 0.0F : (v > 1.0F ? 1.0F : v);
	}

	private void updateDisplayString() {
		this.displayString = label + ": " + Math.round(this.sliderValue * 100.0F) + "%";
	}

	/** Always render in the "default" (non-hovered) state so the track shows under the handle. */
	@Override
	protected int getHoverState(final boolean mouseOver) {
		return 0;
	}

	@Override
	protected void mouseDragged(final Minecraft mc, final int mouseX, final int mouseY) {
		if (!this.visible) {
			return;
		}
		if (this.dragging) {
			this.sliderValue = clamp((float) (mouseX - (this.xPosition + 4)) / (float) (this.width - 8));
			updateDisplayString();
		}
		GlStateManager.color(1.0F, 1.0F, 1.0F, 1.0F);
		mc.getTextureManager().bindTexture(buttonTextures);
		int handleX = this.xPosition + (int) (this.sliderValue * (float) (this.width - 8));
		// Two 4px-wide halves of the vanilla button handle sprite (v=66).
		this.drawTexturedModalRect(handleX, this.yPosition, 0, 66, 4, 20);
		this.drawTexturedModalRect(handleX + 4, this.yPosition, 196, 66, 4, 20);
	}

	@Override
	public boolean mousePressed(final Minecraft mc, final int mouseX, final int mouseY) {
		if (super.mousePressed(mc, mouseX, mouseY)) {
			this.sliderValue = clamp((float) (mouseX - (this.xPosition + 4)) / (float) (this.width - 8));
			updateDisplayString();
			this.dragging = true;
			return true;
		}
		return false;
	}

	@Override
	public void mouseReleased(final int mouseX, final int mouseY) {
		this.dragging = false;
	}
}
