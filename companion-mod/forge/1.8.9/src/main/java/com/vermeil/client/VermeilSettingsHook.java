package com.vermeil.client;

import com.vermeil.client.gui.VermeilLogoButton;
import com.vermeil.client.gui.VermeilSettingsScreen;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiButton;
import net.minecraft.client.gui.GuiIngameMenu;
import net.minecraft.client.gui.GuiMainMenu;
import net.minecraftforge.client.event.GuiScreenEvent;
import net.minecraftforge.fml.common.eventhandler.SubscribeEvent;

/**
 * Adds a small Vermeil-logo button to the vanilla pause menu ({@code
 * GuiIngameMenu}) and title screen ({@code GuiMainMenu}), opening the in-game
 * Vermeil settings screen when clicked, on Minecraft 1.8.9.
 *
 * <p>Uses Forge GUI events rather than a coremod/ASM hook: {@code InitGuiEvent.Post}
 * to append our button, and {@code ActionPerformedEvent.Pre} to intercept the
 * click. The vanilla screens are left fully intact. The button is anchored just
 * to the right of the screen's quit button — "Save and Quit to Title" on the
 * pause menu, "Quit Game" on the title screen — found by its vanilla id in the
 * button list, so it stays aligned at any GUI scale and tolerates other mods'
 * layout tweaks. Closing the settings screen returns to whichever screen opened it.
 */
public final class VermeilSettingsHook {
	public static final VermeilSettingsHook INSTANCE = new VermeilSettingsHook();

	/** A high, fixed id unlikely to collide with vanilla button ids. */
	private static final int BUTTON_ID = 0x7E000001;
	/** Vanilla id of "Save and Quit to Title" in {@code GuiIngameMenu}. */
	private static final int SAVE_QUIT_ID = 1;
	/** Vanilla id of "Quit Game" in {@code GuiMainMenu}. */
	private static final int MAIN_QUIT_ID = 4;
	/** Gap between the quit button and our logo button. */
	private static final int GAP = 4;
	/** Our button's edge length (matches {@link VermeilLogoButton}). */
	private static final int SIZE = 20;

	private VermeilSettingsHook() {
	}

	@SubscribeEvent
	public void onInitGuiPost(final GuiScreenEvent.InitGuiEvent.Post event) {
		int anchorId;
		if (event.gui instanceof GuiIngameMenu) {
			anchorId = SAVE_QUIT_ID;
		} else if (event.gui instanceof GuiMainMenu) {
			anchorId = MAIN_QUIT_ID;
		} else {
			return;
		}

		GuiButton anchor = null;
		for (GuiButton b : event.buttonList) {
			if (b.id == anchorId) {
				anchor = b;
				break;
			}
		}
		if (anchor == null) {
			// Layout changed (another mod removed/replaced the quit button) —
			// skip rather than place the button at a guessed position.
			return;
		}
		int x = anchor.xPosition + anchor.width + GAP;
		int y = freeY(event.buttonList, x, anchor.yPosition, event.gui.height);
		event.buttonList.add(new VermeilLogoButton(BUTTON_ID, x, y));
	}

	/**
	 * Find a vertical position for our {@code SIZE}×{@code SIZE} button at column
	 * {@code x} that doesn't overlap any button already in the list (vanilla or
	 * another mod's). Starts at {@code preferredY} and steps downward; if no free
	 * slot fits on-screen, falls back to the preferred position (a harmless visual
	 * stack is better than dropping the button). We only add our own button and
	 * never touch others, so this can't affect their layout.
	 */
	private static int freeY(final java.util.List<GuiButton> buttons, final int x, final int preferredY, final int screenHeight) {
		int y = preferredY;
		while (y + SIZE <= screenHeight) {
			boolean clear = true;
			for (GuiButton b : buttons) {
				if (overlaps(x, y, b)) {
					clear = false;
					y = b.yPosition + b.height + 2;
					break;
				}
			}
			if (clear) {
				return y;
			}
		}
		return preferredY;
	}

	/** Whether our {@code SIZE}×{@code SIZE} button at (x, y) intersects button {@code b}. */
	private static boolean overlaps(final int x, final int y, final GuiButton b) {
		return x < b.xPosition + b.width && x + SIZE > b.xPosition
			&& y < b.yPosition + b.height && y + SIZE > b.yPosition;
	}

	@SubscribeEvent
	public void onActionPerformed(final GuiScreenEvent.ActionPerformedEvent.Pre event) {
		boolean ourScreen = event.gui instanceof GuiIngameMenu || event.gui instanceof GuiMainMenu;
		if (ourScreen && event.button.id == BUTTON_ID) {
			Minecraft.getMinecraft().displayGuiScreen(new VermeilSettingsScreen(event.gui));
		}
	}
}
