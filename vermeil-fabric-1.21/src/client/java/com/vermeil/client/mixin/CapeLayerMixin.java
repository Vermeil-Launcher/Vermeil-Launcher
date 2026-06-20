package com.vermeil.client.mixin;

import com.vermeil.client.cape.VermeilCape;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.renderer.entity.layers.CapeLayer;
import net.minecraft.client.resources.PlayerSkin;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

/**
 * Makes the local player's cape render from the launcher's custom cape texture
 * when the account has no Mojang-granted cape (Minecraft 1.21.x feature-renderer
 * pipeline).
 *
 * <p>{@code CapeLayer.render} reads {@code player.getSkin()} and only draws a
 * cape when {@code skin.capeTexture() != null}. We redirect that single
 * {@code getSkin()} call: for the local player, when our cape is active and the
 * account has no cape of its own, we return a {@link PlayerSkin} copy whose
 * {@code capeTexture()} points at {@link VermeilCape#CAPE_ID}. Vanilla then
 * renders our texture through its normal path. The redirect is scoped to the
 * cape layer only, so every other consumer of {@code getSkin()} is untouched; we
 * never override an account that already has a cape, and only the local player
 * is affected. The player's own cape model-part toggle is still respected (it is
 * checked before this call), so hiding the cape in skin settings hides ours too.
 */
@Mixin(CapeLayer.class)
public class CapeLayerMixin {
	@Redirect(
		method = "render",
		at = @At(
			value = "INVOKE",
			target = "Lnet/minecraft/client/player/AbstractClientPlayer;getSkin()Lnet/minecraft/client/resources/PlayerSkin;"
		)
	)
	private PlayerSkin vermeil$injectCustomCape(final AbstractClientPlayer player) {
		PlayerSkin skin = player.getSkin();
		if (player == Minecraft.getInstance().player && VermeilCape.isActive() && skin.capeTexture() == null) {
			return new PlayerSkin(
				skin.texture(),
				skin.textureUrl(),
				VermeilCape.CAPE_ID,
				skin.elytraTexture(),
				skin.model(),
				skin.secure()
			);
		}
		return skin;
	}
}
