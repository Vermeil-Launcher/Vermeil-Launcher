import { Component, For, Show, createSignal, createMemo, onMount, onCleanup } from "solid-js";
import { setActiveScreen, setActiveInstanceId, setInitialInstanceTab, instances, refetchInstances, refreshPinnedInstanceIds, pinnedInstanceIds } from "../App";
import { Instance, deleteInstance, renameInstance, getSettings } from "../ipc/commands";
import { IconPlus, IconModrinth, IconCurseForge, IconX } from "../components/Icons";
import Dropdown from "../components/Dropdown";
import { loaderBadgeClass, loaderLabel } from "../lib/loader";

/** Library sort modes. Persisted in localStorage so the choice sticks between
 *  sessions (a pure view preference — kept out of the launcher settings file to
 *  avoid a full settings round-trip / clobber risk from this screen). */
type LibrarySort = "played" | "mostPlayed" | "created" | "name";
const SORT_STORAGE_KEY = "vermeil.librarySort";
const SORT_OPTIONS: { value: LibrarySort; label: string }[] = [
  { value: "played", label: "Recently played" },
  { value: "mostPlayed", label: "Most played" },
  { value: "created", label: "Recently created" },
  { value: "name", label: "Name (A–Z)" },
];

/** Epoch ms from an ISO date string, or 0 when absent/unparseable (so
 *  never-played / missing dates sort last in a descending order). */
