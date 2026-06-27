package com.vermeil.client.gui;

import com.vermeil.VermeilMod;
import com.vermeil.client.VermeilSettingsStore;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.gui.GuiScreen;
import net.minecraft.client.renderer.GlStateManager;
import net.minecraft.util.ResourceLocation;
import org.lwjgl.input.Keyboard;

/**
 * The in-game Vermeil settings screen on Minecraft 1.8.9 — a gamey, pixel-font
 * client-settings UI: left category sidebar (brand + version, text categories
 * with a solid-accent active button), a search bar, and a list of setting rows
 * (name + description + a pill toggle or slider) in the launcher's dark/purple
 * palette with sharp edges.
 *
 * <p>Uses the vanilla pixel font (scaled with GL for sizes) so it reads as part
 * of the game. Each control writes the mod's settings file ({@link
 * VermeilSettingsStore}) so changes apply live and the launcher reads them back
 * on exit. Esc returns to the opening screen.
 */
public class VermeilSettingsScreen extends GuiScreen {
	private static final int PANEL = 0xF2131119;
	private static final int SIDEBAR = 0xF20F0E13;
	private static final int CARD = 0xFF1C1A23;
	private static final int BORDER = 0xFF322F3D;
	private static final int ACCENT = 0xFF8B5CF6;
	private static final int ACCENT_DK = 0xFF7C4DDE;
	private static final int OFF = 0xFF3A3744;
	private static final int FIELD = 0xFF15141A;
	private static final int HOVER = 0x18FFFFFF;
	private static final int TEXT = 0xFFECE9F2;
	private static final int MUTED = 0xFFA6A1B5;
	private static final int FAINT = 0xFF6F6A7E;

	private static final ResourceLocation LOGO = new ResourceLocation("vermeil", "textures/gui/logo.png");
	private static final String[] CATEGORIES = {"Cosmetics", "Visuals"};

	private final GuiScreen parent;
	private int tab;
	private String search = "";
	private boolean searchFocused;

	private int x0;
	private int y0;
	private int x1;
	private int y1;
	private int sidebarRight;
	private int contentX;
	private int contentRight;
	private int searchY;
	private int searchH;
	private int listTop;
	private final int[] navY = new int[CATEGORIES.length];
	private int navH;

	private boolean capeEnabled;
	private float fovValue;
	private boolean draggingFov;

	// One row's live geometry, rebuilt each frame so click + draw agree.
	private static final class Row {
		String key;
		int y;
		int h;
	}

	private final List<Row> rows = new ArrayList<Row>();

	public VermeilSettingsScreen(final GuiScreen parent) {
		this.parent = parent;
	}

	@Override
	public void initGui() {
		Keyboard.enableRepeatEvents(true);
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
		this.listTop = searchY + searchH + 14;

		this.navH = 30;
		int ny = y0 + 64;
		for (int i = 0; i < CATEGORIES.length; i++) {
			this.navY[i] = ny;
			ny += navH + 4;
		}

		this.capeEnabled = VermeilSettingsStore.isCapeEnabled();
		this.fovValue = VermeilSettingsStore.getFovEffectsScale();
	}

	@Override
	public void onGuiClosed() {
		Keyboard.enableRepeatEvents(false);
	}

	private static int clamp(final int v, final int lo, final int hi) {
		return v < lo ? lo : (v > hi ? hi : v);
	}

	private boolean matches(final String name) {
		return search.isEmpty() || name.toLowerCase().contains(search.toLowerCase());
	}

	// ───────────────────────── Input ─────────────────────────

	@Override
	protected void mouseClicked(final int mouseX, final int mouseY, final int mouseButton) throws java.io.IOException {
		super.mouseClicked(mouseX, mouseY, mouseButton);
		if (mouseButton != 0) {
			return;
		}
		// Search focus: clicking the field focuses it (blinking caret); clicking
		// anywhere else unfocuses.
		searchFocused = inRect(mouseX, mouseY, contentX, searchY, contentRight - contentX, searchH);
		if (searchFocused) {
			return;
		}
		for (int i = 0; i < CATEGORIES.length; i++) {
			if (inRect(mouseX, mouseY, x0 + 10, navY[i], 130, navH)) {
				tab = i;
				return;
			}
		}
		for (Row row : rows) {
			if ("cape".equals(row.key) && inRect(mouseX, mouseY, contentRight - 44, row.y + 8, 44, 20)) {
				capeEnabled = !capeEnabled;
				VermeilSettingsStore.setCapeEnabled(capeEnabled);
				return;
			}
			if ("fov".equals(row.key) && inRect(mouseX, mouseY, contentX + 12, row.y + row.h - 20, contentRight - contentX - 24, 18)) {
				draggingFov = true;
				fovValue = valueFromMouse(mouseX);
				return;
			}
		}
	}

