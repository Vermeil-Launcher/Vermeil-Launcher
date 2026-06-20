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
 * <p>This is the Minecraft 1.21.11 (Fabric) build. By 1.21.11 the client API
 * matches the 26.x shape ({@code Identifier}, {@code TickableTexture}, sampler
 * filtering), so its client source is identical to the 26.x project
 * ({@code companion-mod/fabric/26.1-26.2}) — only the toolchain (JDK 21) differs.
 * The intermediate 1.21.x render-state eras (1.21.5–1.21.10) use older texture
 * APIs and are archived under {@code companion-mod/archive/fabric/}.
 * See {@code docs/research/ingame-capes/research.md}.
 */
public class VermeilMod implements ModInitializer {
	public static final String MOD_ID = "vermeil";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	@Override
	public void onInitialize() {
		LOGGER.info("Vermeil mod initialized.");
	}
}