function epoch(dateStr: string | null | undefined): number {
  if (!dateStr) return 0;
  const t = new Date(dateStr).getTime();
  return Number.isNaN(t) ? 0 : t;
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
  // Library is the instance hub. (Download history is its own Downloads
  // screen, reachable from the dock.)
  const [selectMode, setSelectMode] = createSignal(false);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);

  // Escape exits multi-select mode
  const handleKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && selectMode()) {
      setSelectMode(false);
      setSelected(new Set<string>());
    }
  };
  onMount(() => document.addEventListener("keydown", handleKey));
  onCleanup(() => document.removeEventListener("keydown", handleKey));
  const [deleteInput, setDeleteInput] = createSignal("");
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal("");

  // Sort mode, seeded from localStorage so it persists across sessions.
  const storedSort = (typeof localStorage !== "undefined" && localStorage.getItem(SORT_STORAGE_KEY)) as LibrarySort | null;
  const [sortBy, setSortBy] = createSignal<LibrarySort>(
    SORT_OPTIONS.some(o => o.value === storedSort) ? (storedSort as LibrarySort) : "played"
  );
  const changeSort = (v: string) => {
    setSortBy(v as LibrarySort);
    try { localStorage.setItem(SORT_STORAGE_KEY, v); } catch { /* private mode / quota — non-fatal */ }
  };

  // Comparator for the active sort mode.
  const compare = (a: Instance, b: Instance): number => {
    switch (sortBy()) {
      case "mostPlayed": return (b.total_play_seconds || 0) - (a.total_play_seconds || 0);
      case "created": return epoch(b.created_at) - epoch(a.created_at);
      case "name": return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      case "played":
      default: return epoch(b.last_played) - epoch(a.last_played);
    }
  };

  // Pinned instances always float to the top (matching the sidebar pins), then
  // everything else — each group ordered by the chosen sort. Memoized so it only
  // recomputes when the instance list, sort, or pins change.
  const sortedInstances = createMemo(() => {
    const list = [...(instances() ?? [])];
    const pinned = new Set(pinnedInstanceIds());
    list.sort((a, b) => {
      const ap = pinned.has(a.id) ? 0 : 1;
      const bp = pinned.has(b.id) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return compare(a, b);
    });
    return list;
  });

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
    setSelected(new Set<string>());
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
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4)">
        <div class="page-title">Library</div>
        <div style="display:flex;gap:6px;align-items:center">
          <Dropdown
            value={sortBy()}
            options={SORT_OPTIONS}
            onChange={changeSort}
            width="150px"
          />
          <Show when={selectMode()}>
            <button class="btn btn--danger btn--sm" disabled={selected().size === 0} onClick={async () => {
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
          <button class="btn btn--sm tip-below" data-tip="Multi-select" onClick={() => { setSelectMode(!selectMode()); setSelected(new Set<string>()); }}>
            {selectMode() ? <IconX /> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>}
          </button>
        </div>
      </div>

      {/* Delete confirmation */}
      <Show when={showDeleteConfirm()}>
        <div style="background:var(--bg3);border:1px solid var(--danger);padding:12px;margin-bottom:12px">
          <div style="font-size:12px;color:var(--danger);margin-bottom:8px">Delete {selected().size} instance(s)? Type <strong>Confirm</strong> to proceed.</div>
          <div style="display:flex;gap:8px;align-items:center">
            <input class="field-control field-control--text" style="max-width:140px;border-color:var(--danger)" placeholder="Type Confirm" value={deleteInput()} onInput={(e) => setDeleteInput(e.currentTarget.value)} />
            <button class="btn btn--danger" disabled={deleteInput() !== "Confirm"} onClick={deleteSelected}>Delete All</button>
            <button class="btn btn--ghost" onClick={() => { setShowDeleteConfirm(false); setDeleteInput(""); }}>Cancel</button>
          </div>
        </div>
      </Show>

      <div class="card-grid">
          <For each={sortedInstances()}>
            {(inst) => (
              <div
                class={`card card--inst ${selectMode() && selected().has(inst.id) ? "inst-card-selected" : ""}`}
                style="cursor:pointer"
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
                <div class="card-body">
                  <div class={`inst-card-icon ${bannerColor(inst.loader.type)}`}>
                    <Show when={instanceIconUrl(inst)} fallback={
                      <span class="inst-card-icon-letter">{inst.name.trim().charAt(0).toUpperCase() || "?"}</span>
                    }>
                      <img src={instanceIconUrl(inst)!} alt="" draggable={false} />
                    </Show>
                  </div>
                  <div class="inst-card-content">
                    <Show when={renamingId() === inst.id} fallback={
                      <div class="card-title inst-name" onClick={(e: MouseEvent) => { if (!selectMode()) e.stopImmediatePropagation(); }} onDblClick={(e) => { if (!selectMode()) { e.stopImmediatePropagation(); setRenamingId(inst.id); setRenameValue(inst.name); } }}>{inst.name}</div>
                    }>
                      <input class="field-control field-control--text" style="font-size:12px;font-weight:600;height:auto;padding:2px 6px" value={renameValue()}
                        onInput={(e) => setRenameValue(e.currentTarget.value)}
                        onBlur={async () => { if (renameValue().trim()) { await renameInstance(inst.id, renameValue()); refetchInstances(); } setRenamingId(null); }}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLElement).blur(); if (e.key === "Escape") setRenamingId(null); }}
                        ref={(el) => setTimeout(() => { el.focus(); el.select(); }, 10)}
                        onClick={(e: MouseEvent) => { if (!selectMode()) e.stopImmediatePropagation(); }}
                      />
                    </Show>
                    <div class="card-sub inst-meta">
                      {inst.mods.length} mods · {timeAgo(inst.last_played)}
                    </div>
                    <div class="inst-card-badges">
                      <span class="badge badge--version">{inst.game_version}</span>
                      <Show when={inst.source_project_id && inst.source_version}>
                        <span class="badge badge--vnum" title={`Modpack version ${inst.source_version}`}>{inst.source_version}</span>
                      </Show>
                      <span class={`badge badge--loader ${loaderBadgeClass(inst.loader.type)}`}>
                        {loaderLabel(inst.loader.type)}
                      </span>
                      <span class="badge">{inst.java.memory_max_mb} MB</span>
                      <Show when={inst.ingame_cape_supported}>
                        <span class="badge badge--companion" title="Vermeil companion mod supported">
                          <img src="/logo.png" alt="Vermeil" draggable={false} />
                        </span>
                      </Show>
                      <Show when={(inst.source_platforms || []).includes("modrinth")}>
                        <span class="badge badge--source badge--modrinth" title="Available on Modrinth"><IconModrinth /></span>
                      </Show>
                      <Show when={(inst.source_platforms || []).includes("curseforge")}>
                        <span class="badge badge--source badge--curseforge" title="Available on CurseForge"><IconCurseForge /></span>
                      </Show>
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
