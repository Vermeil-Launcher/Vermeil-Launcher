import { Component, createSignal, Show, For, onMount } from "solid-js";
import { instances, showToast, refreshPinnedInstanceIds } from "../App";
import { getSettings, saveSettings } from "../ipc/commands";

/**
 * Sidebar pin manager. Lets the user pick up to 5 instances to surface as
 * quick-launch icons in the sidebar, between Skins and the manage button.
 *
 * Mounted at App level. Open via the exported `openPinInstancesModal()`
 * helper — usually triggered from the sidebar's plus / minus button.
 *
 * The picker shows every existing instance. Selected rows are highlighted
 * with the accent tint; clicking past the limit is rejected with a toast.
 */
const MAX_PINS = 6;

const [open, setOpen] = createSignal(false);
const [pinned, setPinned] = createSignal<string[]>([]);

/** Open the picker. Loads the current pin list from settings on every open
 *  so the modal always reflects what's actually saved. Filters out any IDs
 *  pointing at instances that no longer exist so the count and UI don't lie
 *  about how many real pins there are. */
export function openPinInstancesModal() {
  getSettings()
    .then((s) => {
      const live = new Set((instances() ?? []).map((i) => i.id));
      const realPins = (s.sidebar_pinned_instances ?? []).filter((id) => live.has(id));
      setPinned(realPins);
      setOpen(true);
    })
    .catch((e) => {
      showToast({ title: "Couldn't open pin manager", message: String(e), type: "error" });
    });
}

/** Read by App.tsx to know whether to render the modal at all. */
export const pinInstancesModalOpen = open;

/** Close the pin modal without saving. Used by the global Escape handler. */
export function closePinInstancesModal() {
  setOpen(false);
}

const PinInstancesModal: Component = () => {
  const [saving, setSaving] = createSignal(false);
  const [page, setPage] = createSignal(0);
  const PAGE_SIZE = 5;

  onMount(() => {
    if (open() && pinned().length === 0) {
      getSettings().then((s) => setPinned(s.sidebar_pinned_instances ?? [])).catch(() => {});
    }
  });

  const allInstances = () => instances() ?? [];
  const totalPages = () => Math.max(1, Math.ceil(allInstances().length / PAGE_SIZE));
  const pagedInstances = () => allInstances().slice(page() * PAGE_SIZE, (page() + 1) * PAGE_SIZE);

  const toggle = (id: string) => {
    const current = pinned();
    if (current.includes(id)) {
      setPinned(current.filter((p) => p !== id));
      return;
    }
    if (current.length >= MAX_PINS) {
      showToast({
        title: `${MAX_PINS}-pin limit`,
        message: "Unpin one of the existing pins to add a different instance.",
        type: "info",
        autoCloseMs: 3000,
      });
      return;
    }
    setPinned([...current, id]);
  };

  const close = () => {
    setOpen(false);
    setPage(0);
  };

  const save = async () => {
    setSaving(true);
    try {
      const s = await getSettings();
      s.sidebar_pinned_instances = pinned();
      await saveSettings(s);
      await refreshPinnedInstanceIds();
      setOpen(false);
      setPage(0);
    } catch (e) {
      showToast({ title: "Couldn't save pins", message: String(e), type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const loaderColor = (type: string) => {
    switch (type) {
      case "fabric": return "#dbb587";
      case "forge": return "#3e5494";
      case "neoforge": return "#f08a22";
      case "quilt": return "#c796f0";
      default: return "var(--muted)";
    }
  };

  return (
    <Show when={open()}>
      <div class="modal-overlay" onClick={close}>
        <div class="modal pin-instances-modal panel panel--bracketed" onClick={(e) => e.stopPropagation()}>
          <div class="modal-header">
            <span class="modal-title">Pin instances to sidebar</span>
            <button class="modal-close" onClick={close}>✕</button>
          </div>
          <div class="modal-body">
            <div class="pin-instances-help">
              Pick up to {MAX_PINS} instances to show as quick-launch icons in the sidebar.
              Click an icon there to jump straight into that instance.
            </div>
            <Show
              when={allInstances().length > 0}
              fallback={
                <div class="pin-instances-empty">
                  No instances yet. Create one from the Library tab to pin it.
                </div>
              }
            >
              <div class="pin-instances-list">
                <For each={pagedInstances()}>
                  {(inst) => {
                    const checked = () => pinned().includes(inst.id);
                    return (
                      <div
                        class={`pin-instance-card ${checked() ? "checked" : ""}`}
                        onClick={() => toggle(inst.id)}
                      >
                        <div class="pin-instance-icon">
                          <Show when={inst.icon && inst.icon !== "cube"} fallback={
                            <div class="pin-instance-icon-placeholder">
                              {inst.name.trim().charAt(0).toUpperCase() || "?"}
                            </div>
                          }>
                            <img src={inst.icon} alt="" />
                          </Show>
                        </div>
                        <div class="pin-instance-info">
                          <span class="pin-instance-name">{inst.name}</span>
                          <span class="pin-instance-meta">
                            <span class="pin-instance-version">{inst.game_version}</span>
                            <span class="pin-instance-loader" style={`color:${loaderColor(inst.loader.type)}`}>{inst.loader.type}</span>
                            <span class="pin-instance-ram">{inst.java.memory_max_mb}MB</span>
                            <Show when={inst.mods.length > 0}>
                              <span class="pin-instance-mods">{inst.mods.length} mods</span>
                            </Show>
                          </span>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
              <Show when={totalPages() > 1}>
                <div class="pin-instances-pager">
                  <button
                    class="btn btn--neutral"
                    style="font-size:10px;padding:3px 8px"
                    disabled={page() === 0}
                    onClick={() => setPage(page() - 1)}
                  >‹</button>
                  <span style="font-size:10px;color:var(--muted)">{page() + 1} / {totalPages()}</span>
                  <button
                    class="btn btn--neutral"
                    style="font-size:10px;padding:3px 8px"
                    disabled={page() >= totalPages() - 1}
                    onClick={() => setPage(page() + 1)}
                  >›</button>
                </div>
              </Show>
            </Show>
            <div class="pin-instances-count">
              {pinned().length} / {MAX_PINS} pinned
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn--ghost" onClick={close}>Cancel</button>
            <button class="btn btn--primary" onClick={save} disabled={saving()}>
              {saving() ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default PinInstancesModal;
