import { Component, createSignal, createEffect, onCleanup } from "solid-js";
import { renderCapeModel } from "../lib/capeThumb";

/**
 * Cape-chip thumbnail showing a rendered 3D model of the cape (front-on),
 * instead of the flat UV-atlas texture. For capes that have an elytra (Mojang
 * capes — pass `withElytra`), it slideshows between the cape and elytra models
 * every few seconds. Custom capes have no custom elytra, so they stay
 * cape-only.
 *
 * While the model render is in flight it falls back to the raw texture so the
 * chip is never blank, then swaps to the model once ready.
 */
const CapeChipThumb: Component<{ texture: string; withElytra?: boolean }> = (props) => {
  const [capeImg, setCapeImg] = createSignal<string | null>(null);
  const [elytraImg, setElytraImg] = createSignal<string | null>(null);
  const [showElytra, setShowElytra] = createSignal(false);

  // Render snapshot(s) whenever the texture changes.
  createEffect(() => {
    const tex = props.texture;
    const wantElytra = !!props.withElytra;
    setCapeImg(null);
    setElytraImg(null);
    setShowElytra(false);
    let alive = true;
    renderCapeModel(tex, "cape").then((u) => alive && setCapeImg(u)).catch(() => {});
    if (wantElytra) {
      renderCapeModel(tex, "elytra").then((u) => alive && setElytraImg(u)).catch(() => {});
    }
    onCleanup(() => { alive = false; });
  });

  // Slideshow: alternate cape ↔ elytra once both renders exist.
  createEffect(() => {
    if (!props.withElytra || !capeImg() || !elytraImg()) return;
    const id = window.setInterval(() => setShowElytra((v) => !v), 3500);
    onCleanup(() => window.clearInterval(id));
  });

  // Active image: the chosen model snapshot, falling back to the raw texture
  // until the first render lands.
  const current = () =>
    showElytra() && elytraImg() ? elytraImg()! : capeImg() ?? props.texture;

  return (
    <div
      class="skins-cape-chip-thumb"
      classList={{ "skins-cape-chip-thumb--model": !!capeImg() }}
      style={{ "background-image": `url(${current()})` }}
    />
  );
};

export default CapeChipThumb;
