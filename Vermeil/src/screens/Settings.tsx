import { Component, createSignal, createResource, Show, For, onMount, createEffect } from "solid-js";
import { getSettings, saveSettings, getCacheSize, purgeCache, LauncherSettings, detectJavaInstallations, validateJavaPath, setJavaPath, installRecommendedJava, deleteJavaInstall, pruneInvalidJavaPaths, getSystemMemory, JavaInstall } from "../ipc/commands";
import { setActiveScreen, setActiveInstanceId, setInitialInstanceTab, instances, showToast } from "../App";
import { checkForUpdates } from "../services/updater";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IconDownload, IconSearch, IconFolderOpen, IconTrash, IconModrinth, IconCurseForge, IconChevronRight } from "../components/Icons";
import JavaPathInput from "../components/JavaPathInput";
import JavaChooserModal from "../modals/JavaChooserModal";
import Dropdown from "../components/Dropdown";
import KeybindCapture from "../components/KeybindCapture";
import { KEYBINDS, resolveBinding } from "../lib/keybinds";

type SettingsTab = "general" | "resources" | "instances" | "keybinds";

/// Clamp a concurrency setting to a per-field range. The download semaphore is
/// capped at 10 because most CDNs throttle individual clients past that point;
/// the write semaphore can safely go higher because disk I/O is local.
const clampConcurrency = (n: number, max: number): number =>
  Math.max(1, Math.min(max, Math.round(Number.isNaN(n) ? 10 : n)));

