import { Component, createSignal, onMount, onCleanup, Show } from "solid-js";
import { SkinViewer } from "skinview3d";
import { saveCustomCape, readCustomCapeSource, CustomCape, CapeTransform } from "../ipc/commands";
import { showToast } from "../App";
import Dropdown from "../components/Dropdown";
import { IconImage, IconX } from "../components/Icons";

/**
 * Custom cape editor — a local, display-only cape designer.
 *
 * The user uploads a static image and positions/scales it onto the cape's
 * visible back panel. The result is baked into a standard 64×32 Minecraft
 * cape texture and stored in the per-account cape library; it's never sent to
 * Mojang (their API rejects arbitrary cape textures), so this lives purely in
 * our 3D viewer.
 *
 * ## Geometry
 *
 * skinview3d's `CapeObject` maps the cape box from a 64×32 atlas, and the
 * `PlayerObject` attaches it with `rotation.y = Math.PI`. After that flip, the
 * face an observer sees when looking at the player's back is the box's local
 * +z ("front") face, which `setCapeUVs(0,0,10,16,1)` places at texture rect
 * `(1, 1)` size `10×16` — the same rect Minecraft itself uses for the visible
 * cape art. That rect — `PANEL` below — is where the uploaded image lands.
 * The rest of the cape footprint (`0,0 → 22,17`) is filled with a solid
 * background colour so no cape face renders transparent.
 *
 * ## Transform
 *
 * Position/scale are tracked in panel-texel space (the panel is 10×16), so the
 * 2D workspace and the baked texture use identical maths — the workspace just
 * multiplies everything by `DISP` for display. `dw/dh` come from a contain-fit
 * baseline (`baseDw/baseDh`, derived from the image aspect) times `scale`.
 */

// Visible cape face in the 64×32 atlas — the panel the observer sees once the
// cape mesh's `rotation.y = Math.PI` is applied (its local +z "front" face).
const PANEL = { x: 1, y: 1, w: 10, h: 16 };
// Whole cape footprint in the atlas; filled with the background colour so the
// sides / top / bottom / inner faces never render transparent.
const FOOTPRINT = { x: 0, y: 0, w: 22, h: 17 };
// Display magnification for the 2D workspace (10×16 panel → 220×352 px).
const DISP = 22;
// Bake-resolution choices: multiplier of the 64×32 atlas → baked texture size.
// 1× is the classic pixelated cape; 32× (2048×1024) is the sharpest the
// backend accepts. skinview3d renders whatever resolution we hand it.
const RES_OPTIONS = [
  { value: "1", label: "Standard — 64×32" },
  { value: "2", label: "128×64" },
  { value: "4", label: "256×128" },
  { value: "8", label: "512×256" },
  { value: "16", label: "HD — 1024×512" },
  { value: "32", label: "Max HD — 2048×1024" },
];
const DEFAULT_RES = 16;
const DEFAULT_BG = "#2b2740";
const ALLOWED_RES = [1, 2, 4, 8, 16, 32];

/** Clamp a resolution to the supported set. Guards the re-edit path against a
 *  tampered or stale `capes.json` carrying a wild value that would size the
 *  bake canvas to 64·res and blow up memory. */
function clampRes(r: number | undefined): number {
  return r !== undefined && ALLOWED_RES.includes(r) ? r : DEFAULT_RES;
}

interface Props {
  /** Existing cape to re-edit, or null/undefined to create a new one. */
  editing?: CustomCape | null;
  /** Active skin texture (data URL) so the 3D preview shows the user's body. */
  skinTexture?: string;
  onClose: () => void;
  onSaved: (cape: CustomCape) => void;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.split(",")[1] ?? "";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/**
 * Average colour of an image, as a `#rrggbb` hex string. Downscales to a
 * small canvas and means the (non-transparent) pixels — cheap and gives a
 * representative tone derived from the image itself, so the cape background
 * blends with the art instead of clashing with a fixed colour.
 */
function computeAverageColor(img: HTMLImageElement, fallback: string): string {
  const n = 32;
  const c = document.createElement("canvas");
  c.width = n;
  c.height = n;
  const ctx = c.getContext("2d");
  if (!ctx) return fallback;
  ctx.drawImage(img, 0, 0, n, n);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, n, n).data;
  } catch {
    return fallback; // tainted canvas (shouldn't happen for same-origin data URLs)
  }
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 16) continue; // skip near-transparent pixels
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count++;
  }
  if (count === 0) return fallback;
  const hex = (v: number) => Math.round(v / count).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

