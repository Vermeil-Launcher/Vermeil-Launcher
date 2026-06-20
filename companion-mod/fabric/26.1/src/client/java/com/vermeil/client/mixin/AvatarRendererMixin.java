package com.vermeil.client.mixin;

import com.vermeil.client.cape.VermeilCape;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.entity.player.AvatarRenderer;
import net.minecraft.client.renderer.entity.state.AvatarRenderState;
import net.minecraft.world.entity.Avatar;
import net.minecraft.world.entity.player.PlayerSkin;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Makes the local player's cape render from the launcher's custom cape texture
 * when the in-game cape is active.
 *
 * <p>We inject at the tail of the avatar render-state extraction, after vanilla
 * has populated {@code state.skin}/{@code state.showCape}, and swap in a skin
 * whose {@code cape()} points at our registered texture, forcing {@code showCape}
 * on; the vanilla {@code CapeLayer} then draws it through the normal path. The
 * custom cape takes precedence even over a Mojang-granted cape (enabling it means
 * "use this"). Only the local player is touched.
 */
@Mixin(AvatarRenderer.class)
public class AvatarRendererMixin {
	@Inject(
		method = "extractRenderState(Lnet/minecraft/world/entity/Avatar;Lnet/minecraft/client/renderer/entity/state/AvatarRenderState;F)V",
		at = @At("TAIL")
	)
	private void vermeil$applyCustomCape(final Avatar entity, final AvatarRenderState state, final float partialTicks, final CallbackInfo ci) {
		if (entity != Minecraft.getInstance().player || !VermeilCape.isActive()) {
			return;
		}
		// The custom cape takes precedence even when the account has a real
		// (Mojang-granted) cape — enabling it in the launcher means "use this".
		PlayerSkin skin = state.skin;
		state.showCape = true;
		state.skin = new PlayerSkin(skin.body(), VermeilCape.capeTexture(), skin.elytra(), skin.model(), skin.secure());
	}
}
