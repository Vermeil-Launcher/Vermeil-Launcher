//! Auto-updater service.
//!
//! Uses a split download/install pattern for one critical reason: **on
//! Windows, an NSIS installer cannot replace
//! `vermeil.exe` while the launcher is still running it**. Tauri's stock
//! `Update::download_and_install` spawns the installer and returns *before*
//! the file-replace step finishes — if we then call `relaunch()` we re-spawn
//! the old binary and the install silently fails.
//!
//! Flow:
//! 1. Frontend calls `start_update_download` after the user opts in.
//! 2. We download the payload into memory (emitting `update-progress` events
//!    so the UI can render a real progress bar), then stash `(Update, Vec<u8>)`
//!    in `PendingUpdate`.
//! 3. Frontend calls `apply_pending_update`, which sets a flag and closes the
//!    main window.
//! 4. In `RunEvent::Exit` (registered in `lib.rs`), if the flag is set, we
//!    call `update.install(&data)` synchronously. The webview is gone by
//!    then so file locks are released. After install succeeds we call
//!    `app.restart()` to launch the just-replaced binary.
//!
//! No JS-side `relaunch()` is involved. That's the entire bug fix.

use serde::Serialize;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Emitter, Manager, ResourceId, Runtime, Webview};
use tauri_plugin_updater::Update;

/// Resource managed by Tauri so we can hold the downloaded bytes between the
/// `start_update_download` and `apply_pending_update` calls.
#[derive(Default)]
pub struct PendingUpdate {
    pub data: Mutex<Option<(Arc<Update>, Vec<u8>)>>,
    /// Set to `true` when the user has clicked "Restart and install". Read at
    /// `RunEvent::Exit` to decide whether to run the install + relaunch or
    /// quietly drop the buffered bytes.
    pub apply_on_exit: AtomicBool,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateProgressPayload {
    /// `"downloading"` | `"installing"` | `"done"` | `"error"`
    pub phase: &'static str,
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// 0.0 → 1.0; for `"installing"` we go indeterminate (caller should
    /// render a spinner) since NSIS gives no progress callbacks.
    pub fraction: f64,
    pub message: String,
}

/// Download the update payload into memory, emitting `update-progress` events.
/// The bytes are stashed in `PendingUpdate` for `apply_pending_update` to
/// consume.
pub async fn start_update_download<R: Runtime>(
    webview: Webview<R>,
    rid: ResourceId,
) -> Result<(), String> {
    let pending = webview.state::<PendingUpdate>();
    let update: Arc<Update> = webview
        .resources_table()
        .get::<Update>(rid)
        .map_err(|e| format!("Update resource not found: {}", e))?;

    let app = webview.app_handle().clone();

    let bytes_total: Arc<Mutex<u64>> = Arc::new(Mutex::new(0));
    let bytes_done: Arc<Mutex<u64>> = Arc::new(Mutex::new(0));

    let bytes_total_cb = bytes_total.clone();
    let bytes_done_cb = bytes_done.clone();
    let app_cb = app.clone();

    let data = update
        .download(
            move |chunk_size, total| {
                if let Some(t) = total {
                    if let Ok(mut bt) = bytes_total_cb.lock() {
                        *bt = t;
                    }
                }
                let total_now = bytes_total_cb.lock().map(|g| *g).unwrap_or(0);
                let done_now = if let Ok(mut bd) = bytes_done_cb.lock() {
                    *bd += chunk_size as u64;
                    *bd
                } else {
                    0
                };
                let frac = if total_now > 0 {
                    (done_now as f64 / total_now as f64).min(1.0)
                } else {
                    0.0
                };
                // Best-effort emit; if the webview is gone, silently skip.
                let _ = app_cb.emit(
                    "update-progress",
                    UpdateProgressPayload {
                        phase: "downloading",
                        bytes_done: done_now,
                        bytes_total: total_now,
                        fraction: frac,
                        message: format!(
                            "Downloading update ({:.1} / {:.1} MB)",
                            done_now as f64 / 1_048_576.0,
                            total_now as f64 / 1_048_576.0
                        ),
                    },
                );
            },
            || {
                // download finished callback — handled inline below
            },
        )
        .await
        .map_err(|e| format!("Update download failed: {}", e))?;

    let total_now = bytes_total.lock().map(|g| *g).unwrap_or(data.len() as u64);
    let _ = app.emit(
        "update-progress",
        UpdateProgressPayload {
            phase: "downloading",
            bytes_done: data.len() as u64,
            bytes_total: total_now,
            fraction: 1.0,
            message: "Download complete".to_string(),
        },
    );

    if let Ok(mut slot) = pending.data.lock() {
        slot.replace((update, data));
    }

    Ok(())
}

/// Mark the buffered update for installation at exit and close the window.
/// The actual install runs synchronously in `RunEvent::Exit` so the webview's
/// file locks are released first.
pub async fn apply_pending_update<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let pending = app.state::<PendingUpdate>();
    {
        let slot = pending.data.lock().map_err(|e| e.to_string())?;
        if slot.is_none() {
            return Err("No pending update to install".to_string());
        }
    }
    pending.apply_on_exit.store(true, Ordering::Relaxed);

    // Surface the install phase to the UI as an indeterminate state. NSIS
    // gives no progress callbacks during the actual file-replace step, so
    // the frontend should render a spinner for the brief moment between
    // window-close and process-exit.
    let _ = app.emit(
        "update-progress",
        UpdateProgressPayload {
            phase: "installing",
            bytes_done: 0,
            bytes_total: 0,
            fraction: 0.0,
            message: "Installing update...".to_string(),
        },
    );

    // Close the main window. Tauri will fire `RunEvent::Exit` once the last
    // window is gone (which is where the install actually runs).
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.close();
    }

    Ok(())
}

/// Drop any buffered update without installing it. Called by the frontend
/// when the user dismisses the "update available" prompt.
pub fn clear_pending_update<R: Runtime>(app: &AppHandle<R>) {
    let pending = app.state::<PendingUpdate>();
    if let Ok(mut slot) = pending.data.lock() {
        slot.take();
    }
    pending.apply_on_exit.store(false, Ordering::Relaxed);
}

/// Called from `RunEvent::Exit`. Runs the buffered install and relaunches if
/// the user opted in. Returns silently otherwise.
pub fn install_on_exit<R: Runtime>(app: &AppHandle<R>) {
    let pending = app.state::<PendingUpdate>();
    if !pending.apply_on_exit.load(Ordering::Relaxed) {
        return;
    }

    let buffered = match pending.data.lock() {
        Ok(slot) => slot.clone(),
        Err(_) => return,
    };

    let Some((update, data)) = buffered else {
        return;
    };

    tracing::info!(
        "Installing pending update v{} (was on v{})",
        update.version,
        update.current_version
    );

    match update.install(&data) {
        Ok(()) => {
            tracing::info!("Update installed successfully; restarting");
            app.restart();
        }
        Err(e) => {
            tracing::error!("Update install failed: {}", e);
            // Best-effort error event; window may already be gone.
            let _ = app.emit(
                "update-progress",
                UpdateProgressPayload {
                    phase: "error",
                    bytes_done: 0,
                    bytes_total: 0,
                    fraction: 0.0,
                    message: format!("Install failed: {}", e),
                },
            );
        }
    }
}
