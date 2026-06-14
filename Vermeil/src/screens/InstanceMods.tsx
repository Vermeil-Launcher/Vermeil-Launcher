import { Component, createSignal, createEffect, createResource, For, Show, onMount, onCleanup } from "solid-js";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { setActiveScreen, instances, activeInstanceId, refetchInstances, refreshPinnedInstanceIds, initialInstanceTab, gameRunning, trackDownload, completeDownload, failDownload, startBulkBatch, endBulkBatch, showToast, gameLogsFor, setDockHidden, setDockPagination } from "../App";
import { reportDependencyIssues, DependencyIssue } from "../components/DependencyIssuesModal";
import { searchMods, installModToInstance, installCfModToInstance, minimizeToTray, listInstanceFiles, listInstanceWorlds, openInstanceFolder, deleteInstance, updateInstanceMemory, updateInstanceOptions, toggleModInInstance, removeModFromInstance, removeAllContent, checkModUpdates, applyModUpdate, ModUpdate, cloneInstance, getSettings, getSystemMemory, setInstanceIcon, clearInstanceIcon, searchCurseforge, getResolvedJvmArgs, getPresetJvmArgs, getKnownPresetArgs, ModHit, FileEntry, WorldEntry } from "../ipc/commands";
import { IconArrowLeft, IconBolt, IconMonitor, IconGlobe, IconTrash, IconArrowUp, IconArrowDown, IconSearch, IconModrinth, IconCurseForge } from "../components/Icons";

const SORT_OPTIONS = [
  { value: "relevance", label: "Relevance" },
  { value: "downloads", label: "Downloads" },
  { value: "follows", label: "Follows" },
  { value: "newest", label: "Newest" },
  { value: "updated", label: "Updated" },
];
const VIEW_OPTIONS = [12, 24, 48];

type InstanceTab = "content" | "files" | "worlds" | "logs" | "settings";

/**
 * Resolve the best icon URL for a mod entry / installed item.
 *
 * Prefers `local_icon_path` when set (a `data:image/...;base64,...` URL
 * cached on install — works offline, no CDN re-hit). Falls back to the
 * remote `icon_url` for items that haven't been re-cached yet (older
 * installs from before the cache existed). Returns `undefined` if neither
 * is available so the caller can render its own fallback glyph.
 */
function resolveIconUrl(item: { local_icon_path?: string | null; icon_url?: string | null }): string | undefined {
  if (item.local_icon_path) return item.local_icon_path;
  if (item.icon_url) return item.icon_url;
  return undefined;
}

/**
 * Whether a content category is usable on a given loader. Vanilla (no
 * loader) can only use resource packs and data packs. Mods and shaders
 * both require a loader (mods need Fabric/Forge/etc., shaders need
 * Iris or OptiFine which are themselves mods).
 */
function isCategoryAvailable(category: string, loader: string): boolean {
  if (loader !== "vanilla") return true;
  return category === "resourcepack" || category === "datapack";
}

/**
 * First category in the standard tab order that's available for the given
 * loader. Used to auto-select a usable category when the current selection
 * becomes invalid (e.g. user opens Browse on a vanilla instance — "mod" is
 * grayed out, so we land on "resourcepack" instead).
 */
function firstAvailableCategory(loader: string): "mod" | "resourcepack" | "shader" | "datapack" {
  const order: ("mod" | "resourcepack" | "shader" | "datapack")[] =
    ["mod", "resourcepack", "shader", "datapack"];
  return order.find((c) => isCategoryAvailable(c, loader)) ?? "resourcepack";
}

