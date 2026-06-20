/**
 * Shared custom-cape compositing + animation, used by both the cape editor's
 * preview and the Skins screen's live display so the two surfaces always bake
 * identically.
 *
 * ## Geometry
 *
 * skinview3d maps the cape box from a 64×32 atlas and attaches it with
 * `rotation.y = Math.PI`, so the face an observer sees is the box's +z
 * "front" face at texture rect `(1,1)` size `10×16` — `PANEL`. The image is
 * drawn there and also onto the thin side/top/bottom faces that sit adjacent
 * to it in the atlas, so a scaled-up image's overflow wraps onto those faces
 * as its continuation rather than a duplicate. The inner/back face is left as
 * solid background. The whole footprint (`0,0 → 22,17`) is filled with the
 * background colour first so no face renders transparent.
 *
 * ## Animation (cross-platform note)
 *
 * Animated formats (GIF / APNG / animated WebP) are driven by a hidden, DOM-
 * attached `<img>` element — the browser animates it natively and we sample
 * the current frame onto the cape canvas each tick. This deliberately avoids
 * the WebCodecs `ImageDecoder` API, which is reliable on WebView2 (Windows)
 * but historically absent on WebKitGTK (Linux). Native `<img>` animation +
 * `drawImage` works on both. If a future WebKitGTK release fails to advance
 * a detached/offscreen `<img>`, the fallback is a static first frame — see
 * `loadDisplayImage` (the element is attached and on-viewport to keep it
 * animating).
 */

export const PANEL = { x: 1, y: 1, w: 10, h: 16 };
export const FOOTPRINT = { x: 0, y: 0, w: 22, h: 17 };

/** Supported bake-resolution multipliers of the 64×32 atlas. */
export const ALLOWED_RES = [1, 2, 4, 8, 16, 32];
export const DEFAULT_RES = 16;

/** Max bake resolution for ANIMATED capes. A long animation decodes to a large
 *  texture (frame size × frame count), so animated capes are capped here to keep
 *  memory sane on low-RAM machines; static capes may go up to {@link ALLOWED_RES}'s
 *  max. The cape editor hides higher options for animated sources and
 *  {@link bakeModCapeStrip}'s caller clamps to this, so the preview always matches
 *  what the game gets. */
export const ANIMATED_MAX_RES = 8;

export interface CapeBakeParams {
  /** Image offset within the panel, in panel-texel units. */
  dx: number;
  dy: number;
  /** Multiplier on the contain-fit baseline size. */
  scale: number;
  /** CSS colour filling the cape behind/around the image. */
  bg: string;
  /** Bake-resolution multiplier of the 64×32 atlas. */
  res: number;
}

/** Clamp a resolution to the supported set (guards stale/tampered values that
 *  would size the bake canvas to 64·res and blow up memory). */
export function clampRes(r: number | undefined): number {
  return r !== undefined && ALLOWED_RES.includes(r) ? r : DEFAULT_RES;
}

/** Contain-fit baseline draw size (in panel texels) for an image of the given
 *  pixel dimensions. The whole image fits inside the panel, centred. */
export function computeBaseFit(imgW: number, imgH: number): { baseDw: number; baseDh: number } {
  const ar = imgW / imgH;
  const panelAr = PANEL.w / PANEL.h;
  if (ar > panelAr) return { baseDw: PANEL.w, baseDh: PANEL.w / ar };
  return { baseDw: PANEL.h * ar, baseDh: PANEL.h };
}

/**
 * Bake the full cape texture from `source` (a static image or the current
 * frame of an animated one) into `canvas`, sized to the chosen resolution.
 * `srcW`/`srcH` are the source's intrinsic dimensions (constant across an
 * animation's frames).
 */
export function bakeCape(
  canvas: HTMLCanvasElement,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  t: CapeBakeParams,
): void {
  const S = t.res;
  canvas.width = 64 * S;
  canvas.height = 32 * S;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Solid background across the whole footprint — no transparent faces.
  ctx.fillStyle = t.bg;
  ctx.fillRect(FOOTPRINT.x * S, FOOTPRINT.y * S, FOOTPRINT.w * S, FOOTPRINT.h * S);

  const { baseDw, baseDh } = computeBaseFit(srcW, srcH);
  const dw = baseDw * t.scale * S;
  const dh = baseDh * t.scale * S;
  const ix = (PANEL.x + t.dx) * S;
  const iy = (PANEL.y + t.dy) * S;

  // Front + left/right side faces (atlas x[0,12], y[1,17]) and the top face
  // (atlas x[1,11], y[0,1]) — all continuous with the front image position,
  // so overflow wraps onto the sides/top as the image's continuation.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, PANEL.y * S, (PANEL.w + 2) * S, PANEL.h * S);
  ctx.rect(PANEL.x * S, 0, PANEL.w * S, PANEL.y * S);
  ctx.clip();
  ctx.drawImage(source, ix, iy, dw, dh);
  ctx.restore();

  // Bottom face (atlas x[11,21], y[0,1]) — continuation just below the front.
  ctx.save();
  ctx.beginPath();
  ctx.rect((PANEL.x + PANEL.w) * S, 0, PANEL.w * S, PANEL.y * S);
  ctx.clip();
  ctx.drawImage(source, (PANEL.x + PANEL.w + t.dx) * S, (t.dy - PANEL.h) * S, dw, dh);
  ctx.restore();
}

