package com.vermeil.client.gui;

import com.vermeil.client.VermeilSettingsStore;
import net.minecraft.client.gui.GuiScreen;
import net.minecraft.client.renderer.GlStateManager;
import net.minecraft.util.ResourceLocation;

/**
 * The in-game Vermeil settings screen on Minecraft 1.8.9 — a fully custom-drawn
 * UI in the launcher's visual language (dark panel + purple accent, sharp edges,
 * DM Sans via {@link VermeilFont}), opened from the pause/title logo button.
 *
 * <p>Nothing here uses vanilla widgets; the panel, category tabs, square toggle,
 * and purple-fill slider are all drawn with {@code drawRect} + the custom font,
 * matching the launcher's design tokens. Each control writes the mod's settings
 * file ({@link VermeilSettingsStore}) so changes apply live (cape watcher / FOV
 * hook poll the file) and the launcher reads them back on exit. Esc or Done
 * returns to whichever screen opened it.
 */
public class VermeilSettingsScreen extends GuiScreen {
	// Launcher design tokens (base.css), as ARGB.
	private static final int C_PANEL = 0xFF1D1B24;
	private static final int C_RAISED = 0xFF28252F;
	private static final int C_BORDER = 0xFF322F3D;
	private static final int C_ACCENT = 0xFF8B5CF6;
	private static final int C_ACCENT_STRONG = 0xFF7C4DDE;
	private static final int C_TEXT = 0xFFECE9F2;
	private static final int C_MUTED = 0xFFA6A1B5;
	private static final int C_TRACK = 0xFF15141A;
	private static final int C_SCRIM = 0xC014121A;

	private static final ResourceLocation LOGO = new ResourceLocation("vermeil", "textures/gui/logo.png");

	private static final float TITLE_SCALE = 0.52F;
	private static final float TAB_SCALE = 0.44F;
	private static final float LABEL_SCALE = 0.44F;
	private static final float SMALL_SCALE = 0.40F;

	private static final int PANEL_W = 300;
	private static final int PANEL_H = 196;

	private final GuiScreen parent;

	private int panelX;
	private int panelY;
	private int tab; // 0 = Cosmetics, 1 = Visuals

	// Hit rects (computed in initGui).
	private int tabCosX;
	private int tabCosW;
	private int tabVisX;
	private int tabVisW;
	private int tabsY;
	private int tabsH;
	private int toggleX;
	private int toggleY;
	private int toggleW;
	private int toggleH;
	private int sliderX;
	private int sliderY;
	private int sliderW;
	private int doneX;
	private int doneY;
	private int doneW;
	private int doneH;

	private boolean capeEnabled;
	private float fovValue;
	private boolean draggingFov;

	public VermeilSettingsScreen(final GuiScreen parent) {
		this.parent = parent;
	}

	@Override
	public void initGui() {
		this.panelX = (this.width - PANEL_W) / 2;
		this.panelY = (this.height - PANEL_H) / 2;
		this.capeEnabled = VermeilSettingsStore.isCapeEnabled();
		this.fovValue = VermeilSettingsStore.getFovEffectsScale();

		this.tabsY = panelY + 42;
		this.tabsH = (int) Math.ceil(lineHeight(TAB_SCALE)) + 6;
		this.tabCosX = panelX + 16;
		this.tabCosW = (int) Math.ceil(textWidth("Cosmetics", TAB_SCALE));
		this.tabVisX = tabCosX + tabCosW + 18;
		this.tabVisW = (int) Math.ceil(textWidth("Visuals", TAB_SCALE));

		int rowY = panelY + 80;
		this.toggleW = 30;
		this.toggleH = 16;
		this.toggleX = panelX + PANEL_W - 16 - toggleW;
		this.toggleY = rowY - 2;

		this.sliderX = panelX + 16;
		this.sliderW = PANEL_W - 32;
		this.sliderY = panelY + 104;

		this.doneW = 60;
		this.doneH = 20;
		this.doneX = panelX + PANEL_W - 16 - doneW;
		this.doneY = panelY + PANEL_H - 14 - doneH;
	}

	// ───────────────────────── Input ─────────────────────────

