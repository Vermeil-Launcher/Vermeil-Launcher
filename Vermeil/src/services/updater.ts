import { check, type Update } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  setUpdateAvailable,
  setUpdateDownloading,
  setUpdateProgress,
  setUpdateInstalling,
  setUpdateDownloaded,
  showToast,
} from "../App";

/**
 * Auto-updater glue.
 *
 * The Tauri JS plugin's `update.downloadAndInstall()` does not work reliably
 * on Windows: it spawns the NSIS installer asynchronously and returns before
 * the file-replace step finishes. If we then call `relaunch()` the still-
 * running vermeil.exe holds the file lock and NSIS silently fails to overwrite
 * it — the user perceives "update applied but everything is the same".
 *
 * Instead we go through three Rust commands that surface the staged update
 * as an explicit user action:
 *
 *  1. `start_update_download(rid)` — downloads payload into memory, emits
 *     `update-progress` events for the UI.
 *  2. `apply_pending_update()`     — sets a flag and closes the window.
 *  3. (RunEvent::Exit on the Rust side) — runs `update.install(data)` while
 *     the webview is gone, then `app.restart()`.
 *
 * The `update` resource lives in Tauri's resource table; we keep its `rid`
 * around so the Rust side can fetch the same `Update` instance.
 */

let cachedUpdate: Update | null = null;
let unlistenProgress: UnlistenFn | null = null;

interface UpdateProgressPayload {
  phase: "downloading" | "installing" | "done" | "error";
  bytes_done: number;
  bytes_total: number;
  fraction: number;
  message: string;
}

/**
 * Subscribe to update-progress events from the Rust side. Idempotent — calling
 * it twice does not double-subscribe. Caller is responsible for unlistening
 * (we do this when the popup is dismissed).
 */
async function ensureProgressListener() {
  if (unlistenProgress) return;
  unlistenProgress = await listen<UpdateProgressPayload>("update-progress", (e) => {
    const p = e.payload;
    setUpdateProgress(p.fraction);
    if (p.phase === "downloading") {
      setUpdateDownloading(true);
      setUpdateInstalling(false);
    } else if (p.phase === "installing") {
      setUpdateDownloading(false);
      setUpdateInstalling(true);
    } else if (p.phase === "done") {
      setUpdateDownloading(false);
      setUpdateInstalling(false);
      setUpdateDownloaded(true);
    } else if (p.phase === "error") {
      setUpdateDownloading(false);
      setUpdateInstalling(false);
      showToast({
        title: "Update failed",
        message: p.message,
        type: "error",
        autoCloseMs: 8000,
      });
    }
  });
}

/**
 * Poll for an update and surface one in the global update banner if found.
 * This does NOT auto-download; the user always opts in via
 * the UpdateBanner component.
 *
 * Returns true when a new update is available, false otherwise.
 */
export async function checkForUpdates(silent = false): Promise<boolean> {
  try {
    const update = await check();
    if (!update) {
      if (!silent) {
        showToast({
          title: "No updates",
          message: "You're running the latest version.",
          type: "info",
          autoCloseMs: 3000,
        });
      }
      return false;
    }

    // Re-checks (the 5-min interval) shouldn't disrupt the user if we're
    // already showing them this same version. Bail out without touching the
    // banner state — they may be mid-download.
    if (cachedUpdate && cachedUpdate.version === update.version) {
      return true;
    }

    cachedUpdate = update;
    setUpdateAvailable({
      version: update.version,
      currentVersion: update.currentVersion,
      body: update.body ?? "",
      date: update.date ?? "",
    });
    return true;
  } catch (e) {
    console.error("Update check failed:", e);
    if (!silent) {
      showToast({
        title: "Update check failed",
        message: typeof e === "string" ? e : (e as Error).message ?? "Unknown error",
        type: "error",
        autoCloseMs: 6000,
      });
    }
    return false;
  }
}

/**
 * Download the previously-detected update into memory. Emits `update-progress`
 * events as it goes; the UI listens via `ensureProgressListener`.
 */
export async function downloadUpdate(): Promise<void> {
  if (!cachedUpdate) {
    throw new Error("No update available — run checkForUpdates first");
  }
  await ensureProgressListener();
  setUpdateDownloading(true);
  setUpdateProgress(0);
  // The plugin-updater check() call assigned the resource to the `Update`
  // object — its `rid` is what Rust uses to find it again.
  // @ts-expect-error — `rid` is on the resource but not in the public type
  const rid = cachedUpdate.rid as number;
  await invoke<void>("start_update_download", { rid });
  setUpdateDownloading(false);
  setUpdateDownloaded(true);
}

/**
 * Apply the buffered update. The Rust side closes the window; install runs
 * at RunEvent::Exit, then the app relaunches.
 */
export async function applyUpdate(): Promise<void> {
  await invoke<void>("apply_pending_update");
}

/**
 * Drop the buffered update without installing. Used when the user dismisses
 * the "ready to install" prompt.
 */
export async function dismissUpdate(): Promise<void> {
  cachedUpdate = null;
  await invoke<void>("clear_pending_update");
  setUpdateAvailable(null);
  setUpdateDownloading(false);
  setUpdateDownloaded(false);
  setUpdateInstalling(false);
  setUpdateProgress(0);
  if (unlistenProgress) {
    unlistenProgress();
    unlistenProgress = null;
  }
}