// ─── In-game (companion mod) cape baking ───────────────────────────────────

/** Result of baking a cape for the companion mod. */
export interface ModCapeBake {
  /** PNG bytes: a square 64·res frame, or a vertical strip of N square frames. */
  png: Uint8Array;
  /** Per-frame duration for an animation (mod default is 100). */
  frameTimeMs: number;
  /** Frame count (1 = static). */
  frames: number;
}

function dataUrlToPngBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.split(",")[1] ?? "";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/** Max 2D-canvas edge we'll create. A tall animation strip can otherwise exceed
 *  the browser's canvas limit, which makes `toDataURL()` return an empty data
 *  URL (surfacing downstream as "isn't a valid PNG"). 16384 is safe on both
 *  WebView2 (Windows) and WebKitGTK (Linux). */
const MAX_CANVAS_DIM = 16384;

/**
 * Bake a cape for the Vermeil companion mod.
 *
 * The in-game cape model (modern Minecraft) uses a **64×64** texture, where the
 * visible art occupies the same `PANEL` rect `(1,1)` size `10×16` as the editor's
 * 64×32 atlas — just on a taller sheet whose lower half the cape never samples.
 * So we reuse {@link bakeCape} (which lays the art out on a 64×32 canvas) and drop
 * each baked frame into the **top** of a square `64·res` frame slot. Animations
 * become a vertical strip of those square frames (height = width × frames), which
 * is exactly the strip format the mod decodes. Static capes are a single frame.
 *
 * A long animation's strip can exceed the browser's max canvas height. We keep
 * the chosen resolution and evenly **subsample frames** to fit within
 * {@link MAX_CANVAS_DIM}, stretching the per-frame duration so the loop keeps
 * roughly its original wall-clock length. Resolution is the cape's visible
 * detail; frame count only affects animation smoothness — so resolution is never
 * traded away (an HD cape stays HD in game, just with fewer animation steps when
 * the source has very many frames).
 */
export function bakeModCapeStrip(src: FrameSource, t: CapeBakeParams): ModCapeBake {
  const n0 = src.frameCount;

  // Keep the chosen resolution; subsample frames to whatever fits the strip
  // height. (The old behaviour collapsed resolution first, which forced a long
  // animation — e.g. 180 frames — down to 64px frames, rendering an HD cape at
  // standard resolution in game.)
  const S = clampRes(t.res);
  const frame = 64 * S;
  const maxFrames = Math.max(1, Math.floor(MAX_CANVAS_DIM / frame));
  const n = Math.min(n0, maxFrames);

  const strip = document.createElement("canvas");
  strip.width = frame;
  strip.height = frame * n;
  const ctx = strip.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  // Per-frame 64×32 bake, reused across frames, composited into each slot's top.
  const params: CapeBakeParams = { ...t, res: S };
  const tmp = document.createElement("canvas");
  for (let i = 0; i < n; i++) {
    // Evenly sample source frames when some had to be dropped to fit.
    const srcIdx = n === n0 ? i : Math.min(n0 - 1, Math.round((i * (n0 - 1)) / Math.max(1, n - 1)));
    bakeCape(tmp, src.frameAt(srcIdx), src.width, src.height, params);
    ctx.drawImage(tmp, 0, i * frame);
  }

  // Preserve the loop's wall-clock length: dropped frames each last longer.
  const avg = src.averageDurationMs;
  const frameTimeMs = Math.max(1, Math.round(n === n0 ? avg : (avg * n0) / n));

  return {
    png: dataUrlToPngBytes(strip.toDataURL("image/png")),
    frameTimeMs,
    frames: n,
  };
}

// ─── Animation detection ─────────────────────────────────────────────────

