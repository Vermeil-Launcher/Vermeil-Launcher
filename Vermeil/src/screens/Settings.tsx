import { Component, createSignal, createResource, Show, For, onMount, createEffect } from "solid-js";
import { getSettings, saveSettings, getCacheSize, purgeCache, LauncherSettings, detectJavaInstallations, validateJavaPath, setJavaPath, installRecommendedJava, JavaInstall } from "../ipc/commands";
import { setActiveScreen, setActiveInstanceId, setInitialInstanceTab, instances, showToast } from "../App";
import { checkForUpdates } from "../services/updater";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IconDownload, IconSearch, IconFolderOpen } from "../components/Icons";
import JavaPathInput from "../components/JavaPathInput";
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
  const dlValue = (): number => dlDraft() ?? Math.min(settings()?.concurrent_downloads ?? 10, 10);
  const wrValue = (): number => wrDraft() ?? settings()?.concurrent_writes ?? 10;
  createEffect(() => {
    const s = settings();
    const d = dlDraft();
    if (s && d !== null && Math.min(s.concurrent_downloads, 10) === d) setDlDraft(null);
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
  const [javaBusy, setJavaBusy] = createSignal<Record<number, "install" | "detect" | "browse" | null>>({});
  const setJavaSlotBusy = (major: number, busy: "install" | "detect" | "browse" | null) => {
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

  const runDetect = async (major?: number) => {
    if (major !== undefined) setJavaSlotBusy(major, "detect");
    try {
      const found = await detectJavaInstallations();
      setJavaDetections(found);
      if (major !== undefined) {
        const match = found.find(i => i.major === major);
        if (match) {
          await setJavaPath(major, match.path);
          await refetch();
          showToast({ title: `Java ${major} detected`, message: match.path, type: "success" });
        } else {
          showToast({ title: `Java ${major} not found`, message: "Try Install recommended or Browse manually.", type: "info" });
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

  // Auto-save settings on every change. No explicit indicator — settings always
  // persist. Errors are surfaced via console; users can re-attempt if needed.
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
      <div class="src-tabs" style="margin-bottom:16px">
        <div class={`src-tab ${tab() === "general" ? "active" : ""}`} onClick={() => setTab("general")}>General</div>
        <div class={`src-tab ${tab() === "resources" ? "active" : ""}`} onClick={() => setTab("resources")}>Resources</div>
        <div class={`src-tab ${tab() === "instances" ? "active" : ""}`} onClick={() => setTab("instances")}>Global Instance</div>
        <div class={`src-tab ${tab() === "keybinds" ? "active" : ""}`} onClick={() => setTab("keybinds")}>Keybinds</div>
      </div>

      <Show when={settings()}>
        {/* ═══ GENERAL ═══ */}
        <Show when={tab() === "general"}>
          <div class="settings-section">
            <div class="section-label" style="margin-bottom:8px">Java</div>
            <div class="settings-group">
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
          </div>

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
                  <div class="settings-val">Max files downloading simultaneously (1–10)</div>
                </div>
                <div class="concurrency-control">
                  <input
                    class="concurrency-slider"
                    type="range"
                    min="1"
                    max="10"
                    step="1"
                    value={dlValue()}
                    style={`--slider-pct: ${((dlValue() - 1) / 9) * 100}%`}
                    onInput={(e) => {
                      const safe = clampConcurrency(parseInt(e.currentTarget.value), 10);
                      // Update the gradient fill synchronously so the visual
                      // tracks the thumb instantly, bypassing Solid's render
                      // queue. Without this, fast scrubs look laggy because
                      // the fill repaint waits for the next render tick.
                      e.currentTarget.style.setProperty('--slider-pct', `${((safe - 1) / 9) * 100}%`);
                      setDlDraft(safe);
                      updateSetting("concurrent_downloads", safe);
                    }}
                  />
                  <input
                    class="concurrency-number"
                    type="number"
                    min="1"
                    max="10"
                    value={dlValue()}
                    onChange={(e) => {
                      const safe = clampConcurrency(parseInt(e.currentTarget.value), 10);
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
                          disabled={busy() !== null || installed()}
                          title={installed() ? "Already installed" : "Download from Adoptium"}
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
                updateVideoSettings({ max_fps: null, vsync: null, view_bobbing: null, gui_scale: null, fov: null, fov_effects: null, master_volume: null, music_volume: null, window_width: null, window_height: null, fullscreen: null, start_maximized: null });
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

              {/* Fullscreen toggle */}
              <div class="vs-cell">
                <div class="vs-key">Fullscreen</div>
                <div style="flex:1" />
                <div class={`toggle ${vs().fullscreen ? "on" : ""}`} onClick={() => updateVideoSettings({ fullscreen: !vs().fullscreen })} />
              </div>

              {/* Maximized toggle */}
              <div class="vs-cell">
                <div class="vs-key">Maximized</div>
                <div style="flex:1" />
                <div class={`toggle ${vs().start_maximized ? "on" : ""}`} onClick={() => updateVideoSettings({ start_maximized: !vs().start_maximized })} />
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-label" style="margin-bottom:8px">Select an instance to configure</div>
            <div class="settings-val" style="margin-bottom:12px">Configure memory, resolution, Java arguments, and more per instance.</div>
            <div class="instance-grid">
              <For each={instances() || []}>
                {(inst) => {
                  const iconUrl = (!inst.icon || inst.icon === "cube") ? undefined : inst.icon;
                  const loaderLabel = inst.loader.type === "vanilla" ? "Vanilla" : inst.loader.type.charAt(0).toUpperCase() + inst.loader.type.slice(1);
                  const badgeClass = (() => {
                    switch (inst.loader.type) {
                      case "fabric": return "badge-fabric";
                      case "forge": return "badge-forge";
                      case "neoforge": return "badge-neo";
                      case "quilt": return "badge-quilt";
                      default: return "badge-vanilla";
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
                    <div class="inst-card" onClick={() => openInstanceOptions(inst.id)}>
                      <div class="inst-card-row">
                        <div class={`inst-card-icon ${colorClass}`}>
                          <Show when={iconUrl} fallback={
                            <span class="inst-card-icon-letter">{inst.name.trim().charAt(0).toUpperCase() || "?"}</span>
                          }>
                            <img src={iconUrl!} alt="" draggable={false} />
                          </Show>
                        </div>
                        <div class="inst-card-content">
                          <div class="inst-name">{inst.name}</div>
                          <div class="inst-meta">
                            {inst.game_version} · {inst.mods.length} mods · {inst.window.width}x{inst.window.height}
                          </div>
                          <div class="inst-card-badges">
                            <span class={`inst-badge ${badgeClass}`}>{loaderLabel}</span>
                            <span class="inst-badge badge-ram">{inst.java.memory_max_mb} MB</span>
                            <Show when={inst.window.fullscreen}>
                              <span class="inst-badge" style="background:var(--bg4);color:var(--accent-cyan)">Fullscreen</span>
                            </Show>
                          </div>
                        </div>
                        <span style="color:var(--muted);font-size:14px;flex-shrink:0">›</span>
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
    </div>
  );
};

export default Settings;
