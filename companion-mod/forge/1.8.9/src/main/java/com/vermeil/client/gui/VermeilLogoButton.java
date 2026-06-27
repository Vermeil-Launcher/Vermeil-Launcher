package com.vermeil.client.gui;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiButton;
import net.minecraft.client.renderer.GlStateManager;
import net.minecraft.util.ResourceLocation;

/**
 * A compact 20×20 pause-menu button showing the Vermeil logo, for Minecraft
 * 1.8.9. Sits beside "Save and Quit to Title" and opens the Vermeil settings
 * screen. Draws the vanilla button frame (so it reads as clickable and matches
 * the menu) with the logo scaled into the centre.
 */
public class VermeilLogoButton extends GuiButton {
	private static final ResourceLocation LOGO = new ResourceLocation("vermeil", "textures/gui/logo.png");
	private static final int SIZE = 20;
	private static final int ICON = 16;

	public VermeilLogoButton(final int id, final int x, final int y) {
		super(id, x, y, SIZE, SIZE, "");
	}

	@Override
	public void drawButton(final Minecraft mc, final int mouseX, final int mouseY) {
		// Vanilla button frame + hover highlight (displayString is empty).
		super.drawButton(mc, mouseX, mouseY);
		if (!this.visible) {
			return;
		}
		GlStateManager.color(1.0F, 1.0F, 1.0F, 1.0F);
		mc.getTextureManager().bindTexture(LOGO);
		// Scale the full 64×64 logo into a centred 16×16.
		drawScaledCustomSizeModalRect(
			this.xPosition + (SIZE - ICON) / 2,
			this.yPosition + (SIZE - ICON) / 2,
			0.0F, 0.0F, 64, 64, ICON, ICON, 64.0F, 64.0F);
	}
}
