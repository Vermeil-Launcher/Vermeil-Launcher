import { Component, createSignal, createResource, Show, For, onMount } from "solid-js";
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
                    value={Math.min(settings()!.concurrent_downloads, 10)}
                    style={`--slider-pct: ${((Math.min(settings()!.concurrent_downloads, 10) - 1) / 9) * 100}%`}
                    onInput={(e) => updateSetting("concurrent_downloads", clampConcurrency(parseInt(e.currentTarget.value), 10))}
                  />
                  <input
                    class="concurrency-number"
                    type="number"
                    min="1"
                    max="10"
                    value={Math.min(settings()!.concurrent_downloads, 10)}
                    onChange={(e) => {
                      const safe = clampConcurrency(parseInt(e.currentTarget.value), 10);
                      e.currentTarget.value = String(safe);
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
                    value={settings()!.concurrent_writes}
                    style={`--slider-pct: ${((settings()!.concurrent_writes - 1) / 49) * 100}%`}
                    onInput={(e) => updateSetting("concurrent_writes", clampConcurrency(parseInt(e.currentTarget.value), 50))}
                  />
                  <input
                    class="concurrency-number"
                    type="number"
                    min="1"
                    max="50"
                    value={settings()!.concurrent_writes}
                    onChange={(e) => {
                      const safe = clampConcurrency(parseInt(e.currentTarget.value), 50);
                      e.currentTarget.value = String(safe);
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
            <div class="section-label" style="margin-bottom:8px">Video Settings</div>
            <div class="settings-val" style="margin-bottom:12px">Applied to all instances on launch. Leave a setting on "Default" to keep whatever is set in-game.</div>
            <div class="settings-group">
              <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px">
                <div style="display:flex;align-items:center;justify-content:space-between">
                  <div>
                    <div class="settings-key">Max Framerate</div>
                    <div class="settings-val">{settings()!.video_settings.max_fps === null ? "Default (in-game setting)" : settings()!.video_settings.max_fps === 260 ? "Unlimited" : `${settings()!.video_settings.max_fps} FPS`}</div>
                  </div>
                  <Show when={settings()!.video_settings.max_fps !== null}>
                    <button class="btn" style="font-size:9px;padding:2px 8px" onClick={() => {
                      const vs = { ...settings()!.video_settings, max_fps: null };
                      updateSetting("video_settings", vs);
                    }}>Reset</button>
                  </Show>
                </div>
                <div style="display:flex;align-items:center;gap:10px">
                  <span style="font-size:10px;color:var(--muted);min-width:24px">10</span>
                  <input
                    type="range"
                    min="10"
                    max="260"
                    step="10"
                    value={settings()!.video_settings.max_fps ?? 120}
                    class="memory-slider"
                    style={`flex:1;--slider-pct:${((settings()!.video_settings.max_fps ?? 120) - 10) / 250 * 100}%`}
                    onInput={(e) => {
                      const val = parseInt(e.currentTarget.value);
                      // Update fill immediately for smooth visual feedback
                      e.currentTarget.style.setProperty('--slider-pct', `${(val - 10) / 250 * 100}%`);
                      const vs = { ...settings()!.video_settings, max_fps: val };
                      updateSetting("video_settings", vs);
                    }}
                  />
                  <span style="font-size:10px;color:var(--muted);min-width:24px">260</span>
                </div>
              </div>
              <div class="settings-row">
                <div>
                  <div class="settings-key">VSync</div>
                  <div class="settings-val">{settings()!.video_settings.vsync === null ? "Default (in-game setting)" : settings()!.video_settings.vsync ? "On" : "Off"}</div>
                </div>
                <Dropdown
                  value={settings()!.video_settings.vsync === null ? "default" : settings()!.video_settings.vsync ? "true" : "false"}
                  options={[
                    { value: "default", label: "Default" },
                    { value: "true", label: "On" },
                    { value: "false", label: "Off" },
                  ]}
                  onChange={(val) => {
                    const vs = { ...settings()!.video_settings, vsync: val === "default" ? null : val === "true" };
                    updateSetting("video_settings", vs);
                  }}
                />
              </div>
              <div class="settings-row">
                <div>
                  <div class="settings-key">View Bobbing</div>
                  <div class="settings-val">{settings()!.video_settings.view_bobbing === null ? "Default (in-game setting)" : settings()!.video_settings.view_bobbing ? "On" : "Off"}</div>
                </div>
                <Dropdown
                  value={settings()!.video_settings.view_bobbing === null ? "default" : settings()!.video_settings.view_bobbing ? "true" : "false"}
                  options={[
                    { value: "default", label: "Default" },
                    { value: "true", label: "On" },
                    { value: "false", label: "Off" },
                  ]}
                  onChange={(val) => {
                    const vs = { ...settings()!.video_settings, view_bobbing: val === "default" ? null : val === "true" };
                    updateSetting("video_settings", vs);
                  }}
                />
              </div>
              <div class="settings-row">
                <div>
                  <div class="settings-key">GUI Scale</div>
                  <div class="settings-val">{settings()!.video_settings.gui_scale === null ? "Default (in-game setting)" : settings()!.video_settings.gui_scale === 0 ? "Auto" : ["Auto", "Small", "Normal", "Large", "Huge"][settings()!.video_settings.gui_scale!]}</div>
                </div>
                <Dropdown
                  value={settings()!.video_settings.gui_scale === null ? "default" : String(settings()!.video_settings.gui_scale)}
                  options={[
                    { value: "default", label: "Default" },
                    { value: "0", label: "Auto" },
                    { value: "1", label: "Small" },
                    { value: "2", label: "Normal" },
                    { value: "3", label: "Large" },
                    { value: "4", label: "Huge" },
                  ]}
                  onChange={(val) => {
                    const vs = { ...settings()!.video_settings, gui_scale: val === "default" ? null : parseInt(val) };
                    updateSetting("video_settings", vs);
                  }}
                />
              </div>
              <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px">
                <div style="display:flex;align-items:center;justify-content:space-between">
                  <div>
                    <div class="settings-key">FOV</div>
                    <div class="settings-val">{settings()!.video_settings.fov === null ? "Default (in-game setting)" : `${Math.round(40 * settings()!.video_settings.fov! + 70)}°`}</div>
                  </div>
                  <Show when={settings()!.video_settings.fov !== null}>
                    <button class="btn" style="font-size:9px;padding:2px 8px" onClick={() => {
                      const vs = { ...settings()!.video_settings, fov: null };
                      updateSetting("video_settings", vs);
                    }}>Reset</button>
                  </Show>
                </div>
                <div style="display:flex;align-items:center;gap:10px">
                  <span style="font-size:10px;color:var(--muted);min-width:28px">30°</span>
                  <input
                    type="range"
                    min="30"
                    max="110"
                    step="1"
                    value={settings()!.video_settings.fov === null ? 70 : Math.round(40 * settings()!.video_settings.fov + 70)}
                    class="memory-slider"
                    style={`flex:1;--slider-pct:${((settings()!.video_settings.fov === null ? 70 : Math.round(40 * settings()!.video_settings.fov + 70)) - 30) / 80 * 100}%`}
                    onInput={(e) => {
                      const degrees = parseInt(e.currentTarget.value);
                      // Update fill immediately for smooth visual feedback
                      e.currentTarget.style.setProperty('--slider-pct', `${(degrees - 30) / 80 * 100}%`);
                      const fovValue = (degrees - 70) / 40;
                      const vs = { ...settings()!.video_settings, fov: fovValue };
                      updateSetting("video_settings", vs);
                    }}
                  />
                  <span style="font-size:10px;color:var(--muted);min-width:32px">110°</span>
                </div>
              </div>
              <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px">
                <div style="display:flex;align-items:center;justify-content:space-between">
                  <div>
                    <div class="settings-key">FOV Effects</div>
                    <div class="settings-val">{settings()!.video_settings.fov_effects === null ? "Default (in-game setting)" : `${Math.round(settings()!.video_settings.fov_effects! * 100)}%`}</div>
                  </div>
                  <Show when={settings()!.video_settings.fov_effects !== null}>
                    <button class="btn" style="font-size:9px;padding:2px 8px" onClick={() => {
                      const vs = { ...settings()!.video_settings, fov_effects: null };
                      updateSetting("video_settings", vs);
                    }}>Reset</button>
                  </Show>
                </div>
                <div style="display:flex;align-items:center;gap:10px">
                  <span style="font-size:10px;color:var(--muted);min-width:24px">0%</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={settings()!.video_settings.fov_effects === null ? 100 : Math.round(settings()!.video_settings.fov_effects * 100)}
                    class="memory-slider"
                    style={`flex:1;--slider-pct:${(settings()!.video_settings.fov_effects === null ? 100 : Math.round(settings()!.video_settings.fov_effects * 100))}%`}
                    onInput={(e) => {
                      const pct = parseInt(e.currentTarget.value);
                      e.currentTarget.style.setProperty('--slider-pct', `${pct}%`);
                      const vs = { ...settings()!.video_settings, fov_effects: pct / 100 };
                      updateSetting("video_settings", vs);
                    }}
                  />
                  <span style="font-size:10px;color:var(--muted);min-width:32px">100%</span>
                </div>
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