function findAscii(b: Uint8Array, needle: string, start: number, maxScan: number): number {
  const end = Math.min(b.length - needle.length, start + maxScan);
  for (let i = start; i <= end; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (b[i + j] !== needle.charCodeAt(j)) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function skipGifSubBlocks(b: Uint8Array, p: number): number {
  while (p < b.length) {
    const size = b[p++];
    if (size === 0) break;
    p += size;
  }
  return p;
}

/** Count image-descriptor blocks in a GIF (stops early at 2). */
function gifFrameCount(b: Uint8Array): number {
  let p = 6; // "GIF87a" / "GIF89a"
  if (p + 7 > b.length) return 0;
  const packed = b[p + 4];
  p += 7;
  if (packed & 0x80) p += 3 * (2 << (packed & 0x07)); // global colour table
  let frames = 0;
  while (p < b.length) {
    const block = b[p++];
    if (block === 0x3b) break; // trailer
    if (block === 0x2c) {
      frames++;
      if (frames > 1) return frames;
      if (p + 9 > b.length) break;
      const localPacked = b[p + 8];
      p += 9;
      if (localPacked & 0x80) p += 3 * (2 << (localPacked & 0x07)); // local colour table
      p++; // LZW min code size
      p = skipGifSubBlocks(b, p);
    } else if (block === 0x21) {
      p++; // extension label
      p = skipGifSubBlocks(b, p);
    } else {
      break;
    }
  }
  return frames;
}

/** Whether image bytes are animated: multi-frame GIF, APNG, or animated WebP. */
export function detectAnimated(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  // PNG / APNG — animated iff an 'acTL' chunk exists.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return findAscii(bytes, "acTL", 8, 8192) >= 0;
  }
  // GIF — animated iff more than one image descriptor.
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return gifFrameCount(bytes) > 1;
  }
  // WebP — animated iff an 'ANIM' chunk exists.
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
  ) {
    return findAscii(bytes, "ANIM", 12, 64) >= 0;
  }
  return false;
}

// ─── Frame source (static or animated) ─────────────────────────────────────

function parseDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const comma = dataUrl.indexOf(",");
  const mime = dataUrl.slice(5, comma).split(";")[0] || "application/octet-stream";
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime };
}

/** Load a plain still image (no DOM attachment needed — it's only drawn to a
 *  canvas, never displayed). */
function loadStillImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image load failed"));
    img.src = dataUrl;
  });
}

/** Cap on decoded frames held in memory (bounds a pathological GIF). */
const MAX_FRAMES = 300;

/** Minimal structural type for the WebCodecs `ImageDecoder` we rely on, so we
 *  don't require the WebCodecs lib types to be enabled in tsconfig. */
type ImageDecoderCtor = new (init: { data: Uint8Array; type: string }) => {
  tracks: { ready: Promise<void>; selectedTrack?: { frameCount?: number } };
  decode: (opts: { frameIndex: number }) => Promise<{ image: CanvasImageSource }>;
  close: () => void;
};

/**
 * A still-or-animated image source for cape baking.
 *
 * Animated formats are decoded frame-by-frame up front via WebCodecs
 * `ImageDecoder`. This is the reliable path on Chromium/WebView2: it does NOT
 * depend on an `<img>` being painted, which Chromium pauses for off-screen or
 * transparent images — that pausing is exactly why drawing a hidden animated
 * `<img>` to canvas froze on frame 0. `current()` returns the frame for the
 * present time so callers just bake whatever it hands back each tick.
 *
 * Cross-platform: `ImageDecoder` is present on WebView2 (Windows) and recent
 * WebKitGTK. When it's absent (older WebKitGTK on Linux) we fall back to a
 * static first frame — the cape shows but doesn't animate. That gap is a
 * documented Linux limitation to revisit, not a silent failure.
 */
export class FrameSource {
  width = 0;
  height = 0;
  animated = false;
  // VideoFrame[] at runtime; typed loosely so we don't require WebCodecs lib types.
  private frames: CanvasImageSource[] = [];
  private durations: number[] = [];
  private total = 0;
  private still: HTMLImageElement | null = null;
  private readonly startTs = performance.now();

  static async load(dataUrl: string): Promise<FrameSource> {
    const s = new FrameSource();
    await s.init(dataUrl);
    return s;
  }

  private async init(dataUrl: string): Promise<void> {
    const { bytes, mime } = parseDataUrl(dataUrl);
    const decoderCtor = (globalThis as unknown as { ImageDecoder?: unknown }).ImageDecoder;
    if (detectAnimated(bytes) && typeof decoderCtor === "function") {
      try {
        // APNG needs the dedicated mime to expose its frames; a plain
        // "image/png" decodes as a single frame.
        const isApng = bytes[0] === 0x89 && bytes[1] === 0x50 && findAscii(bytes, "acTL", 8, 8192) >= 0;
        await this.decodeAll(decoderCtor as ImageDecoderCtor, bytes, isApng ? "image/apng" : mime);
      } catch {
        this.disposeFrames(); // decoder failed — fall through to a still frame
      }
    }
    if (this.frames.length > 1) {
      this.animated = true;
      const f0 = this.frames[0] as unknown as { displayWidth: number; displayHeight: number };
      this.width = f0.displayWidth;
      this.height = f0.displayHeight;
      return;
    }
    // Static, or animated with no usable decoder → a single still frame.
    this.disposeFrames();
    const img = await loadStillImage(dataUrl);
    this.still = img;
    this.width = img.naturalWidth;
    this.height = img.naturalHeight;
  }

