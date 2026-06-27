package com.vermeil;

import com.vermeil.client.VermeilCape;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.common.event.FMLInitializationEvent;
import net.minecraftforge.common.MinecraftForge;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

/**
 * Entrypoint for the Vermeil companion mod on Minecraft 1.8.9 (Forge).
 *
 * <p>Vermeil is a general-purpose companion mod for the Vermeil launcher; its
 * first feature is rendering the launcher's local custom capes in-game. This is
 * the 1.8.9 Forge variant — a separate project from the Fabric ones because the
 * loader, mappings, Java version, and cape-render path differ too much to share
 * a toolchain. The mod is client-only (capes are purely visual), so it declares
 * {@code clientSideOnly} and accepts any remote version to never block joining a
 * server.
 *
 * <p>The client-side cape rendering is wired separately (the render hook differs
 * from the Fabric render-state path); this class only sets up shared state such
 * as logging.
 */
@Mod(
	modid = VermeilMod.MOD_ID,
	name = "Vermeil",
	version = VermeilMod.VERSION,
	clientSideOnly = true,
	acceptableRemoteVersions = "*"
)
public class VermeilMod {
	public static final String MOD_ID = "vermeil";
	/**
	 * Informational version for the {@code @Mod} annotation (must be a compile-time
	 * constant). The authoritative version is substituted into {@code mcmod.info}
	 * from {@code gradle.properties} {@code mod_version} at build time; keep this
	 * in sync with it.
	 */
	public static final String VERSION = "0.1.7";
	public static final Logger LOGGER = LogManager.getLogger(MOD_ID);

	@Mod.EventHandler
	public void init(final FMLInitializationEvent event) {
		// Client-only mod: drive the cape file-watcher / animation from the
		// client tick. The render swap itself is done by the coremod transformer
		// on AbstractClientPlayer.getLocationCape (see com.vermeil.asm).
		MinecraftForge.EVENT_BUS.register(VermeilCape.INSTANCE);
		// Pause-menu "Vermeil" button + in-game settings screen.
		MinecraftForge.EVENT_BUS.register(com.vermeil.client.VermeilSettingsHook.INSTANCE);
		LOGGER.info("Vermeil mod initialized.");
	}
}