	@Override
	protected void mouseClickMove(final int mouseX, final int mouseY, final int clickedMouseButton, final long timeSinceLastClick) {
		if (draggingFov) {
			fovValue = valueFromMouse(mouseX);
		}
	}

	@Override
	protected void mouseReleased(final int mouseX, final int mouseY, final int state) {
		super.mouseReleased(mouseX, mouseY, state);
		if (draggingFov) {
			draggingFov = false;
			VermeilSettingsStore.setFovEffectsScale(fovValue);
		}
	}

	@Override
	protected void keyTyped(final char typedChar, final int keyCode) throws java.io.IOException {
		if (keyCode == Keyboard.KEY_ESCAPE) {
			if (searchFocused) {
				searchFocused = false; // Esc first defocuses the search, then closes
			} else {
				this.mc.displayGuiScreen(parent);
			}
			return;
		}
		if (!searchFocused) {
			return;
		}
		if (keyCode == Keyboard.KEY_BACK) {
			if (!search.isEmpty()) {
				search = search.substring(0, search.length() - 1);
			}
			return;
		}
		if (typedChar >= 32 && typedChar < 127 && search.length() < 32) {
			search += typedChar;
		}
	}

	private float valueFromMouse(final int mouseX) {
		int sx = contentX + 12;
		int sw = contentRight - contentX - 24;
		float v = (float) (mouseX - sx) / (float) sw;
		return v < 0.0F ? 0.0F : (v > 1.0F ? 1.0F : v);
	}

	// ───────────────────────── Render ─────────────────────────

	@Override
	public void drawScreen(final int mouseX, final int mouseY, final float partialTicks) {
		// Vanilla menu backdrop: tiled dirt on the title screen, dimmed gradient
		// in-world — so the panel sits on the matching background.
		this.drawDefaultBackground();
		drawRect(x0, y0, x1, y1, PANEL);
		drawRect(x0, y0, sidebarRight, y1, SIDEBAR);
		drawRect(sidebarRight, y0, sidebarRight + 1, y1, BORDER);
		drawRect(x0, y0, x1, y0 + 1, BORDER);
		drawRect(x0, y1 - 1, x1, y1, BORDER);
		drawRect(x0, y0, x0 + 1, y1, BORDER);
		drawRect(x1 - 1, y0, x1, y1, BORDER);

		// Sidebar brand.
		drawIcon(LOGO, x0 + 14, y0 + 16, 18);
		text("Vermeil", x0 + 38, y0 + 18, TEXT, 1.4F, true);
		text("v" + VermeilMod.VERSION, x0 + 38, y0 + 34, MUTED, 1.0F, false);

		// Categories.
		for (int i = 0; i < CATEGORIES.length; i++) {
			drawNav(i, mouseX, mouseY);
		}

		// Search bar.
		drawSearch(mouseX, mouseY);

		// Setting list for the active tab.
		rows.clear();
		int y = listTop;
		if (tab == 0) {
			y = drawCapeRow(y);
		} else {
			y = drawFovRow(y);
		}
	}

	private void drawNav(final int i, final int mouseX, final int mouseY) {
		int x = x0 + 10;
		int y = navY[i];
		int w = 130;
		boolean active = tab == i;
		boolean hover = inRect(mouseX, mouseY, x, y, w, navH);
		if (active) {
			drawRect(x, y, x + w, y + navH, ACCENT);
		} else if (hover) {
			drawRect(x, y, x + w, y + navH, HOVER);
		}
		text(CATEGORIES[i], x + 12, y + (navH - lineH(1.1F)) / 2, active ? 0xFFFFFFFF : MUTED, 1.1F, active);
	}

