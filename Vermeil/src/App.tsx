import { Component, createSignal, createResource, createEffect, Show, onMount, lazy } from "solid-js";
import FloatingDock from "./components/FloatingDock";
import Titlebar from "./components/Titlebar";
import ResizeHandles from "./components/ResizeHandles";
import Home from "./screens/Home";
import Library from "./screens/Library";
import InstanceMods from "./screens/InstanceMods";
import Settings from "./screens/Settings";
import Account from "./screens/Account";
import Downloads from "./screens/Downloads";
// Lazy-load the Skins screen because skinview3d pulls in ~500 KB of three.js
// that we don't want to pay for unless the user actually opens Skins.
const Skins = lazy(() => import("./screens/Skins"));
import CreateChoose from "./modals/CreateChoose";
import CreateCustom from "./modals/CreateCustom";
import BrowseModpacks from "./modals/BrowseModpacks";
import ImportCurseForge from "./modals/ImportCurseForge";
import NoAccountModal from "./components/NoAccountModal";
import Toasts, { showToast } from "./components/Toasts";
import InstallProgress from "./components/InstallProgress";
import BulkInstallToast from "./components/BulkInstallToast";
import DependencyIssuesModal from "./components/DependencyIssuesModal";
import UpdateBanner from "./components/UpdateBanner";
import CrashReportModal, { showCrashReport } from "./components/CrashReportModal";
import OnboardingWizard, { openOnboarding } from "./modals/OnboardingWizard";
import PinInstancesModal from "./modals/PinInstancesModal";
import { pinInstancesModalOpen, closePinInstancesModal } from "./modals/PinInstancesModal";
import { listInstances, getActiveAccount, getSettings, getSkinProfile, showWindow, loadDownloadHistory, saveDownloadHistory } from "./ipc/commands";
import { listen } from "@tauri-apps/api/event";
import { checkForUpdates } from "./services/updater";
import { matchesKeybind, resolveBinding } from "./lib/keybinds";

export type Screen =
  | "home"
  | "library"
  | "mods"
  | "settings"
  | "account"
  | "skins"
  | "downloads"
  | "create-choose"
  | "create-custom"
  | "create-modpack"
  | "create-import";

const [activeScreen, _setActiveScreen] = createSignal<Screen>("home");
const setActiveScreen = (screen: Screen) => {
  _setActiveScreen(screen);
  // Reset scroll position on navigation
  setTimeout(() => document.querySelector(".content")?.scrollTo(0, 0), 0);
};
const [activeInstanceId, setActiveInstanceId] = createSignal<string | null>(null);
const [initialInstanceTab, setInitialInstanceTab] = createSignal<string>("content");
const [gameLaunched, setGameLaunched] = createSignal(false);
const [gameRunning, setGameRunning] = createSignal(false);
const [showNoAccountModal, setShowNoAccountModal] = createSignal(false);

// Live game log buffer, keyed by instance ID. Lives at module scope (not
// per-screen) so logs persist across navigation — exit Minecraft, browse
// the Library, come back to the Logs tab, and the output from your last
// play session is still there to review.
//
// Per-instance buckets fix the cross-talk where launching instance A then
// switching to instance B's Logs tab would show A's output. Each `game-log`
// event carries its originating instance ID; the listener routes lines
// into the matching bucket.
//
// The whole map lives until the launcher itself restarts.
const [gameLogs, setGameLogs] = createSignal<Record<string, string[]>>({});

/** Per-instance log buffer cap. A chatty modpack can emit tens of thousands
 *  of lines per session; keeping them all would grow memory and the Logs-tab
 *  DOM unbounded. We retain the most recent lines (tail), matching the logs
 *  popout window's identical cap. */
const MAX_LOG_LINES = 5000;

export function appendGameLog(instanceId: string, line: string) {
  setGameLogs(prev => {
    const existing = prev[instanceId] ?? [];
    const next = [...existing, line];
    return {
      ...prev,
      [instanceId]: next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next,
    };
  });
}

/** Clear logs for a single instance. Called at launch time so a fresh
 *  session starts with an empty viewer instead of last session's output. */
export function clearGameLogs(instanceId: string) {
  setGameLogs(prev => {
    const next = { ...prev };
    delete next[instanceId];
    return next;
  });
}

/** Logs for a specific instance, or empty array if none. */
export function gameLogsFor(instanceId: string | null | undefined): string[] {
  if (!instanceId) return [];
  return gameLogs()[instanceId] ?? [];
}

export { gameLogs };

// Network state
const [offline, setOffline] = createSignal(!navigator.onLine);
if (typeof window !== "undefined") {
  window.addEventListener("offline", () => setOffline(true));
  window.addEventListener("online", () => setOffline(false));
}

