import { Component, createSignal, createResource, createEffect, onCleanup, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { setActiveScreen, refetchInstances, refreshPinnedInstanceIds, showToast } from "../App";
import { getGameVersions, getFabricLoaderVersions, getFabricGameVersions, getQuiltLoaderVersions, getQuiltGameVersions, getNeoforgeVersions, getNeoforgeGameVersions, getForgeVersions, getForgeGameVersions, createInstance, prepareInstance, getSettings, companionSupportedVersions } from "../ipc/commands";

const LOADERS = ["vanilla", "fabric", "neoforge", "forge", "quilt"] as const;

const CreateCustom: Component = () => {
  const [name, setName] = createSignal("");
  const [loader, setLoader] = createSignal<string>("vanilla");
  const [gameVersion, setGameVersion] = createSignal("");
  const [loaderVersionMode, setLoaderVersionMode] = createSignal<"stable" | "latest" | "other">("stable");
  const [creating, setCreating] = createSignal(false);
  const [versionDropOpen, setVersionDropOpen] = createSignal(false);
  // Search filter + floating-panel positioning for the version dropdown. The
  // panel is rendered in a Portal with fixed positioning so the modal's
  // scroll container can't clip it (the old in-flow absolute panel got cut off
  // at the modal's bottom edge), and the search box means long version lists
  // don't need scrolling at all.
  const [versionQuery, setVersionQuery] = createSignal("");
  const [triggerRect, setTriggerRect] = createSignal<DOMRect | null>(null);
  let triggerEl: HTMLDivElement | undefined;
  let panelEl: HTMLDivElement | undefined;

  const updateRect = () => { if (triggerEl) setTriggerRect(triggerEl.getBoundingClientRect()); };
  const toggleVersionDrop = () => {
    if (versionDropOpen()) { setVersionDropOpen(false); return; }
    setVersionQuery("");
    updateRect();
    setVersionDropOpen(true);
  };

  // Position the floating panel below the trigger, or above it when there's
  // more room up top (so it never spills off-screen or behind the footer).
  const panelStyle = () => {
    const r = triggerRect();
    if (!r) return "";
    const margin = 4;
    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    const openAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
    const maxH = Math.max(160, Math.min(300, (openAbove ? spaceAbove : spaceBelow) - 12));
    const vert = openAbove
      ? `bottom:${Math.round(window.innerHeight - r.top + margin)}px`
      : `top:${Math.round(r.bottom + margin)}px`;
    return `position:fixed;left:${Math.round(r.left)}px;width:${Math.round(r.width)}px;${vert};max-height:${maxH}px`;
  };

  // While open: close on outside click / Escape, and keep the panel glued to
  // the trigger if the modal scrolls or the window resizes.
  createEffect(() => {
    if (!versionDropOpen()) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelEl?.contains(t) || triggerEl?.contains(t)) return;
      setVersionDropOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setVersionDropOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", updateRect);
    window.addEventListener("scroll", updateRect, true);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", updateRect);
      window.removeEventListener("scroll", updateRect, true);
    });
  });

  const [versions] = createResource(async () => {
    const settings = await getSettings();
    return getGameVersions(settings.show_snapshots);
  });
  const [fabricVersions] = createResource(getFabricLoaderVersions);
  const [fabricGameVersions] = createResource(getFabricGameVersions);
  const [quiltVersions] = createResource(getQuiltLoaderVersions);
  const [quiltGameVersions] = createResource(getQuiltGameVersions);
  const [neoforgeGameVersions] = createResource(getNeoforgeGameVersions);
  const [forgeGameVersions] = createResource(getForgeGameVersions);

  // MC versions the Vermeil companion mod supports for the selected loader, so
  // we can mark them in the dropdown. Re-fetches when the loader changes.
  const [companionVersions] = createResource(() => loader(), (l) => companionSupportedVersions(l));
  const isCompanionSupported = (id: string) => !!id && (companionVersions() || []).includes(id);

  // Check if selected MC version is a legacy Fabric version (pre-1.14)
  const isLegacyVersion = () => {
    const gv = selectedGameVersion();
    const parts = gv.split(".");
    if (parts[0] !== "1") return false;
    if (parts.length < 2) return true;
    return parseInt(parts[1]) < 14;
  };

  // Filter game versions based on selected loader
  const gameVersionList = () => {
    const all = versions() || [];
    const l = loader();
    if (l === "vanilla") return all;
    if (l === "fabric") {
      const supported = fabricGameVersions() || [];
      if (supported.length === 0) return all;
      return all.filter(v => supported.includes(v.id));
    }
    if (l === "neoforge") {
      const supported = neoforgeGameVersions() || [];
      if (supported.length === 0) return all;
      return all.filter(v => supported.includes(v.id));
    }
    if (l === "forge") {
      const supported = forgeGameVersions() || [];
      if (supported.length === 0) return all;
      return all.filter(v => supported.includes(v.id));
    }
    if (l === "quilt") {
      const supported = quiltGameVersions() || [];
      if (supported.length === 0) return all;
      return all.filter(v => supported.includes(v.id));
    }
    return all;
  };
  const selectedGameVersion = () => gameVersion() || (gameVersionList().length > 0 ? gameVersionList()[0].id : "");

  // The actual latest version (for the "(latest)" tag), independent of any
  // active search filter.
  const latestVersionId = () => { const l = gameVersionList(); return l.length > 0 ? l[0].id : ""; };
  // Versions matching the dropdown search box (case-insensitive substring).
  const filteredVersions = () => {
    const q = versionQuery().trim().toLowerCase();
    const all = gameVersionList();
    return q ? all.filter(v => v.id.toLowerCase().includes(q)) : all;
  };

  // Fetch NeoForge versions when game version changes
  const [neoforgeVersions] = createResource(
    () => selectedGameVersion(),
    (gv) => gv ? getNeoforgeVersions(gv) : Promise.resolve([])
  );

  // Fetch Forge versions when game version changes
  const [forgeVersions] = createResource(
    () => selectedGameVersion(),
    (gv) => gv ? getForgeVersions(gv) : Promise.resolve([])
  );

  const loaderVersion = () => {
    const mode = loaderVersionMode();
    const l = loader();

    if (l === "fabric") {
      const fv = fabricVersions();
      if (!fv || fv.length === 0) return null;
      if (mode === "stable") return fv.find(v => v.stable)?.version || fv[0].version;
      return fv[0].version;
    }
    if (l === "quilt") {
      const qv = quiltVersions();
      if (!qv || qv.length === 0) return null;
      return qv[0].version;
    }
    if (l === "neoforge") {
      const nv = neoforgeVersions();
      if (!nv || nv.length === 0) return null;
      return nv[0].version;
    }
    if (l === "forge") {
      const fv = forgeVersions();
      if (!fv || fv.length === 0) return null;
      if (mode === "stable") return fv.find(v => v.stable)?.version || fv[0].version;
      return fv[0].version;
    }
    return null;
  };

  const handleCreate = async () => {
    const instanceName = name().trim();
    if (!instanceName) return;

    setCreating(true);
    try {
      const instance = await createInstance({
        name: instanceName,
        game_version: selectedGameVersion(),
        loader_type: loader(),
        loader_version: loader() === "vanilla" ? null : loaderVersion() || null,
        icon: null,
        memory_max_mb: 4096,
      });
      await refetchInstances();
      refreshPinnedInstanceIds().catch(() => {});
      setActiveScreen("library");

      // Start downloading instance files in the background (progress shown in InstallProgress popup)
      prepareInstance(instance.id).catch((e) => {
        showToast({ title: "Install failed", message: String(e), type: "error", autoCloseMs: 8000 });
      });
    } catch (e) {
      console.error("Failed to create instance:", e);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div class="modal-overlay">
      <div class="modal panel panel--bracketed">
        <div class="modal-header">
          <span class="modal-title">Custom setup</span>
          <button class="modal-close" onClick={() => setActiveScreen("library")}>✕</button>
        </div>
        <div class="modal-body">
          {/* Name */}
          <div class="field">
            <div class="field-label">Name</div>
            <input
              class="field-control field-control--text"
              placeholder="e.g. Fabric 1.21.4"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </div>

          {/* Loader */}
          <div class="field">
            <div class="field-label">Loader</div>
            <div class="choice-row">
              <For each={LOADERS}>
                {(l) => {
                  return (
                    <div
                      class={`choice-btn ${loader() === l ? "selected" : ""}`}
                      onClick={() => { setLoader(l); setGameVersion(""); }}
                    >
                      {l === "neoforge" ? "NeoForge" : l.charAt(0).toUpperCase() + l.slice(1)}
                    </div>
                  );
                }}
              </For>
            </div>
          </div>

          {/* Game version */}
          <div class="field">
            <div class="field-label">Game version</div>
            <Show when={gameVersionList().length > 0} fallback={<div class="field-input" style="color:var(--muted)">Loading versions...</div>}>
              <div class="custom-dropdown">
                <div class="custom-dropdown-selected" ref={triggerEl} onClick={toggleVersionDrop}>
                  <span>{selectedGameVersion() || "Select version"}{latestVersionId() === selectedGameVersion() ? " (latest)" : ""}</span>
                  <Show when={isCompanionSupported(selectedGameVersion())}>
                    <img class="companion-version-mark" src="/logo.png" alt="" title="Vermeil companion mod supported" draggable={false} />
                  </Show>
                  <span class="custom-dropdown-arrow" classList={{ open: versionDropOpen() }}>▾</span>
                </div>
                <Show when={versionDropOpen()}>
                  <Portal>
                    <div class="custom-dropdown-options custom-dropdown-options--floating" ref={panelEl} style={panelStyle()}>
                      <input
                        class="custom-dropdown-search"
                        placeholder="Search versions..."
                        value={versionQuery()}
                        onInput={(e) => setVersionQuery(e.currentTarget.value)}
                        ref={(el) => setTimeout(() => el.focus(), 0)}
                      />
                      <div class="custom-dropdown-scroll">
                        <For each={filteredVersions()}>
                          {(v) => (
                            <div
                              class="custom-dropdown-option"
                              classList={{ selected: selectedGameVersion() === v.id }}
                              onClick={() => { setGameVersion(v.id); setVersionDropOpen(false); }}
                            >
                              <span>{v.id}{latestVersionId() === v.id ? " (latest)" : ""}</span>
                              <Show when={isCompanionSupported(v.id)}>
                                <img class="companion-version-mark" src="/logo.png" alt="" title="Vermeil companion mod supported" draggable={false} />
                              </Show>
                            </div>
                          )}
                        </For>
                        <Show when={filteredVersions().length === 0}>
                          <div class="custom-dropdown-empty">No versions match “{versionQuery()}”</div>
                        </Show>
                      </div>
                    </div>
                  </Portal>
                </Show>
              </div>
            </Show>
          </div>

          {/* Loader version */}
          <div class="field">
            <div class="field-label">Loader version</div>
            <Show when={loader() !== "vanilla"} fallback={
              <div>
                <div class="choice-row" style="opacity:0.4;pointer-events:none">
                  <div class="choice-btn selected">Stable</div>
                  <div class="choice-btn">Beta</div>
                </div>
                <div style="font-size:11px;color:var(--muted);margin-top:6px;font-family:var(--font-mono)">
                  → No mod loader
                </div>
              </div>
            }>
              <div class="choice-row">
                <div
                  class={`choice-btn ${loaderVersionMode() === "stable" ? "selected" : ""}`}
                  onClick={() => setLoaderVersionMode("stable")}
                >
                  Stable
                </div>
                <div
                  class={`choice-btn ${loaderVersionMode() === "latest" ? "selected" : ""}`}
                  onClick={() => setLoaderVersionMode("latest")}
                >
                  Beta
                </div>
              </div>
              <Show when={loaderVersion()}>
                <div style="font-size:11px;color:var(--muted);margin-top:6px;font-family:var(--font-mono)">
                  → {loader() === "fabric" && isLegacyVersion() ? "Legacy " : ""}{loaderVersion()}
                </div>
              </Show>
            </Show>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn btn--ghost" onClick={() => setActiveScreen("create-choose")}>
            ← Back
          </button>
          <button
            class="btn btn--primary"
            onClick={handleCreate}
            disabled={creating() || !name().trim()}
          >
            {creating() ? "Creating..." : "+ Create instance"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CreateCustom;
