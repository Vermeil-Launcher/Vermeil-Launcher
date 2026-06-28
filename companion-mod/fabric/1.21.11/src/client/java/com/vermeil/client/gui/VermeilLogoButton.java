package com.vermeil.client.gui;

import com.mojang.blaze3d.platform.NativeImage;
import com.vermeil.VermeilMod;
import java.io.IOException;
import java.io.InputStream;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.AbstractButton;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.narration.NarrationElementOutput;
import net.minecraft.client.input.InputWithModifiers;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;

/**
 * A compact square menu button that draws the vanilla button frame with the
 * Vermeil logo centred and opens the in-game Vermeil settings. The Fabric
 * counterpart of the 1.8.9 logo button — {@link
 * com.vermeil.client.mixin.VermeilMenuButtonMixin} places it beside the menu's
 * existing buttons so it reads as part of the cluster and never overlaps them.
 *
 * <p>The logo ({@code logo.png}, 64×64) is loaded from the mod jar's classpath
 * and registered with the texture manager on first render, mirroring the cape's
 * texture handling ({@link com.vermeil.client.cape.VermeilCapeTexture}). This is
 * deliberate: a plain resource-pack blit of a mod asset doesn't resolve in a
 * split-sourceset dev run, whereas a classpath read + manual register works the
 * same in dev and in a packaged install.
 */
public class VermeilLogoButton extends AbstractButton {
	/** Registered texture id the logo is uploaded under (not a resource path). */
	private static final Identifier LOGO_ID = Identifier.fromNamespaceAndPath("vermeil", "menu_logo");
	/** Classpath location of the logo image inside the mod jar. */
	private static final String LOGO_RESOURCE = "/assets/vermeil/textures/gui/logo.png";
	private static final int ICON = 16;
	private static final int TEX = 64;

	/** One-shot guard: attempt the upload once, success or fail, to avoid retry storms. */
	private static boolean logoRegistered;

	private final Runnable action;

	public VermeilLogoButton(final int x, final int y, final int size, final Runnable action) {
		super(x, y, size, size, Component.literal("Vermeil"));
		this.action = action;
		this.setTooltip(Tooltip.create(Component.literal("Vermeil settings")));
	}

	@Override
	public void onPress(final InputWithModifiers input) {
		action.run();
	}

	@Override
	protected void updateWidgetNarration(final NarrationElementOutput output) {
		this.defaultButtonNarrationText(output);
	}

	@Override
	protected void renderContents(final GuiGraphics gfx, final int mouseX, final int mouseY, final float delta) {
		this.renderDefaultSprite(gfx);
		ensureLogoRegistered();
		final int ix = this.getX() + (this.getWidth() - ICON) / 2;
		final int iy = this.getY() + (this.getHeight() - ICON) / 2;
		// Scale the whole 64×64 logo into a centred 16×16.
		gfx.blit(RenderPipelines.GUI_TEXTURED, LOGO_ID, ix, iy, 0.0F, 0.0F, ICON, ICON, TEX, TEX, TEX, TEX);
	}

	/** Loads the logo from the classpath and registers it once (render thread). */
	private static void ensureLogoRegistered() {
		if (logoRegistered) {
			return;
		}
		logoRegistered = true;
		try (InputStream in = VermeilLogoButton.class.getResourceAsStream(LOGO_RESOURCE)) {
			if (in == null) {
				VermeilMod.LOGGER.error("Vermeil logo not found on classpath at {}.", LOGO_RESOURCE);
				return;
			}
			final NativeImage image = NativeImage.read(in);
			Minecraft.getInstance().getTextureManager().register(LOGO_ID, new DynamicTexture(() -> "Vermeil menu logo", image));
		} catch (IOException e) {
			VermeilMod.LOGGER.error("Failed to load Vermeil logo texture.", e);
		}
	}
}