// Download tracking
export interface DownloadEntry {
  id: string;
  name: string;
  category: string;
  status: "downloading" | "completed" | "failed";
  timestamp: number;
  iconUrl?: string;
  loader?: string;
  gameVersion?: string;
  /** Primary author display name. Cached when the user installs from
   *  search results so we can show "by Author" in the Downloads history
   *  card without re-fetching project metadata. */
  author?: string;
}
const [downloads, setDownloads] = createSignal<DownloadEntry[]>([]);
const [bulkBatchSize, setBulkBatchSize] = createSignal(0); // Track bulk install total

// Load persisted download history on startup
loadDownloadHistory().then(json => {
  try {
    const entries: DownloadEntry[] = JSON.parse(json);
    // Only load completed/failed entries (not stale "downloading" from a crash)
    const persisted = entries.filter(d => d.status !== "downloading").slice(0, 200);
    setDownloads(persisted);
  } catch {}
}).catch(() => {});

// Persist to disk whenever a download completes or fails (debounced)
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
function persistDownloads() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const completed = downloads().filter(d => d.status !== "downloading").slice(0, 200);
    saveDownloadHistory(JSON.stringify(completed)).catch(() => {});
  }, 500);
}

export function trackDownload(
  name: string,
  category: string,
  meta?: { iconUrl?: string | null; loader?: string; gameVersion?: string; author?: string | null },
): string {
  const id = Math.random().toString(36).slice(2);
  const entry: DownloadEntry = {
    id,
    name,
    category,
    status: "downloading",
    timestamp: Date.now(),
    iconUrl: meta?.iconUrl ?? undefined,
    loader: meta?.loader,
    gameVersion: meta?.gameVersion,
    author: meta?.author ?? undefined,
  };
  setDownloads(prev => [entry, ...prev].slice(0, 200));
  return id;
}

export function completeDownload(id: string, nameOverride?: string) {
  setDownloads(prev => prev.map(d => d.id === id ? { ...d, status: "completed" as const, timestamp: Date.now(), name: nameOverride || d.name } : d));
  persistDownloads();
}

export function failDownload(id: string) {
  setDownloads(prev => prev.map(d => d.id === id ? { ...d, status: "failed" as const, timestamp: Date.now() } : d));
  persistDownloads();
}

export function startBulkBatch(total: number) { setBulkBatchSize(total); }
export function endBulkBatch() { setBulkBatchSize(0); }

const activeDownloadCount = () => downloads().filter(d => d.status === "downloading").length;
const isBulkInstall = () => bulkBatchSize() > 1;
const bulkDone = () => bulkBatchSize() - activeDownloadCount();
const bulkProgress = () => bulkBatchSize() > 0 ? bulkDone() / bulkBatchSize() : 0;

export function clearDownloadHistory() {
  setDownloads(prev => prev.filter(d => d.status === "downloading"));
  persistDownloads();
}

// Auto-updater state. Populated by `services/updater.ts` after a successful
// check; read by the <UpdateBanner /> component to render the install prompt.
export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  body: string;
  date: string;
}
const [updateAvailable, setUpdateAvailable] = createSignal<AvailableUpdate | null>(null);
const [updateDownloading, setUpdateDownloading] = createSignal(false);
const [updateInstalling, setUpdateInstalling] = createSignal(false);
const [updateDownloaded, setUpdateDownloaded] = createSignal(false);
const [updateProgress, setUpdateProgress] = createSignal(0);
export {
  updateAvailable,
  setUpdateAvailable,
  updateDownloading,
  setUpdateDownloading,
  updateInstalling,
  setUpdateInstalling,
  updateDownloaded,
  setUpdateDownloaded,
  updateProgress,
  setUpdateProgress,
};

/**
 * Pre-launch check. If no account exists, shows modal and returns false.
 * Caller should bail out of the launch if this returns false.
 */
export function ensureAccountOrPrompt(): boolean {
  if (!account()) {
    setShowNoAccountModal(true);
    return false;
  }
  return true;
}

const [instances, { refetch: refetchInstances }] = createResource(listInstances);
const [account, { refetch: refetchAccount }] = createResource(getActiveAccount);

// Sidebar pinned-instance IDs. Sourced from `LauncherSettings.sidebar_pinned_instances`
// but mirrored into a signal so the sidebar updates reactively the moment
// `PinInstancesModal` saves new pins. Without this mirror, the sidebar
// would be reading from a settings snapshot that doesn't refresh until the
// app is reloaded.
const [pinnedInstanceIds, setPinnedInstanceIds] = createSignal<string[]>([]);

/** Re-load pin list from settings. Called on startup and after the pin
 *  manager modal saves changes. */
export async function refreshPinnedInstanceIds() {
  try {
    const s = await getSettings();
    setPinnedInstanceIds(s.sidebar_pinned_instances ?? []);
  } catch (e) {
    console.error("Failed to load sidebar pins:", e);
  }
}