const InstanceMods: Component = () => {
  const [mainTab, setMainTab] = createSignal<InstanceTab>(initialInstanceTab() as InstanceTab || "content");
  const [systemMemoryMb] = createResource(getSystemMemory);

  // Memory hint based on allocation amount
  const memoryHintText = (mb: number) => {
    if (mb <= 1024) return "Very low — may struggle with vanilla";
    if (mb <= 2048) return "Minimum for vanilla Minecraft";
    if (mb <= 4096) return "Good for vanilla and light modpacks";
    if (mb <= 6144) return "Recommended for most modpacks";
    if (mb <= 8192) return "Good for large modpacks (100+ mods)";
    if (mb <= 12288) return "High — only needed for heavy modpacks";
    return "Very high — may cause GC stuttering";
  };
  const memoryHintLevel = (mb: number): string => {
    if (mb <= 1024) return "warn";
    if (mb <= 2048) return "low";
    if (mb <= 8192) return "good";
    if (mb <= 12288) return "high";
    return "warn";
  };

  // React to external tab change requests (e.g., from Home settings button)
  createEffect(() => {
    const tab = initialInstanceTab();
    if (tab) setMainTab(tab as InstanceTab);
  });

  // Keep the local "installed" cache in sync with the actual mods list.
  // Without this, bulk-delete or single-remove would leave Browse-tab
  // "Installed" badges stale until the page is reloaded.
  createEffect(() => {
    const inst = instance();
    if (!inst) return;
    const ids = new Set(inst.mods.map(m => m.project_id).filter(Boolean));
    setLocalInstalled(ids);
  });

  // Refresh the update map whenever the Installed tab is opened or the
  // instance's mod list changes. We only run while the tab is visible to
  // avoid surprise network calls in the background.
  createEffect(() => {
    if (mainTab() === "content" && contentTab() === "installed") {
      const inst = instance();
      if (inst && inst.mods.length > 0) {
        // Re-run on mod list size change so newly installed mods get checked
        // and removed mods drop out of the map.
        const _ = inst.mods.length;
        refreshUpdates();
      } else {
        setModUpdates(new Map());
      }
    }
  });
  const [contentTab, setContentTab] = createSignal<"installed" | "browse">("installed");
  const [installedFilter, setInstalledFilter] = createSignal<"all" | "mod" | "resourcepack" | "shader" | "datapack">("all");
  // Installed tab: search + sort. Sort defaults to newest-first because users
  // most often want to find what they just installed. The Vec<ModEntry> from
  // backend is in install order (push at end), so newest = reversed list.
  const [installedSearch, setInstalledSearch] = createSignal("");
  const [installedSort, setInstalledSort] = createSignal<"newest" | "oldest">("newest");

  // Map of project_id → ModUpdate. Populated by `checkModUpdates` whenever the
  // Installed tab is opened so each card can render an "Update" pill without
  // a per-card network round-trip. `updatingMod` tracks the project currently
  // being upgraded so its card can show a spinner.
  const [modUpdates, setModUpdates] = createSignal<Map<string, ModUpdate>>(new Map());
  const [updatingMod, setUpdatingMod] = createSignal<string | null>(null);
  const [checkingUpdates, setCheckingUpdates] = createSignal(false);

  // Refresh the update map. Runs on:
  //  - Installed tab activation
  //  - After a successful update (so the row's pill goes away)
  //  - Manual user refresh button
  // The check is best-effort: network failures are logged but don't show a
  // toast because most users won't care that an update probe failed.
  const refreshUpdates = async (interactive = false) => {
    const inst = instance();
    if (!inst) return;
    if (inst.mods.length === 0) {
      setModUpdates(new Map());
      return;
    }
    setCheckingUpdates(true);
    try {
      const map = await checkModUpdates(inst.id);
      setModUpdates(new Map(Object.entries(map)));
      if (interactive) {
        const count = Object.keys(map).length;
        showToast({
          title: count === 0 ? "Up to date" : `${count} update${count === 1 ? "" : "s"} available`,
          message:
            count === 0
              ? "Every installed item is on its latest compatible version."
              : "Click the green pill on a card to upgrade.",
          type: count === 0 ? "info" : "success",
          autoCloseMs: 3500,
        });
      }
    } catch (e) {
      console.error("Update check failed:", e);
      if (interactive) {
        showToast({
          title: "Update check failed",
          message: typeof e === "string" ? e : (e as Error).message ?? "Unknown error",
          type: "error",
          autoCloseMs: 5000,
        });
      }
    } finally {
      setCheckingUpdates(false);
    }
  };
  const [browseFilter, setBrowseFilter] = createSignal<"mod" | "resourcepack" | "shader" | "datapack">("mod");
  const [browseVersion, setBrowseVersion] = createSignal<string>("");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchResults, setSearchResults] = createSignal<ModHit[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [totalHits, setTotalHits] = createSignal(0);
  const [currentPage, setCurrentPage] = createSignal(1);
  const [sortBy, setSortBy] = createSignal("relevance");
  const [viewCount, setViewCount] = createSignal(12);
  const [modSource, setModSource] = createSignal<"modrinth" | "curseforge">("modrinth");
  const [installing, setInstalling] = createSignal<string | null>(null);
  const [localInstalled, setLocalInstalled] = createSignal<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = createSignal(false);
  const [deleteCountdown, setDeleteCountdown] = createSignal(5);
  const [cloning, setCloning] = createSignal(false);
  // Bulk content delete confirmation (per-category). Separate from the
  // instance-deletion countdown above so a stray click doesn't misfire.
  const [showBulkDelete, setShowBulkDelete] = createSignal(false);

  // Bulk select state
  const [selectMode, setSelectMode] = createSignal(false);
  const [selectedItems, setSelectedItems] = createSignal<Map<string, { mod: ModHit; category: string }>>(new Map());
  const [bulkInstalling, setBulkInstalling] = createSignal(false);

  // Escape exits multi-select mode in the Browse tab
  {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectMode()) {
        setSelectMode(false);
        setSelectedItems(new Map());
      }
    };
    onMount(() => document.addEventListener("keydown", handleKey));
    onCleanup(() => document.removeEventListener("keydown", handleKey));
  }

  // Files tab state
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  const [filePath, setFilePath] = createSignal<string | undefined>(undefined);

  // Worlds tab state
  const [worlds, setWorlds] = createSignal<WorldEntry[]>([]);

  // Logs tab state. The actual log buffer lives at App level keyed by
  // instance ID (`gameLogs` map in App.tsx) so it persists across screen
  // navigation AND stays scoped to the right instance — viewing instance B's
  // Logs tab no longer shows instance A's output. Filters and search are
  // component-local since they're per-view UI state.
  const logs = () => gameLogsFor(activeInstanceId());
  const [logFilters, setLogFilters] = createSignal<Set<string>>(new Set(["all"]));
  /** Substring search across log lines. Empty string disables the filter. */
  const [logSearch, setLogSearch] = createSignal("");

  // Auto-scroll state for the Logs tab. True = follow new output (snap to
  // bottom on each new line). Flips to false when the user scrolls up to
  // read earlier output, and back to true when they return to the bottom
  // (via the jump button or by scrolling down themselves).
  const [autoScrollLogs, setAutoScrollLogs] = createSignal(true);

  // Hide the floating dock while the Logs tab is active so it doesn't cover
  // output. Reset on tab change and on unmount. The dock still reveals on
  // cursor-near-bottom (handled in FloatingDock).
  createEffect(() => {
    setDockHidden(mainTab() === "logs");
  });
  onCleanup(() => setDockHidden(false));

  // Dock pagination is set up after goToPage is defined (see below).
  onCleanup(() => setDockPagination(null));

  const instance = () => {
    const list = instances();
    const id = activeInstanceId();
    if (!list || !id) return list?.[0] || null;
    return list.find(i => i.id === id) || list[0] || null;
  };

  // Optimistic local mirror of the per-instance memory value so the slider
  // label and fill update synchronously while the user drags. Without this
  // the displayed "X.Y GB" lags the thumb because the read source
  // (`instance().java.memory_max_mb`) only refreshes after the IPC save
  // round-trip + refetchInstances() completes.
  const [memoryDraft, setMemoryDraft] = createSignal<number | null>(null);
  const memoryValue = (): number => memoryDraft() ?? instance()?.java.memory_max_mb ?? 4096;
  // Clear the draft once the resource catches up so external changes are
  // reflected eventually. (The resource always re-reads on refetch.)
  createEffect(() => {
    const inst = instance();
    const draft = memoryDraft();
    if (inst && draft !== null && inst.java.memory_max_mb === draft) {
      setMemoryDraft(null);
    }
  });

  // Debounced save for the memory slider. Firing IPC on every drag tick
  // (~30/sec) caused concurrent read-modify-write races on instance.json,
  // surfacing as "EOF while parsing" toasts. Now we only persist after
  // the user pauses dragging — the visual updates instantly via the draft
  // signal, save fires once when the drag settles.
  let memorySaveTimer: number | undefined;
  const commitMemory = (instanceId: string, mb: number) => {
    if (memorySaveTimer !== undefined) clearTimeout(memorySaveTimer);
    memorySaveTimer = window.setTimeout(() => {
      memorySaveTimer = undefined;
      updateInstanceOptions(instanceId, { memoryMaxMb: mb })
        .then(() => refetchInstances())
        .catch((err) => {
          console.error("Save memory failed:", err);
          showToast({ title: "Failed to save memory setting", message: String(err), type: "error" });
        });
    }, 200);
  };

  // Java args editor. Displays the effective GC flags in an editable
  // textarea. If the user has custom `extra_args` saved, those are shown.
  // If `extra_args` is empty, we pre-fill with the current GC preset flags
  // (so the user sees what's being applied and can edit from there).
  // Whatever is in the editor at blur is what the backend uses at launch —
  // `extra_args` overrides the preset when non-empty.
  //
  // Preset stickiness fix: `extra_args` saved during a previous global GC
  // preset would otherwise pin the instance to those exact flags forever
  // (the launch path uses `extra_args` verbatim when non-empty, ignoring
  // the global preset). We resolve every known preset's flags up-front and
  // treat `extra_args` as "no override" when it matches *any* of them. That
  // way switching the global preset in Settings actually propagates: the
  // next time the user opens the editor, they see the new preset's flags,
  // and on blur we save empty `extra_args` so launches stay live too.
  const [extraArgsText, setExtraArgsText] = createSignal("");
  const [knownPresets, setKnownPresets] = createSignal<Record<string, string[]>>({});
  const [globalPreset, setGlobalPreset] = createSignal<string>("g1gc");
  let gutterRef: HTMLDivElement | undefined;

  /** Display label for a preset ID — matches the strings in Settings.tsx. */
  const presetLabel = (id: string): string => {
    if (id === "g1gc") return "G1GC (recommended)";
    if (id === "zgc") return "ZGC";
    if (id === "shenandoah") return "Shenandoah";
    return id.toUpperCase();
  };

  /** Multiset equality — JVM flag order doesn't change semantics, so two
   *  flag lists with the same contents in any order are considered equal. */
  const argsListsEqual = (a: string[], b: string[]): boolean => {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
    return true;
  };

  /** Whether the given flag list matches any known preset's flags. Memory
   *  args (`-Xmx`/`-Xms`) are excluded from comparison since the slider
   *  controls them separately and they're never part of the editor's text. */
  const matchesAnyPreset = (args: string[]): boolean => {
    const cleaned = args.filter(a => !a.startsWith("-Xmx") && !a.startsWith("-Xms"));
    const presets = knownPresets();
    for (const flags of Object.values(presets)) {
      if (argsListsEqual(cleaned, flags)) return true;
    }
    return false;
  };

  /** Whether the current editor contents are preset-equal — i.e. the global
   *  preset is effectively in control. Reactive because it depends on both
   *  the textarea text and the loaded preset map. */
  const isCurrentlyPreset = (): boolean => {
    const text = extraArgsText().trim();
    if (!text) return true;
    const args = text.split(/\s+/).filter(a => a.trim());
    return matchesAnyPreset(args);
  };

  // Sync editor text whenever instance changes or settings tab opens.
  // We first load the known-preset map and global preset name (so the
  // "Active preset" label and the preset-equal detection are accurate),
  // then decide what to show:
  //   • saved extra_args matches a preset → show *current* preset flags
  //     (so a global preset switch is reflected immediately),
  //   • saved extra_args is genuinely customized → show those,
  //   • no saved extra_args → show current preset flags.
  createEffect(() => {
    const inst = instance();
    if (!inst || mainTab() !== "settings") return;
    const id = activeInstanceId();
    if (!id) return;

    Promise.all([
      getKnownPresetArgs(id).catch(() => ({} as Record<string, string[]>)),
      getSettings().catch(() => null),
    ]).then(([presets, settings]) => {
      setKnownPresets(presets);
      if (settings) setGlobalPreset(settings.gc_preset);

      const userArgs = (inst.java.extra_args || []).filter(a => a.trim());
      const isPresetEqual = userArgs.length === 0 || (() => {
        const cleaned = userArgs.filter(a => !a.startsWith("-Xmx") && !a.startsWith("-Xms"));
        for (const flags of Object.values(presets)) {
          if (cleaned.length === flags.length) {
            const sa = [...cleaned].sort();
            const sb = [...flags].sort();
            if (sa.every((v, i) => v === sb[i])) return true;
          }
        }
        return false;
      })();

      if (!isPresetEqual && userArgs.length > 0) {
        setExtraArgsText(userArgs.join("\n"));
      } else {
        // Preset-equal or empty — render current preset flags so the editor
        // tracks the global setting live.
        getPresetJvmArgs(id).then((args) => {
          const filtered = args.filter(a => !a.startsWith("-Xmx") && !a.startsWith("-Xms"));
          setExtraArgsText(filtered.join("\n"));
        }).catch(() => {});
      }
    });
  });

  // Line-number gutter
  const lineNumbers = (): number[] => {
    const text = extraArgsText();
    const count = Math.max(text.split("\n").length, 1);
    return Array.from({ length: count }, (_, i) => i + 1);
  };

  // Space → newline so each flag lives on its own line
  const handleArgsKeyDown = (e: KeyboardEvent) => {
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      const ta = e.currentTarget as HTMLTextAreaElement;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = ta.value.slice(0, start) + "\n" + ta.value.slice(end);
      setExtraArgsText(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 1;
      });
    }
  };

  const handleArgsBlur = async () => {
    const inst = instance();
    if (!inst) return;
    const args = extraArgsText().split(/\s+/).filter(a => a.trim());
    // If the user's flags exactly match a known preset, save empty
    // `extra_args` instead. The launch path treats empty extras as "use the
    // global preset" — keeping it empty means switching the global preset
    // in Settings actually takes effect on next launch instead of being
    // shadowed forever by stale preset-equal extras.
    const argsToSave = matchesAnyPreset(args) ? [] : args;
    try {
      await updateInstanceOptions(inst.id, { extraArgs: argsToSave });
      await refetchInstances();
      // Keep the editor visually unchanged regardless of what we persisted.
      setExtraArgsText(args.join("\n"));
    } catch (err) {
      console.error("Save extra args failed:", err);
      showToast({ title: "Failed to save Java arguments", message: String(err), type: "error" });
    }
  };

  const totalPages = () => Math.max(1, Math.ceil(totalHits() / viewCount()));

  // Load files when tab switches
  createEffect(() => {
    if (mainTab() === "files" && instance()) {
      loadFiles();
    }
  });

  createEffect(() => {
    if (mainTab() === "worlds" && instance()) {
      loadWorlds();
    }
  });

  // Logs are streamed into a global buffer (`gameLogs` in App.tsx) so
  // they persist across screen navigation. Subscribing to the
  // `game-log` event happens once at App level — no per-screen listener
  // needed here.
  //
  // Logs persist for the lifetime of the launcher session — so users can
  // exit Minecraft, switch back to the Logs tab, and still review the
  // output from the play session that just ended. The in-memory log buffer
  // is naturally wiped when the launcher itself exits (signals don't
  // persist), which is exactly the "fresh start on relaunch" behavior we
  // want without explicit work here.

  // Auto-scroll is handled by the .log-viewer-frame ref callback below
  // (scroll listener + MutationObserver gated on autoScrollLogs). No separate
  // effect here — a second mechanism would fight the user's scroll intent.

  createEffect(() => {
    if (mainTab() === "content" && contentTab() === "browse") {
      const _filter = browseFilter(); // track category changes
      if (instance()) {
        setSearchResults([]);
        setCurrentPage(1);
        doSearch(1);
      }
    }
  });

  /**
   * Auto-correct the browse category when entering Browse mode on a loader
   * that doesn't support the current selection. Triggered when the user:
   *   • opens Browse on a vanilla instance for the first time (default
   *     `browseFilter` is "mod" but mods are unavailable on vanilla)
   *   • switches to an instance whose loader can't run the previously
   *     selected category
   * Runs whenever any of those signals change.
   */
  createEffect(() => {
    const inst = instance();
    if (!inst) return;
    if (mainTab() !== "content" || contentTab() !== "browse") return;
    if (!isCategoryAvailable(browseFilter(), inst.loader.type)) {
      setBrowseFilter(firstAvailableCategory(inst.loader.type));
    }
  });

  /**
   * Same auto-correction for the Installed-tab filter — keeps users on a
   * usable category when they switch instances.
   */
  createEffect(() => {
    const inst = instance();
    if (!inst) return;
    if (mainTab() !== "content" || contentTab() !== "installed") return;
    const f = installedFilter();
    if (f !== "all" && !isCategoryAvailable(f, inst.loader.type)) {
      setInstalledFilter("all");
    }
  });

  const loadFiles = async () => {
    const inst = instance();
    if (!inst) return;
    try {
      const result = await listInstanceFiles(inst.id, filePath());
      setFiles(result);
    } catch (e) { console.error(e); }
  };

  const loadWorlds = async () => {
    const inst = instance();
    if (!inst) return;
    try {
      const result = await listInstanceWorlds(inst.id);
      setWorlds(result);
    } catch (e) { console.error(e); }
  };

  const navigateToFolder = (path: string) => {
    setFilePath(path);
    loadFiles();
  };

  const navigateUp = () => {
    const current = filePath();
    if (!current) return;
    const parts = current.split("/");
    parts.pop();
    setFilePath(parts.length > 0 ? parts.join("/") : undefined);
    loadFiles();
  };

  let searchTimeout: number | undefined;
  let pageTimeout: number | undefined;

  const doSearch = async (page?: number) => {
    const inst = instance();
    if (!inst) return;
    const p = page || currentPage();
    const offset = (p - 1) * viewCount();
    setSearching(true);
    try {
      // For resources/shaders, allow user to override version (empty = any version)
      const filter = browseFilter();
      const version = (filter === "resourcepack" || filter === "shader") && browseVersion()
        ? browseVersion()
        : inst.game_version;

      let result;
      if (modSource() === "curseforge") {
        result = await searchCurseforge(searchQuery(), inst.loader.type, version, offset, viewCount(), sortBy(), filter);
      } else {
        result = await searchMods(searchQuery(), inst.loader.type, version, offset, viewCount(), sortBy(), filter);
      }

      if (currentPage() === p) {
        setSearchResults(result.hits);
        setTotalHits(result.total_hits);
      }
    } catch (e) { console.error("Search failed:", e); }
    finally { setSearching(false); }
  };

  const handleSourceToggle = () => {
    setModSource(modSource() === "modrinth" ? "curseforge" : "modrinth");
    setSearchResults([]);
    setCurrentPage(1);
    doSearch(1);
  };

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    setCurrentPage(1);
    clearTimeout(searchTimeout);
    searchTimeout = window.setTimeout(() => doSearch(1), 300);
  };

  const handleSortChange = (sort: string) => { setSortBy(sort); setCurrentPage(1); doSearch(1); };
  const handleViewChange = (count: number) => { setViewCount(count); setCurrentPage(1); doSearch(1); };

  const goToPage = (page: number) => {
    if (page < 1 || page > totalPages()) return;
    setCurrentPage(page);
    clearTimeout(pageTimeout);
    pageTimeout = window.setTimeout(() => {
      doSearch(page);
    }, 150); // Debounce rapid slider changes
  };

  // Push pagination state into the dock when the browse tab is active and
  // there are multiple pages. Clear it otherwise so the dock hides the controls.
  createEffect(() => {
    if (mainTab() === "content" && contentTab() === "browse" && totalPages() > 1) {
      setDockPagination({ current: currentPage(), total: totalPages(), onPageChange: goToPage });
    } else {
      setDockPagination(null);
    }
  });

  const handleInstallMod = async (mod: ModHit) => {
    const inst = instance();
    if (!inst) return;
    setInstalling(mod.project_id);
    const dlId = trackDownload(mod.title, browseFilter(), {
      iconUrl: mod.icon_url,
      loader: inst.loader.type,
      gameVersion: inst.game_version,
      author: mod.author,
    });
    try {
      const resultJson = modSource() === "curseforge"
        ? await installCfModToInstance(inst.id, mod.project_id, inst.loader.type, inst.game_version, browseFilter())
        : await installModToInstance(inst.id, mod.project_id, inst.loader.type, inst.game_version, browseFilter());
      setLocalInstalled(prev => { const s = new Set(prev); s.add(mod.project_id); return s; });
      try {
        const result = JSON.parse(resultJson);
        const depsInstalled: number = result.deps_installed ?? 0;
        const depTitles: string[] = result.dep_titles ?? [];
        const depIssues: DependencyIssue[] = result.issues ?? [];
        if (depsInstalled > 0) {
          // Show up to 3 dep titles inline; fall back to count for the rest.
          const preview = depTitles.slice(0, 3).join(", ");
          const more = depTitles.length > 3 ? ` +${depTitles.length - 3} more` : "";
          const message = depTitles.length > 0
            ? `${mod.title} with ${preview}${more}`
            : `${mod.title} (+${depsInstalled} dep${depsInstalled === 1 ? "" : "s"})`;
          completeDownload(dlId, message);
          showToast({ title: "Installed", message, type: "success", autoCloseMs: 4000 });
        } else {
          completeDownload(dlId);
          showToast({ title: "Installed", message: mod.title, type: "success", autoCloseMs: 3000 });
        }
        // Show structured per-dep modal for missing/incompatible/failed deps.
        if (depIssues.length > 0) {
          reportDependencyIssues(mod.title, depIssues);
        }
      } catch {
        completeDownload(dlId);
        showToast({ title: "Installed", message: mod.title, type: "success", autoCloseMs: 3000 });
      }
    } catch (e: any) {
      failDownload(dlId);
      showToast({ title: "Install failed", message: typeof e === "string" ? e : (e?.message || "Unknown error"), type: "error", autoCloseMs: 5000 });
    } finally { setInstalling(null); }
  };

  const toggleSelectItem = (mod: ModHit) => {
    const map = new Map(selectedItems());
    if (map.has(mod.project_id)) {
      map.delete(mod.project_id);
    } else {
      map.set(mod.project_id, { mod, category: browseFilter() });
    }
    setSelectedItems(map);
  };

  /// Apply an available update for a single Modrinth-sourced mod. Reuses the
  /// install-flow's structured error envelope so any compatibility issues
  /// during the dependency walk are surfaced through the existing modal.
  const handleUpdateMod = async (projectId: string, modTitle: string) => {
    const inst = instance();
    if (!inst) return;
    setUpdatingMod(projectId);
    try {
      const resultJson = await applyModUpdate(inst.id, projectId);
      // Clear the pill optimistically; the next refresh confirms.
      setModUpdates(prev => {
        const next = new Map(prev);
        next.delete(projectId);
        return next;
      });
      try {
        const result = JSON.parse(resultJson);
        const issues: DependencyIssue[] = result.issues ?? [];
        if (issues.length > 0) {
          reportDependencyIssues(modTitle, issues);
        }
      } catch {
        // Older command shape — ignore.
      }
      await refetchInstances();
      showToast({ title: "Updated", message: modTitle, type: "success", autoCloseMs: 3000 });
      // Re-check in case the update introduced new mods that themselves have
      // pending updates (rare but possible with deep dep trees).
      refreshUpdates();
    } catch (e: any) {
      showToast({
        title: "Update failed",
        message: typeof e === "string" ? e : (e?.message || "Unknown error"),
        type: "error",
        autoCloseMs: 5000,
      });
    } finally {
      setUpdatingMod(null);
    }
  };

  const handleBulkInstall = async () => {
    const inst = instance();
    if (!inst) return;
    const items = Array.from(selectedItems().values());
    if (items.length === 0) return;

    setBulkInstalling(true);
    setSelectMode(false);
    setSelectedItems(new Map());

    // Track all items upfront so toast shows correct total
    const dlIds: { dlId: string; mod: ModHit; category: string }[] = [];
    for (const { mod, category } of items) {
      const dlId = trackDownload(mod.title, category, {
        iconUrl: mod.icon_url,
        loader: inst.loader.type,
        gameVersion: inst.game_version,
      });
      dlIds.push({ dlId, mod, category });
    }
    startBulkBatch(items.length);

    // Aggregate dependency issues across the whole batch so the modal at the
    // end lists everything in one place rather than firing per-item.
    const aggregateIssues: DependencyIssue[] = [];

    // Process items sequentially to avoid rate limits and instance.json race conditions
    for (const { dlId, mod, category } of dlIds) {
      try {
        const resultJson = modSource() === "curseforge"
          ? await installCfModToInstance(inst.id, mod.project_id, inst.loader.type, inst.game_version, category)
          : await installModToInstance(inst.id, mod.project_id, inst.loader.type, inst.game_version, category);
        setLocalInstalled(prev => { const s = new Set(prev); s.add(mod.project_id); return s; });
        completeDownload(dlId);
        try {
          const result = JSON.parse(resultJson);
          const depIssues: DependencyIssue[] = result.issues ?? [];
          aggregateIssues.push(...depIssues);
        } catch {
          // resultJson might not be valid JSON for older command shapes — ignore
        }
      } catch (e: any) {
        failDownload(dlId);
        console.error(`Bulk install failed for ${mod.title}:`, e);
      }
    }

    endBulkBatch();
    setBulkInstalling(false);
    await refetchInstances();
    showToast({ title: "Bulk install complete", message: `${items.length} items installed`, type: "success", autoCloseMs: 4000 });

    // Surface every issue collected during the batch in one modal.
    if (aggregateIssues.length > 0) {
      reportDependencyIssues(`${items.length} items`, aggregateIssues);
    }
  };

  // Note: launching/stopping is now handled by the floating dock's center
  // button (`FloatingDock.tsx`). The previous inline play/stop button on
  // the instance context bar has been removed.

  const isModInstalled = (projectId: string): boolean => localInstalled().has(projectId) || (instance()?.mods.some(m => m.project_id === projectId) || false);
  const formatDownloads = (n: number): string => {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
    return n.toString();
  };
  const formatSize = (bytes: number): string => {
    if (bytes >= 1_000_000) return (bytes / 1_000_000).toFixed(1) + " MB";
    if (bytes >= 1_000) return (bytes / 1_000).toFixed(1) + " KB";
    return bytes + " B";
  };

  /// Format a project's supported MC versions as a card badge. Modrinth's
  /// `versions[]` field is sorted oldest first. Filter out pre-release noise
  /// and show a range when there are several.
  const formatVersionRange = (versions: string[] | undefined): string => {
    if (!versions || versions.length === 0) return "";
    const releases = versions.filter(v => /^\d+(\.\d+)*$/.test(v));
    const list = releases.length > 0 ? releases : versions;
    if (list.length === 1) return list[0];
    return `${list[0]}–${list[list.length - 1]}`;
  };

  /// Loaders we recognize on Modrinth project `categories`. Modrinth bundles
  /// loader IDs into the same array as content categories, so we filter to
  /// just the loader subset for the badge row.
  const KNOWN_LOADERS = new Set(["fabric", "forge", "neoforge", "quilt", "datapack", "iris", "optifine", "vanilla"]);

  /// Extract every loader a project supports from its `categories` array.
  /// Returns them in a stable order so a project that supports both Fabric and
  /// Quilt always renders Fabric first. Empty when no known loader is present.
  const LOADER_ORDER = ["fabric", "quilt", "forge", "neoforge", "datapack", "iris", "optifine", "vanilla"];
  const extractLoaders = (categories: string[]): string[] => {
    const found = new Set<string>();
    for (const c of categories) {
      if (KNOWN_LOADERS.has(c)) found.add(c);
    }
    // For shaders on CurseForge, "vanilla" appears as a category but isn't
    // meaningful as a loader badge — CF doesn't track iris/optifine support.
    // Drop it so the card doesn't show a misleading "vanilla" pill.
    if (browseFilter() === "shader" && modSource() === "curseforge") {
      found.delete("vanilla");
    }
    return LOADER_ORDER.filter(l => found.has(l));
  };

  const toggleLogFilter = (filter: string) => {
    const current = new Set(logFilters());
    if (filter === "all") {
      setLogFilters(new Set(["all"]));
      return;
    }
    current.delete("all");
    if (current.has(filter)) {
      current.delete(filter);
      if (current.size === 0) current.add("all");
    } else {
      current.add(filter);
    }
    setLogFilters(current);
  };

  const filteredLogs = () => {
    const filters = logFilters();
    const search = logSearch().trim().toLowerCase();

    let lines = logs();
    if (!filters.has("all")) {
      lines = lines.filter(l => {
        if (filters.has("error") && (l.includes("ERROR") || l.includes("FATAL"))) return true;
        if (filters.has("warn") && (l.includes("WARN") || l.includes("WARNING"))) return true;
        if (filters.has("info") && l.includes("INFO")) return true;
        return false;
      });
    }
    if (search) {
      lines = lines.filter(l => l.toLowerCase().includes(search));
    }
    return lines;
  };

  return (
    <div class="screen-enter">
      <Show when={instance()} fallback={
        <div style="text-align:center;color:var(--muted);padding:40px;font-size:13px">
          <div style="margin-bottom:8px">No instance selected.</div>
          <button class="btn" onClick={() => setActiveScreen("home")}>← Go to Home</button>
        </div>
      }>
      {/* Context bar */}
      <div class="inst-context-bar">
        <button class="btn btn-ghost" style="padding:3px 7px;font-size:12px" onClick={() => setActiveScreen("library")}>
          <IconArrowLeft />
        </button>
        <span style="font-size:13px;font-weight:600;color:var(--text)">{instance()?.name}</span>
        <Show when={instance()?.loader.type !== "vanilla"}>
          <span class={`ctx-badge badge-${instance()?.loader.type === "neoforge" ? "neo" : instance()?.loader.type}`}>
            {instance()?.loader.type}
          </span>
        </Show>
        <span class="ctx-badge" style="background:var(--bg4);color:var(--muted)">{instance()?.game_version}</span>
        <Show when={(instance()?.source_platforms || []).includes("modrinth")}>
          <span class="ctx-badge badge-source-mr" title="Available on Modrinth"><IconModrinth /></span>
        </Show>
        <Show when={(instance()?.source_platforms || []).includes("curseforge")}>
          <span class="ctx-badge badge-source-cf" title="Available on CurseForge"><IconCurseForge /></span>
        </Show>

        <div class="ctx-action-group">
          <div class="ctx-tabs">
            <div class={`ctx-tab ${mainTab() === "content" ? "active" : ""}`} onClick={() => setMainTab("content")}>Content</div>
            <div class={`ctx-tab ${mainTab() === "files" ? "active" : ""}`} onClick={() => setMainTab("files")}>Files</div>
            <div class={`ctx-tab ${mainTab() === "worlds" ? "active" : ""}`} onClick={() => setMainTab("worlds")}>Worlds</div>
            <div class={`ctx-tab ${mainTab() === "logs" ? "active" : ""}`} onClick={() => setMainTab("logs")}>Logs</div>
            <div class={`ctx-tab ${mainTab() === "settings" ? "active" : ""}`} onClick={() => setMainTab("settings")}>⚙</div>
          </div>
          {/* Play/Stop control lives in the floating dock now (the center
              FAB). Removed from here to avoid duplicating the action and
              freeing up horizontal space in the context bar. */}
        </div>
      </div>

      {/* Instance Settings Tab */}
      <Show when={mainTab() === "settings"}>
        <div>
          <div class="section-label">Instance Options</div>

          {/* Icon picker. Lets the user replace the auto-fetched modpack
              icon (or default placeholder) with their own image. The
              file dialog is filtered to common raster image types. The
              reset button only shows when there's something to reset to —
              if the instance is on the default `"cube"` sentinel, the
              "Reset" affordance would be a no-op so we hide it. */}
          <div class="settings-group" style="margin-bottom:16px">
            <div class="settings-row">
              <div style="display:flex;gap:14px;align-items:center;flex:1;min-width:0">
                <div class="instance-icon-preview">
                  <Show
                    when={instance() && instance()!.icon !== "cube"}
                    fallback={<span class="instance-icon-placeholder">{(instance()?.name ?? "?").trim().charAt(0).toUpperCase() || "?"}</span>}
                  >
                    <img
                      src={instance()!.icon}
                      alt=""
                      draggable={false}
                    />
                  </Show>
                </div>
                <div style="min-width:0">
                  <div class="settings-key">Instance icon</div>
                  <div class="settings-val">PNG, JPG, or WebP. Shown on Library cards and sidebar pins.</div>
                </div>
              </div>
              <div style="display:flex;gap:8px;flex-shrink:0">
                <button
                  class="btn"
                  style="font-size:11px"
                  onClick={async () => {
                    const inst = instance();
                    if (!inst) return;
                    const picked = await openDialog({
                      multiple: false,
                      directory: false,
                      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
                    });
                    if (!picked || typeof picked !== "string") return;
                    try {
                      await setInstanceIcon(inst.id, picked);
                      await refetchInstances();
                      showToast({ title: "Icon updated", message: "", type: "success", autoCloseMs: 2000 });
                    } catch (e) {
                      showToast({ title: "Couldn't set icon", message: String(e), type: "error" });
                    }
                  }}
                >
                  Change icon
                </button>
                <Show when={instance() && instance()!.icon !== "cube"}>
                  <button
                    class="btn btn-ghost"
                    style="font-size:11px"
                    onClick={async () => {
                      const inst = instance();
                      if (!inst) return;
                      try {
                        await clearInstanceIcon(inst.id);
                        await refetchInstances();
                        showToast({ title: "Icon reset", message: "", type: "info", autoCloseMs: 2000 });
                      } catch (e) {
                        showToast({ title: "Couldn't reset icon", message: String(e), type: "error" });
                      }
                    }}
                  >
                    Reset
                  </button>
                </Show>
              </div>
            </div>
          </div>

          {/* Memory */}
          <div class="settings-group" style="margin-bottom:16px">
            <div class="settings-row">
              <div>
                <div class="settings-key">Memory allocated</div>
                <div class="settings-val">RAM assigned to this instance</div>
              </div>
              <div class="memory-slider-wrap">
                <div class="memory-slider-track-wrap">
                  <div class="memory-slider-dots">
                    {(() => {
                      const max = Math.max((systemMemoryMb() || 16384) - 2048, 4096);
                      const dots = [];
                      for (let gb = 4096; gb <= max; gb += 4096) {
                        const pct = ((gb - 512) / (max - 512)) * 100;
                        const current = memoryValue();
                        dots.push(
                          <div
                            class="memory-dot"
                            classList={{ filled: gb <= current }}
                            style={{ left: `${pct}%` }}
                          />
                        );
                      }
                      return dots;
                    })()}
                  </div>
                  <input
                    type="range"
                    class="memory-slider"
                    min={512}
                    max={Math.max((systemMemoryMb() || 16384) - 2048, 4096)}
                    step={256}
                    value={memoryValue()}
                    style={{
                      "--slider-pct": `${((memoryValue() - 512) / (Math.max((systemMemoryMb() || 16384) - 2048, 4096) - 512)) * 100}%`
                    }}
                    onInput={(e) => {
                      const inst = instance();
                      if (!inst) return;
                      const val = parseInt(e.currentTarget.value);
                      const snapped = Math.round(val / 512) * 512 || 512;
                      e.currentTarget.value = String(snapped);
                      // Update the gradient fill synchronously so the thumb
                      // tracks instantly, bypassing Solid's render queue.
                      // Without this, fast scrubs look laggy because the
                      // fill repaint waits for the next render tick.
                      const max = Math.max((systemMemoryMb() || 16384) - 2048, 4096);
                      e.currentTarget.style.setProperty('--slider-pct', `${((snapped - 512) / (max - 512)) * 100}%`);
                      // Update local signal synchronously so display follows the thumb.
                      setMemoryDraft(snapped);
                      // Debounce the actual IPC save — firing one save per
                      // drag tick races on instance.json reads/writes.
                      commitMemory(inst.id, snapped);
                    }}
                  />
                </div>
                <div class="memory-slider-labels">
                  <span>512 MB</span>
                  <span class="memory-slider-value">{(memoryValue() / 1024).toFixed(1).replace('.0', '')} GB</span>
                  <span>{Math.round(Math.max((systemMemoryMb() || 16384) - 2048, 4096) / 1024)} GB</span>
                </div>
                <div class={`memory-hint ${memoryHintLevel(memoryValue())}`}>
                  {memoryHintText(memoryValue())}
                </div>
              </div>
            </div>
          </div>

          {/* Java arguments — single editable code-editor panel.
              Shows the GC preset flags pre-filled (editable). Whatever is
              in here at blur time is saved and used at launch — the user
              can delete, modify, or add any flag. Memory args (-Xmx/-Xms)
              are excluded since the slider handles those. */}
          <div class="settings-group" style="margin-bottom:16px">
            <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:6px">
              <div class="settings-key">Java arguments</div>
              <div class="java-args-panel">
                <div class="java-args-panel-header" style="display:flex;align-items:center;gap:8px">
                  <span>JVM flags (one per line · space = new line)</span>
                  {/* Active preset indicator. Reads the global GC preset from
                      Settings and labels it the same way the dropdown there
                      does, so users always know which preset is feeding the
                      flags below. When the user edits the flags into a
                      genuinely-custom set, an extra "custom" tag flips on
                      so the indicator doesn't lie about what's launching. */}
                  <span style="margin-left:auto;display:flex;align-items:center;gap:6px;text-transform:none;letter-spacing:0;font-weight:500;font-size:10px;color:var(--muted)">
                    <span>Active preset:</span>
                    <strong style="color:var(--text);font-weight:600">{presetLabel(globalPreset())}</strong>
                    <Show when={!isCurrentlyPreset()}>
                      <span style="color:var(--accent);font-weight:600">· custom</span>
                    </Show>
                  </span>
                </div>
                <div class="code-editor">
                  <div class="code-editor-gutter" ref={(el) => (gutterRef = el)}>
                    <For each={lineNumbers()}>
                      {(n) => <span>{n}</span>}
                    </For>
                  </div>
                  <textarea
                    class="code-editor-input"
                    spellcheck={false}
                    placeholder={"Flags from your GC preset will appear here.\nEdit freely — these are what's passed at launch."}
                    value={extraArgsText()}
                    onInput={(e) => setExtraArgsText(e.currentTarget.value)}
                    onKeyDown={handleArgsKeyDown}
                    onBlur={handleArgsBlur}
                    onScroll={(e) => {
                      if (gutterRef) gutterRef.scrollTop = e.currentTarget.scrollTop;
                    }}
                  />
                </div>
              </div>
              <div class="settings-val">
                Pre-filled from your GC preset. Edit, add, or remove any flag — what's here is exactly what's passed to the JVM (memory comes from the slider above).
              </div>
            </div>
          </div>

          {/* Clone — duplicate the entire instance (mods, configs, worlds)
              into a new entry. Sits above the Danger Zone since it's a safe
              action; uses an accent button so it reads as "do something". */}
          <div style="margin-top:20px;border-top:1px solid var(--border);padding-top:16px">
            <div class="section-label">Clone instance</div>
            <div style="display:flex;align-items:center;gap:10px">
              <span style="font-size:12px;color:var(--muted);flex:1">
                Make a copy with the same loader, mods, configs, and worlds. Useful for testing changes without breaking your main setup.
              </span>
              <button
                class="btn btn-accent"
                style="font-size:11px;white-space:nowrap"
                disabled={cloning()}
                onClick={async () => {
                  const inst = instance();
                  if (!inst) return;
                  setCloning(true);
                  try {
                    const cloned = await cloneInstance(inst.id);
                    await refetchInstances();
                    showToast({
                      title: "Instance cloned",
                      message: `Created "${cloned.name}".`,
                      type: "success",
                      autoCloseMs: 3500,
                    });
                  } catch (e: any) {
                    showToast({
                      title: "Clone failed",
                      message: typeof e === "string" ? e : (e as Error).message ?? "Unknown error",
                      type: "error",
                      autoCloseMs: 6000,
                    });
                  } finally {
                    setCloning(false);
                  }
                }}
              >
                {cloning() ? "Cloning..." : "Clone"}
              </button>
            </div>
          </div>

          {/* Danger zone */}
          <div style="margin-top:20px;border-top:1px solid var(--border);padding-top:16px">
            <div class="section-label" style="color:#e05252">Danger Zone</div>
            <Show when={!deleteConfirm()} fallback={
              <div style="display:flex;flex-direction:column;gap:8px">
                <span style="font-size:12px;color:#e05252">Type <strong>Confirm</strong> to delete this instance permanently.</span>
                <div style="display:flex;gap:8px;align-items:center">
                  <input class="search-input" style="max-width:160px;border-color:#e05252" placeholder="Type Confirm"
                    onInput={(e) => setDeleteCountdown(e.currentTarget.value === "Confirm" ? 0 : 1)} />
                  <button class="btn" style="font-size:11px;color:#e05252;border-color:#e05252" disabled={deleteCountdown() !== 0}
                    onClick={async () => { const inst = instance(); if (!inst) return; await deleteInstance(inst.id); await refetchInstances(); refreshPinnedInstanceIds().catch(() => {}); setActiveScreen("library"); }}>Delete</button>
                  <button class="btn btn-ghost" style="font-size:11px" onClick={() => setDeleteConfirm(false)}>Cancel</button>
                </div>
              </div>
            }>
              <button class="btn" style="font-size:11px;color:#e05252;border-color:#e05252"
                onClick={async () => {
                  const settings = await getSettings();
                  if (settings.force_delete) {
                    const inst = instance();
                    if (!inst) return;
                    await deleteInstance(inst.id);
                    await refetchInstances();
                    refreshPinnedInstanceIds().catch(() => {});
                    setActiveScreen("library");
                  } else {
                    setDeleteConfirm(true);
                    setDeleteCountdown(1);
                  }
                }}>
                Delete Instance
              </button>
            </Show>
          </div>
        </div>
      </Show>

      {/* ═══ CONTENT TAB ═══ */}
      <Show when={mainTab() === "content"}>
        {/* Mode toggle */}
        <div class="src-tabs" style="margin-bottom:8px">
          <div class={`src-tab ${contentTab() === "installed" ? "active" : ""}`} onClick={() => { setContentTab("installed"); refetchInstances(); }}>Installed</div>
          <div class={`src-tab ${contentTab() === "browse" ? "active" : ""}`} onClick={() => setContentTab("browse")}>Browse</div>
        </div>

        {/* Category filter */}
        <Show when={contentTab() === "installed"}>
          <div class="installed-filter-row">
            <div class="src-tabs" style="margin-bottom:0;flex:1">
              {(() => {
                const loader = () => instance()?.loader.type ?? "vanilla";
                const filter = (cat: "all" | "mod" | "resourcepack" | "shader" | "datapack", label: string, count: () => number) => {
                  if (cat !== "all" && !isCategoryAvailable(cat, loader())) return null;
                  return (
                    <div
                      class={`src-tab ${installedFilter() === cat ? "active" : ""}`}
                      onClick={() => setInstalledFilter(cat)}
                    >
                      {label}{count() > 0 ? ` (${count()})` : ""}
                    </div>
                  );
                };
                return (
                  <>
                    {filter("all", "All", () => instance()?.mods.length || 0)}
                    {filter("mod", "Mods", () => (instance()?.mods || []).filter(m => !(m as any).category || (m as any).category === "mod").length)}
                    {filter("resourcepack", "Resources", () => (instance()?.mods || []).filter(m => (m as any).category === "resourcepack").length)}
                    {filter("shader", "Shaders", () => (instance()?.mods || []).filter(m => (m as any).category === "shader").length)}
                    {filter("datapack", "Datapacks", () => (instance()?.mods || []).filter(m => (m as any).category === "datapack").length)}
                  </>
                );
              })()}
            </div>
            {/* Bulk-delete button — scope follows the active filter. "All" wipes
                everything, otherwise only the matching category. */}
            <button
              class="btn btn-danger-icon tip-below tip-left"
              data-tip={installedFilter() === "all" ? "Delete all content" : `Delete all ${installedFilter()}s`}
              disabled={(() => {
                const mods = instance()?.mods || [];
                if (installedFilter() === "all") return mods.length === 0;
                return mods.filter(m => ((m as any).category || "mod") === installedFilter()).length === 0;
              })()}
              onClick={() => setShowBulkDelete(true)}
            >
              <IconTrash />
            </button>
          </div>
          {/* Search + sort row — applies on top of the category filter above. */}
          <div class="installed-search-row">
            <input
              class="search-input"
              style="flex:1"
              placeholder="Search installed content..."
              value={installedSearch()}
              onInput={(e) => setInstalledSearch(e.currentTarget.value)}
            />
            <select
              class="control-select"
              value={installedSort()}
              onChange={(e) => setInstalledSort(e.currentTarget.value as "newest" | "oldest")}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
            {/* Manual refresh — the auto-check runs on tab activation but the
                user may want to re-check after publishing schedules they know
                about (e.g. Sodium just dropped a release). Spinner during the
                check; does nothing while one is already in flight. */}
            <button
              class="btn"
              style="font-size:11px;padding:6px 10px;white-space:nowrap"
              disabled={checkingUpdates() || (instance()?.mods.length ?? 0) === 0}
              onClick={() => refreshUpdates(true)}
              title="Check Modrinth for newer versions of every installed item"
            >
              {checkingUpdates() ? "Checking..." : "Check updates"}
            </button>
          </div>
        </Show>
        <Show when={contentTab() === "browse"}>
          {/* Browse category tabs. Tabs for categories that aren't usable
              on the current loader (mods/shaders on vanilla) are hidden
              entirely to avoid clutter and confusion. */}
          <div class="src-tabs" style="margin-bottom:12px">
            {(() => {
              const loader = () => instance()?.loader.type ?? "vanilla";
              const tab = (cat: "mod" | "resourcepack" | "shader" | "datapack", label: string) => {
                if (!isCategoryAvailable(cat, loader())) return null;
                return (
                  <div
                    class={`src-tab ${browseFilter() === cat ? "active" : ""}`}
                    onClick={() => setBrowseFilter(cat)}
                  >
                    {label}{browseFilter() === cat && totalHits() > 0 ? ` (${totalHits().toLocaleString()})` : ""}
                  </div>
                );
              };
              return (
                <>
                  {tab("mod", "Mods")}
                  {tab("resourcepack", "Resources")}
                  {tab("shader", "Shaders")}
                  {tab("datapack", "Datapacks")}
                </>
              );
            })()}
          </div>
        </Show>

        <Show when={contentTab() === "installed"}>
          <Show when={(instance()?.mods.length || 0) === 0}>
            <div style="text-align:center;color:var(--muted);padding:30px;font-size:12px">No content installed. Switch to "Browse mods" to find some.</div>
          </Show>
          <Show when={showBulkDelete()}>
            <div class="bulk-delete-confirm">
              <div style="font-size:12px;color:#e05252;margin-bottom:8px">
                {(() => {
                  const f = installedFilter();
                  const mods = instance()?.mods || [];
                  const count = f === "all"
                    ? mods.length
                    : mods.filter(m => ((m as any).category || "mod") === f).length;
                  const label = f === "all" ? "all content entries" : `all ${f}s`;
                  return `Delete ${count} ${label}? Files will be removed from disk.`;
                })()}
              </div>
              <div style="display:flex;gap:8px">
                <button class="btn" style="font-size:11px;color:#e05252;border-color:#e05252" onClick={async () => {
                  const inst = instance();
                  if (!inst) return;
                  setShowBulkDelete(false);
                  try {
                    const removed = await removeAllContent(inst.id, installedFilter());
                    await refetchInstances();
                    showToast({
                      title: "Content deleted",
                      message: `Removed ${removed} ${removed === 1 ? "entry" : "entries"}`,
                      type: "success",
                      autoCloseMs: 3000,
                    });
                  } catch (e: any) {
                    showToast({
                      title: "Delete failed",
                      message: typeof e === "string" ? e : "Unknown error",
                      type: "error",
                      autoCloseMs: 5000,
                    });
                  }
                }}>Delete</button>
                <button class="btn btn-ghost" style="font-size:11px" onClick={() => setShowBulkDelete(false)}>Cancel</button>
              </div>
            </div>
          </Show>
          <div class="mod-grid">
            <For each={(() => {
              const mods = instance()?.mods || [];
              const f = installedFilter();
              const q = installedSearch().trim().toLowerCase();
              const filtered = mods.filter(m => {
                const cat = (m as any).category || "mod";
                if (f !== "all" && cat !== f) return false;
                if (q) {
                  const haystack = ((m.title || m.filename) + " " + (m.description || "")).toLowerCase();
                  if (!haystack.includes(q)) return false;
                }
                return true;
              });
              // Backend pushes new mods to the end of the Vec, so the array is
              // already in install order (oldest → newest). Reverse for newest-first.
              return installedSort() === "newest" ? filtered.slice().reverse() : filtered;
            })()}>
              {(mod) => (
                <div class="mod-card" style={mod.enabled ? "" : "opacity:0.5"}>
                  <div class="mod-card-header">
                    <div class="mod-card-icon" style={`background:${(mod as any).category === "resourcepack" ? "#1a2035" : (mod as any).category === "shader" ? "#251a35" : "#251a35"}`}>
                      <Show when={resolveIconUrl(mod as any)} fallback={
                        <span style="font-size:16px">{(mod as any).category === "resourcepack" ? "🎨" : (mod as any).category === "shader" ? "✨" : "⚡"}</span>
                      }>
                        <img src={resolveIconUrl(mod as any)!} style="width:100%;height:100%;border-radius:6px;object-fit:cover" />
                      </Show>
                    </div>
                    <div class="mod-card-name-wrap">
                      <div class="mod-card-name">{mod.title || mod.filename}</div>
                      <Show when={(mod as any).author}>
                        <div class="mod-card-author">by {(mod as any).author}</div>
                      </Show>
                    </div>
                  </div>
                  <div class="mod-card-desc">{mod.description || ""}</div>
                  {/* Installed cards show the instance's loader + MC version
                      since that's what the file is compatible with — Modrinth
                      doesn't ship a per-mod compatibility tag in the install
                      manifest. Resource packs / shaders only show the MC ver.
                      The optional update pill is rendered alongside so it
                      sits in the user's eye-line right below the title. */}
                  <Show when={instance()}>
                    <div class="mod-card-tags">
                      <Show when={((mod as any).category || "mod") === "mod"}>
                        <span class={`mod-tag mod-tag-loader loader-${instance()!.loader.type}`}>
                          {instance()!.loader.type}
                        </span>
                      </Show>
                      <span class="mod-tag mod-tag-version">{instance()!.game_version}</span>
                      <Show when={modUpdates().has(mod.project_id)}>
                        <button
                          class="mod-tag mod-tag-update"
                          disabled={updatingMod() === mod.project_id}
                          title={`Update to ${modUpdates().get(mod.project_id)?.latest_version_number}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleUpdateMod(mod.project_id, mod.title || mod.filename);
                          }}
                        >
                          {updatingMod() === mod.project_id
                            ? "Updating..."
                            : `↑ ${modUpdates().get(mod.project_id)?.latest_version_number ?? "Update"}`}
                        </button>
                      </Show>
                    </div>
                  </Show>
                  <div class="mod-card-footer">
                    <div class="mod-card-meta">{(mod as any).category || "mod"} · {mod.enabled ? "Enabled" : "Disabled"}</div>
                    <div class="mod-card-actions">
                      <div class={`toggle ${mod.enabled ? "on" : ""}`} style="transform:scale(0.8)" onClick={async () => {
                        const inst = instance();
                        if (!inst) return;
                        await toggleModInInstance(inst.id, mod.id);
                        await refetchInstances();
                      }} />
                      <button class="btn" style="font-size:9px;padding:2px 5px;color:#e05252;border-color:#e05252" onClick={async () => {
                        const inst = instance();
                        if (!inst) return;
                        await removeModFromInstance(inst.id, mod.id);
                        await refetchInstances();
                      }}>✕</button>
                    </div>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={contentTab() === "browse"}>
          <div class="browse-wrapper">
            <div class="search-bar" style="display:flex;gap:8px;align-items:center">
              <button
                class="btn mod-source-toggle"
                onClick={handleSourceToggle}
                title={modSource() === "modrinth" ? "Switch to CurseForge" : "Switch to Modrinth"}
              >
                <Show when={modSource() === "modrinth"} fallback={
                  <span class="mod-source-badge cf"><IconCurseForge /></span>
                }>
                  <span class="mod-source-badge mr"><IconModrinth /></span>
                </Show>
              </button>
              <input class="search-input" style="flex:1" placeholder={modSource() === "modrinth" ? "Search Modrinth..." : "Search CurseForge..."} value={searchQuery()} onInput={(e) => handleSearch(e.currentTarget.value)} />
              <button class={`btn tip-below ${selectMode() ? "btn-active" : ""}`} style="font-size:10px;padding:5px 10px;white-space:nowrap"
                data-tip="Bulk install"
                onClick={() => { setSelectMode(!selectMode()); if (selectMode()) setSelectedItems(new Map()); }}>
                {selectMode() ? `Cancel (${selectedItems().size})` : "Select"}
              </button>
            </div>
            <div class="browse-controls">
              <div class="control-group">
                <span class="control-label">Sort:</span>
                <select class="control-select" value={sortBy()} onChange={(e) => handleSortChange(e.currentTarget.value)}>
                  <For each={SORT_OPTIONS}>{(opt) => <option value={opt.value}>{opt.label}</option>}</For>
                </select>
              </div>
              <div class="control-group">
                <span class="control-label">View:</span>
                <select class="control-select" value={viewCount()} onChange={(e) => handleViewChange(parseInt(e.currentTarget.value))}>
                  <For each={VIEW_OPTIONS}>{(n) => <option value={n}>{n}</option>}</For>
                </select>
              </div>
              <Show when={totalHits() > 0}><span class="control-total"></span></Show>
            </div>
            <div class="filter-hint">
              <svg viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="1.8" style="width:13px;height:13px;flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              <Show when={browseFilter() === "resourcepack" || browseFilter() === "shader"} fallback={
                <>Showing for <strong style="color:var(--accent);margin:0 3px">{instance()?.loader.type}</strong> · <strong style="color:var(--text)">{instance()?.game_version}</strong></>
              }>
                <>Version: <input class="search-input" style="width:80px;padding:2px 6px;font-size:10px;display:inline-block;margin:0 4px" placeholder={instance()?.game_version || "any"} value={browseVersion()} onInput={(e) => { setBrowseVersion(e.currentTarget.value); setCurrentPage(1); clearTimeout(searchTimeout); searchTimeout = window.setTimeout(() => doSearch(1), 400); }} /> <span style="color:var(--muted);font-size:10px">(leave empty for any)</span></>
              </Show>
            </div>
            <Show when={searching()}><div style="text-align:center;color:var(--muted);padding:20px;font-size:12px">Searching...</div></Show>
            <div class="mod-grid">
              <For each={searchResults()}>
                {(mod) => (
                  <div class={`mod-card ${selectMode() && selectedItems().has(mod.project_id) ? "mod-item-selected" : ""}`}
                    onClick={() => selectMode() && !isModInstalled(mod.project_id) ? toggleSelectItem(mod) : undefined}
                    style={selectMode() ? "cursor:pointer" : ""}>
                    <div class="mod-card-header">
                      <div class="mod-card-icon" style="background:#251a35">
                        <Show when={mod.icon_url} fallback={<IconBolt />}>
                          <img src={mod.icon_url!} style="width:100%;height:100%;border-radius:6px;object-fit:cover" />
                        </Show>
                      </div>
                      <div class="mod-card-name-wrap">
                        <div class="mod-card-name">{mod.title}</div>
                        <Show when={mod.author}>
                          <div class="mod-card-author">by {mod.author}</div>
                        </Show>
                      </div>
                    </div>
                    <div class="mod-card-desc">{mod.description}</div>
                    {/* Loader + MC-version badges. We render every supported
                        loader so users can see at a glance whether the
                        project covers their instance's loader. The previous
                        single-pick was misleading because the first loader
                        in `categories` doesn't always match the instance
                        loader. The actual install gate is enforced
                        server-side in `find_preferred_version`. */}
                    <Show when={extractLoaders(mod.categories).length > 0 || mod.versions?.length}>
                      <div class="mod-card-tags">
                        <For each={extractLoaders(mod.categories)}>
                          {(l) => (
                            <span class={`mod-tag mod-tag-loader loader-${l}`}>{l}</span>
                          )}
                        </For>
                        <Show when={mod.versions && mod.versions.length > 0}>
                          <span class="mod-tag mod-tag-version">{formatVersionRange(mod.versions)}</span>
                        </Show>
                      </div>
                    </Show>
                    <div class="mod-card-footer">
                      <div class="mod-card-meta">
                        ↓ {formatDownloads(mod.downloads)} · ♥ {formatDownloads(mod.follows)}
                        <Show when={mod.client_side || mod.server_side}>
                          {" · "}
                          <Show when={mod.client_side === "required" || mod.client_side === "optional"}>
                            <span class="side-icon" title={`Client: ${mod.client_side}`}><IconMonitor /></span>
                          </Show>
                          <Show when={mod.server_side === "required" || mod.server_side === "optional"}>
                            <span class="side-icon" title={`Server: ${mod.server_side}`}><IconGlobe /></span>
                          </Show>
                        </Show>
                      </div>
                      <Show when={isModInstalled(mod.project_id)}>
                        <span class="install-btn installed" style="font-size:10px;padding:3px 8px">Installed</span>
                      </Show>
                      <Show when={!isModInstalled(mod.project_id)}>
                        <Show when={selectMode()} fallback={
                          <button class="install-btn" style="font-size:10px;padding:3px 8px" disabled={installing() === mod.project_id} onClick={() => handleInstallMod(mod)}>
                            {installing() === mod.project_id ? "..." : "+ Install"}
                          </button>
                        }>
                          <div class={`select-check ${selectedItems().has(mod.project_id) ? "checked" : ""}`}>
                            {selectedItems().has(mod.project_id) ? "✓" : ""}
                          </div>
                        </Show>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>
            {/* Bulk install floating bar */}
            <Show when={selectMode() && selectedItems().size > 0 && !bulkInstalling()}>
              <div class="bulk-install-bar">
                <span style="font-size:12px;color:var(--text)">{selectedItems().size} selected</span>
                <button class="install-btn" onClick={handleBulkInstall}>
                  Install {selectedItems().size} items
                </button>
                <button class="btn btn-ghost" style="font-size:11px" onClick={() => setSelectedItems(new Map())}>Clear</button>
              </div>
            </Show>
          </div>
        </Show>
      </Show>

      {/* ═══ FILES TAB ═══ */}
      <Show when={mainTab() === "files"}>
        <div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
            <Show when={filePath()}>
              <button class="btn" style="font-size:11px;padding:4px 10px" onClick={navigateUp}>← Back</button>
            </Show>
            <span style="font-size:11px;color:var(--muted);font-family:var(--font-mono)">
              /{filePath() || ""}
            </span>
            <button class="btn" style="margin-left:auto;font-size:11px;padding:4px 10px" onClick={() => openInstanceFolder(instance()!.id, filePath())}>
              Open in Explorer
            </button>
          </div>
          <div class="mod-list">
            <For each={files()}>
              {(file) => (
                <div class="mod-item" style="cursor:pointer" onClick={() => file.is_dir && navigateToFolder(file.path)}>
                  <div class="mod-icon" style={file.is_dir ? "background:#1a2035" : "background:#1e2024"}>
                    <span style="font-size:14px">{file.is_dir ? "📁" : "📄"}</span>
                  </div>
                  <div class="mod-details">
                    <div class="mod-name">{file.name}</div>
                    <div class="mod-stats">{file.is_dir ? "Folder" : formatSize(file.size)}</div>
                  </div>
                </div>
              )}
            </For>
            <Show when={files().length === 0}>
              <div style="text-align:center;color:var(--muted);padding:30px;font-size:12px">Empty folder</div>
            </Show>
          </div>
        </div>
      </Show>

      {/* ═══ WORLDS TAB ═══ */}
      <Show when={mainTab() === "worlds"}>
        <div>
          <Show when={worlds().length === 0}>
            <div style="text-align:center;color:var(--muted);padding:30px;font-size:12px">No worlds yet. Play the game to create one.</div>
          </Show>
          <div class="mod-list">
            <For each={worlds()}>
              {(world) => (
                <div class="mod-item">
                  <div class="mod-icon" style="background:#251a35">
                    <span style="font-size:16px">🌍</span>
                  </div>
                  <div class="mod-details">
                    <div class="mod-name">{world.name}</div>
                    <div class="mod-stats">{world.game_mode} · {world.size_mb} MB</div>
                  </div>
                  <button class="btn" style="font-size:10px;padding:4px 8px" onClick={() => openInstanceFolder(instance()!.id, `saves/${world.folder_name}`)}>
                    Open
                  </button>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* ═══ LOGS TAB ═══ */}
      <Show when={mainTab() === "logs"}>
        {(() => {
          // Stable handle to the scrollable log element for the jump buttons.
          let viewerEl: HTMLDivElement | undefined;
          const jumpToTop = () => {
            // Reading earlier output → stop following new lines.
            setAutoScrollLogs(false);
            viewerEl?.scrollTo({ top: 0, behavior: "smooth" });
          };
          const jumpToBottom = () => {
            // Returning to latest → resume following.
            setAutoScrollLogs(true);
            if (viewerEl) viewerEl.scrollTo({ top: viewerEl.scrollHeight, behavior: "smooth" });
          };
          return (
            <div style="display:flex;flex-direction:column;height:calc(100vh - 140px)">
              <div class="log-toolbar">
                {/* Filter chips on the left */}
                <div class="log-toolbar-filters">
                  <div class={`log-filter-btn ${logFilters().has("all") ? "active" : ""}`} onClick={() => toggleLogFilter("all")}>All</div>
                  <div class={`log-filter-btn error ${logFilters().has("error") ? "active" : ""}`} onClick={() => toggleLogFilter("error")}>Errors</div>
                  <div class={`log-filter-btn warn ${logFilters().has("warn") ? "active" : ""}`} onClick={() => toggleLogFilter("warn")}>Warnings</div>
                </div>

                {/* Search input — case-insensitive substring match across log lines. */}
                <div class="log-toolbar-search">
                  <span class="log-toolbar-search-icon"><IconSearch /></span>
                  <input
                    class="log-toolbar-search-input"
                    type="text"
                    spellcheck={false}
                    placeholder="Search logs..."
                    value={logSearch()}
                    onInput={(e) => setLogSearch(e.currentTarget.value)}
                  />
                  <Show when={logSearch()}>
                    <button
                      class="log-toolbar-search-clear"
                      onClick={() => setLogSearch("")}
                      title="Clear search"
                    >
                      ✕
                    </button>
                  </Show>
                </div>

                {/* Jump-to-top / jump-to-bottom + line count on the right */}
                <button class="log-toolbar-jump" onClick={jumpToTop} title="Jump to top">
                  <IconArrowUp />
                </button>
                <button class="log-toolbar-jump" onClick={jumpToBottom} title="Jump to latest">
                  <IconArrowDown />
                </button>
                <span class="log-toolbar-count">{filteredLogs().length} lines</span>
              </div>

              <div
                class="log-viewer-frame"
                ref={(el) => {
                  const scroller = el.querySelector<HTMLDivElement>(".log-viewer");
                  if (!scroller) return;
                  viewerEl = scroller;

                  // Track whether the user is at the bottom. When they scroll
                  // up to read earlier output we stop following; when they
                  // return to the bottom we resume. A small threshold absorbs
                  // sub-pixel rounding and the in-flight smooth-scroll.
                  const onScroll = () => {
                    const atBottom =
                      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
                    setAutoScrollLogs(atBottom);
                  };
                  scroller.addEventListener("scroll", onScroll, { passive: true });

                  // On new log lines, snap to bottom only while following.
                  const observer = new MutationObserver(() => {
                    if (autoScrollLogs()) {
                      scroller.scrollTop = scroller.scrollHeight;
                    }
                  });
                  observer.observe(scroller, { childList: true });

                  // Start pinned to the bottom.
                  scroller.scrollTop = scroller.scrollHeight;
                }}
              >
                {/* Log placeholder — Feather-style terminal icon (MIT).
                    Pinned to the frame so it stays centered regardless of log scroll.
                    Disappears as soon as any log line is present. */}
                <Show when={filteredLogs().length === 0}>
                  <div class="log-ascii-backdrop">
                    <svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 24 24" fill="none" stroke="url(#log-grad)" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round">
                      <defs>
                        <linearGradient id="log-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                          <stop offset="0%" stop-color="var(--accent-cyan)" />
                          <stop offset="100%" stop-color="var(--accent)" />
                        </linearGradient>
                      </defs>
                      <rect x="2" y="3" width="20" height="18" rx="2" />
                      <polyline points="7 8 10 11 7 14" />
                      <line x1="13" y1="14" x2="17" y2="14" />
                    </svg>
                  </div>
                </Show>

                <div class="log-viewer">
                  <Show when={filteredLogs().length === 0}>
                    <div class="log-empty-hint">
                      <Show
                        when={gameRunning()}
                        fallback={
                          <Show
                            when={logSearch()}
                            fallback={<span>No logs yet. Launch the game to see output here.</span>}
                          >
                            <span>No matches for "{logSearch()}".</span>
                          </Show>
                        }
                      >
                        <span>Waiting for game output...</span>
                      </Show>
                    </div>
                  </Show>
                  <For each={filteredLogs()}>
                    {(line) => (
                      <div class={`log-line ${line.includes("ERROR") || line.includes("FATAL") ? "log-error" : (line.includes("WARN") || line.includes("WARNING")) ? "log-warn" : ""}`}>
                        {line}
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>
          );
        })()}
      </Show>

      </Show>
    </div>
  );
};

export default InstanceMods;
