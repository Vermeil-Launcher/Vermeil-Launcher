package com.vermeil.asm;

import net.minecraft.launchwrapper.IClassTransformer;
import net.minecraft.launchwrapper.Launch;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.FrameNode;
import org.objectweb.asm.tree.InsnList;
import org.objectweb.asm.tree.InsnNode;
import org.objectweb.asm.tree.JumpInsnNode;
import org.objectweb.asm.tree.LabelNode;
import org.objectweb.asm.tree.MethodInsnNode;
import org.objectweb.asm.tree.MethodNode;
import org.objectweb.asm.tree.VarInsnNode;

/**
 * Injects a custom-cape redirect into {@code AbstractClientPlayer
 * .getLocationCape()}.
 *
 * <p>At the method head we call {@link com.vermeil.client.VermeilCape
 * #overrideCapeLocation(net.minecraft.client.entity.AbstractClientPlayer)} with
 * {@code this}; if it returns non-null (the local player has an active custom
 * cape) we return that immediately, so vanilla {@code LayerCape} binds and draws
 * our texture. Otherwise we call {@link com.vermeil.client.VermeilCape
 * #shouldHideCape(net.minecraft.client.entity.AbstractClientPlayer)}: when true
 * (the cape was explicitly turned off) we return null, suppressing even a
 * Mojang-granted cape. When both are false the original vanilla logic runs
 * unchanged, so every other player keeps their real Mojang cape.
 *
 * <p>Frame handling: we read with {@code EXPAND_FRAMES} and write with
 * {@code COMPUTE_MAXS}, supplying the two stack-map frames our branch targets
 * need by hand. This avoids recomputing frames for the whole class (which would
 * force classloading mid-transform) while keeping the verifier happy on Java 8.
 */
public class VermeilCapeTransformer implements IClassTransformer {
	private static final String TARGET_CLASS = "net.minecraft.client.entity.AbstractClientPlayer";
	private static final String TARGET_INTERNAL = "net/minecraft/client/entity/AbstractClientPlayer";
	private static final String RESOURCE_LOCATION = "net/minecraft/util/ResourceLocation";
	private static final String METHOD_DESC = "()L" + RESOURCE_LOCATION + ";";

	private static final String HOOK_OWNER = "com/vermeil/client/VermeilCape";
	private static final String HOOK_NAME = "overrideCapeLocation";
	private static final String HOOK_DESC = "(L" + TARGET_INTERNAL + ";)L" + RESOURCE_LOCATION + ";";

	/** Second hook: force the local player's cape off when explicitly disabled. */
	private static final String HIDE_NAME = "shouldHideCape";
	private static final String HIDE_DESC = "(L" + TARGET_INTERNAL + ";)Z";

	/** MCP name in dev; SRG name once FML's deobf remapper has run (production). */
	private static final String NAME_MCP = "getLocationCape";
	private static final String NAME_SRG = "func_110303_q";

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
			LabelNode notCustom = new LabelNode();
			LabelNode runVanilla = new LabelNode();
			InsnList head = new InsnList();
			// 1. Active custom cape? Return it so vanilla LayerCape draws our texture.
			head.add(new VarInsnNode(Opcodes.ALOAD, 0)); // this
			head.add(new MethodInsnNode(Opcodes.INVOKESTATIC, HOOK_OWNER, HOOK_NAME, HOOK_DESC, false));
			head.add(new InsnNode(Opcodes.DUP));
			head.add(new JumpInsnNode(Opcodes.IFNULL, notCustom));
			head.add(new InsnNode(Opcodes.ARETURN));
			head.add(notCustom);
			// Branch target: locals = [this], stack = [ResourceLocation] (the null we DUP'd).
			head.add(new FrameNode(Opcodes.F_NEW,
				1, new Object[] { TARGET_INTERNAL },
				1, new Object[] { RESOURCE_LOCATION }));
			head.add(new InsnNode(Opcodes.POP));
			// 2. Cape explicitly disabled? Return null (no cape) so nothing renders,
			//    skipping the vanilla real-cape fallback.
			head.add(new VarInsnNode(Opcodes.ALOAD, 0)); // this
			head.add(new MethodInsnNode(Opcodes.INVOKESTATIC, HOOK_OWNER, HIDE_NAME, HIDE_DESC, false));
			head.add(new JumpInsnNode(Opcodes.IFEQ, runVanilla));
			head.add(new InsnNode(Opcodes.ACONST_NULL));
			head.add(new InsnNode(Opcodes.ARETURN));
			head.add(runVanilla);
			// Branch target: locals = [this], stack = [] — fall through to vanilla.
			head.add(new FrameNode(Opcodes.F_NEW,
				1, new Object[] { TARGET_INTERNAL },
				0, new Object[] {}));
			method.instructions.insert(head);
			injected = true;
			break;
		}

		if (!injected) {
			// Don't silently ship a no-op hook — make a mismatch loud in the log.
			System.err.println("[Vermeil] could not find " + methodName + METHOD_DESC
				+ " on " + TARGET_CLASS + "; custom cape will not render.");
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
