import { Component, For, Show, createSignal, onMount, onCleanup } from "solid-js";
import { setActiveScreen, setActiveInstanceId, setInitialInstanceTab, instances, refetchInstances, refreshPinnedInstanceIds } from "../App";
import { Instance, deleteInstance, renameInstance, getSettings } from "../ipc/commands";
import { IconPlus } from "../components/Icons";

function loaderBadgeClass(loader: string): string {
  switch (loader) {
    case "fabric": return "badge-fabric";
    case "forge": return "badge-forge";
    case "neoforge": return "badge-neo";
    case "quilt": return "badge-quilt";
    default: return "badge-vanilla";
  }
}

function bannerColor(loader: string): string {
  switch (loader) {
    case "fabric": return "fabric";
    case "quilt": return "quilt";
    case "neoforge": return "blue";
    case "forge": return "orange";
    default: return "green"; // vanilla
  }
}

/**
 * Resolve an instance's banner icon. We treat the literal `"cube"` value as
 * the sentinel "no real icon, fall back to the loader badge" because that's
 * what the backend writes for instances created without an `icon_url`. A real
 * value is a `data:image/...;base64,...` URL ready for `<img src>`.
 */
function instanceIconUrl(inst: { icon: string }): string | undefined {
  if (!inst.icon || inst.icon === "cube") return undefined;
  return inst.icon;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "Never played";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

const Library: Component = () => {
  const [selectMode, setSelectMode] = createSignal(false);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);

  // Escape exits multi-select mode
  const handleKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && selectMode()) {
      setSelectMode(false);
      setSelected(new Set());
    }
  };
  onMount(() => document.addEventListener("keydown", handleKey));
  onCleanup(() => document.removeEventListener("keydown", handleKey));
  const [deleteInput, setDeleteInput] = createSignal("");
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal("");

  // Transient drag-select state. We need to distinguish a plain click (toggle)
  // from a drag (additive — original card + every card entered). Without this,
  // a drag that doesn't leave the start card would behave as an unwanted
  // mousedown→click→toggle pair.
  let dragStartId: string | null = null;
  let dragExtended = false;

  const toggleSelect = (id: string) => {
    const s = new Set(selected());
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  };

  const deleteSelected = async () => {
    for (const id of selected()) {
      await deleteInstance(id);
    }
    setSelected(new Set());
    setSelectMode(false);
    setShowDeleteConfirm(false);
    setDeleteInput("");
    refetchInstances();
    // Backend already strips deleted IDs from `sidebar_pinned_instances`,
    // but the frontend pin signal is set on app boot and never re-reads
    // settings unless we ask. Without this refresh, the manage-pins
    // button would stay stuck in the "is-at-limit" state and show the
    // morph-to-minus animation even after deleting a pinned instance.
    refreshPinnedInstanceIds().catch(() => {});
  };

  const openInstance = (inst: Instance) => {
    if (selectMode()) { toggleSelect(inst.id); return; }
    setActiveInstanceId(inst.id);
    setInitialInstanceTab("content");
    setActiveScreen("mods");
  };

  return (
    <div class="screen-enter">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="section-label" style="margin-bottom:0">Instances</div>
        <div style="display:flex;gap:6px">
          <Show when={selectMode()}>
            <button class="btn" style="font-size:10px;padding:4px 8px;color:#e05252;border-color:#e05252" disabled={selected().size === 0} onClick={async () => {
              const settings = await getSettings();
              if (settings.force_delete) {
                await deleteSelected();
              } else {
                setShowDeleteConfirm(true);
              }
            }}>
              Delete ({selected().size})
            </button>
          </Show>
          <button class="btn tip-below" style="font-size:10px;padding:4px 8px" data-tip="Multi-select" onClick={() => { setSelectMode(!selectMode()); setSelected(new Set()); }}>
            {selectMode() ? "✕" : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>}
          </button>
        </div>
      </div>

      {/* Delete confirmation */}
      <Show when={showDeleteConfirm()}>
        <div style="background:var(--bg3);border:1px solid #e05252;border-radius:8px;padding:12px;margin-bottom:12px">
          <div style="font-size:12px;color:#e05252;margin-bottom:8px">Delete {selected().size} instance(s)? Type <strong>Confirm</strong> to proceed.</div>
          <div style="display:flex;gap:8px;align-items:center">
            <input class="search-input" style="max-width:140px;border-color:#e05252" placeholder="Type Confirm" value={deleteInput()} onInput={(e) => setDeleteInput(e.currentTarget.value)} />
            <button class="btn" style="font-size:10px;color:#e05252;border-color:#e05252" disabled={deleteInput() !== "Confirm"} onClick={deleteSelected}>Delete All</button>
            <button class="btn btn-ghost" style="font-size:10px" onClick={() => { setShowDeleteConfirm(false); setDeleteInput(""); }}>Cancel</button>
          </div>
        </div>
      </Show>
      <div class="instance-grid">
        <For each={instances()}>
          {(inst) => (
            <div
              class={`inst-card ${selectMode() && selected().has(inst.id) ? "inst-card-selected" : ""}`}
              onClick={() => {
                // If a drag occurred, the cards were already added during drag
                // — skip the click toggle so we don't deselect the start card.
                if (selectMode() && dragExtended) {
                  dragExtended = false;
                  dragStartId = null;
                  return;
                }
                openInstance(inst);
                dragStartId = null;
              }}
              onMouseDown={(e) => {
                if (selectMode() && e.button === 0) {
                  dragStartId = inst.id;
                  dragExtended = false;
                }
              }}
              onMouseEnter={(e) => {
                // Drag-extension: while left mouse is held in select mode,
                // hovering over a card other than the start card converts the
                // gesture into a drag-select. The start card and every entered
                // card are added (additive, never toggles).
                if (selectMode() && e.buttons === 1 && dragStartId && dragStartId !== inst.id) {
                  const s = new Set(selected());
                  if (dragStartId && !s.has(dragStartId)) {
                    s.add(dragStartId);
                  }
                  if (!s.has(inst.id)) {
                    s.add(inst.id);
                  }
                  setSelected(s);
                  dragExtended = true;
                }
              }}
            >
              <div class="inst-card-row">
                <div class={`inst-card-icon ${bannerColor(inst.loader.type)}`}>
                  <Show when={instanceIconUrl(inst)} fallback={
                    <span class="inst-card-icon-letter">{inst.name.trim().charAt(0).toUpperCase() || "?"}</span>
                  }>
                    <img src={instanceIconUrl(inst)!} alt="" draggable={false} />
                  </Show>
                </div>
                <div class="inst-card-content">
                  <Show when={renamingId() === inst.id} fallback={
                    <div class="inst-name" onClick={(e: MouseEvent) => { if (!selectMode()) e.stopImmediatePropagation(); }} onDblClick={(e) => { if (!selectMode()) { e.stopImmediatePropagation(); setRenamingId(inst.id); setRenameValue(inst.name); } }}>{inst.name}</div>
                  }>
                    <input class="field-input" style="font-size:12px;font-weight:600;padding:2px 6px" value={renameValue()}
                      onInput={(e) => setRenameValue(e.currentTarget.value)}
                      onBlur={async () => { if (renameValue().trim()) { await renameInstance(inst.id, renameValue()); refetchInstances(); } setRenamingId(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLElement).blur(); if (e.key === "Escape") setRenamingId(null); }}
                      ref={(el) => setTimeout(() => { el.focus(); el.select(); }, 10)}
                      onClick={(e: MouseEvent) => { if (!selectMode()) e.stopImmediatePropagation(); }}
                    />
                  </Show>
                  <div class="inst-meta">
                    {inst.game_version} · {inst.mods.length} mods · {timeAgo(inst.last_played)}
                  </div>
                  <div class="inst-card-badges">
                    <span class={`inst-badge ${loaderBadgeClass(inst.loader.type)}`}>
                      {inst.loader.type === "vanilla" ? "Vanilla" : inst.loader.type.charAt(0).toUpperCase() + inst.loader.type.slice(1)}
                    </span>
                    <span class="inst-badge badge-ram">{inst.java.memory_max_mb} MB</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </For>

        <div class="add-card" onClick={() => setActiveScreen("create-choose")}>
          <IconPlus />
          <div class="add-label">New instance</div>
        </div>
      </div>
    </div>
  );
};

export default Library;
