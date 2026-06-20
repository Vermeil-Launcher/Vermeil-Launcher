package com.vermeil;

import net.fabricmc.api.ModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Common (both-environment) entrypoint for the Vermeil companion mod.
 *
 * Vermeil is a general-purpose companion mod for the Vermeil launcher; its
 * first feature is rendering the launcher's local custom capes in-game. The
 * client-side rendering lives in {@link com.vermeil.client.VermeilModClient};
 * this common initializer only sets up shared state such as logging.
 *
 * <p>This is the Minecraft 1.21.9–1.21.10 (Fabric) build. It renders the cape
 * through the render-state pipeline, hooking {@code AvatarRenderer.extractRenderState}
 * → {@code AvatarRenderState} (the cape moved to a {@code ClientAsset} on the
 * world {@code PlayerSkin} at 1.21.9, same shape as 26.x). The texture path still
 * uses {@code ResourceLocation} + {@code setFilter} + {@code Tickable} here;
 * 1.21.11 ({@code companion-mod/fabric/1.21.11}) churns those again. See
 * {@code docs/research/ingame-capes/research.md}.
 */
public class VermeilMod implements ModInitializer {
	public static final String MOD_ID = "vermeil";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	@Override
	public void onInitialize() {
		LOGGER.info("Vermeil mod initialized.");
	}
}
