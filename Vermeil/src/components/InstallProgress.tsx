import { Component, createSignal, Show, onMount, onCleanup } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { IconDownload } from "./Icons";

interface ProgressEvent {
  section: string;
  title: string;
  message: string;
  fraction: number;
  skipped: boolean;
}

/**
 * Install progress popup — single unified progress bar.
 *
 * Two backend event streams feed this UI:
 *
 *   1. `install-progress` — the orchestrator's high-level phases
 *      ("Preparing", "Extracting Java", "Patching client") and the
 *      installer's streamed log phases for Forge / NeoForge.
 *   2. `download-progress` — fired ~20Hz inside `download_all` while a
 *      batch is in flight, carrying `completed/total` and a per-tick
 *      file count.
 *
 * The flicker bug: when the loader installer is streaming phase lines and
 * `resolve_libraries` is also kicking off a parallel download batch, both
 * streams race to write the message. The user sees "Patching client" and
 * "Downloading files (n/m)" alternating frame-by-frame.
 *
 * Fix: when an `install-progress` event lands with a real (non-skipped)
 * message, latch that message for a short guard window. While the latch
 * is held, `download-progress` is still allowed to advance the bar
 * fraction (so the bar moves smoothly), but it CANNOT overwrite the
 * message text. The latch expires when no new phase arrives for ~2s,
 * at which point `download-progress` resumes owning the text again.
 */
const InstallProgress: Component = () => {
  const [visible, setVisible] = createSignal(false);
  const [title, setTitle] = createSignal("");
  const [message, setMessage] = createSignal("");
  const [fraction, setFraction] = createSignal(0);
  const [done, setDone] = createSignal(false);

  let hideTimeout: number | undefined;
  let activityTimeout: number | undefined;
  /**
   * Latch state for the message-source race. While `phaseLatchUntil` is
   * in the future, `download-progress` won't touch the message text.
   * When an installer-phase event arrives (fraction >= 0.95), the latch
   * holds until the next install-progress event updates it — effectively
   * locking the message to the installer's stream for the entire duration
   * of Forge/NeoForge processor execution.
   */
  let phaseLatchUntil = 0;
  const PHASE_LATCH_MS = 2000;
  /** When true, the installer subprocess is actively streaming phases.
   *  Download-progress events may still advance the bar fraction but
   *  NEVER overwrite the message text until the subprocess finishes. */
  let installerActive = false;

  onMount(() => {
    const unlistenInstall = listen<ProgressEvent>("install-progress", (event) => {
      const payload = event.payload;

      // Clear any pending hide
      if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = undefined; }

      // "done" signal — hide popup after a short delay
      if (payload.section === "done") {
        installerActive = false;
        setDone(true);
        setFraction(1);
        setMessage("Ready to play");
        hideTimeout = window.setTimeout(() => {
          setVisible(false);
          setDone(false);
          setFraction(0);
          setMessage("");
          setTitle("");
        }, 2500);
        return;
      }

      // Skip cached sections
      if (payload.skipped) return;

      setVisible(true);
      setTitle(payload.title);
      setMessage(payload.message);
      // Latch this message so `download-progress` events can't clobber it.
      // If the fraction is >= 0.95, we're in the installer-subprocess phase
      // (BinaryPatcher, SpecialSource, etc.) — hold the latch indefinitely
      // until the next install-progress event refreshes it.
      if (payload.fraction >= 0.95) {
        installerActive = true;
        phaseLatchUntil = Infinity;
      } else {
        installerActive = false;
        phaseLatchUntil = Date.now() + PHASE_LATCH_MS;
      }

      // Only update fraction from install-progress if download-progress hasn't taken over
      // (install-progress sends coarse fractions like 0.97, 0.98 for post-download steps)
      if (payload.fraction > fraction()) {
        setFraction(payload.fraction);
      }

      // Safety: if no events for 30s, auto-hide
      if (activityTimeout) clearTimeout(activityTimeout);
      activityTimeout = window.setTimeout(() => {
        setVisible(false);
        setDone(false);
        setFraction(0);
      }, 30000);
    });

    // Listen to download-progress for real-time file progress (the main driver of 0→100%)
    const unlistenDownload = listen<{ completed: number; total: number; current_file: string }>("download-progress", (event) => {
      const { completed, total } = event.payload;
      if (total > 0 && visible() && !done()) {
        const fileFraction = completed / total;
        setFraction(fileFraction);
        // Only own the message text when no install-progress phase is
        // currently latched AND the installer subprocess isn't running.
        // This stops the "Downloading files (n/m)" string from blinking
        // over a more specific phase like "Patching client (BinaryPatcher)".
        if (!installerActive && Date.now() >= phaseLatchUntil) {
          setMessage(`Downloading files (${completed}/${total})`);
        }
      }
    });

    onCleanup(() => {
      unlistenInstall.then(fn => fn());
      unlistenDownload.then(fn => fn());
      if (hideTimeout) clearTimeout(hideTimeout);
      if (activityTimeout) clearTimeout(activityTimeout);
    });
  });

  return (
    <Show when={visible()}>
      <div class="install-progress-popup">
        <div class="install-progress-header">
          <IconDownload />
          <span class="install-progress-title">{title()}</span>
          <button class="install-progress-close" onClick={() => { setVisible(false); setDone(false); setFraction(0); }}>✕</button>
        </div>
        <div class="install-progress-body">
          <div class="install-progress-section">
            <div class="install-progress-section-header">
              <span class="install-progress-stage">
                {done() ? "Ready to play" : message()}
              </span>
              <span class="install-progress-percent">
                {done() ? "Complete" : `${Math.round(fraction() * 100)}%`}
              </span>
            </div>
            <div class="install-progress-bar-track">
              <div
                class="install-progress-bar-fill"
                classList={{ done: done() }}
                style={{ width: `${Math.min(fraction() * 100, 100)}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default InstallProgress;