	@Override
	protected void mouseClicked(final int mouseX, final int mouseY, final int mouseButton) throws java.io.IOException {
		super.mouseClicked(mouseX, mouseY, mouseButton);
		if (mouseButton != 0) {
			return;
		}
		// Tabs
		if (inRect(mouseX, mouseY, tabCosX, tabsY, tabCosW, tabsH)) {
			tab = 0;
			return;
		}
		if (inRect(mouseX, mouseY, tabVisX, tabsY, tabVisW, tabsH)) {
			tab = 1;
			return;
		}
		// Done
		if (inRect(mouseX, mouseY, doneX, doneY, doneW, doneH)) {
			this.mc.displayGuiScreen(parent);
			return;
		}
		if (tab == 0 && inRect(mouseX, mouseY, toggleX, toggleY, toggleW, toggleH)) {
			capeEnabled = !capeEnabled;
			VermeilSettingsStore.setCapeEnabled(capeEnabled);
			return;
		}
		if (tab == 1 && inRect(mouseX, mouseY, sliderX, sliderY - 7, sliderW, 18)) {
			draggingFov = true;
			fovValue = valueFromMouse(mouseX);
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
		if (keyCode == 1) { // Esc → back to the opening screen, not out to the world
			this.mc.displayGuiScreen(parent);
			return;
		}
		super.keyTyped(typedChar, keyCode);
	}

	private float valueFromMouse(final int mouseX) {
		float v = (float) (mouseX - sliderX) / (float) sliderW;
		return v < 0.0F ? 0.0F : (v > 1.0F ? 1.0F : v);
	}

	// ───────────────────────── Render ─────────────────────────

	@Override
	public void drawScreen(final int mouseX, final int mouseY, final float partialTicks) {
		// Dim the game behind the panel.
		drawRect(0, 0, this.width, this.height, C_SCRIM);

		// Panel: 1px border, then inset fill.
		drawRect(panelX - 1, panelY - 1, panelX + PANEL_W + 1, panelY + PANEL_H + 1, C_BORDER);
		drawRect(panelX, panelY, panelX + PANEL_W, panelY + PANEL_H, C_PANEL);

		// Header: logo + wordmark + accent underline.
		drawLogo(panelX + 14, panelY + 12, 18);
		text("VERMEIL", panelX + 38, panelY + 14, C_TEXT, TITLE_SCALE);
		drawRect(panelX + 14, panelY + 34, panelX + PANEL_W - 14, panelY + 35, C_ACCENT);

		// Tabs.
		drawTab("Cosmetics", tabCosX, tabCosW, 0);
		drawTab("Visuals", tabVisX, tabVisW, 1);

		// Active tab content.
		if (tab == 0) {
			drawCosmetics(mouseX, mouseY);
		} else {
			drawVisuals();
		}

		// Done button.
		boolean doneHover = inRect(mouseX, mouseY, doneX, doneY, doneW, doneH);
		drawRect(doneX, doneY, doneX + doneW, doneY + doneH, doneHover ? C_ACCENT_STRONG : C_ACCENT);
		float dtw = textWidth("Done", LABEL_SCALE);
		text("Done", doneX + (doneW - dtw) / 2.0F, doneY + (doneH - lineHeight(LABEL_SCALE)) / 2.0F + 1, C_TEXT, LABEL_SCALE);
	}

	private void drawTab(final String label, final int x, final int w, final int index) {
		boolean active = tab == index;
		text(label, x, tabsY, active ? C_TEXT : C_MUTED, TAB_SCALE);
		if (active) {
			int underY = tabsY + (int) Math.ceil(lineHeight(TAB_SCALE)) + 1;
			drawRect(x, underY, x + w, underY + 1, C_ACCENT);
		}
	}

	private void drawCosmetics(final int mouseX, final int mouseY) {
		int rowY = panelY + 80;
		text("Custom cape", panelX + 18, rowY, C_TEXT, LABEL_SCALE);
		text("Show your Vermeil cape in-game", panelX + 18, rowY + 13, C_MUTED, SMALL_SCALE);
		drawToggle(toggleX, toggleY, toggleW, toggleH, capeEnabled);
	}

	private void drawVisuals() {
		int rowY = panelY + 80;
		text("FOV Effects", panelX + 18, rowY, C_TEXT, LABEL_SCALE);
		String pct = Math.round(fovValue * 100.0F) + "%";
		float pw = textWidth(pct, LABEL_SCALE);
		text(pct, panelX + PANEL_W - 18 - pw, rowY, C_ACCENT, LABEL_SCALE);
		text("How much speed, sprint and other effects warp your FOV", panelX + 18, rowY + 13, C_MUTED, SMALL_SCALE);

		// Track: filled portion (accent) + remainder (dark).
		int handleW = 6;
		int fillEnd = sliderX + (int) (fovValue * (sliderW - handleW));
		drawRect(sliderX, sliderY, sliderX + sliderW, sliderY + 4, C_TRACK);
		drawRect(sliderX, sliderY, fillEnd, sliderY + 4, C_ACCENT);
		// Square handle.
		drawRect(fillEnd, sliderY - 5, fillEnd + handleW, sliderY + 9, C_TEXT);
	}

	/** A square on/off toggle: accent fill when on, raised+border when off, with a square knob. */
	private void drawToggle(final int x, final int y, final int w, final int h, final boolean on) {
		drawRect(x - 1, y - 1, x + w + 1, y + h + 1, C_BORDER);
		drawRect(x, y, x + w, y + h, on ? C_ACCENT : C_RAISED);
		int knob = h - 4;
		int knobX = on ? x + w - 2 - knob : x + 2;
		drawRect(knobX, y + 2, knobX + knob, y + 2 + knob, C_TEXT);
	}

	private void drawLogo(final int x, final int y, final int size) {
		GlStateManager.color(1.0F, 1.0F, 1.0F, 1.0F);
		GlStateManager.enableBlend();
		this.mc.getTextureManager().bindTexture(LOGO);
		drawScaledCustomSizeModalRect(x, y, 0.0F, 0.0F, 64, 64, size, size, 64.0F, 64.0F);
	}

	// ───────────────────────── Text helpers (DM Sans, vanilla fallback) ─────

	private void text(final String s, final float x, final float y, final int color, final float scale) {
		if (VermeilFont.INSTANCE.isReady()) {
			VermeilFont.INSTANCE.drawString(s, x, y, color, scale);
		} else {
			this.fontRendererObj.drawString(s, (int) x, (int) y, color);
		}
	}

	private float textWidth(final String s, final float scale) {
		if (VermeilFont.INSTANCE.isReady()) {
			return VermeilFont.INSTANCE.width(s, scale);
		}
		return this.fontRendererObj.getStringWidth(s);
	}

	private float lineHeight(final float scale) {
		if (VermeilFont.INSTANCE.isReady()) {
			return VermeilFont.INSTANCE.lineHeight(scale);
		}
		return this.fontRendererObj.FONT_HEIGHT;
	}

	private static boolean inRect(final int mx, final int my, final int x, final int y, final int w, final int h) {
		return mx >= x && mx < x + w && my >= y && my < y + h;
	}

	@Override
	public boolean doesGuiPauseGame() {
		return true;
	}
}
