package com.vermeil.asm;

import java.util.Map;
import net.minecraftforge.fml.relauncher.IFMLLoadingPlugin;

/**
 * FML core plugin (coremod) for the Vermeil companion mod on Minecraft 1.8.9.
 *
 * <p>It exists solely to register {@link VermeilCapeTransformer}, which redirects
 * the local player's cape texture so vanilla {@code LayerCape} draws the
 * launcher's custom cape. 1.8.9 Forge has no clean event for the cape location,
 * so a bytecode transformer on {@code AbstractClientPlayer.getLocationCape()} is
 * the narrowest seam (the Fabric projects use Mixins for the equivalent hook;
 * 1.8.9 predates the Mixin toolchain we use elsewhere).
 *
 * <p>{@code SortingIndex} is 1001 so the transformer runs <em>after</em> FML's
 * deobfuscating remapper: in production the class arrives with SRG names
 * ({@code func_110303_q}), in dev with MCP names ({@code getLocationCape}). The
 * transformer picks the right one from the {@code fml.deobfuscatedEnvironment}
 * flag. {@code TransformerExclusions} keeps our own ASM package off the transform
 * path. The actual mod ({@code @Mod com.vermeil.VermeilMod}) lives in the same
 * jar, flagged via {@code FMLCorePluginContainsFMLMod} in the manifest.
 */
@IFMLLoadingPlugin.MCVersion("1.8.9")
@IFMLLoadingPlugin.Name("Vermeil Core")
@IFMLLoadingPlugin.TransformerExclusions("com.vermeil.asm")
@IFMLLoadingPlugin.SortingIndex(1001)
public class VermeilLoadingPlugin implements IFMLLoadingPlugin {
	@Override
	public String[] getASMTransformerClass() {
		return new String[] { "com.vermeil.asm.VermeilCapeTransformer" };
	}

	@Override
	public String getModContainerClass() {
		return null;
	}

	@Override
	public String getSetupClass() {
		return null;
	}

	@Override
	public void injectData(final Map<String, Object> data) {
	}

	@Override
	public String getAccessTransformerClass() {
		return null;
	}
}
