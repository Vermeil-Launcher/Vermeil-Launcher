package com.vermeil.client;

import com.vermeil.client.gui.VermeilSettingsScreen;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiButton;
import net.minecraft.client.gui.GuiIngameMenu;
import net.minecraftforge.client.event.GuiScreenEvent;
import net.minecraftforge.fml.common.eventhandler.SubscribeEvent;

/**
 * Adds a "Vermeil" button to the vanilla pause menu ({@code GuiIngameMenu}) and
 * opens the in-game Vermeil settings screen when it's clicked, on Minecraft
 * 1.8.9.
 *
 * <p>Uses Forge GUI events rather than a coremod/ASM hook: {@code InitGuiEvent.Post}
 * to append our button to the pause menu's button list, and
 * {@code ActionPerformedEvent.Pre} to intercept the click. The vanilla menu is
 * left fully intact. The button sits in the top-left corner so it never collides
 * with the centered vanilla button column at any GUI scale. Closing the settings
 * screen returns to the pause menu (the screen keeps a reference to it).
 */
public final class VermeilSettingsHook {
	public static final VermeilSettingsHook INSTANCE = new VermeilSettingsHook();

	/** A high, fixed id unlikely to collide with vanilla pause-menu button ids. */
	private static final int BUTTON_ID = 0x7E000001;

	private VermeilSettingsHook() {
	}

	@SubscribeEvent
	public void onInitGuiPost(final GuiScreenEvent.InitGuiEvent.Post event) {
		if (event.gui instanceof GuiIngameMenu) {
			event.buttonList.add(new GuiButton(BUTTON_ID, 5, 5, 100, 20, "Vermeil"));
		}
	}

	@SubscribeEvent
	public void onActionPerformed(final GuiScreenEvent.ActionPerformedEvent.Pre event) {
		if (event.gui instanceof GuiIngameMenu && event.button.id == BUTTON_ID) {
			Minecraft.getMinecraft().displayGuiScreen(new VermeilSettingsScreen(event.gui));
		}
	}
}
