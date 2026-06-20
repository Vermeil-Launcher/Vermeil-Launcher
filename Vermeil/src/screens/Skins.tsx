import { Component, createSignal, createResource, createEffect, onCleanup, onMount, Show, For } from "solid-js";
import { account, showToast, refreshActiveSkin } from "../App";
import {
  getSkinProfile,
  uploadSkin,
  resetSkin,
  equipCape,
  unequipCape,
  listLocalSkins,
  equipLocalSkin,
  removeLocalSkin,
  listCustomCapes,
  removeCustomCape,
  readCustomCapeSource,
  setIngameCape,
  setIngameCapeEnabled,
  clearIngameCape,
  getIngameCape,
  PlayerProfile,
  LocalSkin,
  CustomCape,
  SkinVariant,
} from "../ipc/commands";
import { SkinViewer, IdleAnimation, PlayerObject } from "skinview3d";
import { CylinderGeometry, MeshBasicMaterial, Mesh, Group } from "three";
import { IconUpload, IconReload, IconTrash2, IconPlus, IconEdit } from "../components/Icons";
import SkinAvatar from "../components/SkinAvatar";
import CustomCapeEditor from "../modals/CustomCapeEditor";
import { CapeAnimator, FrameSource, bakeModCapeStrip, clampRes } from "../lib/cape";

/**
 * Idle animation with a subtle elytra breath.
 *
 * Extends skinview3d's IdleAnimation (the slow arm + cape sway) and, only when
 * the elytra is the active back-equipment, breathes the wings on the same slow
 * tempo so they read as alive instead of frozen — without ever spreading. The
 * body never leaves the upright idle stance — this is deliberately NOT the
 * flight pose.
 *
 * Wing angles come straight from the model's own joints: the folded rest is 15°
 * (0.2617994 rad) on the z axis. The breath flexes them a few degrees above
 * that rest and back, never opening anywhere near the flight spread (90°).
 */
class IdleElytraAnimation extends IdleAnimation {
  protected animate(player: PlayerObject): void {
    // Keep the normal idle body sway (arms, cape).
    super.animate(player);

    // Wings are only visible when the elytra is equipped — skip the work
    // (and leave the joints untouched) when the cape or nothing is shown.
    if (!player.elytra.visible) return;

    const FOLDED = 0.2617994; // 15° — the model's resting wing fold

    // Continuous breath, matched to the body's idle tempo. skinview3d's idle
    // arms/cape use `sin(progress) * small`, period 2π ≈ 6.3 s; we ride the
    // same `progress` so the flex syncs with the rest of the body. AMP is
    // ~2.3°, picked to be visibly alive but well under any "spreading" read,
    // and the (1 - cos)/2 form keeps the wings at-or-above FOLDED so they
    // never close tighter than the rest pose.
    const AMP = 0.04;
    const z = FOLDED + AMP * (1 - Math.cos(this.progress)) / 2;

    player.elytra.leftWing.rotation.x = FOLDED;
    player.elytra.leftWing.rotation.y = 0.01; // model's tiny offset to avoid z-fighting
    player.elytra.leftWing.rotation.z = z;
    player.elytra.updateRightWing();
  }
}

/**
 * Skin & cape changer — cinematic hero canvas redesign.
 *
 * The 3D model is the centerpiece. All chrome (variant toggle, action
 * buttons, cape gallery, saved skin library, carousel arrows) floats over
 * the canvas as glass overlays and auto-hides 1.5 s after the last mouse
 * movement, returning the screen to "just the model" at rest.
 *
 * Microsoft accounts only — offline accounts hit the disabled state since
 * Mojang has no concept of their UUID and any upload would 401.
 *
 * Texture pipeline: every skin / cape texture arrives from the backend as
 * a base64 `data:image/png;` URL. The webview never makes a request to
 * `textures.minecraft.net`, so there are no CORS or http/https scheme
 * issues — drop the data URL straight into skinview3d.
 */

