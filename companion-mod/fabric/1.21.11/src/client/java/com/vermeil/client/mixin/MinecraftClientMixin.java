package com.vermeil.client.mixin;

import com.vermeil.client.cape.VermeilCape;
import net.minecraft.client.Minecraft;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Drives the custom-cape file watcher from the client tick. Injecting at the tail
 * of {@link Minecraft#tick()} reproduces what a client-tick lifecycle event would
 * give us, so the mod needs no Fabric API dependency — only the loader and the
 * game itself. The launcher can enable/disable or swap the cape and have it apply
 * live; the render swap is done by {@code CapeLayerMixin}.
 */
@Mixin(Minecraft.class)
public class MinecraftClientMixin {
	@Inject(method = "tick", at = @At("TAIL"))
	private void vermeil$tickCape(final CallbackInfo ci) {
		VermeilCape.tickReload((Minecraft) (Object) this);
	}
}