// Seed pins on launcher boot so the sidebar comes up with the right icons.
refreshPinnedInstanceIds().catch(() => {});

export { pinnedInstanceIds };

// Pin selector overlay — when true, the floating dock transforms into a
// scrollable horizontal carousel of pinned instances. Toggled by the
// `toggle_pin_selector` keybind (default Ctrl+P) or by the dock's center
// button while in selector mode.
const [pinSelectorOpen, setPinSelectorOpen] = createSignal(false);
export { pinSelectorOpen, setPinSelectorOpen };

// Dock auto-hide. Set true to slide the floating dock out of view (used on
// the instance Logs tab so it doesn't cover log output). The dock reveals
// itself when the cursor nears the bottom of the window regardless of this
// flag, and screens reset it to false when they unmount.
const [dockHidden, setDockHidden] = createSignal(false);
export { dockHidden, setDockHidden };

// Dock pagination. Screens that need page navigation set this to a descriptor
// object; the floating dock renders the page controls inline. When the screen
// unmounts or no longer needs paging, it sets this back to null.
export interface DockPaginationState {
  current: number;
  total: number;
  onPageChange: (page: number) => void;
}
const [dockPagination, setDockPagination] = createSignal<DockPaginationState | null>(null);
export { dockPagination, setDockPagination };

// Active skin URL for the currently signed-in Microsoft account. Populated
// lazily from `getSkinProfile()` whenever the active account changes; cleared
// for offline accounts since they have no Mojang profile to fetch.
//
// Surfaced everywhere a user avatar is shown — titlebar pill, Account screen
// rows, etc. — so the launcher feels personalized without each component
// having to round-trip Mojang on its own.
const [activeSkinUrl, setActiveSkinUrl] = createSignal<string | null>(null);

/**
 * Re-fetch the active skin from Mojang and update the global signal.
 * Called from `App.tsx` on account change and from any code path that
 * uploads / resets a skin (e.g. the Skins screen).
 */
export async function refreshActiveSkin() {
  const a = account();
  if (!a || a.is_offline) {
    setActiveSkinUrl(null);
    return;
  }
  try {
    const profile = await getSkinProfile();
    const active = profile.skins.find((s) => s.state === "ACTIVE") ?? profile.skins[0];
    setActiveSkinUrl(active?.texture ?? null);
  } catch (e) {
    console.error("Active skin fetch failed:", e);
    setActiveSkinUrl(null);
  }
}

// React to account changes — clear the URL on sign-out, fetch on sign-in.
createEffect(() => {
  const a = account();
  if (!a || a.is_offline) {
    setActiveSkinUrl(null);
    return;
  }
  refreshActiveSkin().catch(() => {});
});

export { activeScreen, setActiveScreen, activeInstanceId, setActiveInstanceId, initialInstanceTab, setInitialInstanceTab, gameLaunched, setGameLaunched, gameRunning, setGameRunning, downloads, activeDownloadCount, isBulkInstall, bulkDone, bulkProgress, instances, refetchInstances, account, refetchAccount, activeSkinUrl, offline, showToast };

const screenTitles: Record<Screen, string> = {
  home: "Home",
  library: "Library",
  mods: "Instance",
  settings: "Settings",
  account: "Account",
  skins: "Skins & capes",
  downloads: "Downloads",
  "create-choose": "Create Instance",
  "create-custom": "Custom Setup",
  "create-modpack": "Browse Modpacks",
  "create-import": "Import",
};