  private async decodeAll(
    Ctor: ImageDecoderCtor,
    bytes: Uint8Array,
    type: string,
  ): Promise<void> {
    const decoder = new Ctor({ data: bytes, type });
    await decoder.tracks.ready;
    const count = Math.min(decoder.tracks.selectedTrack?.frameCount ?? 1, MAX_FRAMES);
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      this.frames.push(image);
      const us = (image as unknown as { duration: number | null }).duration;
      const ms = us ? us / 1000 : 100;
      this.durations.push(ms > 0 ? ms : 100);
    }
    this.total = this.durations.reduce((a, b) => a + b, 0);
    decoder.close();
  }

  /** The frame to draw for the current moment in the loop. */
  current(): CanvasImageSource {
    if (this.frames.length > 1 && this.total > 0) {
      const elapsed = (performance.now() - this.startTs) % this.total;
      let acc = 0;
      for (let i = 0; i < this.frames.length; i++) {
        acc += this.durations[i];
        if (elapsed < acc) return this.frames[i];
      }
      return this.frames[this.frames.length - 1];
    }
    return this.still as CanvasImageSource;
  }

  /** Number of discrete frames (1 for a static or undecodable-animated source). */
  get frameCount(): number {
    return this.frames.length > 1 ? this.frames.length : 1;
  }

  /** The i-th frame (clamped), or the still image for a static source. */
  frameAt(i: number): CanvasImageSource {
    if (this.frames.length > 1) {
      return this.frames[Math.max(0, Math.min(i, this.frames.length - 1))];
    }
    return this.still as CanvasImageSource;
  }

  /** Mean per-frame duration in ms (defaults to 100 when unknown). */
  get averageDurationMs(): number {
    if (this.durations.length === 0 || this.total <= 0) return 100;
    return this.total / this.durations.length;
  }

  private disposeFrames(): void {
    for (const f of this.frames) {
      (f as unknown as { close?: () => void }).close?.();
    }
    this.frames = [];
    this.durations = [];
    this.total = 0;
  }

  dispose(): void {
    this.disposeFrames();
    this.still = null;
  }
}

// ─── Animation controller ───────────────────────────────────────────────────

/** Caps the per-frame re-bake + GPU re-upload so a high-resolution animated
 *  cape doesn't peg the GPU; 24fps is plenty for a cape's gentle sway. */
const ANIM_FPS = 24;

interface CapeViewer {
  loadCape: (source: CanvasImageSource, options: { backEquipment: "cape" | "elytra" }) => unknown;
}

/**
 * Drives an animated cape onto a skinview3d viewer: decodes the source's
 * frames, runs a throttled rAF loop, and re-bakes the current frame onto a
 * reused canvas each tick. `getParams` is read every frame so live edits
 * (drag/scale/bg/res) and the elytra toggle take effect immediately.
 */
export class CapeAnimator {
  private src: FrameSource | null = null;
  private raf = 0;
  private last = 0;
  private readonly canvas = document.createElement("canvas");

  constructor(
    private readonly viewer: CapeViewer,
    private readonly getParams: () => CapeBakeParams & { elytra: boolean },
  ) {}

  /** Begin animating from a source data URL. Replaces any current animation. */
  async start(sourceDataUrl: string): Promise<void> {
    this.stop();
    const src = await FrameSource.load(sourceDataUrl);
    this.src = src;
    this.render(); // paint the first frame immediately
    if (!src.animated) return; // static fallback — no loop needed
    const tick = (ts: number) => {
      this.raf = requestAnimationFrame(tick);
      if (ts - this.last < 1000 / ANIM_FPS) return;
      this.last = ts;
      this.render();
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Bake + upload the current frame once (used immediately and each tick). */
  render(): void {
    if (!this.src) return;
    const p = this.getParams();
    bakeCape(this.canvas, this.src.current(), this.src.width, this.src.height, p);
    try {
      this.viewer.loadCape(this.canvas, { backEquipment: p.elytra ? "elytra" : "cape" });
    } catch {
      // viewer may be mid-teardown; ignore.
    }
  }

  /** Stop the loop and release decoded frames. */
  stop(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.src?.dispose();
    this.src = null;
  }
}
