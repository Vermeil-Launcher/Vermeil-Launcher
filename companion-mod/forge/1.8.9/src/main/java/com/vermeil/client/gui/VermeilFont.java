package com.vermeil.client.gui;

import com.vermeil.VermeilMod;
import java.awt.Color;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.InputStream;
import java.nio.ByteBuffer;
import net.minecraft.client.renderer.GlStateManager;
import net.minecraft.client.renderer.Tessellator;
import net.minecraft.client.renderer.WorldRenderer;
import net.minecraft.client.renderer.vertex.DefaultVertexFormats;
import org.lwjgl.BufferUtils;
import org.lwjgl.opengl.GL11;

/**
 * A custom TrueType font renderer for the Vermeil settings UI on Minecraft 1.8.9,
 * so the in-game screen can use the launcher's DM Sans typeface (1.8.9 predates
 * Minecraft's built-in TTF font support).
 *
 * <p>On first use it loads the bundled {@code dmsans.ttf}, rasterizes the
 * printable-ASCII glyphs (antialiased, white) into a single texture atlas via
 * AWT, and uploads that as an OpenGL texture with linear filtering. {@link
 * #drawString} then draws one textured quad per glyph, tinted by a GlStateManager
 * colour — the glyphs are white so the tint is the text colour. Rendering at a
 * larger atlas size and drawing scaled-down keeps text crisp at any GUI scale.
 *
 * <p>Best-effort: if the font can't be loaded the renderer reports {@link
 * #isReady()} false and callers fall back to the vanilla font.
 */
public final class VermeilFont {
	public static final VermeilFont INSTANCE = new VermeilFont();

	/** Resource path of the bundled TTF (OFL — see assets/vermeil/font/OFL.txt). */
	private static final String FONT_RESOURCE = "/assets/vermeil/font/dmsans.ttf";
	/** Point size the glyphs are rasterized at — higher than display size for crisp downscaling. */
	private static final int ATLAS_FONT_SIZE = 32;
	/** First and last printable-ASCII code points baked into the atlas. */
	private static final char FIRST = 32;
	private static final char LAST = 126;
	/** Padding around each glyph cell so antialiased edges don't bleed into neighbours. */
	private static final int PAD = 2;

	private boolean ready;
	private boolean attempted;
	private int textureId = -1;
	private int atlasWidth;
	private int atlasHeight;
	/** Per-glyph atlas rect + advance, indexed by (char - FIRST). */
	private int[] glyphX;
	private int[] glyphY;
	private int[] glyphW;
	private int[] glyphH;
	private int[] advance;
	private int ascent;
	/** Line height at the atlas size (ascent + descent). */
	private int atlasLineHeight;

	private VermeilFont() {
	}

	/** Whether the font loaded and is usable. Callers fall back to vanilla if false. */
	public boolean isReady() {
		ensureLoaded();
		return ready;
	}

	/** Line height in GUI pixels at the given scale (matches {@link #drawString} sizing). */
	public float lineHeight(final float scale) {
		ensureLoaded();
		return atlasLineHeight * scale;
	}

	/** Width of {@code text} in GUI pixels at {@code scale}. */
	public float width(final String text, final float scale) {
		ensureLoaded();
		if (!ready || text == null) {
			return 0.0F;
		}
		float w = 0.0F;
		for (int i = 0; i < text.length(); i++) {
			w += advanceOf(text.charAt(i));
		}
		return w * scale;
	}

	/**
	 * Draw {@code text} with its top-left at ({@code x}, {@code y}) in GUI pixels,
	 * scaled by {@code scale}, tinted to {@code argb}. Returns the x just past the
	 * text. No-op (returns x) when the font isn't ready.
	 */
	public float drawString(final String text, final float x, final float y, final int argb, final float scale) {
		ensureLoaded();
		if (!ready || text == null || text.isEmpty()) {
			return x;
		}

		float a = ((argb >> 24) & 0xFF) / 255.0F;
		if (a == 0.0F) {
			a = 1.0F; // treat colours given without an alpha byte as opaque
		}
		float r = ((argb >> 16) & 0xFF) / 255.0F;
		float g = ((argb >> 8) & 0xFF) / 255.0F;
		float b = (argb & 0xFF) / 255.0F;

		GlStateManager.enableBlend();
		GlStateManager.tryBlendFuncSeparate(GL11.GL_SRC_ALPHA, GL11.GL_ONE_MINUS_SRC_ALPHA, GL11.GL_ONE, GL11.GL_ZERO);
		GlStateManager.enableTexture2D();
		GlStateManager.color(r, g, b, a);
		GlStateManager.bindTexture(textureId);

		Tessellator tessellator = Tessellator.getInstance();
		WorldRenderer wr = tessellator.getWorldRenderer();
		wr.begin(GL11.GL_QUADS, DefaultVertexFormats.POSITION_TEX);

		float penX = x;
		for (int i = 0; i < text.length(); i++) {
			char c = text.charAt(i);
			int idx = glyphIndex(c);
			if (idx >= 0 && glyphW[idx] > 0) {
				float gx = penX;
				float gy = y;
				float gw = glyphW[idx] * scale;
				float gh = glyphH[idx] * scale;
				float u0 = (float) glyphX[idx] / atlasWidth;
				float v0 = (float) glyphY[idx] / atlasHeight;
				float u1 = (float) (glyphX[idx] + glyphW[idx]) / atlasWidth;
				float v1 = (float) (glyphY[idx] + glyphH[idx]) / atlasHeight;
				wr.pos(gx, gy + gh, 0.0D).tex(u0, v1).endVertex();
				wr.pos(gx + gw, gy + gh, 0.0D).tex(u1, v1).endVertex();
				wr.pos(gx + gw, gy, 0.0D).tex(u1, v0).endVertex();
				wr.pos(gx, gy, 0.0D).tex(u0, v0).endVertex();
			}
			penX += advanceOf(c) * scale;
		}
		tessellator.draw();
		GlStateManager.color(1.0F, 1.0F, 1.0F, 1.0F);
		return penX;
	}

