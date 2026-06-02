import { Component, createSignal, createResource, For, Show } from "solid-js";
import { setActiveScreen, refetchInstances, showToast } from "../App";
import { getGameVersions, getFabricLoaderVersions, getFabricGameVersions, getQuiltLoaderVersions, getQuiltGameVersions, getNeoforgeVersions, getNeoforgeGameVersions, getForgeVersions, getForgeGameVersions, createInstance, prepareInstance, getSettings } from "../ipc/commands";

const LOADERS = ["vanilla", "fabric", "neoforge", "forge", "quilt"] as const;

const CreateCustom: Component = () => {
  const [name, setName] = createSignal("");
  const [loader, setLoader] = createSignal<string>("vanilla");
  const [gameVersion, setGameVersion] = createSignal("");
  const [loaderVersionMode, setLoaderVersionMode] = createSignal<"stable" | "latest" | "other">("stable");
  const [creating, setCreating] = createSignal(false);
  const [versionDropOpen, setVersionDropOpen] = createSignal(false);

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
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">Custom setup</span>
          <button class="modal-close" onClick={() => setActiveScreen("library")}>✕</button>
        </div>
        <div class="modal-body">
          {/* Name */}
          <div class="field">
            <div class="field-label">Name</div>
            <input
              class="field-input"
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
                      onClick={() => setLoader(l)}
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
              <div class="custom-dropdown" tabIndex={0} onBlur={() => setVersionDropOpen(false)}>
                <div class="custom-dropdown-selected" onClick={() => setVersionDropOpen(!versionDropOpen())}>
                  <span>{selectedGameVersion() || "Select version"}{gameVersionList()[0]?.id === selectedGameVersion() ? " (latest)" : ""}</span>
                  <span class="custom-dropdown-arrow" classList={{ open: versionDropOpen() }}>▾</span>
                </div>
                <Show when={versionDropOpen()}>
                  <div class="custom-dropdown-options">
                    <For each={gameVersionList()}>
                      {(v, i) => (
                        <div
                          class="custom-dropdown-option"
                          classList={{ selected: selectedGameVersion() === v.id }}
                          onClick={() => { setGameVersion(v.id); setVersionDropOpen(false); }}
                        >
                          {v.id}{i() === 0 ? " (latest)" : ""}
                        </div>
                      )}
                    </For>
                  </div>
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
          <button class="btn btn-ghost" onClick={() => setActiveScreen("create-choose")}>
            ← Back
          </button>
          <button
            class="btn btn-accent"
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