const CustomCapeEditor: Component<Props> = (props) => {
  const [name, setName] = createSignal(props.editing?.name ?? "Custom Cape");
  const [bg, setBg] = createSignal<string>(props.editing?.transform.bg ?? DEFAULT_BG);
  const [scale, setScale] = createSignal<number>(props.editing?.transform.scale ?? 1);
  const [res, setRes] = createSignal<number>(clampRes(props.editing?.transform.res));
  const [hasImage, setHasImage] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

  // Image position offset within the panel, in panel-texel units.
  let dx = props.editing?.transform.dx ?? 0;
  let dy = props.editing?.transform.dy ?? 0;
  // Contain-fit baseline draw size (recomputed whenever an image loads).
  let baseDw = PANEL.w;
  let baseDh = PANEL.h;

  let sourceImg: HTMLImageElement | null = null;
  let sourceBytes: Uint8Array | null = null;
  let sourceMime = "image/png";

  let workspaceCanvas: HTMLCanvasElement | undefined;
  let previewCanvas: HTMLCanvasElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  let viewer: SkinViewer | undefined;
  // Reused offscreen canvas for the HD bake — avoids allocating one per drag
  // frame. Passed straight to loadCape (a canvas is a TextureSource, so the
  // load is synchronous with no per-frame PNG encode/decode).
  let bakeCanvas: HTMLCanvasElement | undefined;

  // ─── Compositing ───

  /** Recompute the contain-fit baseline + centred offset for the loaded image. */
  const fitImage = () => {
    if (!sourceImg) return;
    const ar = sourceImg.naturalWidth / sourceImg.naturalHeight;
    const panelAr = PANEL.w / PANEL.h;
    if (ar > panelAr) {
      baseDw = PANEL.w;
      baseDh = PANEL.w / ar;
    } else {
      baseDh = PANEL.h;
      baseDw = PANEL.h * ar;
    }
  };

  /**
   * Bake the full cape texture into the reused offscreen canvas at the chosen
   * resolution (64·res × 32·res). Coordinates stay in texel units
   * (PANEL/FOOTPRINT) and are multiplied by the resolution here, so the
   * transform maths and the 2D workspace (which uses DISP) stay identical.
   * Returns the canvas, or null when no image is loaded yet.
   */
  const bakeCapeCanvas = (): HTMLCanvasElement | null => {
    if (!sourceImg) return null;
    const S = res();
    const c = bakeCanvas ?? (bakeCanvas = document.createElement("canvas"));
    c.width = 64 * S;
    c.height = 32 * S;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    // Smooth downscale so photos don't look blocky at the cape's texel grid.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, c.width, c.height);
    // Solid background across the whole cape footprint — no transparent edges.
    ctx.fillStyle = bg();
    ctx.fillRect(FOOTPRINT.x * S, FOOTPRINT.y * S, FOOTPRINT.w * S, FOOTPRINT.h * S);
    // Positioned image, clipped to the visible back panel.
    ctx.save();
    ctx.beginPath();
    ctx.rect(PANEL.x * S, PANEL.y * S, PANEL.w * S, PANEL.h * S);
    ctx.clip();
    const dw = baseDw * scale() * S;
    const dh = baseDh * scale() * S;
    ctx.drawImage(sourceImg, (PANEL.x + dx) * S, (PANEL.y + dy) * S, dw, dh);
    ctx.restore();

    // The thin surrounding faces (left/right sides, top, bottom) and the inner
    // face keep the solid background fill applied above. It's sampled from the
    // image's average colour, so it reads as a matching border. We deliberately
    // don't paint the image's edge pixels onto them: those faces are only one
    // texel deep, so stretching an edge strip across a face smeared into a
    // visibly distorted band at viewing angles.
    return c;
  };

  /** Push the freshly-baked cape into the 3D preview. Passing the canvas
   *  (not a data URL) keeps loadCape synchronous, so dragging stays smooth.
   *  Rendered with skinview3d's default nearest filtering so each cape texel
   *  is a crisp block — the chosen resolution then directly controls how
   *  pixelated the cape looks, matching how the game draws cape textures. */
  const updatePreview = () => {
    if (!viewer) return;
    const cv = bakeCapeCanvas();
    if (!cv) {
      viewer.resetCape();
      return;
    }
    try {
      viewer.loadCape(cv, { backEquipment: "cape" });
    } catch (e) {
      console.error("Cape preview failed:", e);
    }
  };
  const redrawWorkspace = () => {
    const cv = workspaceCanvas;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const W = PANEL.w * DISP;
    const H = PANEL.h * DISP;

    ctx.clearRect(0, 0, W, H);
    // Background fill (matches what the cape will show behind the image).
    ctx.fillStyle = bg();
    ctx.fillRect(0, 0, W, H);

    // Positioned image, clipped to the panel bounds.
    if (sourceImg) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.clip();
      const dw = baseDw * scale() * DISP;
      const dh = baseDh * scale() * DISP;
      ctx.drawImage(sourceImg, dx * DISP, dy * DISP, dw, dh);
      ctx.restore();
    }

    // Blender-style guide grid — one line per texel.
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= PANEL.w; gx++) {
      ctx.beginPath();
      ctx.moveTo(gx * DISP + 0.5, 0);
      ctx.lineTo(gx * DISP + 0.5, H);
      ctx.stroke();
    }
    for (let gy = 0; gy <= PANEL.h; gy++) {
      ctx.beginPath();
      ctx.moveTo(0, gy * DISP + 0.5);
      ctx.lineTo(W, gy * DISP + 0.5);
      ctx.stroke();
    }
  };

  const refresh = () => {
    redrawWorkspace(); // cheap (220×352) — keep immediate so dragging feels live
    schedulePreview(); // expensive (HD bake + GPU upload) — coalesce to one/frame
  };

  // The 3D preview re-bakes an HD texture and re-uploads it to the GPU, which
  // is too heavy to run on every pointermove/slider tick (a 32× cape is a
  // 2048×1024 texture). Coalesce updates to at most one per animation frame.
  let previewRaf = 0;
  const schedulePreview = () => {
    if (previewRaf) return;
    previewRaf = requestAnimationFrame(() => {
      previewRaf = 0;
      updatePreview();
    });
  };

  // ─── Upload ───

  const handleUploadClick = () => fileInput?.click();

  const loadImageFromDataUrl = (dataUrl: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        sourceImg = img;
        fitImage();
        resolve();
      };
      img.onerror = () => reject(new Error("Image decode failed"));
      img.src = dataUrl;
    });

  const handleFileSelected = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      sourceBytes = new Uint8Array(buf);
      sourceMime = file.type || "image/png";
      const reader = new FileReader();
      const dataUrl: string = await new Promise((res, rej) => {
        reader.onload = () => res(reader.result as string);
        reader.onerror = () => rej(new Error("File read failed"));
        reader.readAsDataURL(file);
      });
      await loadImageFromDataUrl(dataUrl);
      // Reset position/scale to a centred fit for the new image.
      dx = (PANEL.w - baseDw) / 2;
      dy = (PANEL.h - baseDh) / 2;
      setScale(1);
      // Auto-match the background to the image so the cape's surrounding
      // faces blend with the art rather than showing a clashing fixed colour.
      if (sourceImg) setBg(computeAverageColor(sourceImg, DEFAULT_BG));
      setHasImage(true);
      if (!name().trim() || name() === "Custom Cape") {
        const stem = file.name.replace(/\.[^.]+$/, "");
        if (stem) setName(stem);
      }
      refresh();
    } catch (err) {
      showToast({ title: "Couldn't load image", message: String(err), type: "error" });
    }
  };

  // ─── Drag to position ───

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    dx += (e.clientX - lastX) / DISP;
    dy += (e.clientY - lastY) / DISP;
    lastX = e.clientX;
    lastY = e.clientY;
    refresh();
  };

  const onPointerUp = () => {
    dragging = false;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  };

  const onWorkspacePointerDown = (e: PointerEvent) => {
    if (!sourceImg) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const handleScale = (v: number) => {
    setScale(v);
    refresh();
  };

  const handleBg = (v: string) => {
    setBg(v);
    refresh();
  };

  const handleRes = (v: string) => {
    const n = parseInt(v, 10);
    if (!Number.isNaN(n)) {
      setRes(n);
      refresh();
    }
  };

  const handleCenter = () => {
    if (!sourceImg) return;
    dx = (PANEL.w - baseDw * scale()) / 2;
    dy = (PANEL.h - baseDh * scale()) / 2;
    refresh();
  };

  // ─── Save ───

  const handleSave = async () => {
    if (!sourceImg || !sourceBytes) {
      showToast({ title: "Add an image first", type: "info" });
      return;
    }
    const cv = bakeCapeCanvas();
    if (!cv) {
      showToast({ title: "Couldn't render cape", type: "error" });
      return;
    }
    const baked = cv.toDataURL("image/png");
    setSaving(true);
    try {
      const transform: CapeTransform = { dx, dy, scale: scale(), bg: bg(), res: res() };
      const cape = await saveCustomCape(
        props.editing?.id ?? null,
        name().trim() || "Custom Cape",
        Array.from(dataUrlToBytes(baked)),
        Array.from(sourceBytes),
        sourceMime,
        transform,
      );
      showToast({ title: "Cape saved", message: cape.name, type: "success" });
      props.onSaved(cape);
      props.onClose();
    } catch (e) {
      showToast({ title: "Save failed", message: String(e), type: "error" });
    } finally {
      setSaving(false);
    }
  };

  // ─── Lifecycle ───

  onMount(async () => {
    if (previewCanvas) {
      viewer = new SkinViewer({ canvas: previewCanvas, width: 240, height: 352 });
      viewer.controls.enableZoom = false;
      viewer.zoom = 0.78;
      // Rotate the body so the cape's outer face points at the camera.
      viewer.playerObject.rotation.y = Math.PI;
      if (props.skinTexture) {
        try {
          viewer.loadSkin(props.skinTexture);
        } catch (e) {
          console.error("Preview skin load failed:", e);
        }
      }
    }

    // Re-editing: pull the stored source image on demand (it isn't inlined in
    // the cape list) and reapply the saved transform.
    if (props.editing) {
      try {
        const sourceUrl = await readCustomCapeSource(props.editing.id);
        await loadImageFromDataUrl(sourceUrl);
        // fitImage() recomputed baseDw/baseDh; the stored dx/dy/scale are in
        // the same panel-texel space so they reapply directly.
        sourceBytes = dataUrlToBytes(sourceUrl);
        sourceMime = sourceUrl.slice(5, sourceUrl.indexOf(";"));
        setHasImage(true);
      } catch (e) {
        console.error("Failed to load cape for editing:", e);
        showToast({ title: "Couldn't load cape for editing", message: String(e), type: "error" });
      }
    }
    refresh();
  });

  onCleanup(() => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    if (previewRaf) cancelAnimationFrame(previewRaf);
    viewer?.dispose();
    viewer = undefined;
  });

  return (
    <div class="modal-overlay">
      <div class="modal panel panel--bracketed cape-editor" style="width:640px">
        <div class="modal-header">
          <span class="modal-title">{props.editing ? "Edit custom cape" : "New custom cape"}</span>
          <button class="modal-close" onClick={props.onClose}><IconX /></button>
        </div>

        <div class="modal-body cape-editor-body">
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
            style="display:none"
            onChange={handleFileSelected}
          />

          <div class="cape-editor-stage">
            {/* 2D positioning workspace */}
            <div class="cape-editor-workspace">
              <div class="cape-editor-panel-label">Back panel</div>
              <canvas
                ref={workspaceCanvas}
                class="cape-workspace-canvas"
                width={PANEL.w * DISP}
                height={PANEL.h * DISP}
                onPointerDown={onWorkspacePointerDown}
                style={{ cursor: hasImage() ? "move" : "default" }}
              />
              <Show when={!hasImage()}>
                <button class="cape-workspace-empty" onClick={handleUploadClick}>
                  <IconImage />
                  <span>Upload an image</span>
                </button>
              </Show>
            </div>

            {/* Live 3D preview */}
            <div class="cape-editor-preview">
              <div class="cape-editor-panel-label">Preview</div>
              <canvas ref={previewCanvas} class="cape-preview-canvas" />
            </div>
          </div>

          {/* Controls */}
          <div class="cape-editor-controls">
            <label class="cape-control">
              <span class="cape-control-label">Name</span>
              <input
                class="field-control field-control--text"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                placeholder="Custom Cape"
              />
            </label>

            <label class="cape-control">
              <span class="cape-control-label">Scale</span>
              <input
                type="range"
                min="0.2"
                max="4"
                step="0.01"
                value={scale()}
                disabled={!hasImage()}
                onInput={(e) => handleScale(parseFloat(e.currentTarget.value))}
              />
            </label>

            <label class="cape-control cape-control--bg">
              <span class="cape-control-label">Background</span>
              <input
                type="color"
                value={bg()}
                onInput={(e) => handleBg(e.currentTarget.value)}
              />
            </label>

            <div class="cape-control">
              <span class="cape-control-label">Resolution</span>
              <Dropdown
                value={String(res())}
                options={RES_OPTIONS}
                onChange={handleRes}
                width="150px"
                openUp
              />
            </div>

            <div class="cape-editor-control-btns">
              <button class="btn" onClick={handleUploadClick}>
                <IconImage />
                <span>{hasImage() ? "Replace" : "Upload"}</span>
              </button>
              <button class="btn" onClick={handleCenter} disabled={!hasImage()}>
                Center
              </button>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn btn--ghost" onClick={props.onClose}>Cancel</button>
          <button
            class="install-btn"
            onClick={handleSave}
            disabled={!hasImage() || saving()}
          >
            {saving() ? "Saving…" : "Save cape"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CustomCapeEditor;
