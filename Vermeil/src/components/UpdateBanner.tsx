import { Component, Show } from "solid-js";
import {
  updateAvailable,
  updateDownloading,
  updateInstalling,
  updateDownloaded,
  updateProgress,
} from "../App";
import { downloadUpdate, applyUpdate, dismissUpdate } from "../services/updater";
import { openUrl } from "@tauri-apps/plugin-opener";

const RELEASES_URL = "https://github.com/davekb1976-beep/Vermeil-Launcher/releases/tag";

/**
 * Auto-update prompt rendered as a centered fixed-position card matching the
 * other top-level overlays (`InstallProgress`, `BulkInstallToast`).
 *
 * State machine:
 *   • idle              → hidden
 *   • update available  → "Vermeil X is available — Download / Later"
 *   • downloading       → progress bar with bytes
 *   • downloaded        → "Ready to install — Restart now / Later"
 *   • installing        → indeterminate spinner ("Installing... app will close")
 *
 * The "installing" phase is intentionally indeterminate. NSIS does not emit
 * progress callbacks during file-replace, and the install runs in our
 * `RunEvent::Exit` handler after the window is gone — which means by the
 * time install actually starts, this UI is no longer rendered. We keep the
 * indeterminate spinner up between the user clicking "Restart" and the
 * window closing so they have visible feedback that something is happening.
 */
const UpdateBanner: Component = () => {
  const visible = () => updateAvailable() !== null;

  const phaseLabel = () => {
    if (updateInstalling()) return "Installing update...";
    if (updateDownloaded()) return "Ready to install";
    if (updateDownloading()) {
      return `Downloading — ${Math.round(updateProgress() * 100)}%`;
    }
    return `Vermeil ${updateAvailable()?.version} is available`;
  };

  return (
    <Show when={visible()}>
      <div class="update-banner">
        <div class="update-banner-header">
          <div class="update-banner-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="18" height="18">
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <polyline points="21 3 21 8 16 8" />
            </svg>
          </div>
          <div class="update-banner-title">{phaseLabel()}</div>
          <Show when={!updateInstalling()}>
            <button
              class="update-banner-dismiss"
              onClick={() => dismissUpdate()}
              title="Dismiss"
            >
              ✕
            </button>
          </Show>
        </div>

        <div class="update-banner-body">
          <Show when={!updateDownloading() && !updateDownloaded() && !updateInstalling()}>
            <div class="update-banner-meta">
              From {updateAvailable()?.currentVersion} → {updateAvailable()?.version}
            </div>
            <div class="update-banner-actions">
              <button
                class="btn btn-accent"
                onClick={() => downloadUpdate().catch((e) => console.error(e))}
              >
                Download
              </button>
              <button
                class="btn btn-ghost"
                onClick={() =>
                  openUrl(`${RELEASES_URL}/v${updateAvailable()?.version}`).catch(() => {})
                }
                title="Open release notes on GitHub"
              >
                Release notes
              </button>
              <button class="btn btn-ghost" onClick={() => dismissUpdate()}>
                Later
              </button>
            </div>
          </Show>

          <Show when={updateDownloading()}>
            <div class="update-banner-bar-track">
              <div
                class="update-banner-bar-fill"
                style={{ width: `${Math.min(updateProgress() * 100, 100)}%` }}
              />
            </div>
          </Show>

          <Show when={updateDownloaded() && !updateInstalling()}>
            <div class="update-banner-meta">
              Vermeil will close, install the update, and reopen on the new version.
            </div>
            <div class="update-banner-actions">
              <button
                class="btn btn-accent"
                onClick={() => applyUpdate().catch((e) => console.error(e))}
              >
                Restart and install
              </button>
              <button class="btn btn-ghost" onClick={() => dismissUpdate()}>
                Later
              </button>
            </div>
          </Show>

          <Show when={updateInstalling()}>
            <div class="update-banner-installing">
              <div class="update-banner-spinner" />
              <span class="update-banner-meta">
                Closing Vermeil and applying the update — the app will reopen automatically.
              </span>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
};

export default UpdateBanner;
