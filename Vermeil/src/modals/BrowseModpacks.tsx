import { Component, createSignal, For, Show } from "solid-js";
import { setActiveScreen, refetchInstances, instances, trackDownload, completeDownload, failDownload } from "../App";
import { searchModpacks, searchCurseforge, installModpack, installCfModpack, ModHit } from "../ipc/commands";
import Dropdown from "../components/Dropdown";
import { IconModrinth, IconCurseForge } from "../components/Icons";

const KNOWN_LOADERS = ["fabric", "forge", "neoforge", "quilt"];

/** Extract the primary loader from a ModHit's categories array. */
function extractLoader(hit: ModHit): string {
  const cats = hit.categories ?? [];
  return cats.find(c => KNOWN_LOADERS.includes(c)) ?? "";
}

/** Extract a compact version range string from a ModHit's versions array. */
function extractVersionRange(hit: ModHit): string {
  const versions = hit.versions ?? [];
  if (versions.length === 0) return "";
  if (versions.length === 1) return versions[0];
  // Versions come sorted oldest-first from Modrinth. Show newest few.
  const recent = versions.slice(-3).reverse();
  return recent.join(", ");
}

const PAGE_SIZE = 10;

const BrowseModpacks: Component = () => {
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<ModHit[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [installing, setInstalling] = createSignal<string | null>(null);
  const [confirmPack, setConfirmPack] = createSignal<ModHit | null>(null);
  const [page, setPage] = createSignal(1);
  const [totalHits, setTotalHits] = createSignal(0);
  const [sortBy, setSortBy] = createSignal("relevance");
  const [loaderFilter, setLoaderFilter] = createSignal("");
  const [modSource, setModSource] = createSignal<"modrinth" | "curseforge">("modrinth");

  const handleSourceToggle = () => {
    setModSource(modSource() === "modrinth" ? "curseforge" : "modrinth");
    setResults([]);
    setPage(1);
    doSearch(query(), 1);
  };

  const totalPages = () => Math.max(1, Math.ceil(totalHits() / PAGE_SIZE));

  let searchTimeout: number | undefined;

  const doSearch = async (q: string, p: number) => {
    setSearching(true);
    try {
      const offset = (p - 1) * PAGE_SIZE;
      let result;
      if (modSource() === "curseforge") {
        result = await searchCurseforge(q, loaderFilter(), "", offset, PAGE_SIZE, sortBy(), "modpack");
      } else {
        result = await searchModpacks(q, offset, sortBy(), loaderFilter());
      }
      setResults(result.hits);
      setTotalHits(result.total_hits);
    } catch (e) { console.error(e); }
    finally { setSearching(false); }
  };

  const handleSearch = (q: string) => {
    setQuery(q);
    setPage(1);
    clearTimeout(searchTimeout);
    searchTimeout = window.setTimeout(() => doSearch(q, 1), 300);
  };

  const goPage = (p: number) => {
    if (p < 1 || p > totalPages()) return;
    setPage(p);
    doSearch(query(), p);
  };

  const handleFilterChange = () => {
    setPage(1);
    doSearch(query(), 1);
  };

  // Load popular modpacks on mount
  setTimeout(() => doSearch("", 1), 100);

  // Get instances that were created from a specific modpack project
  const getInstalledInstances = (projectId: string) => {
    const list = instances() || [];
    return list.filter(i => i.source_project_id === projectId);
  };

  const getInstallCount = (projectId: string): number => getInstalledInstances(projectId).length;

  const handleInstallClick = (pack: ModHit) => {
    const count = getInstallCount(pack.project_id);
    if (count > 0) {
      // Show confirmation dialog
      setConfirmPack(pack);
    } else {
      doInstall(pack);
    }
  };

  const doInstall = async (pack: ModHit) => {
    setConfirmPack(null);
    setInstalling(pack.project_id);

    // Close the modal immediately so the InstallProgress popup is visible.
    setActiveScreen("library");

    // Track this install in the global download history (visible in the
    // Downloads screen) so modpack installs are recorded alongside individual
    // mod installs.
    const dlId = trackDownload(pack.title, "modpack", {
      iconUrl: pack.icon_url,
      loader: extractLoader(pack),
      gameVersion: extractVersionRange(pack),
    });

    const installPromise = modSource() === "curseforge"
      ? installCfModpack(pack.project_id, pack.latest_version ?? undefined)
      : installModpack(pack.project_id);

    installPromise
      .then(() => {
        refetchInstances();
        completeDownload(dlId);
      })
      .catch((e) => {
        console.error("Modpack install failed:", e);
        failDownload(dlId);
        alert(typeof e === "string" ? e : "Install failed");
      })
      .finally(() => setInstalling(null));
  };

  const formatDownloads = (n: number): string => {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
    return n.toString();
  };

  return (
    <div class="modal-overlay">
      <div class="modal" style="width:520px">
        <div class="modal-header">
          <span class="modal-title">Browse Modpacks</span>
          <Show when={searching()}>
            <div class="modpack-spinner" />
          </Show>
          <div class="modpack-filters">
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
            <Dropdown
              value={sortBy()}
              options={[
                { value: "relevance", label: "Relevance" },
                { value: "downloads", label: "Downloads" },
                { value: "follows", label: "Follows" },
                { value: "newest", label: "Newest" },
                { value: "updated", label: "Updated" },
              ]}
              onChange={(v) => { setSortBy(v); handleFilterChange(); }}
              width="100px"
            />
            <Dropdown
              value={loaderFilter()}
              options={[
                { value: "", label: "All loaders" },
                { value: "fabric", label: "Fabric" },
                { value: "forge", label: "Forge" },
                { value: "neoforge", label: "NeoForge" },
                { value: "quilt", label: "Quilt" },
              ]}
              onChange={(v) => { setLoaderFilter(v); handleFilterChange(); }}
              width="110px"
            />
          </div>
          <button class="modal-close" onClick={() => setActiveScreen("library")}>✕</button>
        </div>
        <div class="modal-body">
          <div class="search-bar">
            <input
              class="search-input"
              placeholder={modSource() === "modrinth" ? "Search Modrinth modpacks..." : "Search CurseForge modpacks..."}
              value={query()}
              onInput={(e) => handleSearch(e.currentTarget.value)}
            />
          </div>

          {/* Confirmation dialog */}
          <Show when={confirmPack()}>
            <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px">
              <div style="font-size:12px;color:var(--text);margin-bottom:8px">
                You already have <strong>{getInstallCount(confirmPack()!.project_id)}</strong> instance(s) of <strong>{confirmPack()!.title}</strong>:
              </div>
              <div style="max-height:80px;overflow-y:auto;margin-bottom:8px">
                <For each={getInstalledInstances(confirmPack()!.project_id)}>
                  {(inst) => (
                    <div style="font-size:11px;color:var(--muted);padding:2px 0">• {inst.name}</div>
                  )}
                </For>
              </div>
              <div style="display:flex;gap:8px;align-items:center">
                <button class="install-btn" onClick={() => doInstall(confirmPack()!)}>Install Anyway</button>
                <button class="btn btn-ghost" style="font-size:11px" onClick={() => setConfirmPack(null)}>Cancel</button>
              </div>
            </div>
          </Show>

          <div class="mod-list" style="min-height:320px;max-height:320px;overflow-y:auto">
            <For each={results()}>
              {(pack) => {
                const count = () => getInstallCount(pack.project_id);
                return (
                  <div class="mod-item">
                    <div class="mod-icon" style="background:#1a2035">
                      <Show when={pack.icon_url} fallback={<span style="font-size:16px">📦</span>}>
                        <img src={pack.icon_url!} style="width:36px;height:36px;border-radius:8px;object-fit:cover" />
                      </Show>
                    </div>
                    <div class="mod-details">
                      <div class="mod-name">{pack.title}</div>
                      <Show when={pack.author}>
                        <div class="mod-author">by {pack.author}</div>
                      </Show>
                      <div class="mod-desc">{pack.description}</div>
                      <div class="mod-card-tags" style="margin-top:4px">
                        <Show when={extractLoader(pack)}>
                          <span class={`mod-tag mod-tag-loader loader-${extractLoader(pack)}`}>{extractLoader(pack)}</span>
                        </Show>
                        <Show when={extractVersionRange(pack)}>
                          <span class="mod-tag">{extractVersionRange(pack)}</span>
                        </Show>
                      </div>
                      <div class="mod-stats">↓ {formatDownloads(pack.downloads)} · ♥ {formatDownloads(pack.follows)}</div>
                    </div>
                    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
                      <button
                        class="install-btn"
                        disabled={installing() === pack.project_id}
                        onClick={() => handleInstallClick(pack)}
                      >
                        {installing() === pack.project_id ? "Installing..." : "Install"}
                      </button>
                      <Show when={count() > 0}>
                        <span style="font-size:9px;color:var(--accent);white-space:nowrap">
                          Installed{count() > 1 ? ` (${count()})` : ""}
                        </span>
                      </Show>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </div>
        <div class="modal-footer">
          <Show when={totalPages() > 1}>
            <div class="modpack-page-indicator">
              <button class="modpack-page-btn" disabled={page() <= 1} onClick={() => goPage(page() - 1)}>‹</button>
              <span class="modpack-page-label">Page {page()}/{totalPages()}</span>
              <button class="modpack-page-btn" disabled={page() >= totalPages()} onClick={() => goPage(page() + 1)}>›</button>
            </div>
          </Show>
          <button class="btn btn-ghost" onClick={() => setActiveScreen("create-choose")}>← Back</button>
        </div>
      </div>
    </div>
  );
};

export default BrowseModpacks;