	private int advanceOf(final char c) {
		int idx = glyphIndex(c);
		return idx >= 0 ? advance[idx] : advance[glyphIndex(' ')];
	}

	private int glyphIndex(final char c) {
		if (c < FIRST || c > LAST) {
			return -1;
		}
		return c - FIRST;
	}

	private void ensureLoaded() {
		if (attempted) {
			return;
		}
		attempted = true;
		try {
			buildAtlas();
			ready = true;
			VermeilMod.LOGGER.info("Vermeil DM Sans font atlas ready ({}x{}).", atlasWidth, atlasHeight);
		} catch (Throwable t) {
			VermeilMod.LOGGER.error("Failed to build Vermeil font atlas; falling back to vanilla font.", t);
			ready = false;
		}
	}

	private void buildAtlas() throws Exception {
		Font font;
		try (InputStream in = VermeilFont.class.getResourceAsStream(FONT_RESOURCE)) {
			if (in == null) {
				throw new IllegalStateException("font resource not found: " + FONT_RESOURCE);
			}
			font = Font.createFont(Font.TRUETYPE_FONT, in).deriveFont((float) ATLAS_FONT_SIZE);
		}

		// Measure with a throwaway graphics context.
		BufferedImage probe = new BufferedImage(1, 1, BufferedImage.TYPE_INT_ARGB);
		Graphics2D pg = probe.createGraphics();
		pg.setFont(font);
		FontMetrics fm = pg.getFontMetrics();
		this.ascent = fm.getAscent();
		this.atlasLineHeight = fm.getAscent() + fm.getDescent();
		int count = LAST - FIRST + 1;
		this.glyphX = new int[count];
		this.glyphY = new int[count];
		this.glyphW = new int[count];
		this.glyphH = new int[count];
		this.advance = new int[count];

		int cellH = atlasLineHeight + PAD * 2;
		int maxWidth = 512;
		// Lay glyph cells left-to-right, wrapping to new rows.
		int penX = 0;
		int penY = 0;
		int rowH = cellH;
		for (char c = FIRST; c <= LAST; c++) {
			int i = c - FIRST;
			int adv = fm.charWidth(c);
			this.advance[i] = adv;
			int cellW = Math.max(adv, 1) + PAD * 2;
			if (penX + cellW > maxWidth) {
				penX = 0;
				penY += rowH;
			}
			this.glyphX[i] = penX;
			this.glyphY[i] = penY;
			this.glyphW[i] = cellW;
			this.glyphH[i] = cellH;
			penX += cellW;
		}
		pg.dispose();

		this.atlasWidth = maxWidth;
		this.atlasHeight = penY + rowH;

		// Render the glyphs into the atlas image (white, antialiased, transparent bg).
		BufferedImage atlas = new BufferedImage(atlasWidth, atlasHeight, BufferedImage.TYPE_INT_ARGB);
		Graphics2D g = atlas.createGraphics();
		g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
		g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
		g.setRenderingHint(RenderingHints.KEY_FRACTIONALMETRICS, RenderingHints.VALUE_FRACTIONALMETRICS_ON);
		g.setFont(font);
		g.setColor(Color.WHITE);
		for (char c = FIRST; c <= LAST; c++) {
			int i = c - FIRST;
			g.drawString(String.valueOf(c), glyphX[i] + PAD, glyphY[i] + PAD + ascent);
		}
		g.dispose();

		uploadTexture(atlas);
	}

	private void uploadTexture(final BufferedImage image) {
		int w = image.getWidth();
		int h = image.getHeight();
		int[] pixels = new int[w * h];
		image.getRGB(0, 0, w, h, pixels, 0, w);
		ByteBuffer buf = BufferUtils.createByteBuffer(w * h * 4);
		for (int i = 0; i < pixels.length; i++) {
			int p = pixels[i];
			buf.put((byte) ((p >> 16) & 0xFF)); // R
			buf.put((byte) ((p >> 8) & 0xFF));  // G
			buf.put((byte) (p & 0xFF));         // B
			buf.put((byte) ((p >> 24) & 0xFF)); // A
		}
		buf.flip();

		this.textureId = GL11.glGenTextures();
		GlStateManager.bindTexture(textureId);
		GL11.glTexParameteri(GL11.GL_TEXTURE_2D, GL11.GL_TEXTURE_MIN_FILTER, GL11.GL_LINEAR);
		GL11.glTexParameteri(GL11.GL_TEXTURE_2D, GL11.GL_TEXTURE_MAG_FILTER, GL11.GL_LINEAR);
		GL11.glTexParameteri(GL11.GL_TEXTURE_2D, GL11.GL_TEXTURE_WRAP_S, GL11.GL_CLAMP);
		GL11.glTexParameteri(GL11.GL_TEXTURE_2D, GL11.GL_TEXTURE_WRAP_T, GL11.GL_CLAMP);
		GL11.glTexImage2D(GL11.GL_TEXTURE_2D, 0, GL11.GL_RGBA, w, h, 0, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, buf);
	}
}
