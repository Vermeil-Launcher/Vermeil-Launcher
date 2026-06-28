package com.vermeil.client.gui;

import com.vermeil.VermeilMod;
import com.vermeil.client.VermeilSettingsStore;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import org.lwjgl.glfw.GLFW;

/**
 * In-game Vermeil settings screen (Minecraft 26.x) — the Fabric counterpart of
 * the 1.8.9 screen, same gamey client-settings look (left category sidebar, a
 * search bar, setting rows with an ON/OFF pill) in the launcher's dark/purple
 * palette using the vanilla pixel font. Cape-only: FOV effects is native on
 * 1.16+, so there's no Visuals category here.
 *
 * <p>26.x renders via the extract-render-state pipeline: screens implement
 * {@code extractRenderState(GuiGraphicsExtractor, …)} (not {@code render}), and
 * text is drawn with {@code graphics.text(…)} (not {@code drawString}). Verified
 * from the 26.2 genSources.
 *
 * <p>The cape toggle writes the mod's settings file ({@link VermeilSettingsStore})
 * so it applies live (the cape watcher polls it) and the launcher reads it back
 * on exit. Esc / the close affordance returns to the opening screen.
 */
public class VermeilSettingsScreen extends Screen {
	private static final int PANEL = 0xF2131119;
	private static final int SIDEBAR = 0xF20F0E13;
	private static final int CARD = 0xFF1C1A23;
	private static final int BORDER = 0xFF322F3D;
	private static final int ACCENT = 0xFF8B5CF6;
	private static final int OFF = 0xFF3A3744;
	private static final int FIELD = 0xFF15141A;
	private static final int HOVER = 0x18FFFFFF;
	private static final int TEXT = 0xFFECE9F2;
	private static final int MUTED = 0xFFA6A1B5;
	private static final int FAINT = 0xFF6F6A7E;

	private final Screen parent;
	private String search = "";
	private boolean searchFocused;
	private boolean capeEnabled;

	private int x0;
	private int y0;
	private int x1;
	private int y1;
	private int sidebarRight;
	private int contentX;
	private int contentRight;
	private int searchY;
	private int searchH;
	private int navY;
	private int navH;
	private int rowY;
	private int rowH;

	public VermeilSettingsScreen(final Screen parent) {
		super(Component.literal("Vermeil"));
		this.parent = parent;
	}

	@Override
	protected void init() {
		int mx = clamp(this.width / 7, 44, 170);
		int my = clamp(this.height / 8, 34, 120);
		this.x0 = mx;
		this.y0 = my;
		this.x1 = this.width - mx;
		this.y1 = this.height - my;
		this.sidebarRight = x0 + 150;
		this.contentX = sidebarRight + 18;
		this.contentRight = x1 - 18;
		this.searchY = y0 + 18;
		this.searchH = 22;
		this.navH = 30;
		this.navY = y0 + 64;
		this.rowY = searchY + searchH + 14;
		this.rowH = 42;
		this.capeEnabled = VermeilSettingsStore.isCapeEnabled();
	}

	private static int clamp(final int v, final int lo, final int hi) {
		return v < lo ? lo : (v > hi ? hi : v);
	}

	private boolean capeVisible() {
		return search.isEmpty() || "custom cape".contains(search.toLowerCase());
	}

	@Override
	public boolean isPauseScreen() {
		return true;
	}

	@Override
	public void onClose() {
		this.minecraft.gui.setScreen(parent);
	}

	// ───────────────────────── Input ─────────────────────────

	@Override
	public boolean mouseClicked(final MouseButtonEvent event, final boolean doubled) {
		if (event.button() == 0) {
			final double mouseX = event.x();
			final double mouseY = event.y();
			searchFocused = inRect(mouseX, mouseY, contentX, searchY, contentRight - contentX, searchH);
			if (searchFocused) {
				return true;
			}
			if (capeVisible() && inRect(mouseX, mouseY, contentRight - 44, rowY + 11, 32, 18)) {
				capeEnabled = !capeEnabled;
				VermeilSettingsStore.setCapeEnabled(capeEnabled);
				return true;
			}
		}
		return super.mouseClicked(event, doubled);
	}

	@Override
	public boolean keyPressed(final KeyEvent event) {
		final int keyCode = event.key();
		if (keyCode == GLFW.GLFW_KEY_ESCAPE) {
			if (searchFocused) {
				searchFocused = false;
			} else {
				onClose();
			}
			return true;
		}
		if (searchFocused && keyCode == GLFW.GLFW_KEY_BACKSPACE) {
			if (!search.isEmpty()) {
				search = search.substring(0, search.length() - 1);
			}
			return true;
		}
		return super.keyPressed(event);
	}

