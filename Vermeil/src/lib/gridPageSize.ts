import { createSignal, onCleanup } from "solid-js";

/**
 * Column-aware page size for a paged `.card-grid`. Measures the grid container
 * and reports `columns × rows`, so each page fills complete rows with no empty
 * trailing cell when the window is resized/maximized.
 *
 * Unlike a layout-overriding approach it does NOT touch the grid's CSS template
 * (the grid still lays out via `auto-fit`) — it only sizes the *page* — and it
 * recomputes only after a resize settles, so the layout never jumps. `cols`
 * uses the same math CSS `auto-fit` uses, so it matches the rendered columns:
 * pass the same `track` (the grid's `minmax` min) and `gap` the CSS uses.
 *
 * Usage:
 *   const page = createGridPageSize({ track: 240, gap: 12, rowHeight: 210, maxRows: 5 });
 *   <div class="card-grid" ref={page.setEl}>…</div>
 *   // page.size() → items to show/fetch per page
 */
export function createGridPageSize(opts: { track: number; gap: number; rowHeight: number; maxRows: number }) {
  const [size, setSize] = createSignal(opts.maxRows * 4 || 16);
  let el: HTMLElement | undefined;
  let settle: number | undefined;

  const compute = () => {
    if (!el) return;
    const w = el.clientWidth;
    if (w <= 0) return;
    const cols = Math.max(1, Math.floor((w + opts.gap) / (opts.track + opts.gap)));
    const content = el.closest(".content") as HTMLElement | null;
    let availH = window.innerHeight;
    if (content) {
      const top = el.getBoundingClientRect().top - content.getBoundingClientRect().top;
      availH = content.clientHeight - top;
    }
    const rows = Math.min(opts.maxRows, Math.max(1, Math.ceil(availH / (opts.rowHeight + opts.gap))));
    setSize(cols * rows); // multiple of cols → trailing row is always full
  };

  const onResize = () => {
    if (settle !== undefined) clearTimeout(settle);
    settle = window.setTimeout(compute, 300);
  };

  const setEl = (node: HTMLElement) => {
    el = node;
    compute();
    requestAnimationFrame(compute);
    const ro = new ResizeObserver(onResize);
    ro.observe(node);
    const content = node.closest(".content");
    if (content) ro.observe(content);
    onCleanup(() => { ro.disconnect(); if (settle !== undefined) clearTimeout(settle); });
  };

  return { setEl, size };
}