const Settings: Component = () => {
  const [tab, setTab] = createSignal<SettingsTab>("general");
  const [settings, { refetch }] = createResource(getSettings);
  const [appVersion] = createResource(getVersion);
  const [systemMemoryMb] = createResource(getSystemMemory);
  const [cacheSize, setCacheSize] = createSignal(0);
  const [purging, setPurging] = createSignal(false);

  // Optimistic local mirror of `settings.video_settings` so slider values
  // (text labels) update live during drag. The resource only refetches after
  // the save round-trip completes, which lags the slider thumb. We mirror it
  // here, write through to the backend, and the local signal stays authoritative.
  type VS = LauncherSettings["video_settings"];
  const [vsLocal, setVsLocal] = createSignal<VS | null>(null);
  createEffect(() => {
    const s = settings();
    if (s && vsLocal() === null) setVsLocal(s.video_settings);
  });
  const vs = (): VS => vsLocal() ?? settings()!.video_settings;

  // Same optimistic-display pattern for the concurrency sliders. Without
  // these, the displayed number lags the thumb because the read source
  // (`settings()!.concurrent_*`) only refreshes after the save+refetch
  // round-trip completes.
  const [dlDraft, setDlDraft] = createSignal<number | null>(null);
  const [wrDraft, setWrDraft] = createSignal<number | null>(null);
  const dlValue = (): number => dlDraft() ?? Math.min(settings()?.concurrent_downloads ?? 10, 20);
  const wrValue = (): number => wrDraft() ?? settings()?.concurrent_writes ?? 10;
  createEffect(() => {
    const s = settings();
    const d = dlDraft();
    if (s && d !== null && Math.min(s.concurrent_downloads, 20) === d) setDlDraft(null);
  });
  createEffect(() => {
    const s = settings();
    const w = wrDraft();
    if (s && w !== null && s.concurrent_writes === w) setWrDraft(null);
  });

  // Java location finder — populated by `runDetect()` and re-run on demand.
  // The four "slots" (8/17/21/25) cover every Minecraft version that exists.
  // Anything missing falls back to auto-detection / auto-install at launch.
  const JAVA_SLOTS: number[] = [25, 21, 17, 8];
  const [javaDetections, setJavaDetections] = createSignal<JavaInstall[]>([]);
  const [javaBusy, setJavaBusy] = createSignal<Record<number, "install" | "detect" | "browse" | "delete" | null>>({});
  const setJavaSlotBusy = (major: number, busy: "install" | "detect" | "browse" | "delete" | null) => {
    setJavaBusy(prev => ({ ...prev, [major]: busy }));
  };

  /** Best detected install for a given major, used as the path display fallback. */
  const detectionFor = (major: number): JavaInstall | undefined =>
    javaDetections().find(i => i.major === major);
  /** Resolved path for a given major: user override beats detection. */
  const javaPathFor = (major: number): string => {
    const userSet = settings()?.java_paths?.[major];
    if (userSet) return userSet;
    return detectionFor(major)?.path ?? "";
  };

  // Chooser-modal state. When `Detect` finds more than one matching JRE for
  // a major, we surface this modal so the user picks one explicitly instead
  // of silently auto-selecting the first by source priority. Single matches
  // still auto-apply — no popup for the obvious case.
  const [chooser, setChooser] = createSignal<{ major: number; options: JavaInstall[] } | null>(null);

  /** Apply a detected install: persist, refetch settings, toast. */
  const applyDetection = async (major: number, install: JavaInstall) => {
    await setJavaPath(major, install.path);
    await refetch();
    setJavaDetections((prev) => {
      const without = prev.filter((i) => i.path !== install.path);
      return [...without, install];
    });
    showToast({ title: `Java ${major} set`, message: install.path, type: "success" });
  };

  const runDetect = async (major?: number) => {
    if (major !== undefined) setJavaSlotBusy(major, "detect");
    try {
      const found = await detectJavaInstallations();
      setJavaDetections(found);
      if (major !== undefined) {
        const matches = found.filter((i) => i.major === major);
        if (matches.length === 0) {
          showToast({ title: `Java ${major} not found`, message: "Try Install recommended or Browse manually.", type: "info" });
        } else if (matches.length === 1) {
          await applyDetection(major, matches[0]);
        } else {
          // Multiple matches — let the user pick. The chooser handles the
          // apply step itself via `onPick`.
          setChooser({ major, options: matches });
        }
      } else {
        showToast({ title: `Found ${found.length} Java install${found.length === 1 ? "" : "s"}`, type: "success" });
      }
    } catch (e) {
      showToast({ title: "Detection failed", message: String(e), type: "error" });
    } finally {
      if (major !== undefined) setJavaSlotBusy(major, null);
    }
  };

  const runDelete = async (major: number) => {
    setJavaSlotBusy(major, "delete");
    try {
      const deletedDir = await deleteJavaInstall(major);
      await refetch();
      // Path-scoped cache invalidation: only drop detections inside the
      // directory we just removed. Filtering by `major` would also wipe an
      // unrelated user JDK for the same major (Oracle / Microsoft / etc.),
      // hiding it from the slot until the next full re-detect.
      setJavaDetections((prev) => prev.filter((i) => !i.path.startsWith(deletedDir)));
      showToast({ title: `Java ${major} removed`, message: "Vermeil's downloaded copy was deleted.", type: "success" });
    } catch (e) {
      showToast({ title: `Java ${major} delete failed`, message: String(e), type: "error" });
    } finally {
      setJavaSlotBusy(major, null);
    }
  };

  const runInstall = async (major: number) => {
    setJavaSlotBusy(major, "install");
    try {
      const install = await installRecommendedJava(major);
      await refetch();
      // Refresh detections so the install shows up in the local cache too.
      setJavaDetections(prev => {
        const without = prev.filter(i => i.path !== install.path);
        return [...without, install];
      });
      showToast({ title: `Java ${major} installed`, message: install.full_version, type: "success" });
    } catch (e) {
      showToast({ title: `Java ${major} install failed`, message: String(e), type: "error" });
    } finally {
      setJavaSlotBusy(major, null);
    }
  };

  const runBrowse = async (major: number) => {
    setJavaSlotBusy(major, "browse");
    try {
      const isWin = navigator.userAgent.includes("Windows");
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        filters: isWin
          ? [{ name: "Java executable", extensions: ["exe"] }]
          : [],
      });
      if (!picked) return;
      const path = typeof picked === "string" ? picked : (picked as { path: string }).path;
      const install = await validateJavaPath(path);
      if (install.major !== major) {
        showToast({
          title: `That's Java ${install.major}, not ${major}`,
          message: "Pick a JRE matching the requested major version.",
          type: "warning",
        });
        return;
      }
      await setJavaPath(major, install.path);
      await refetch();
      setJavaDetections(prev => {
        const without = prev.filter(i => i.path !== install.path);
        return [...without, install];
      });
      showToast({ title: `Java ${major} updated`, message: install.path, type: "success" });
    } catch (e) {
      showToast({ title: "Browse failed", message: String(e), type: "error" });
    } finally {
      setJavaSlotBusy(major, null);
    }
  };

  onMount(async () => {
    try { setCacheSize(await getCacheSize()); } catch {}
    // Self-heal stale Java overrides. The user may have deleted a JRE
    // manually (or uninstalled an external one) since the last launch — we
    // clear those entries before showing them so the input never displays
    // a path pointing at nothing. Each cleared major gets its own toast so
    // the cause-effect is visible to the user.
    try {
      const cleared = await pruneInvalidJavaPaths();
      if (cleared.length > 0) {
        await refetch();
        for (const m of cleared) {
          showToast({
            title: `Java ${m} path cleared`,
            message: "The previous file no longer exists on disk.",
            type: "info",
          });
        }
      }
    } catch (e) {
      console.error("Java path prune failed:", e);
    }
    // Fire-and-forget initial detection so the Java section has paths to show
    // when the user first opens the Resources tab.
    detectJavaInstallations().then(setJavaDetections).catch(() => {});
  });

  const formatCacheSize = () => (cacheSize() / (1024 * 1024)).toFixed(1);

  const handlePurgeCache = async () => {
    setPurging(true);
    try {
      await purgeCache();
      setCacheSize(0);
    } catch (e) { console.error(e); }
    finally { setPurging(false); }
  };

  // Adaptive RAM defaults — mirrors `services::memory::default_max_for_system`
  // and `default_min_for_system` so the Settings UI can show real numbers in
  // placeholders without an extra IPC round trip. **PARALLEL SURFACE**: if
  // either Rust function changes its constants, update this too.
  const adaptiveDefaultMax = (systemMb: number): number => {
    if (!systemMb) return 4096;
    const [reserve, pct] = systemMb <= 6144
      ? [1024, 0.90]
      : systemMb <= 12288
        ? [1536, 0.85]
        : [4096, 0.75];
    const usable = Math.max(0, systemMb - reserve);
    const aligned = Math.floor(Math.floor(usable * pct) / 256) * 256;
    return Math.max(1024, Math.min(aligned, 16384));
  };
  const adaptiveDefaultMin = (systemMb: number): number => {
    const max = adaptiveDefaultMax(systemMb);
    const aligned = Math.floor(Math.floor(max * 0.40) / 256) * 256;
    return Math.max(1024, Math.min(aligned, 4096));
  };

  /** Current effective min for the adaptive bounds — user-set value, or the
   *  system-derived default when the stored value is the `0` sentinel. */
  const adaptiveMin = (): number => {
    const stored = settings()?.adaptive_ram_min_mb ?? 0;
    return stored > 0 ? stored : adaptiveDefaultMin(systemMemoryMb() || 0);
  };
  const adaptiveMax = (): number => {
    const stored = settings()?.adaptive_ram_max_mb ?? 0;
    return stored > 0 ? stored : adaptiveDefaultMax(systemMemoryMb() || 0);
  };

  /** Format MB as "X.X GB" matching the rest of the launcher's memory text. */
  const formatMemoryGb = (mb: number): string => {
    const gb = mb / 1024;
    return `${gb.toFixed(gb < 10 ? 1 : 0).replace(/\.0$/, "")} GB`;
  };

  /** Toggle the master adaptive switch. Fires the intro toast on first
   *  enable so users understand what they just turned on. */
  const handleAdaptiveToggle = async () => {
    const s = settings();
    if (!s) return;
    const next = !s.adaptive_ram;
    await updateSetting("adaptive_ram", next);
    if (next && !s.adaptive_ram_seen_intro) {
      const max = adaptiveMax();
      showToast({
        title: "Adaptive RAM is on",
        message: `Vermeil now picks an allocation per instance, capped at ${formatMemoryGb(max)} on this system. Heavy packs may show a "capped" warning — that's normal on systems with limited RAM.`,
        type: "info",
        autoCloseMs: 8000,
      });
      await updateSetting("adaptive_ram_seen_intro", true);
    }
  };
  const updateSetting = async <K extends keyof LauncherSettings>(key: K, value: LauncherSettings[K]) => {
    const current = settings();
    if (!current) return;
    const updated = { ...current, [key]: value };
    try {
      await saveSettings(updated);
      await refetch();
      // Notify the global keydown handler that the keybind cache is stale.
      // App.tsx listens for this event and re-reads settings.keybinds.
      if (key === "keybinds") {
        window.dispatchEvent(new CustomEvent("vermeil-keybinds-changed"));
      }
    } catch (e) {
      console.error("Failed to save setting:", e);
    }
  };

  // Patch helper for video_settings: writes optimistically to local signal
  // (so slider text labels update during drag), then fires the backend save.
  const updateVideoSettings = (patch: Partial<VS>) => {
    const merged = { ...vs(), ...patch };
    setVsLocal(merged);
    updateSetting("video_settings", merged);
  };

  const openInstanceOptions = (id: string) => {
    setActiveInstanceId(id);
    setInitialInstanceTab("settings");
    setActiveScreen("mods");
  };

  return (
    <div class="screen-enter">
      <div class="section-label">Settings</div>

      {/* Tabs */}
      <div class="tab-strip" style="margin-bottom:16px">
        <div class={`tab ${tab() === "general" ? "active" : ""}`} onClick={() => setTab("general")}>General</div>
        <div class={`tab ${tab() === "resources" ? "active" : ""}`} onClick={() => setTab("resources")}>Resources</div>
        <div class={`tab ${tab() === "instances" ? "active" : ""}`} onClick={() => setTab("instances")}>Global Instance</div>
        <div class={`tab ${tab() === "keybinds" ? "active" : ""}`} onClick={() => setTab("keybinds")}>Keybinds</div>
      </div>

      <Show when={settings()}>
        {/* ═══ GENERAL ═══ */}
        <Show when={tab() === "general"}>
          <div class="settings-section">
            <div class="section-label" style="margin-bottom:8px">Launcher</div>
            <div class="settings-group">
              <div class="settings-row">
                <div>
                  <div class="settings-key">Minimize to tray on launch</div>
                  <div class="settings-val">Hides launcher when game starts</div>
                </div>
                <div class={`toggle ${settings()!.close_on_launch ? "on" : ""}`} onClick={() => updateSetting("close_on_launch", !settings()!.close_on_launch)} />
              </div>
              <div class="settings-row">
                <div>
                  <div class="settings-key">Auto-update launcher</div>
                </div>
                <div class={`toggle ${settings()!.auto_update ? "on" : ""}`} onClick={() => updateSetting("auto_update", !settings()!.auto_update)} />
              </div>
              <div class="settings-row">
                <div>
                  <div class="settings-key">Check for updates</div>
                  <div class="settings-val">Manually check for a new version</div>
                </div>
                <button class="btn" style="font-size:10px;padding:4px 10px" onClick={() => checkForUpdates(false)}>Check now</button>
              </div>
              <div class="settings-row">
                <div>
                  <div class="settings-key">Discord Rich Presence</div>
                </div>
                <div class={`toggle ${settings()!.discord_rpc ? "on" : ""}`} onClick={() => updateSetting("discord_rpc", !settings()!.discord_rpc)} />
              </div>
              <div class="settings-row">
                <div>
                  <div class="settings-key">Show snapshots</div>
                  <div class="settings-val">Include experimental versions</div>
                </div>
                <div class={`toggle ${settings()!.show_snapshots ? "on" : ""}`} onClick={() => updateSetting("show_snapshots", !settings()!.show_snapshots)} />
              </div>
              <div class="settings-row">
                <div>
                  <div class="settings-key">Force delete</div>
                  <div class="settings-val">Skip confirmation when deleting instances</div>
                </div>
                <div class={`toggle ${settings()!.force_delete ? "on" : ""}`} onClick={() => updateSetting("force_delete", !settings()!.force_delete)} />
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-label" style="margin-bottom:8px">About</div>
            <div class="settings-group">
              <div class="settings-row">
                <div>
                  <div class="settings-key">Vermeil</div>
                  <div class="settings-val">Version {appVersion() || "..."}</div>
                </div>
                <button class="btn" style="font-size:10px;padding:4px 10px;display:flex;align-items:center;gap:4px" onClick={() => openUrl("https://github.com/davekb1976-beep/Vermeil-Launcher")}>
                  <svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
                </button>
              </div>
              <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:6px">
                <div class="settings-key">Disclaimer</div>
                <div class="settings-val" style="line-height:1.5">
                  Vermeil is an unofficial Minecraft launcher. Not affiliated with, endorsed by, or sponsored by Mojang Studios or Microsoft.
                  Minecraft is a trademark of Mojang Synergies AB.
                </div>
              </div>
              <div class="settings-row">
                <div>
                  <div class="settings-key">Privacy</div>
                  <div class="settings-val">No data is collected or sent to Vermeil servers. All data stays on your device.</div>
                </div>
                <button class="btn" style="font-size:10px;padding:4px 10px" onClick={() => openUrl("https://github.com/davekb1976-beep/Vermeil-Launcher/blob/main/PRIVACY.md")}>
                  Read policy
                </button>
              </div>
            </div>
          </div>
        </Show>

        {/* ═══ RESOURCES ═══ */}
        <Show when={tab() === "resources"}>
          <div class="settings-section">
            <div class="section-label" style="margin-bottom:8px">Storage</div>
            <div class="settings-group">
              <div class="settings-row">
                <div>
                  <div class="settings-key">App directory</div>
                  <div class="settings-val" style="font-family:var(--font-mono);font-size:10px">%APPDATA%/Vermeil</div>
                </div>
              </div>
              <div class="settings-row">
                <div>
                  <div class="settings-key">App cache</div>
                  <div class="settings-val">Version metadata and loader installers · {formatCacheSize()} MB</div>
                </div>
                <button class="btn" style="font-size:10px;padding:4px 10px" onClick={handlePurgeCache} disabled={purging()}>
                  {purging() ? "Purging..." : "Purge cache"}
                </button>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-label" style="margin-bottom:8px">Performance</div>
            <div class="settings-group">
              <div class="settings-row" style="align-items:center">
                <div>
                  <div class="settings-key">Concurrent downloads</div>
                  <div class="settings-val">Max files downloading simultaneously (1–20)</div>
                </div>
                <div class="concurrency-control">
                  <input
                    class="concurrency-slider"
                    type="range"
                    min="1"
                    max="20"
                    step="1"
                    value={dlValue()}
                    style={`--slider-pct: ${((dlValue() - 1) / 19) * 100}%`}
                    onInput={(e) => {
                      const safe = clampConcurrency(parseInt(e.currentTarget.value), 20);
                      // Update the gradient fill synchronously so the visual
                      // tracks the thumb instantly, bypassing Solid's render
                      // queue. Without this, fast scrubs look laggy because
                      // the fill repaint waits for the next render tick.
                      e.currentTarget.style.setProperty('--slider-pct', `${((safe - 1) / 19) * 100}%`);
                      setDlDraft(safe);
                      updateSetting("concurrent_downloads", safe);
                    }}
                  />
                  <input
                    class="concurrency-number"
                    type="number"
                    min="1"
                    max="20"
                    value={dlValue()}
                    onChange={(e) => {
                      const safe = clampConcurrency(parseInt(e.currentTarget.value), 20);
                      e.currentTarget.value = String(safe);
                      setDlDraft(safe);
                      updateSetting("concurrent_downloads", safe);
                    }}
                  />
                </div>
              </div>
              <div class="settings-row" style="align-items:center">
                <div>
                  <div class="settings-key">Concurrent writes</div>
                  <div class="settings-val">Max files being written to disk simultaneously (1–50)</div>
                </div>
                <div class="concurrency-control">
                  <input
                    class="concurrency-slider"
                    type="range"
                    min="1"
                    max="50"
                    step="1"
                    value={wrValue()}
                    style={`--slider-pct: ${((wrValue() - 1) / 49) * 100}%`}
                    onInput={(e) => {
                      const safe = clampConcurrency(parseInt(e.currentTarget.value), 50);
                      // Direct setProperty for instant visual fill — see
                      // the concurrent-downloads slider above for rationale.
                      e.currentTarget.style.setProperty('--slider-pct', `${((safe - 1) / 49) * 100}%`);
                      setWrDraft(safe);
                      updateSetting("concurrent_writes", safe);
                    }}
                  />
                  <input
                    class="concurrency-number"
                    type="number"
                    min="1"
                    max="50"
                    value={wrValue()}
                    onChange={(e) => {
                      const safe = clampConcurrency(parseInt(e.currentTarget.value), 50);
                      e.currentTarget.value = String(safe);
                      setWrDraft(safe);
                      updateSetting("concurrent_writes", safe);
                    }}
                  />
                </div>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-label" style="margin-bottom:8px">Java</div>
            <div class="settings-val" style="margin-bottom:10px">
              Each Minecraft major needs a different JRE. Use Detect to scan your system,
              Install recommended to download Adoptium Temurin, or Browse to point at an
              existing install.
            </div>
            {/* Java runtime + GC preset rows. Used to live under General →
                Java; relocated here so every Java-related toggle (runtime
                source, GC preset, per-major slots) is on one tab. */}
            <div class="settings-group" style="margin-bottom:14px">
              <div class="settings-row">
                <div>
                  <div class="settings-key">Java runtime</div>
                  <div class="settings-val">{settings()!.java_runtime === "auto" ? "Auto-managed (Adoptium)" : settings()!.java_runtime}</div>
                </div>
                <Dropdown
                  value={settings()!.java_runtime}
                  options={[
                    { value: "auto", label: "Auto (Adoptium)" },
                    { value: "system", label: "System Java" },
                  ]}
                  onChange={(val) => updateSetting("java_runtime", val)}
                />
              </div>
              <div class="settings-row">
                <div>
                  <div class="settings-key">GC preset</div>
                  <div class="settings-val">{settings()!.gc_preset === "g1gc" ? "G1GC (recommended)" : settings()!.gc_preset.toUpperCase()}</div>
                </div>
                <Dropdown
                  value={settings()!.gc_preset}
                  options={[
                    { value: "g1gc", label: "G1GC (recommended)" },
                    { value: "zgc", label: "ZGC (Java 21+)" },
                    { value: "shenandoah", label: "Shenandoah" },
                  ]}
                  onChange={(val) => updateSetting("gc_preset", val)}
                />
              </div>
            </div>
            <div class="java-slots">
              <For each={JAVA_SLOTS}>
                {(major) => {
                  const path = () => javaPathFor(major);
                  const installed = () => Boolean(path());
                  const det = () => detectionFor(major);
                  const busy = () => javaBusy()[major] ?? null;
                  return (
                    <div class="java-slot">
                      <div class="java-slot-title">Java {major} location</div>
                      <JavaPathInput
                        major={major}
                        value={path()}
                        placeholder={`No Java ${major} configured`}
                        disabled={busy() !== null}
                        onCommit={async (newPath) => {
                          // Refresh the settings resource so other UI sees the
                          // change, and refresh detections so the meta line
                          // under the input picks up the new install.
                          await refetch();
                          if (newPath) {
                            try {
                              const install = await validateJavaPath(newPath);
                              setJavaDetections(prev => {
                                const without = prev.filter(i => i.path !== install.path);
                                return [...without, install];
                              });
                            } catch {
                              // Already toasted by JavaPathInput on the unhappy path.
                            }
                          }
                        }}
                      />
                      <Show when={det() && installed()}>
                        <div class="java-slot-meta">
                          {det()!.full_version} · {det()!.arch} · {det()!.source.replace("_", " ")}
                        </div>
                      </Show>
                      <div class="java-slot-actions">
                        <button
                          class="btn"
                          onClick={() => runInstall(major)}
                          disabled={busy() !== null}
                          title={installed() ? "Replace with a fresh Adoptium download" : "Download from Adoptium"}
                        >
                          <IconDownload />
                          {busy() === "install" ? "Installing..." : "Install recommended"}
                        </button>
                        <button
                          class="btn"
                          onClick={() => runDetect(major)}
                          disabled={busy() !== null}
                        >
                          <IconSearch />
                          {busy() === "detect" ? "Detecting..." : "Detect"}
                        </button>
                        <button
                          class="btn"
                          onClick={() => runBrowse(major)}
                          disabled={busy() !== null}
                        >
                          <IconFolderOpen />
                          {busy() === "browse" ? "Picking..." : "Browse"}
                        </button>
                        {/* Delete is gated on the *current slot's path*
                            being a Vermeil-managed install (path lives
                            inside `<data>/java/`). We look up the detection
                            by exact path — not by major — because multiple
                            JREs can share a major (e.g. Oracle + Adoptium)
                            and a `.find(major)` would return the wrong one
                            after we splice in a new install. The backend
                            also re-checks the path-prefix before any rm-rf,
                            so a stale UI state can never wipe a user JDK. */}
                          {(() => {
                            const det = javaDetections().find((i) => i.path === path());
                            const ownsCurrent = det?.is_vermeil_managed === true;
                            return (
                              <Show when={ownsCurrent}>
                                <button
                                  class="btn btn--danger"
                                  onClick={() => runDelete(major)}
                                  disabled={busy() !== null}
                                  title="Delete Vermeil's downloaded copy"
                                >
                                  <IconTrash />
                                  {busy() === "delete" ? "Deleting..." : "Delete"}
                                </button>
                              </Show>
                            );
                          })()}
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>

        {/* ═══ INSTANCE OPTIONS ═══ */}
        <Show when={tab() === "instances"}>
          <div class="settings-section">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
              <div class="section-label" style="margin-bottom:0;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted)">Video</div>
              <button class="btn" style="font-size:9px;padding:3px 10px" onClick={() => {
                updateVideoSettings({ max_fps: null, vsync: null, view_bobbing: null, gui_scale: null, fov: null, fov_effects: null, master_volume: null, music_volume: null, window_width: null, window_height: null, start_maximized: null });
              }}>Reset All</button>
            </div>
            <div class="vs-grid">
              {/* Max Framerate — slider */}
              <div class="vs-cell">
                <div class="vs-key">Max FPS</div>
                <input
                  type="range"
                  min="10"
                  max="260"
                  step="10"
                  value={vs().max_fps ?? 120}
                  class="memory-slider vs-slider"
                  style={`--slider-pct:${((vs().max_fps ?? 120) - 10) / 250 * 100}%`}
                  onInput={(e) => {
                    const val = parseInt(e.currentTarget.value);
                    e.currentTarget.style.setProperty('--slider-pct', `${(val - 10) / 250 * 100}%`);
                    updateVideoSettings({ max_fps: val });
                  }}
                />
                <div class="vs-val">{vs().max_fps === null ? "Default" : vs().max_fps === 260 ? "Unlimited" : `${vs().max_fps} FPS`}</div>
              </div>

              {/* VSync */}
              <div class="vs-cell">
                <div class="vs-key">VSync</div>
                <div style="flex:1" />
                <Dropdown
                  value={vs().vsync === null ? "default" : vs().vsync ? "true" : "false"}
                  options={[
                    { value: "default", label: "Default" },
                    { value: "true", label: "On" },
                    { value: "false", label: "Off" },
                  ]}
                  onChange={(val) => {
                    updateVideoSettings({ vsync: val === "default" ? null : val === "true" });
                  }}
                />
              </div>

              {/* View Bobbing */}
              <div class="vs-cell">
                <div class="vs-key">View Bobbing</div>
                <div style="flex:1" />
                <Dropdown
                  value={vs().view_bobbing === null ? "default" : vs().view_bobbing ? "true" : "false"}
                  options={[
                    { value: "default", label: "Default" },
                    { value: "true", label: "On" },
                    { value: "false", label: "Off" },
                  ]}
                  onChange={(val) => {
                    updateVideoSettings({ view_bobbing: val === "default" ? null : val === "true" });
                  }}
                />
              </div>

              {/* GUI Scale */}
              <div class="vs-cell">
                <div class="vs-key">GUI Scale</div>
                <div style="flex:1" />
                <Dropdown
                  value={vs().gui_scale === null ? "default" : String(vs().gui_scale)}
                  options={[
                    { value: "default", label: "Default" },
                    { value: "0", label: "Auto" },
                    { value: "1", label: "Small" },
                    { value: "2", label: "Normal" },
                    { value: "3", label: "Large" },
                    { value: "4", label: "Huge" },
                  ]}
                  onChange={(val) => {
                    updateVideoSettings({ gui_scale: val === "default" ? null : parseInt(val) });
                  }}
                />
              </div>

              {/* FOV */}
              <div class="vs-cell">
                <div class="vs-key">FOV</div>
                <input
                  type="range"
                  min="30"
                  max="110"
                  step="1"
                  value={vs().fov === null ? 70 : Math.round(40 * vs().fov! + 70)}
                  class="memory-slider vs-slider"
                  style={`--slider-pct:${((vs().fov === null ? 70 : Math.round(40 * vs().fov! + 70)) - 30) / 80 * 100}%`}
                  onInput={(e) => {
                    const degrees = parseInt(e.currentTarget.value);
                    e.currentTarget.style.setProperty('--slider-pct', `${(degrees - 30) / 80 * 100}%`);
                    const fovValue = (degrees - 70) / 40;
                    updateVideoSettings({ fov: fovValue });
                  }}
                />
                <div class="vs-val">{vs().fov === null ? "Default" : `${Math.round(40 * vs().fov! + 70)}°`}</div>
              </div>

              {/* FOV Effects */}
              <div class="vs-cell">
                <div class="vs-key">FOV Effects</div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={vs().fov_effects === null ? 100 : Math.round(vs().fov_effects! * 100)}
                  class="memory-slider vs-slider"
                  style={`--slider-pct:${(vs().fov_effects === null ? 100 : Math.round(vs().fov_effects! * 100))}%`}
                  onInput={(e) => {
                    const pct = parseInt(e.currentTarget.value);
                    e.currentTarget.style.setProperty('--slider-pct', `${pct}%`);
                    updateVideoSettings({ fov_effects: pct / 100 });
                  }}
                />
                <div class="vs-val">{vs().fov_effects === null ? "Default" : `${Math.round(vs().fov_effects! * 100)}%`}</div>
              </div>
            </div>
          </div>

          {/* Sound section */}
          <div class="settings-section">
            <div class="section-label" style="margin-bottom:10px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted)">Sound</div>
            <div class="vs-grid">
              {/* Master Volume */}
              <div class="vs-cell">
                <div class="vs-key">Master</div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={vs().master_volume === null ? 100 : Math.round(vs().master_volume! * 100)}
                  class="memory-slider vs-slider"
                  style={`--slider-pct:${(vs().master_volume === null ? 100 : Math.round(vs().master_volume! * 100))}%`}
                  onInput={(e) => {
                    const pct = parseInt(e.currentTarget.value);
                    e.currentTarget.style.setProperty('--slider-pct', `${pct}%`);
                    updateVideoSettings({ master_volume: pct / 100 });
                  }}
                />
                <div class="vs-val">{vs().master_volume === null ? "Default" : `${Math.round(vs().master_volume! * 100)}%`}</div>
              </div>

              {/* Music Volume */}
              <div class="vs-cell">
                <div class="vs-key">Music</div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={vs().music_volume === null ? 100 : Math.round(vs().music_volume! * 100)}
                  class="memory-slider vs-slider"
                  style={`--slider-pct:${(vs().music_volume === null ? 100 : Math.round(vs().music_volume! * 100))}%`}
                  onInput={(e) => {
                    const pct = parseInt(e.currentTarget.value);
                    e.currentTarget.style.setProperty('--slider-pct', `${pct}%`);
                    updateVideoSettings({ music_volume: pct / 100 });
                  }}
                />
                <div class="vs-val">{vs().music_volume === null ? "Default" : `${Math.round(vs().music_volume! * 100)}%`}</div>
              </div>
            </div>
            <div class="settings-val" style="margin-top:8px;font-size:9px">Applied to all instances on launch. "Default" keeps whatever is set in-game.</div>
          </div>

          {/* Window section */}
          <div class="settings-section">
            <div class="section-label" style="margin-bottom:10px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted)">Window</div>
            <div class="vs-grid">
              {/* Resolution preset dropdown */}
              <div class="vs-cell">
                <div class="vs-key">Resolution</div>
                <div style="flex:1" />
                <Dropdown
                  value={vs().window_width && vs().window_height ? `${vs().window_width}x${vs().window_height}` : "1280x720"}
                  options={[
                    { value: "1280x720", label: "1280 × 720" },
                    { value: "1366x768", label: "1366 × 768" },
                    { value: "1600x900", label: "1600 × 900" },
                    { value: "1920x1080", label: "1920 × 1080" },
                    { value: "2560x1440", label: "2560 × 1440" },
                    { value: "3840x2160", label: "3840 × 2160" },
                  ]}
                  onChange={(val) => {
                    const [w, h] = val.split("x").map(Number);
                    updateVideoSettings({ window_width: w, window_height: h });
                  }}
                />
              </div>

              {/* Maximized toggle */}
              <div class="vs-cell">
                <div class="vs-key">Maximized</div>
                <div style="flex:1" />
                <div class={`toggle ${vs().start_maximized ? "on" : ""}`} onClick={() => updateVideoSettings({ start_maximized: !vs().start_maximized })} />
              </div>
            </div>
          </div>

          {/* Memory section — adaptive RAM allocation. Lives here in Global
              Instance because it's a per-instance behaviour control: every
              instance's `-Xmx` is computed from this when adaptive is on.
              The min/max dropdowns stay visible even with the toggle off so
              users can pre-configure their preferred bounds before flipping
              the switch (and so they understand the effect before opting in). */}
          <div class="settings-section">
            <div class="section-label" style="margin-bottom:10px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted)">Memory</div>
            <div class="vs-grid">
              {/* Adaptive toggle */}
              <div class="vs-cell">
                <div class="vs-key">Adaptive RAM</div>
                <div style="flex:1" />
                <div
                  class={`toggle ${settings()!.adaptive_ram ? "on" : ""}`}
                  onClick={handleAdaptiveToggle}
                />
              </div>

              {/* Minimum RAM dropdown. Always visible so users can configure
                  their preferred floor regardless of toggle state. The Auto
                  label shows the system-derived default so users know what
                  the sentinel value resolves to. */}
              <div class="vs-cell">
                <div class="vs-key">Minimum RAM</div>
                <div style="flex:1" />
                <Dropdown
                  value={String(settings()!.adaptive_ram_min_mb || 0)}
                  options={(() => {
                    const sysMb = systemMemoryMb() || 0;
                    const auto = adaptiveDefaultMin(sysMb);
                    return [
                      { value: "0", label: `Auto (${formatMemoryGb(auto)})` },
                      { value: "1024", label: "1 GB" },
                      { value: "1536", label: "1.5 GB" },
                      { value: "2048", label: "2 GB" },
                      { value: "2560", label: "2.5 GB" },
                      { value: "3072", label: "3 GB" },
                      { value: "4096", label: "4 GB" },
                    ];
                  })()}
                  onChange={(val) => {
                    updateSetting("adaptive_ram_min_mb", parseInt(val) || 0);
                  }}
                />
              </div>

              {/* Maximum RAM dropdown. Capped at 16 GB to keep G1GC pause
                  times healthy; users on big-memory systems with ZGC can
                  override per-instance via the in-instance Override link. */}
              <div class="vs-cell">
                <div class="vs-key">Maximum RAM</div>
                <div style="flex:1" />
                <Dropdown
                  value={String(settings()!.adaptive_ram_max_mb || 0)}
                  options={(() => {
                    const sysMb = systemMemoryMb() || 0;
                    const auto = adaptiveDefaultMax(sysMb);
                    return [
                      { value: "0", label: `Auto (${formatMemoryGb(auto)})` },
                      { value: "2048", label: "2 GB" },
                      { value: "3072", label: "3 GB" },
                      { value: "4096", label: "4 GB" },
                      { value: "6144", label: "6 GB" },
                      { value: "8192", label: "8 GB" },
                      { value: "10240", label: "10 GB" },
                      { value: "12288", label: "12 GB" },
                      { value: "14336", label: "14 GB" },
                      { value: "16384", label: "16 GB" },
                    ];
                  })()}
                  onChange={(val) => {
                    updateSetting("adaptive_ram_max_mb", parseInt(val) || 0);
                  }}
                />
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-label" style="margin-bottom:8px">Select an instance to configure</div>
            <div class="settings-val" style="margin-bottom:12px">Configure memory, resolution, Java arguments, and more per instance.</div>
            <div class="card-grid" style="margin-bottom:80px">
              <For each={instances() || []}>
                {(inst) => {
                  const iconUrl = (!inst.icon || inst.icon === "cube") ? undefined : inst.icon;
                  const loaderLabel = inst.loader.type === "vanilla" ? "Vanilla" : inst.loader.type.charAt(0).toUpperCase() + inst.loader.type.slice(1);
                  const badgeClass = (() => {
                    switch (inst.loader.type) {
                      case "fabric": return "badge--fabric";
                      case "forge": return "badge--forge";
                      case "neoforge": return "badge--neoforge";
                      case "quilt": return "badge--quilt";
                      default: return "badge--vanilla";
                    }
                  })();
                  const colorClass = (() => {
                    switch (inst.loader.type) {
                      case "fabric": return "fabric";
                      case "quilt": return "quilt";
                      case "neoforge": return "blue";
                      case "forge": return "orange";
                      default: return "green";
                    }
                  })();
                  return (
                    <div class="card card--inst" style="cursor:pointer" onClick={() => openInstanceOptions(inst.id)}>
                      <div class="card-body">
                        <div class={`inst-card-icon ${colorClass}`}>
                          <Show when={iconUrl} fallback={
                            <span class="inst-card-icon-letter">{inst.name.trim().charAt(0).toUpperCase() || "?"}</span>
                          }>
                            <img src={iconUrl!} alt="" draggable={false} />
                          </Show>
                        </div>
                        <div class="inst-card-content">
                          <div class="card-title inst-name">{inst.name}</div>
                          <div class="card-sub inst-meta">
                            {inst.game_version} · {inst.mods.length} mods · {inst.window.width}x{inst.window.height}
                          </div>
                          <div class="inst-card-badges">
                            <span class={`badge badge--loader ${badgeClass}`}>{loaderLabel}</span>
                            <span class="badge">{inst.java.memory_max_mb} MB</span>
                            <Show when={(inst.source_platforms || []).includes("modrinth")}>
                              <span class="badge badge--source badge--modrinth"><IconModrinth /></span>
                            </Show>
                            <Show when={(inst.source_platforms || []).includes("curseforge")}>
                              <span class="badge badge--source badge--curseforge"><IconCurseForge /></span>
                            </Show>
                          </div>
                        </div>
                        <span class="side-icon" style="color:var(--muted)"><IconChevronRight /></span>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>

        {/* ═══ KEYBINDS ═══ */}
        <Show when={tab() === "keybinds"}>
          <div class="settings-section">
            <div class="section-label" style="margin-bottom:8px">Keyboard shortcuts</div>
            <div class="settings-group">
              <For each={KEYBINDS}>
                {(action) => (
                  <div class="settings-row">
                    <div>
                      <div class="settings-key">{action.label}</div>
                      <Show when={action.description}>
                        <div class="settings-val">{action.description}</div>
                      </Show>
                    </div>
                    <KeybindCapture
                      binding={resolveBinding(action.id, settings()?.keybinds)}
                      defaultBinding={action.default}
                      onChange={(newBinding) => {
                        const current = { ...(settings()?.keybinds ?? {}) };
                        if (!newBinding) {
                          // Reset → remove override so default kicks in
                          delete current[action.id];
                        } else {
                          current[action.id] = newBinding;
                        }
                        updateSetting("keybinds", current);
                      }}
                    />
                  </div>
                )}
              </For>
            </div>
            <div style="font-size:11px;color:var(--muted);margin-top:10px;padding:0 4px">
              Click a binding and press the new key combination. Escape cancels capture.
              The reset arrow restores the default.
            </div>
          </div>
        </Show>
      </Show>

      {/* Chooser modal — rendered at the screen root so it overlays the
          Settings tabs when the Detect action returns multiple matches. The
          single-match path bypasses this entirely (auto-applied in
          `runDetect`). */}
      <Show when={chooser()}>
        <JavaChooserModal
          major={chooser()!.major}
          options={chooser()!.options}
          onCancel={() => setChooser(null)}
          onPick={async (install) => {
            const major = chooser()!.major;
            setChooser(null);
            await applyDetection(major, install);
          }}
        />
      </Show>
    </div>
  );
};

export default Settings;