	private void drawSearch(final int mouseX, final int mouseY) {
		drawRect(contentX, searchY, contentRight, searchY + searchH, FIELD);
		int edge = searchFocused ? ACCENT : BORDER;
		drawRect(contentX, searchY, contentRight, searchY + 1, edge);
		drawRect(contentX, searchY + searchH - 1, contentRight, searchY + searchH, edge);
		drawRect(contentX, searchY, contentX + 1, searchY + searchH, edge);
		drawRect(contentRight - 1, searchY, contentRight, searchY + searchH, edge);

		boolean empty = search.isEmpty();
		boolean showPlaceholder = empty && !searchFocused;
		String shown = showPlaceholder ? "Search modules..." : search;
		int ty = searchY + (searchH - lineH(1.0F)) / 2;
		text(shown, contentX + 10, ty, showPlaceholder ? FAINT : TEXT, 1.0F, false);

		// Blinking caret when focused, so it's clear the field accepts typing.
		if (searchFocused && (System.currentTimeMillis() / 500L) % 2L == 0L) {
			int cx = contentX + 10 + textW(search, 1.0F);
			drawRect(cx, searchY + 6, cx + 1, searchY + searchH - 6, TEXT);
		}
	}

	private int drawCapeRow(final int top) {
		if (!matches("Custom cape")) {
			return top;
		}
		int h = 42;
		newRow("cape", top, h);
		drawRect(contentX, top, contentRight, top + h, CARD);
		text("Custom cape", contentX + 12, top + 9, TEXT, 1.2F, true);
		text("Show your Vermeil cape in-game", contentX + 12, top + 25, MUTED, 1.0F, false);
		drawPill(contentRight - 44, top + 11, 32, 18, capeEnabled);
		return top + h + 8;
	}

	private int drawFovRow(final int top) {
		if (!matches("FOV Effects")) {
			return top;
		}
		int h = 56;
		newRow("fov", top, h);
		drawRect(contentX, top, contentRight, top + h, CARD);
		text("FOV Effects", contentX + 12, top + 9, TEXT, 1.2F, true);
		String pct = Math.round(fovValue * 100.0F) + "%";
		text(pct, contentRight - 12 - textW(pct, 1.1F), top + 9, ACCENT, 1.1F, true);
		text("How much sprint, speed and bow-draw warp your view", contentX + 12, top + 25, MUTED, 1.0F, false);

		int sx = contentX + 12;
		int sw = contentRight - contentX - 24;
		int sy = top + h - 14;
		int handle = 6;
		int fillEnd = sx + (int) (fovValue * (sw - handle));
		drawRect(sx, sy, sx + sw, sy + 4, FIELD);
		drawRect(sx, sy, fillEnd, sy + 4, ACCENT);
		drawRect(fillEnd, sy - 5, fillEnd + handle, sy + 9, TEXT);
		return top + h + 8;
	}

	private Row newRow(final String key, final int y, final int h) {
		Row row = new Row();
		row.key = key;
		row.y = y;
		row.h = h;
		rows.add(row);
		return row;
	}

	/** Simple ON/OFF pill — solid accent on, dark gray off. */
	private void drawPill(final int x, final int y, final int w, final int h, final boolean on) {
		drawRect(x, y, x + w, y + h, on ? ACCENT : OFF);
		String s = on ? "ON" : "OFF";
		text(s, x + (w - textW(s, 1.0F)) / 2, y + (h - lineH(1.0F)) / 2, on ? 0xFFFFFFFF : MUTED, 1.0F, false);
	}

	private void drawIcon(final ResourceLocation tex, final int x, final int y, final int size) {
		GlStateManager.color(1.0F, 1.0F, 1.0F, 1.0F);
		GlStateManager.enableBlend();
		this.mc.getTextureManager().bindTexture(tex);
		drawScaledCustomSizeModalRect(x, y, 0.0F, 0.0F, 64, 64, size, size, 64.0F, 64.0F);
	}

	// ───────────────────────── Pixel-font helpers (vanilla, GL-scaled) ─────

	private void text(final String s, final int x, final int y, final int color, final float scale, final boolean shadow) {
		if (scale == 1.0F) {
			this.fontRendererObj.drawString(s, x, y, color, shadow);
			return;
		}
		GlStateManager.pushMatrix();
		GlStateManager.scale(scale, scale, 1.0F);
		this.fontRendererObj.drawString(s, Math.round(x / scale), Math.round(y / scale), color, shadow);
		GlStateManager.popMatrix();
	}

	private int textW(final String s, final float scale) {
		return (int) (this.fontRendererObj.getStringWidth(s) * scale);
	}

	private int lineH(final float scale) {
		return (int) (this.fontRendererObj.FONT_HEIGHT * scale);
	}

	private static boolean inRect(final int mx, final int my, final int x, final int y, final int w, final int h) {
		return mx >= x && mx < x + w && my >= y && my < y + h;
	}

	@Override
	public boolean doesGuiPauseGame() {
		return true;
	}
}
