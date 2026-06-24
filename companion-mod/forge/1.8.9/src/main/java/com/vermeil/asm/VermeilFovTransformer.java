package com.vermeil.asm;

import net.minecraft.launchwrapper.IClassTransformer;
import net.minecraft.launchwrapper.Launch;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.tree.AbstractInsnNode;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.InsnList;
import org.objectweb.asm.tree.MethodInsnNode;
import org.objectweb.asm.tree.MethodNode;

/**
 * Scales the FOV-effect contribution on Minecraft 1.8.9 by wrapping the result
 * of {@code AbstractClientPlayer.getFovModifier()} with
 * {@link com.vermeil.client.VermeilFovEffects#applyScale(float)}.
 *
 * <p>1.8.9 has no native FOV Effects toggle — it pre-dates the 1.16
 * {@code fovEffectScale} setting. The whole {@code FOV-effect} computation
 * (sprint, Speed/Slowness potions, Creative flight, bow draw) lives in this one
 * method, which returns a multiplier centred on {@code 1.0F} (1.0 = no
 * change). Scaling its return uniformly captures every effect: a multiplier of
 * {@code 1.15} (sprint) becomes {@code 1.0 + 0.15 * scale}; {@code 0.85} (bow
 * draw) becomes {@code 1.0 + (-0.15) * scale}. {@code EntityRenderer} smooths
 * this value, applies it to the user's FOV setting, and renders. We only have
 * to touch the source.
 *
 * <p>The decompiled MCP source ends with a single
 * {@code return ForgeHooksClient.getOffsetFOV(this, f)} — one {@code FRETURN}
 * after Forge's offset hook. We insert our {@code INVOKESTATIC} before every
 * {@code FRETURN} in the method (iterating defensively in case a future
 * recompile produces more than one) so our scale is the last transform other
 * mods see.
 *
 * <p>Frame handling: pure stack-shape preservation — pop float, push float — so
 * no stack-map frames change and {@link ClassWriter#COMPUTE_MAXS} alone is
 * enough. We do not request {@code COMPUTE_FRAMES} (which would force class
 * loading mid-transform).
 *
 * <p>Like {@link VermeilCapeTransformer}, we run after FML's deobfuscating
 * remapper ({@code SortingIndex(1001)} on the loading plugin): in dev the
 * method arrives as {@code getFovModifier}, in production as
 * {@code func_175156_o}. The {@code fml.deobfuscatedEnvironment} blackboard
 * flag picks the right one.
 */
public class VermeilFovTransformer implements IClassTransformer {
	private static final String TARGET_CLASS = "net.minecraft.client.entity.AbstractClientPlayer";

	private static final String METHOD_DESC = "()F";

	private static final String HOOK_OWNER = "com/vermeil/client/VermeilFovEffects";
	private static final String HOOK_NAME = "applyScale";
	private static final String HOOK_DESC = "(F)F";

	/** MCP name in dev; SRG name once FML's deobf remapper has run (production). */
	private static final String NAME_MCP = "getFovModifier";
	private static final String NAME_SRG = "func_175156_o";

	@Override
	public byte[] transform(final String name, final String transformedName, final byte[] basicClass) {
		if (basicClass == null || !TARGET_CLASS.equals(transformedName)) {
			return basicClass;
		}

		String methodName = isDeobfuscated() ? NAME_MCP : NAME_SRG;

		ClassNode node = new ClassNode();
		new ClassReader(basicClass).accept(node, ClassReader.EXPAND_FRAMES);

		boolean injected = false;
		for (MethodNode method : node.methods) {
			if (!method.name.equals(methodName) || !method.desc.equals(METHOD_DESC)) {
				continue;
			}
			// Wrap every FRETURN with our scale: pop the returning float, call
			// VermeilFovEffects.applyScale, push the scaled float, FRETURN.
			// Iterate over a snapshot — we modify instructions while iterating.
			AbstractInsnNode[] snapshot = method.instructions.toArray();
			for (AbstractInsnNode insn : snapshot) {
				if (insn.getOpcode() != Opcodes.FRETURN) {
					continue;
				}
				InsnList wrap = new InsnList();
				wrap.add(new MethodInsnNode(Opcodes.INVOKESTATIC, HOOK_OWNER, HOOK_NAME, HOOK_DESC, false));
				method.instructions.insertBefore(insn, wrap);
				injected = true;
			}
			break;
		}

		if (!injected) {
			// Don't silently ship a no-op hook — make a mismatch loud in the log.
			System.err.println("[Vermeil] could not find " + methodName + METHOD_DESC
				+ " on " + TARGET_CLASS + " or it has no FRETURN; FOV effects scaling will not apply.");
			return basicClass;
		}

		ClassWriter writer = new ClassWriter(ClassWriter.COMPUTE_MAXS);
		node.accept(writer);
		return writer.toByteArray();
	}

	private static boolean isDeobfuscated() {
		Object flag = Launch.blackboard.get("fml.deobfuscatedEnvironment");
		return flag instanceof Boolean && (Boolean) flag;
	}
}