// In-game cape state + the selected custom cape live at MODULE scope so they
// survive the screen remounting on navigation (the screen is mounted via
// `<Show>`, which unmounts it when you leave). Keeping them local caused a
// flicker: on every remount the selection reset to null, briefly highlighting
// "No cape" until the async state load resolved. Module scope + a one-time load
// means re-entering the screen reflects the real state immediately.
const [activeCustomCapeId, setActiveCustomCapeId] = createSignal<string | null>(null);
const [ingameCapeId, setIngameCapeId] = createSignal<string | null>(null);
const [ingameEnabled, setIngameEnabled] = createSignal(false);
let ingameStateLoaded = false;

const Skins: Component = () => {
  const [profile, { refetch: refetchProfile }] = createResource<PlayerProfile | null>(async () => {
    if (!account() || account()!.is_offline) return null;
    try {
      return await getSkinProfile();
    } catch (e) {
      showToast({ title: "Couldn't load profile", message: String(e), type: "error" });
      return null;
    }
  });

  const [localSkins, { refetch: refetchLocal }] = createResource<LocalSkin[]>(async () => {
    if (!account() || account()!.is_offline) return [];
    try {
      return await listLocalSkins();
    } catch {
      return [];
    }
  });

  // Selected skin variant. Starts `null` (unknown) rather than defaulting to
  // a concrete value: the screen fully remounts on every navigation, and the
  // profile loads asynchronously, so a hardcoded default would flash the wrong
  // toggle as "active" for a frame before the profile resolves. While null,
  // neither toggle is highlighted — the profile-load effect sets the real
  // variant once it arrives.
  const [variant, setVariant] = createSignal<SkinVariant | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [capeCooldownUntil, setCapeCooldownUntil] = createSignal(0);
  const isCapeOnCooldown = () => Date.now() < capeCooldownUntil();
  const [showElytra, setShowElytra] = createSignal(false);

  // Local custom capes (display-only — never sent to Mojang). `activeCustomCapeId`
  // is the cape currently shown on the model; when set it overrides the Mojang
  // cape in the display effect. Selecting a Mojang cape or "No cape" clears it.
  const [customCapes, { refetch: refetchCustomCapes }] = createResource<CustomCape[]>(async () => {
    if (!account() || account()!.is_offline) return [];
    try {
      return await listCustomCapes();
    } catch {
      return [];
    }
  });
  const [showCapeEditor, setShowCapeEditor] = createSignal(false);
  const [editingCape, setEditingCape] = createSignal<CustomCape | null>(null);
  // In-game cape (companion mod): `ingameCapeId`/`ingameEnabled` are module-scope
  // (above) so they persist across remounts; `ingameBusy` is transient per-mount.
  const [ingameBusy, setIngameBusy] = createSignal(false);

  // Active skin texture, handed to the cape editor so its 3D preview shows the
  // user's own body instead of an empty stand.
  const activeSkinTexture = (): string | undefined => {
    const p = profile();
    const a = p?.skins.find((s) => s.state === "ACTIVE") ?? p?.skins[0];
    return a?.texture;
  };

  // Idle / chrome auto-hide. Any mousemove on the hero resets the timer;
  // 1.5 s without movement → fade chrome to invisible, leaving just the
  // model on screen. Any subsequent move brings everything back.
  const [idle, setIdle] = createSignal(false);
  let idleTimer: number | undefined;
  const wakeChrome = () => {
    if (idle()) setIdle(false);
    if (idleTimer !== undefined) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => setIdle(true), 1500);
  };
  onCleanup(() => {
    if (idleTimer !== undefined) window.clearTimeout(idleTimer);
  });

  // Canvas crossfade flag — toggles a brief opacity drop while a new texture
  // loads so the swap reads as a soft transition, not a hard cut.
  const [canvasFading, setCanvasFading] = createSignal(false);

  let fileInputRef: HTMLInputElement | undefined;
  let viewerCanvas: HTMLCanvasElement | undefined;
  let viewer: SkinViewer | undefined;
  let heroEl: HTMLDivElement | undefined;
  let stageEl: HTMLDivElement | undefined;

  // Animated custom capes drive a live frame loop instead of a static texture.
  // We keep one animator for the main viewer and track which cape it's playing
  // so the display effect can re-run (e.g. on elytra toggle) without restarting
  // it. `getParams` reads the live transform + elytra each frame.
  let capeAnimator: CapeAnimator | undefined;
  let animatorCapeId: string | null = null;

  const ensureAnimator = (): CapeAnimator => {
    if (!capeAnimator) {
      capeAnimator = new CapeAnimator(viewer!, () => {
        const live = (customCapes() ?? []).find((c) => c.id === animatorCapeId);
        const t = live?.transform;
        return {
          dx: t?.dx ?? 0,
          dy: t?.dy ?? 0,
          scale: t?.scale ?? 1,
          bg: t?.bg ?? "#2b2740",
          res: clampRes(t?.res),
          elytra: showElytra(),
        };
      });
    }
    return capeAnimator;
  };

  const startCapeAnimation = async (cape: CustomCape) => {
    animatorCapeId = cape.id; // mark up-front so re-runs don't double-start
    try {
      const src = await readCustomCapeSource(cape.id);
      if (animatorCapeId !== cape.id || !viewer) return; // superseded while fetching
      await ensureAnimator().start(src);
    } catch (e) {
      console.error("Animated cape failed, falling back to static frame:", e);
      // Fall back to the stored poster texture so the cape still shows.
      try {
        viewer?.loadCape(cape.texture, { backEquipment: showElytra() ? "elytra" : "cape" });
      } catch {
        // viewer gone; ignore
      }
    }
  };

  const stopCapeAnimation = () => {
    capeAnimator?.stop();
    animatorCapeId = null;
  };

  // Size the canvas to a PORTRAIT rect that scales with the stage height.
  // A humanoid model is ~2x taller than its max rotational width, so a tall
  // narrow canvas fills with the model (appears large) instead of wasting
  // horizontal space like a square would, and lets the side docks sit close.
  // Height drives the size and grows with the window; width is 80% of height,
  // chosen to fit an open elytra spread (each wing tip lands roughly ±13.5
  // world units at the idle flutter's apex, vs ±6 for the body alone) with a
  // small margin. A tighter ratio looked great with just the skin but clipped
  // the wings on every flutter peak.
  const computeCanvasSize = () => {
    if (!viewer || !stageEl) return;
    const rect = stageEl.getBoundingClientRect();
    const h = Math.min(rect.height * 0.96, 880);
    const w = Math.min(rect.width, h * 0.8);
    if (h > 0 && w > 0) viewer.setSize(Math.round(w), Math.round(h));
  };

  onMount(() => {
    if (!viewerCanvas) return;
    viewer = new SkinViewer({
      canvas: viewerCanvas,
      width: 400,
      height: 520,
      skin: undefined,
    });
    viewer.animation = new IdleElytraAnimation();
    viewer.controls.enableZoom = false;
    // Zoom out from the default (0.9) so the full model — plus the pedestal
    // below the feet — fits with margin. At 0.9 the model nearly fills the
    // canvas height, so rotating it (arms/legs swinging out) or the added
    // platform clipped at the frame edges. 0.62 leaves comfortable headroom
    // at every angle.
    viewer.zoom = 0.62;

    // Hexagonal figurine pedestal under the model. Two stacked discs:
    // a chunky dark base and a thinner accent rim sitting on top.
    //
    // Coordinate system (traced from skinview3d's PlayerObject): the skin is
    // offset +8 inside the player, legs sit at y=-12 and extend ~12 units
    // down, so the FEET BOTTOM lands at scene Y ≈ -16. Y=0 is chest/waist
    // height (which is why a platform at y≈0 floated at the chest). Place the
    // pedestal so the rim's top surface meets the foot plane at -16.
    const platform = new Group();
    const base = new Mesh(
      // radiusTop, radiusBottom, height, 6 sides for a chunky hex pedestal
      new CylinderGeometry(7, 8, 1.5, 6),
      new MeshBasicMaterial({ color: 0x1d1b24 }),
    );
    base.position.y = -17.0; // top surface at -16.25, just below the feet
    const rim = new Mesh(
      new CylinderGeometry(8.2, 8.2, 0.3, 6),
      new MeshBasicMaterial({ color: 0x8b5cf6 }),
    );
    rim.position.y = -16.1; // sits on the base, top surface ≈ foot plane (-16)
    platform.add(base);
    platform.add(rim);
    viewer.scene.add(platform);

    computeCanvasSize();
    const ro = new ResizeObserver(computeCanvasSize);
    if (stageEl) ro.observe(stageEl);
    onCleanup(() => ro.disconnect());

    // Prime the idle timer so chrome shows on first paint then settles.
    wakeChrome();
  });

  onCleanup(() => {
    stopCapeAnimation();
    viewer?.dispose();
    viewer = undefined;
  });

  // Push the active skin into the 3D viewer whenever the profile changes.
  // Wraps the load in a brief opacity fade for the cinematic swap. The cape is
  // loaded by a separate effect so toggling cape/elytra never reloads the skin.
  createEffect(() => {
    const p = profile();
    if (!viewer || !p) return;

    const active = p.skins.find((s) => s.state === "ACTIVE") ?? p.skins[0];
    if (active) {
      setVariant(active.variant);
      setCanvasFading(true);
      try {
        viewer.loadSkin(active.texture, {
          model: active.variant === "SLIM" ? "slim" : "default",
        });
      } catch (e) {
        console.error("Skin load failed:", e);
      }
      // 250 ms: long enough to read as a fade, short enough not to feel slow.
      window.setTimeout(() => setCanvasFading(false), 250);
    }
  });

  // Show the active cape on the model whenever the profile or the cape/elytra
  // toggle changes. Only the back-equipment swaps between "cape" and "elytra";
  // the model keeps its idle animation with no flying pose or transition, so
  // the elytra simply appears on the player's back.
  createEffect(() => {
    const elytra = showElytra();
    const customId = activeCustomCapeId();
    const caps = customCapes();
    const p = profile();
    if (!viewer || !p) return;

    const cc = customId ? (caps ?? []).find((c) => c.id === customId) : undefined;

    // Animated custom cape → drive the live frame loop. The animator reads the
    // elytra toggle live each frame, so a re-run from toggling elytra must NOT
    // restart it — only (re)start when the target cape actually changes.
    if (cc && cc.transform.animated) {
      if (animatorCapeId !== cc.id) {
        stopCapeAnimation();
        startCapeAnimation(cc);
      }
      return;
    }

    // Not an animated custom cape — make sure any running animation is stopped
    // before we paint a static texture.
    stopCapeAnimation();

    // A locally-selected static custom cape wins over the Mojang cape — it's a
    // display-only override that lives entirely in the viewer.
    if (cc) {
      // Rendered with skinview3d's default nearest filtering (crisp texels)
      // so the cape's baked resolution shows as a real pixel grid, matching
      // the editor preview. loadCape is async for a data-URL source, so
      // guard the returned promise's rejection.
      const r = viewer.loadCape(cc.texture, {
        backEquipment: elytra ? "elytra" : "cape",
      }) as unknown as Promise<unknown> | undefined;
      if (r && typeof (r as { then?: unknown }).then === "function") {
        r.catch((e) => console.error("Custom cape load failed:", e));
      }
      return;
    }

    const activeCape = p.capes.find((c) => c.state === "ACTIVE");
    if (activeCape) {
      try {
        viewer.loadCape(activeCape.texture, {
          backEquipment: elytra ? "elytra" : "cape",
        });
      } catch (e) {
        console.error("Cape load failed:", e);
      }
    } else {
      viewer.resetCape();
    }
  });

  // Re-load skin on local variant toggle (Classic ↔ Slim).
  createEffect(() => {
    const v = variant();
    const p = profile();
    if (!viewer || !p) return;
    const active = p.skins.find((s) => s.state === "ACTIVE") ?? p.skins[0];
    if (active) {
      try {
        viewer.loadSkin(active.texture, {
          model: v === "SLIM" ? "slim" : "default",
        });
      } catch (e) {
        console.error("Variant switch failed:", e);
      }
    }
  });

  // ─── Actions ───

  const handleUpload = () => fileInputRef?.click();

  const handleFileSelected = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;

    setBusy("upload");
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const name = file.name.replace(/\.png$/i, "") || "Custom skin";
      // Fall back to Classic if the profile hasn't resolved the variant yet
      // (variant() is null until then). In practice the profile is loaded by
      // the time the user can click Upload.
      const v = variant() ?? "CLASSIC";
      await uploadSkin(Array.from(bytes), v, true, name);
      await refetchLocal();
      await refetchProfile();
      await refreshActiveSkin();
      showToast({
        title: "Skin equipped",
        message: `${name} (${v === "SLIM" ? "Slim" : "Classic"})`,
        type: "success",
      });
    } catch (err) {
      showToast({ title: "Skin upload failed", message: String(err), type: "error" });
    } finally {
      setBusy(null);
    }
  };

  const handleReset = async () => {
    setBusy("reset");
    try {
      await resetSkin();
      await refetchProfile();
      await refreshActiveSkin();
      showToast({ title: "Skin reset to default", type: "success" });
    } catch (e) {
      showToast({ title: "Reset failed", message: String(e), type: "error" });
    } finally {
      setBusy(null);
    }
  };

  const handleRefresh = async () => {
    setBusy("refresh");
    try {
      await refetchProfile();
      await refetchLocal();
    } finally {
      setBusy(null);
    }
  };

  const handleEquipLocal = async (skin: LocalSkin) => {
    if (busy() !== null) return;
    // Optimistic crossfade: swap the canvas texture immediately so the click
    // reads as instant. The Mojang upload runs in the background; the
    // profile-change effect later reaffirms with the same texture data, so
    // there's no flicker from the eventual round-trip.
    if (viewer) {
      setCanvasFading(true);
      try {
        viewer.loadSkin(skin.texture, {
          model: skin.variant === "SLIM" ? "slim" : "default",
        });
      } catch (e) {
        console.error("Optimistic skin preview failed:", e);
      }
      window.setTimeout(() => setCanvasFading(false), 250);
    }

    setBusy(`equip-${skin.hash}`);
    try {
      await equipLocalSkin(skin.hash);
      await refetchProfile();
      await refreshActiveSkin();
      showToast({ title: `${skin.name} equipped`, type: "success" });
    } catch (e) {
      showToast({ title: "Equip failed", message: String(e), type: "error" });
    } finally {
      setBusy(null);
    }
  };

  const handleRemoveLocal = async (skin: LocalSkin) => {
    setBusy(`remove-${skin.hash}`);
    try {
      await removeLocalSkin(skin.hash);
      await refetchLocal();
    } catch (e) {
      showToast({ title: "Remove failed", message: String(e), type: "error" });
    } finally {
      setBusy(null);
    }
  };

  const handleVariantSwitch = async (newVariant: SkinVariant) => {
    if (newVariant === variant()) return;
    const p = profile();
    if (!p) return;
    const active = p.skins.find((s) => s.state === "ACTIVE") ?? p.skins[0];
    if (!active) return;

    setVariant(newVariant);
    setBusy("variant");
    try {
      const base64 = active.texture.split(",")[1];
      const binary = atob(base64);
      const bytes = Array.from({ length: binary.length }, (_, i) => binary.charCodeAt(i));
      await uploadSkin(bytes, newVariant, false);
      await refetchProfile();
      await refreshActiveSkin();
      showToast({
        title: "Variant changed",
        message: newVariant === "SLIM" ? "Slim (3px arms)" : "Classic (4px arms)",
        type: "success",
        autoCloseMs: 2000,
      });
    } catch (e) {
      showToast({ title: "Variant switch failed", message: String(e), type: "error" });
      const p2 = profile();
      if (p2) {
        const act = p2.skins.find((s) => s.state === "ACTIVE") ?? p2.skins[0];
        if (act) setVariant(act.variant);
      }
    } finally {
      setBusy(null);
    }
  };

  const handleEquipCape = async (capeId: string | null) => {
    // Selecting a Mojang cape (or "No cape") clears any local custom cape
    // override and turns the in-game custom cape off, so the launcher selection
    // and what shows in-game stay in sync.
    if (ingameBusy()) return;
    setActiveCustomCapeId(null);
    if (ingameEnabled()) {
      try {
        await setIngameCapeEnabled(false);
        setIngameEnabled(false);
      } catch {
        // best-effort
      }
    }
    if (isCapeOnCooldown()) {
      showToast({
        title: "Slow down",
        message: "Mojang rate-limits cape changes. Wait a moment between switches.",
        type: "info",
        autoCloseMs: 3000,
      });
      return;
    }
    setBusy(`cape-${capeId ?? "none"}`);
    try {
      if (capeId) await equipCape(capeId);
      else await unequipCape();
      await refetchProfile();
      setCapeCooldownUntil(Date.now() + 3000);
    } catch (e) {
      showToast({ title: "Cape change failed", message: String(e), type: "error" });
    } finally {
      setBusy(null);
    }
  };

  // ─── Custom capes ───

  const openNewCape = () => {
    setEditingCape(null);
    setShowCapeEditor(true);
  };

  const openEditCape = (cape: CustomCape) => {
    setEditingCape(cape);
    setShowCapeEditor(true);
  };

  const handleCapeSaved = async (cape: CustomCape) => {
    await refetchCustomCapes();
    // Saving equips the cape everywhere: show it on the model and (re)apply it
    // in-game from the just-saved transform, so a resolution / position / bg edit
    // takes effect in the game too — not only in the viewer.
    setActiveCustomCapeId(cape.id);
    setIngameBusy(true);
    try {
      const { png, frameTimeMs } = await bakeForIngame(cape);
      await setIngameCape(cape.id, png, frameTimeMs);
      setIngameCapeId(cape.id);
      setIngameEnabled(true);
    } catch (e) {
      showToast({ title: "Couldn't apply cape in-game", message: String(e), type: "error" });
    } finally {
      setIngameBusy(false);
    }
  };

  const handleEquipCustomCape = async (id: string) => {
    if (ingameBusy()) return;
    // Clicking the active cape again unequips it (viewer + in-game), like
    // clicking an equipped cape to take it off.
    if (activeCustomCapeId() === id) {
      setActiveCustomCapeId(null);
      if (ingameEnabled()) {
        setIngameBusy(true);
        try {
          await setIngameCapeEnabled(false);
          setIngameEnabled(false);
        } catch (e) {
          showToast({ title: "Couldn't remove in-game cape", message: String(e), type: "error" });
        } finally {
          setIngameBusy(false);
        }
      }
      return;
    }
    // Equip: show in the viewer immediately, then apply it in-game (bake +
    // store). On supported instances the cape appears in-game on next launch
    // (or live, if one is running).
    setActiveCustomCapeId(id);
    const cape = (customCapes() ?? []).find((c) => c.id === id);
    if (!cape) return;
    setIngameBusy(true);
    try {
      const { png, frameTimeMs } = await bakeForIngame(cape);
      await setIngameCape(id, png, frameTimeMs);
      setIngameCapeId(id);
      setIngameEnabled(true);
      showToast({
        title: "Cape equipped",
        message: "Applies in-game on launch (Fabric on MC 26.x or 1.21.1).",
        type: "success",
        autoCloseMs: 3000,
      });
    } catch (e) {
      showToast({ title: "In-game cape failed", message: String(e), type: "error" });
    } finally {
      setIngameBusy(false);
    }
  };

  const handleRemoveCustomCape = async (id: string) => {
    setBusy(`ccape-${id}`);
    try {
      await removeCustomCape(id);
      if (activeCustomCapeId() === id) setActiveCustomCapeId(null);
      // If this cape was the in-game one, clear that too so it doesn't linger.
      if (ingameCapeId() === id) {
        try {
          await clearIngameCape();
        } catch {
          // best-effort
        }
        setIngameCapeId(null);
        setIngameEnabled(false);
      }
      await refetchCustomCapes();
    } catch (e) {
      showToast({ title: "Remove failed", message: String(e), type: "error" });
    } finally {
      setBusy(null);
    }
  };

  // ─── In-game cape (companion mod) ───

  // Load the current in-game cape state once, and reflect it in the selection
  // so the dock shows the enabled cape as active (no "nothing selected but still
  // on" desync when re-entering the screen).
  onMount(async () => {
    if (ingameStateLoaded) return; // module-scope state persists across remounts
    try {
      const st = await getIngameCape();
      setIngameCapeId(st?.cape_id ?? null);
      setIngameEnabled(st?.enabled ?? false);
      if (st?.enabled && st.cape_id) setActiveCustomCapeId(st.cape_id);
      ingameStateLoaded = true;
    } catch {
      // Leave it off; retry on the next mount.
    }
  });

  /** Bake a custom cape into the mod's frame-strip layout and return IPC-ready bytes. */
  const bakeForIngame = async (cape: CustomCape) => {
    const sourceUrl = await readCustomCapeSource(cape.id);
    const src = await FrameSource.load(sourceUrl);
    try {
      const t = cape.transform;
      // Cap animated strips so a high-res GIF doesn't make a huge multi-frame PNG.
      const res = src.frameCount > 1 ? Math.min(clampRes(t.res), 8) : clampRes(t.res);
      const bake = bakeModCapeStrip(src, { dx: t.dx, dy: t.dy, scale: t.scale, bg: t.bg, res });
      return { png: Array.from(bake.png), frameTimeMs: bake.frames > 1 ? bake.frameTimeMs : null };
    } finally {
      src.dispose();
    }
  };

  // ─── Render ───

  return (
    <div class="screen-enter skins-screen">
      <Show
        when={account() && !account()!.is_offline}
        fallback={
          <div class="skins-empty">
            <div class="section-label">
              Skins & capes <span class="beta-pill">Beta</span>
            </div>
            <div class="skins-empty-card">
              <div class="skins-empty-title">Microsoft account required</div>
              <div class="skins-empty-body">
                Mojang only allows skin and cape changes on Microsoft accounts.
                Sign in with Microsoft from the Account screen to use this feature.
              </div>
            </div>
          </div>
        }
      >
        {/* Hidden file picker driven by the Upload button. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png"
          style="display:none"
          onChange={handleFileSelected}
        />

        <div
          class={`skins-hero ${idle() ? "idle" : ""}`}
          ref={heroEl}
          onMouseMove={wakeChrome}
        >
          {/* Top floating toolbar — variant + actions + elytra. */}
          <div class="skins-floating skins-toolbar-floating">
            <div class="skins-toolbar-group">
              <button
                class={`skins-toolbar-btn ${variant() === "CLASSIC" ? "active" : ""}`}
                disabled={busy() !== null}
                onClick={() => handleVariantSwitch("CLASSIC")}
                title="Classic — 4px arms"
              >
                Classic
              </button>
              <button
                class={`skins-toolbar-btn ${variant() === "SLIM" ? "active" : ""}`}
                disabled={busy() !== null}
                onClick={() => handleVariantSwitch("SLIM")}
                title="Slim — 3px arms"
              >
                Slim
              </button>
            </div>

            <div class="skins-toolbar-divider" />

            <button
              class={`skins-toolbar-btn ${showElytra() ? "active" : ""}`}
              onClick={() => setShowElytra(!showElytra())}
              title={showElytra() ? "Show as cape" : "Show as elytra"}
            >
              {showElytra() ? "Elytra" : "Cape"}
            </button>

            <div class="skins-toolbar-divider" />

            <button
              class="skins-toolbar-btn skins-toolbar-btn--primary"
              onClick={handleUpload}
              disabled={busy() !== null}
            >
              <IconUpload />
              <span>{busy() === "upload" ? "Uploading…" : "Upload"}</span>
            </button>
            <button
              class="skins-toolbar-btn"
              onClick={handleReset}
              disabled={busy() !== null}
              title="Reset to Mojang default"
            >
              <IconReload />
            </button>
            <button
              class="skins-toolbar-btn"
              onClick={handleRefresh}
              disabled={busy() !== null}
              title="Refresh from Mojang"
            >
              Refresh
            </button>
          </div>

          {/* Beta flag — Mojang's profile API isn't a stable public contract,
              so we flag the feature to set expectations. Floats in the hero's
              top-left and fades out with the rest of the chrome when idle. */}
          <div class="skins-floating skins-beta-floating">
            <span class="beta-pill">Beta</span>
          </div>

          {/* Flex row: left dock | model stage | right dock. Layout flow,
              not absolute positioning, so docks sit immediately next to the
              canvas regardless of window size. */}
          <div class="skins-hero-row">
            {/* Left side dock — saved skins library. */}
            <div class="skins-fade-on-idle skins-dock-side">
              <Show
                when={(localSkins() ?? []).length > 0}
                fallback={
                  <div class="skins-dock-empty">
                    Skins you upload save here.
                  </div>
                }
              >
                <For each={localSkins()}>
                  {(skin) => {
                    const isActive = () => {
                      const p = profile();
                      const a = p?.skins.find((s) => s.state === "ACTIVE") ?? p?.skins[0];
                      return a?.texture === skin.texture;
                    };
                    return (
                      <div
                        class={`skins-lib-chip ${isActive() ? "active" : ""}`}
                        title={`${skin.name} — ${skin.variant === "SLIM" ? "Slim" : "Classic"}`}
                      >
                        <button
                          class="skins-lib-chip-equip"
                          onClick={() => handleEquipLocal(skin)}
                          disabled={busy() !== null}
                        >
                          <SkinAvatar
                            texture={skin.texture}
                            variant={skin.variant as "CLASSIC" | "SLIM" | "Unknown"}
                            size={64}
                          />
                        </button>
                        <button
                          class="skins-lib-chip-remove"
                          onClick={() => handleRemoveLocal(skin)}
                          disabled={busy() !== null}
                          title="Remove from library"
                        >
                          <IconTrash2 />
                        </button>
                      </div>
                    );
                  }}
                </For>
              </Show>
            </div>

            {/* Model stage — flex middle, holds the canvas. */}
            <div class="skins-stage" ref={stageEl}>
              <canvas
                ref={viewerCanvas}
                class={`skins-hero-canvas ${canvasFading() ? "fading" : ""}`}
              />
            </div>

            {/* Right side dock — capes (Mojang + local custom). */}
            <div class="skins-fade-on-idle skins-dock-side">
              {/* No cape */}
              <button
                class={`skins-cape-chip ${
                  !activeCustomCapeId() && !profile()?.capes.some((c) => c.state === "ACTIVE")
                    ? "active"
                    : ""
                }`}
                onClick={() => handleEquipCape(null)}
                disabled={busy() !== null}
                title="No cape"
              >
                <span class="skins-cape-empty-glyph">×</span>
              </button>

              {/* Mojang-granted capes */}
              <For each={profile()?.capes ?? []}>
                {(cape) => (
                  <button
                    class={`skins-cape-chip ${
                      !activeCustomCapeId() && cape.state === "ACTIVE" ? "active" : ""
                    }`}
                    onClick={() => handleEquipCape(cape.id)}
                    disabled={busy() !== null}
                    title={cape.alias}
                  >
                    <div
                      class="skins-cape-chip-thumb"
                      style={{ "background-image": `url(${cape.texture})` }}
                    />
                  </button>
                )}
              </For>

              {/* Local custom capes */}
              <For each={customCapes() ?? []}>
                {(cape) => (
                  <div
                    class={`skins-cape-chip skins-cape-chip--custom ${
                      activeCustomCapeId() === cape.id ? "active" : ""
                    }`}
                    title={cape.name}
                  >
                    <button
                      class="skins-cape-chip-equip"
                      onClick={() => handleEquipCustomCape(cape.id)}
                      disabled={busy() !== null || ingameBusy()}
                    >
                      <div
                        class="skins-cape-chip-thumb"
                        style={{ "background-image": `url(${cape.texture})` }}
                      />
                    </button>
                    <button
                      class="skins-cape-chip-edit"
                      onClick={() => openEditCape(cape)}
                      disabled={busy() !== null}
                      title="Edit cape"
                    >
                      <IconEdit />
                    </button>
                    <button
                      class="skins-cape-chip-remove"
                      onClick={() => handleRemoveCustomCape(cape.id)}
                      disabled={busy() !== null}
                      title="Remove cape"
                    >
                      <IconTrash2 />
                    </button>
                  </div>
                )}
              </For>

              {/* Create a new custom cape */}
              <button
                class="skins-cape-chip skins-cape-add"
                onClick={openNewCape}
                disabled={busy() !== null}
                title="Create custom cape"
              >
                <IconPlus />
              </button>
            </div>
          </div>
        </div>

        <Show when={showCapeEditor()}>
          <CustomCapeEditor
            editing={editingCape()}
            skinTexture={activeSkinTexture()}
            onClose={() => setShowCapeEditor(false)}
            onSaved={handleCapeSaved}
          />
        </Show>
      </Show>
    </div>
  );
};

export default Skins;