const App: Component = () => {
  // Listen for game exit/crash events from backend
  onMount(async () => {
    // Live game log stream. Subscribe at app level so log lines pour into
    // the global per-instance buckets even when the user is on a different
    // screen — they can switch to the Logs tab later and still see
    // everything for that specific instance.
    listen<{ instanceId: string; line: string }>("game-log", (event) => {
      const { instanceId, line } = event.payload;
      if (instanceId) {
        appendGameLog(instanceId, line);
      }
    });

    listen("game-exited", () => {
      setGameRunning(false);
    });

    // Re-fetch instances when modpack metadata enrichment completes in the
    // background. The install command returns immediately for snappy UX;
    // the backend then enriches mod metadata + checks cross-platform
    // availability and emits this event so cards can update.
    listen<string>("instance-enriched", () => {
      refetchInstances();
    });

    listen<string | null>("game-crashed", (event) => {
      setGameRunning(false);
      const crashPath = event.payload;
      showToast({
        title: "Game crashed",
        message: crashPath
          ? "Open the crash report or check the Logs tab for details."
          : "The game exited unexpectedly. Check the Logs tab for details.",
        type: "error",
        autoCloseMs: 12000,
        action: crashPath
          ? {
              label: "View report",
              onClick: () => showCrashReport(crashPath),
            }
          : undefined,
      });
    });

    // Auto-update check on startup if enabled (skip when offline). After
    // the first check, re-poll every 5 minutes so a release published
    // while the launcher is open still surfaces without a relaunch. The
    // check is dedup'd against the cached version so an existing banner
    // won't re-prompt. Manual checks are wired separately via the
    // "Check for updates" button on the Settings screen.
    if (!offline()) {
      getSettings().then(s => {
        if (s.auto_update) {
          checkForUpdates(true).catch(e => console.error("Auto-update check failed:", e));
          setInterval(() => {
            if (!offline()) {
              checkForUpdates(true).catch(e =>
                console.error("Auto-update re-check failed:", e),
              );
            }
          }, 5 * 60 * 1000);
        }
      }).catch(() => {});
    }

    // First-run onboarding. Show the wizard once per user — gated on
    // `settings.onboarded` AND an empty Library, so existing users with
    // instances aren't re-prompted on upgrade. Calls `listInstances()`
    // directly because the `instances` resource may not have settled yet
    // when `onMount` first runs.
    try {
      const [s, list] = await Promise.all([getSettings(), listInstances()]);
      if (!s.onboarded && list.length === 0) {
        openOnboarding();
      }
    } catch (e) {
      console.error("Onboarding gate failed:", e);
    }

    // Show window after initialization is complete (window starts hidden)
    await showWindow();

    // Global keyboard shortcuts.
    //
    // Bindings are sourced from `LauncherSettings.keybinds` (user-customizable
    // via Settings → Keybinds) with fallbacks defined in `lib/keybinds.ts`.
    // We cache the user bindings here and refresh them whenever settings
    // change. The cache is invalidated by listening on a custom DOM event
    // (`vermeil-keybinds-changed`) that the Settings tab fires after save.
    let userBindings: Record<string, string> = {};
    const refreshBindings = async () => {
      try {
        const s = await getSettings();
        userBindings = s.keybinds ?? {};
      } catch {
        userBindings = {};
      }
    };
    refreshBindings();
    window.addEventListener("vermeil-keybinds-changed", () => {
      refreshBindings();
    });

    document.addEventListener("keydown", (e) => {
      // Escape is hardcoded — closes the topmost open modal/tool. Not
      // user-rebindable because users expect Escape to "back out" of UI
      // and remapping it would brick recovery from a stuck modal.
      if (e.key === "Escape") {
        if (pinSelectorOpen()) {
          setPinSelectorOpen(false);
          return;
        }
        if (pinInstancesModalOpen()) {
          closePinInstancesModal();
          return;
        }
        const screen = activeScreen();
        if (screen === "create-choose" || screen === "create-custom" || screen === "create-modpack" || screen === "create-import") {
          setActiveScreen("library");
          return;
        }
      }

      // Customizable shortcuts. Each lookup resolves to either the user's
      // override or the action's default.
      if (matchesKeybind(e, resolveBinding("create_instance", userBindings))) {
        e.preventDefault();
        setActiveScreen("create-choose");
        return;
      }
      if (matchesKeybind(e, resolveBinding("open_settings", userBindings))) {
        e.preventDefault();
        setActiveScreen("settings");
        return;
      }
      if (matchesKeybind(e, resolveBinding("toggle_pin_selector", userBindings))) {
        e.preventDefault();
        setPinSelectorOpen((v) => !v);
        return;
      }
    });
  });

  return (
    <div class="app">
      <ResizeHandles />
      <div class="main">
        <Show when={offline()}>
          <div class="offline-banner">No internet connection</div>
        </Show>
        <Titlebar title={screenTitles[activeScreen()]} />
        <div class="content">
          <Show when={activeScreen() === "home"}><Home /></Show>
          <Show when={activeScreen() === "library"}><Library /></Show>
          <Show when={activeScreen() === "mods"}><InstanceMods /></Show>
          <Show when={activeScreen() === "settings"}><Settings /></Show>
          <Show when={activeScreen() === "account"}><Account /></Show>
          <Show when={activeScreen() === "skins"}><Skins /></Show>
          <Show when={activeScreen() === "downloads"}><Downloads /></Show>
          <Show when={activeScreen() === "create-choose"}><CreateChoose /></Show>
          <Show when={activeScreen() === "create-custom"}><CreateCustom /></Show>
          <Show when={activeScreen() === "create-modpack"}><BrowseModpacks /></Show>
          <Show when={activeScreen() === "create-import"}><ImportCurseForge /></Show>
        </div>
        <FloatingDock />
      </div>
      <NoAccountModal open={showNoAccountModal()} onClose={() => setShowNoAccountModal(false)} />
      <InstallProgress />
      <BulkInstallToast />
      <DependencyIssuesModal />
      <UpdateBanner />
      <CrashReportModal />
      <OnboardingWizard />
      <PinInstancesModal />
      <Toasts />
    </div>
  );
};

export default App;
