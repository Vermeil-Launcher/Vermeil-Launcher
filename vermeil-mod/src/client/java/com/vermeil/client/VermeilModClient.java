package com.vermeil.client;

import com.vermeil.VermeilMod;
import net.fabricmc.api.ClientModInitializer;

/**
 * Client entrypoint. The custom-cape file watcher is driven from the client tick
 * by {@code MinecraftClientMixin}, and the render swap by {@code
 * AvatarRendererMixin} — so this entrypoint only logs init. The mod depends on
 * the Fabric loader alone (no Fabric API).
 */
public class VermeilModClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		VermeilMod.LOGGER.info("Vermeil client initialized.");
	}
}
