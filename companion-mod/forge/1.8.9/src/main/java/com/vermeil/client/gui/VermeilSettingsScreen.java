package com.vermeil.client.gui;

import com.vermeil.client.VermeilSettingsStore;
import net.minecraft.client.gui.GuiButton;
import net.minecraft.client.gui.GuiScreen;

/**
 * The in-game Vermeil settings screen on Minecraft 1.8.9, opened from the
 * pause-menu "Vermeil" button (see {@code VermeilSettingsHook}).
 *
 * <p>Settings are grouped into categories. Today: <b>Cosmetics</b> (cape on/off)
 * and <b>Visuals</b> (FOV-effects slider). Each control writes the change to the
 * mod's settings file ({@link VermeilSettingsStore}) so it applies live (the cape
 * watcher / FOV hook poll the file) and the launcher reads it back on exit.
 * Closing returns to the pause menu, not the world.
 */
public class VermeilSettingsScreen extends GuiScreen {
	private static final int ID_CAPE = 201;
	private static final int ID_FOV = 202;
	private static final int ID_DONE = 200;
	private static final int CONTROL_WIDTH = 200;

	private final GuiScreen parent;
	private GuiButton capeButton;
	private VermeilSlider fovSlider;

	public VermeilSettingsScreen(final GuiScreen parent) {
		this.parent = parent;
	}

	@Override
	public void initGui() {
		this.buttonList.clear();
		int cx = this.width / 2;
		int left = cx - CONTROL_WIDTH / 2;

		// Cosmetics
		int capeY = this.height / 4 + 16;
		this.capeButton = new GuiButton(ID_CAPE, left, capeY, CONTROL_WIDTH, 20, capeLabel());
		this.buttonList.add(this.capeButton);

		// Visuals
		int fovY = capeY + 48;
		this.fovSlider = new VermeilSlider(ID_FOV, left, fovY, CONTROL_WIDTH, "FOV Effects",
			VermeilSettingsStore.getFovEffectsScale());
		this.buttonList.add(this.fovSlider);

		this.buttonList.add(new GuiButton(ID_DONE, left, this.height - 28, CONTROL_WIDTH, 20, "Done"));
	}

	private String capeLabel() {
		return "Cape: " + (VermeilSettingsStore.isCapeEnabled() ? "ON" : "OFF");
	}

	@Override
	protected void actionPerformed(final GuiButton button) {
		if (!button.enabled) {
			return;
		}
		if (button.id == ID_CAPE) {
			VermeilSettingsStore.setCapeEnabled(!VermeilSettingsStore.isCapeEnabled());
			this.capeButton.displayString = capeLabel();
		} else if (button.id == ID_DONE) {
			this.mc.displayGuiScreen(this.parent);
		}
	}

	@Override
	public void onGuiClosed() {
		// Persist the FOV slider once on close — writing every drag tick would
		// thrash the file (and the effect isn't visible from the menu anyway).
		if (this.fovSlider != null) {
			VermeilSettingsStore.setFovEffectsScale(this.fovSlider.sliderValue);
		}
	}

	@Override
	public void drawScreen(final int mouseX, final int mouseY, final float partialTicks) {
		this.drawDefaultBackground();
		this.drawCenteredString(this.fontRendererObj, "Vermeil Settings", this.width / 2, 18, 0xFFFFFF);
		int left = this.width / 2 - CONTROL_WIDTH / 2;
		this.drawString(this.fontRendererObj, "Cosmetics", left, this.height / 4 + 4, 0xA0A0A0);
		this.drawString(this.fontRendererObj, "Visuals", left, this.height / 4 + 52, 0xA0A0A0);
		super.drawScreen(mouseX, mouseY, partialTicks);
	}
}
