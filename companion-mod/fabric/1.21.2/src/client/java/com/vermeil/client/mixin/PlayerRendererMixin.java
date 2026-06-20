package com.vermeil.client.mixin;

import com.vermeil.client.cape.VermeilCape;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.renderer.entity.player.PlayerRenderer;
import net.minecraft.client.renderer.entity.state.PlayerRenderState;
import net.minecraft.client.resources.PlayerSkin;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Makes the local player's cape render from the launcher's custom cape texture
 * when the in-game cape is active (Minecraft 1.21.2–1.21.11 render-state
 * pipeline).
 *
 * <p>1.21.2 moved entity rendering to per-frame <em>render states</em>:
 * {@code PlayerRenderer.extractRenderState} populates a {@link PlayerRenderState}
 * (its {@code skin} and {@code showCape}), and {@code CapeLayer.render} later
 * draws the cape from {@code state.skin.capeTexture()} when {@code showCape} is
 * set. We inject at the tail of extraction and, for the local player, replace
 * {@code state.skin} with a copy whose {@code capeTexture()} points at our
 * registered texture ({@link VermeilCape#CAPE_ID}) and force {@code showCape} on.
 * Vanilla then renders our texture through its normal cape path.
 *
 * <p>The custom cape takes precedence even over a Mojang-granted cape (enabling
 * it in the launcher means "use this"). Only the local player is touched. This
 * is the render-state analogue of the 1.21–1.21.1 feature-renderer hook; the
 * {@code PlayerSkin} record (a {@code ResourceLocation} cape texture) is the same
 * shape on both, so only the injection point differs.
 */
@Mixin(PlayerRenderer.class)
public class PlayerRendererMixin {
	@Inject(
		method = "extractRenderState(Lnet/minecraft/client/player/AbstractClientPlayer;Lnet/minecraft/client/renderer/entity/state/PlayerRenderState;F)V",
		at = @At("TAIL")
	)
	private void vermeil$applyCustomCape(final AbstractClientPlayer player, final PlayerRenderState state, final float partialTicks, final CallbackInfo ci) {
		if (player != Minecraft.getInstance().player || !VermeilCape.isActive()) {
			return;
		}
		PlayerSkin skin = state.skin;
		state.showCape = true;
		state.skin = new PlayerSkin(
			skin.texture(),
			skin.textureUrl(),
			VermeilCape.CAPE_ID,
			skin.elytraTexture(),
			skin.model(),
			skin.secure()
		);
	}
}
