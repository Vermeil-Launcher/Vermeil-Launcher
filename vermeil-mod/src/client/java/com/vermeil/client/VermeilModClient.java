package com.vermeil.client;

import net.fabricmc.api.ClientModInitializer;

import com.vermeil.VermeilMod;

/**
 * Client entrypoint. For now it just confirms the client side loaded — the
 * custom-cape rendering is layered on top of this once the toolchain build is
 * verified end to end.
 */
public class VermeilModClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		VermeilMod.LOGGER.info("Vermeil client initialized.");
	}
}
