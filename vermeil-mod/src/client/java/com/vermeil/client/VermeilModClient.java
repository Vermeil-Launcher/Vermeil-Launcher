package com.vermeil.client;

import com.vermeil.VermeilMod;
import com.vermeil.client.cape.VermeilCape;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;

/**
 * Client entrypoint. Wires the custom-cape file watcher into the client tick so
 * the launcher can enable/disable or swap the cape and have it apply live; the
 * actual render swap is done by {@code AvatarRendererMixin}.
 */
public class VermeilModClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		ClientTickEvents.END_CLIENT_TICK.register(VermeilCape::tickReload);
		VermeilMod.LOGGER.info("Vermeil client initialized.");
	}
}