	@Override
	public boolean charTyped(final CharacterEvent event) {
		final int chr = event.codepoint();
		if (searchFocused && chr >= 32 && chr < 127 && search.length() < 32) {
			search += (char) chr;
			return true;
		}
		return super.charTyped(event);
	}

	// ───────────────────────── Render ─────────────────────────

	@Override
	public void extractRenderState(final GuiGraphicsExtractor gfx, final int mouseX, final int mouseY, final float delta) {
		// The engine already extracted the (blurred) background before calling this
		// in 26.x — extracting it again double-blurs and crashes.
		gfx.fill(x0, y0, x1, y1, PANEL);
		gfx.fill(x0, y0, sidebarRight, y1, SIDEBAR);
		gfx.fill(sidebarRight, y0, sidebarRight + 1, y1, BORDER);
		outline(gfx, x0, y0, x1, y1, BORDER);

		// Brand.
		scaledText(gfx, "Vermeil", x0 + 16, y0 + 18, TEXT, 1.4F, true);
		scaledText(gfx, "v" + VermeilMod.version(), x0 + 16, y0 + 34, MUTED, 1.0F, false);

		// Category (Cosmetics, single + active).
		gfx.fill(x0 + 10, navY, x0 + 140, navY + navH, ACCENT);
		scaledText(gfx, "Cosmetics", x0 + 22, navY + (navH - lineH(1.1F)) / 2, 0xFFFFFFFF, 1.1F, true);

		drawSearch(gfx);

		if (capeVisible()) {
			gfx.fill(contentX, rowY, contentRight, rowY + rowH, CARD);
			scaledText(gfx, "Custom cape", contentX + 12, rowY + 9, TEXT, 1.2F, true);
			scaledText(gfx, "Show your Vermeil cape in-game", contentX + 12, rowY + 25, MUTED, 1.0F, false);
			drawPill(gfx, contentRight - 44, rowY + 11, 32, 18, capeEnabled);
		}

		super.extractRenderState(gfx, mouseX, mouseY, delta);
	}

	private void drawSearch(final GuiGraphicsExtractor gfx) {
		gfx.fill(contentX, searchY, contentRight, searchY + searchH, FIELD);
		outline(gfx, contentX, searchY, contentRight, searchY + searchH, searchFocused ? ACCENT : BORDER);
		boolean showPlaceholder = search.isEmpty() && !searchFocused;
		String shown = showPlaceholder ? "Search modules..." : search;
		scaledText(gfx, shown, contentX + 10, searchY + (searchH - lineH(1.0F)) / 2, showPlaceholder ? FAINT : TEXT, 1.0F, false);
		if (searchFocused && (System.currentTimeMillis() / 500L) % 2L == 0L) {
			int cx = contentX + 10 + (int) (this.font.width(search) * 1.0F);
			gfx.fill(cx, searchY + 6, cx + 1, searchY + searchH - 6, TEXT);
		}
	}

	private void drawPill(final GuiGraphicsExtractor gfx, final int x, final int y, final int w, final int h, final boolean on) {
		gfx.fill(x, y, x + w, y + h, on ? ACCENT : OFF);
		String s = on ? "ON" : "OFF";
		scaledText(gfx, s, x + (w - this.font.width(s)) / 2, y + (h - lineH(1.0F)) / 2, on ? 0xFFFFFFFF : MUTED, 1.0F, false);
	}

	private void outline(final GuiGraphicsExtractor gfx, final int ax, final int ay, final int bx, final int by, final int color) {
		gfx.fill(ax, ay, bx, ay + 1, color);
		gfx.fill(ax, by - 1, bx, by, color);
		gfx.fill(ax, ay, ax + 1, by, color);
		gfx.fill(bx - 1, ay, bx, by, color);
	}

	// ───────────────────────── Pixel-font helpers ─────────────────────────

	private void scaledText(final GuiGraphicsExtractor gfx, final String s, final int x, final int y, final int color, final float scale, final boolean shadow) {
		if (scale == 1.0F) {
			gfx.text(this.font, s, x, y, color, shadow);
			return;
		}
		gfx.pose().pushMatrix();
		gfx.pose().scale(scale, scale);
		gfx.text(this.font, s, Math.round(x / scale), Math.round(y / scale), color, shadow);
		gfx.pose().popMatrix();
	}

	private int lineH(final float scale) {
		return (int) (this.font.lineHeight * scale);
	}

	private static boolean inRect(final double mx, final double my, final int x, final int y, final int w, final int h) {
		return mx >= x && mx < x + w && my >= y && my < y + h;
	}
}
