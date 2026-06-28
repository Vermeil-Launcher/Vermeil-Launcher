package com.vermeil.client.mixin;

import com.vermeil.client.gui.VermeilLogoButton;
import com.vermeil.client.gui.VermeilSettingsScreen;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.screens.PauseScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.network.chat.Component;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Adds a compact Vermeil logo button to the pause menu ({@code PauseScreen}) and
 * title screen ({@code TitleScreen}) that opens the in-game Vermeil settings.
 * These projects carry no Fabric API, so there's no screen-init event — a Mixin
 * into the screens' {@code init()} is the seam, mirroring how the cape watcher
 * hooks the client tick. The mixin extends {@code Screen} (both targets'
 * superclass) so it can read the screen's widgets and call {@code
 * addRenderableWidget}.
 *
 * <p>Rather than guess coordinates, it anchors to the screens' own buttons so it
 * never overlaps the vanilla cluster (which now includes the language and
 * accessibility side buttons on the title screen): on the pause menu it sits
 * right of the bottom full-width button (Save and Quit / Disconnect); on the
 * title screen it sits at the end of the bottom row, just past the accessibility
 * button. If the anchor isn't present (e.g. the pause menu is suppressed on the
 * world-saving screen), no button is added. The vanilla screens are otherwise
 * untouched.
 */
@Mixin({PauseScreen.class, TitleScreen.class})
public abstract class VermeilMenuButtonMixin extends Screen {
	@Unique
	private static final int VERMEIL_BUTTON_SIZE = 20;

	protected VermeilMenuButtonMixin(final Component title) {
		super(title);
	}

	@Inject(method = "init", at = @At("TAIL"))
	private void vermeil$addButton(final CallbackInfo ci) {
		final Screen self = (Screen) (Object) this;
		final int bx;
		final int by;
		if (self instanceof TitleScreen) {
			// Bottom row is [language][Options][Quit][accessibility]; sit just past
			// the accessibility icon so we extend the cluster without overlapping it.
			final AbstractWidget quit = vermeil$findByMessage(Component.translatable("menu.quit"));
			if (quit == null) {
				return;
			}
			bx = quit.getRight() + VERMEIL_BUTTON_SIZE + 8;
			by = quit.getY();
		} else {
			// Pause menu: right of the bottom full-width button (Save and Quit /
			// Disconnect). Absent when the pause menu isn't shown.
			final AbstractWidget bottom = vermeil$lowestWideButton();
			if (bottom == null) {
				return;
			}
			bx = bottom.getRight() + 4;
			by = bottom.getY();
		}
		this.addRenderableWidget(
			new VermeilLogoButton(bx, by, VERMEIL_BUTTON_SIZE,
				() -> Minecraft.getInstance().setScreen(new VermeilSettingsScreen(self))));
	}

	/** First widget whose label equals {@code message}, or null. */
	@Unique
	private AbstractWidget vermeil$findByMessage(final Component message) {
		for (final GuiEventListener child : this.children()) {
			if (child instanceof AbstractWidget widget && message.equals(widget.getMessage())) {
				return widget;
			}
		}
		return null;
	}

	/** The lowest full-width (>=200px) button — the pause menu's bottom button. */
	@Unique
	private AbstractWidget vermeil$lowestWideButton() {
		AbstractWidget found = null;
		for (final GuiEventListener child : this.children()) {
			if (child instanceof AbstractWidget widget && widget.getWidth() >= 200) {
				if (found == null || widget.getY() > found.getY()) {
					found = widget;
				}
			}
		}
		return found;
	}
}
