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
  PlayerProfile,
  LocalSkin,
  SkinVariant,
} from "../ipc/commands";
import { SkinViewer, WalkingAnimation, FlyingAnimation } from "skinview3d";
import { IconUpload, IconReload, IconTrash2 } from "../components/Icons";

/**
 * Skin & cape changer.
 *
 * Microsoft accounts only — offline accounts hit the disabled state since
 * Mojang has no concept of their UUID and any upload would 401.
 *
 * Texture pipeline: every skin / cape texture arrives from the backend as
 * a base64 `data:image/png;` URL. The webview
 * never makes a request to `textures.minecraft.net`, so there are no CORS
 * or http/https scheme issues to worry about — we drop the data URL straight
 * into `<img>`, skinview3d, and CSS `background-image` URLs.
 *
 * Layout (left → right):
 *   • 3D preview (skinview3d, walking animation, drag to rotate)
 *   • Variant toggle (Classic / Slim) + Upload / Reset / Refresh actions
 *   • Local skin library (grid of saved skins, click to re-equip)
 *   • Cape carousel (fetched from the live profile, click to equip)
 */
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

  const [variant, setVariant] = createSignal<SkinVariant>("CLASSIC");
  const [busy, setBusy] = createSignal<string | null>(null);

  // Cooldown timestamp for cape changes — Mojang rate-limits us with HTTP
  // 429 if we hammer the `/capes/active` endpoint too fast (e.g. user
  // spam-clicking cape cards). A 1.5 s cooldown after each successful
  // change keeps us under the limit while still feeling responsive for
  // intentional changes.
  const [capeCooldownUntil, setCapeCooldownUntil] = createSignal(0);
  const isCapeOnCooldown = () => Date.now() < capeCooldownUntil();
  const [showElytra, setShowElytra] = createSignal(false);

  // Hidden file input the Upload button drives. Cleaner than wiring up a
  // separate Tauri fs plugin + capability just to read a single PNG; the
  // browser hands us the bytes via `File.arrayBuffer()` for free.
  let fileInputRef: HTMLInputElement | undefined;

  // ─── Skin viewer wiring ───
  let viewerCanvas: HTMLCanvasElement | undefined;
  let viewer: SkinViewer | undefined;

  onMount(() => {
    if (!viewerCanvas) return;
    viewer = new SkinViewer({
      canvas: viewerCanvas,
      width: 280,
      height: 360,
      skin: undefined,
    });
    viewer.animation = new WalkingAnimation();
    // Keep zoom locked — the canvas is small enough that wheel-scroll is more
    // annoying than useful.
    viewer.controls.enableZoom = false;
  });

  onCleanup(() => {
    viewer?.dispose();
    viewer = undefined;
  });

  // Whenever the profile changes, push the active skin + cape into the
  // 3D viewer. Textures arrive as data URLs already, so skinview3d takes
  // them directly with no extra work.
  createEffect(() => {
    const p = profile();
    if (!viewer || !p) return;

    const active = p.skins.find((s) => s.state === "ACTIVE") ?? p.skins[0];
    if (active) {
      setVariant(active.variant);
      try {
        viewer.loadSkin(active.texture, {
          model: active.variant === "SLIM" ? "slim" : "default",
        });
      } catch (e) {
        console.error("Skin load failed:", e);
      }
    }

    const activeCape = p.capes.find((c) => c.state === "ACTIVE");
    if (activeCape) {
      try {
        viewer.loadCape(activeCape.texture, {
          backEquipment: showElytra() ? "elytra" : "cape",
        });
      } catch (e) {
        console.error("Cape load failed:", e);
      }
    } else {
      viewer.resetCape();
    }
  });

  // Re-render cape as elytra or cape when the toggle changes.
  // Also switch animation: elytra uses FlyingAnimation so the wings spread
  // and move; cape uses WalkingAnimation for the natural sway.
  // Uses a short speed ramp to smooth the transition between animations.
  createEffect(() => {
    const elytra = showElytra();
    const p = profile();
    if (!viewer || !p) return;
    const activeCape = p.capes.find((c) => c.state === "ACTIVE");
    if (activeCape) {
      try {
        viewer.loadCape(activeCape.texture, {
          backEquipment: elytra ? "elytra" : "cape",
        });
      } catch (e) {
        console.error("Elytra toggle failed:", e);
      }
    }

    // Smoothly transition between animations by ramping speed down, switching,
    // then ramping back up over ~300ms.
    const newAnim = elytra ? new FlyingAnimation() : new WalkingAnimation();
    if (viewer.animation) {
      viewer.animation.speed = 0;
    }
    viewer.animation = newAnim;
    newAnim.speed = 0;

    const duration = 300;
    const start = performance.now();
    const ramp = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      // Ease-out curve for a natural feel
      newAnim.speed = t * t * (3 - 2 * t);
      if (t < 1) requestAnimationFrame(ramp);
    };
    requestAnimationFrame(ramp);
  });

  // Re-load the skin when the user manually switches variant (Classic ↔ Slim).
  // The profile-change effect only fires on Mojang profile updates; this one
  // handles the local toggle so the 3D model updates immediately.
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

  const handleUpload = async () => {
    fileInputRef?.click();
  };

  const handleFileSelected = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // Reset the input so the same filename can be re-picked later.
    input.value = "";
    if (!file) return;

    setBusy("upload");
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const name = file.name.replace(/\.png$/i, "") || "Custom skin";
      await uploadSkin(Array.from(bytes), variant(), true, name);
      await refetchLocal();
      await refetchProfile();
      await refreshActiveSkin();
      showToast({
        title: "Skin equipped",
        message: `${name} (${variant() === "SLIM" ? "Slim" : "Classic"})`,
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

  /** Switch the active skin's variant on Mojang. Re-uploads the same skin
   *  texture with the new variant so it takes effect in-game immediately. */
  const handleVariantSwitch = async (newVariant: SkinVariant) => {
    if (newVariant === variant()) return;
    const p = profile();
    if (!p) return;
    const active = p.skins.find((s) => s.state === "ACTIVE") ?? p.skins[0];
    if (!active) return;

    setVariant(newVariant);
    setBusy("variant");
    try {
      // Decode the data URL back to raw bytes for re-upload
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
      // Revert the local signal on failure
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
    // Reject rapid-fire clicks. Without this Mojang's `/capes/active`
    // endpoint quickly rate-limits us with HTTP 429, which then propagates
    // up as a confusing "Couldn't load profile" toast to the user.
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
      // Block further cape changes for 1.5s — covers the worst-case Mojang
      // rate-limit window without feeling sluggish.
      setCapeCooldownUntil(Date.now() + 3000);
    } catch (e) {
      showToast({ title: "Cape change failed", message: String(e), type: "error" });
    } finally {
      setBusy(null);
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
        <div class="section-label">
          Skins & capes <span class="beta-pill">Beta</span>
        </div>

        {/* Hidden file picker driven by the Upload button. Stays mounted so
            the ref is stable, never visually rendered. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png"
          style="display:none"
          onChange={handleFileSelected}
        />

        <div class="skins-layout">
          {/* Left column: 3D preview + actions */}
          <div class="skins-preview-col">
            <div class="skins-canvas-wrap">
              <canvas ref={viewerCanvas} class="skins-canvas" />
              <button
                class={`skins-elytra-toggle ${showElytra() ? "active" : ""}`}
                onClick={() => setShowElytra(!showElytra())}
                title={showElytra() ? "Show as cape" : "Show as elytra"}
              >
                {showElytra() ? "Cape" : "Elytra"}
              </button>
            </div>

            <div class="skins-variant-row">
              <div class="field-label">Model variant</div>
              <div class="choice-row">
                <button
                  class={`choice-btn ${variant() === "CLASSIC" ? "selected" : ""}`}
                  disabled={busy() !== null}
                  onClick={() => handleVariantSwitch("CLASSIC")}
                >
                  Classic (4px arms)
                </button>
                <button
                  class={`choice-btn ${variant() === "SLIM" ? "selected" : ""}`}
                  disabled={busy() !== null}
                  onClick={() => handleVariantSwitch("SLIM")}
                >
                  Slim (3px arms)
                </button>
              </div>
            </div>

            <div class="skins-actions">
              <button class="btn btn-accent" onClick={handleUpload} disabled={busy() !== null}>
                <IconUpload />
                {busy() === "upload" ? "Uploading..." : "Upload skin"}
              </button>
              <button class="btn" onClick={handleReset} disabled={busy() !== null}>
                <IconReload />
                {busy() === "reset" ? "Resetting..." : "Reset to default"}
              </button>
              <button class="btn btn-ghost" onClick={handleRefresh} disabled={busy() !== null}>
                Refresh
              </button>
            </div>
          </div>

          {/* Right column: library + capes */}
          <div class="skins-side-col">
            <div class="section-label">Saved skins</div>
            <Show
              when={(localSkins() ?? []).length > 0}
              fallback={
                <div class="skins-empty-row">
                  Skins you upload are saved here so you can switch back without re-uploading.
                </div>
              }
            >
              <div class="skins-library">
                <For each={localSkins()}>
                  {(skin) => (
                    <div class="skins-library-item">
                      <div class="skins-library-thumb-wrap">
                        <img
                          class="skins-library-thumb"
                          src={skin.texture}
                          alt={skin.name}
                          loading="lazy"
                        />
                      </div>
                      <div class="skins-library-info">
                        <div class="skins-library-name" title={skin.name}>{skin.name}</div>
                        <div class="skins-library-variant">{skin.variant === "SLIM" ? "Slim" : "Classic"}</div>
                      </div>
                      <div class="skins-library-actions">
                        <button
                          class="btn btn-accent"
                          onClick={() => handleEquipLocal(skin)}
                          disabled={busy() !== null}
                        >
                          {busy() === `equip-${skin.hash}` ? "..." : "Equip"}
                        </button>
                        <button
                          class="btn btn-ghost skins-library-remove"
                          onClick={() => handleRemoveLocal(skin)}
                          disabled={busy() !== null}
                          title="Remove from library"
                        >
                          <IconTrash2 />
                        </button>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <div class="section-label" style="margin-top:18px">Capes</div>
            <Show
              when={(profile()?.capes ?? []).length > 0}
              fallback={
                <div class="skins-empty-row">
                  Capes you've earned (Migrator, Birthday, etc.) appear here.
                </div>
              }
            >
              <div class="skins-cape-grid">
                {/* "No cape" slot */}
                <button
                  class={`skins-cape-card ${
                    !profile()?.capes.some((c) => c.state === "ACTIVE") ? "active" : ""
                  }`}
                  onClick={() => handleEquipCape(null)}
                  disabled={busy() !== null}
                >
                  <div class="skins-cape-thumb skins-cape-empty">No cape</div>
                  <div class="skins-cape-name">No cape</div>
                </button>
                <For each={profile()?.capes ?? []}>
                  {(cape) => (
                    <button
                      class={`skins-cape-card ${cape.state === "ACTIVE" ? "active" : ""}`}
                      onClick={() => handleEquipCape(cape.id)}
                      disabled={busy() !== null}
                    >
                      <div
                        class="skins-cape-thumb"
                        style={{ "background-image": `url(${cape.texture})` }}
                      />
                      <div class="skins-cape-name" title={cape.alias}>{cape.alias}</div>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default Skins;
