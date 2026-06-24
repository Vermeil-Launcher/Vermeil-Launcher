mod commands;
mod error;
mod models;
mod services;
mod util;

pub use error::AppError;

use commands::{app_updater, auth, cf_import, files, instances, java, launch, meta, mods, settings, skins};
use services::app_updater::PendingUpdate;
use tauri::Manager;

/// Show the main window — called by frontend after initialization completes.
#[tauri::command]
fn show_window(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Logical-pixel floor for the launcher's main window. The same numbers live
/// in `tauri.conf.json`, but the conf-level minimum can't be relied on by
/// itself: on Linux compositors that don't enforce `xdg_toplevel.set_min_size`
/// for client-side-decorated windows (we are CSD by `decorations: false`), the
/// user can drag a window edge below the hint. Centralizing the constants
/// here lets the setup-time migration and the runtime resize-event clamp
/// share a single source of truth.
const MIN_WIDTH: f64 = 1100.0;
const MIN_HEIGHT: f64 = 720.0;

/// Whether a saved window position lands on a currently-connected monitor.
///
/// We probe a point in the window's titlebar grab area (just inside the
/// top-left corner) rather than the exact origin, so a window restored with a
/// slightly-negative origin is still considered reachable. Returns `false`
/// when the point falls in dead space — e.g. the Windows (-32000, -32000)
/// minimized sentinel, or coordinates left over from a monitor that has since
/// been unplugged — so the caller can skip the restore and let Tauri place the
/// window at its configured default instead of dropping it off-screen.
fn position_visible(window: &tauri::WebviewWindow, x: i32, y: i32) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };
    let px = x + 40;
    let py = y + 20;
    monitors.iter().any(|m| {
        let pos = m.position();
        let size = m.size();
        px >= pos.x
            && px < pos.x + size.width as i32
            && py >= pos.y
            && py < pos.y + size.height as i32
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();

    // Discord RPC watcher: polls setting every 5s, connects/disconnects instantly
    services::discord::spawn_watcher();

    tauri::Builder::default()
        .manage(PendingUpdate::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the existing window when a second instance is launched
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .setup(|app| {
            // Window shadow for native frameless look
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_shadow(true);

                // Square the window corners on Windows 11. DWM otherwise rounds
                // every top-level window's corners by default; for our blocky
                // sharp-edge UI that round halo at the very edges of the frame
                // looks out of place. Asks the compositor to render the corners
                // as `DWMWCP_DONOTROUND`. No-op on Win10 / Linux. Logged but
                // never fatal — a missing rounded-corner override is cosmetic.
                #[cfg(windows)]
                {
                    use windows_sys::Win32::Graphics::Dwm::{
                        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
                    };
                    if let Ok(hwnd) = window.hwnd() {
                        let pref: u32 = DWMWCP_DONOTROUND as u32;
                        unsafe {
                            let _ = DwmSetWindowAttribute(
                                hwnd.0 as _,
                                DWMWA_WINDOW_CORNER_PREFERENCE as u32,
                                &pref as *const _ as *const _,
                                std::mem::size_of::<u32>() as u32,
                            );
                        }
                    }
                }

                // Pin the minimum window size in logical pixels. Two reasons
                // we do this in setup() instead of relying solely on
                // `tauri.conf.json`:
                //
                //   1. Tauri 2 has a known issue (#7075) where the conf
                //      `minWidth`/`minHeight` can be flaky depending on
                //      window-state plugin restore ordering. Re-applying
                //      from setup is the canonical workaround.
                //   2. We want a hard floor at the launcher's intended
                //      design size, regardless of what the user's previous
                //      session left in `window-state.json`.
                //
                // Logical pixels are DPI-independent so this works the same
                // on a 4k monitor at 200% scale as it does at 100%. The
                // constants live at module scope (MIN_WIDTH / MIN_HEIGHT) so
                // the runtime resize-event clamp below uses the same floor.

                // Restore the window's last position / size / maximized flag
                // from our in-tree persister (replaces tauri-plugin-window-state
                // — see services/window_state.rs for the migration story).
                // Apply BEFORE `set_min_size` so a restored size below the new
                // floor gets clamped up by the migration block below.
                if let Some(saved) = services::window_state::load() {
                    if let (Some(x), Some(y)) = (saved.x, saved.y) {
                        // Only restore the position if it lands on a currently
                        // connected monitor. A minimized/hidden window reports
                        // the Windows (-32000, -32000) sentinel, and a monitor
                        // unplugged since last session leaves coordinates in
                        // dead space — restoring either drops the window
                        // off-screen (visible in the taskbar but unreachable).
                        // When the saved spot isn't visible we skip it and let
                        // Tauri's configured placement win.
                        if position_visible(&window, x, y) {
                            let _ = window.set_position(tauri::Position::Physical(
                                tauri::PhysicalPosition { x, y },
                            ));
                        }
                    }
                    if saved.width > 0 && saved.height > 0 {
                        let _ = window.set_size(tauri::Size::Physical(
                            tauri::PhysicalSize {
                                width: saved.width,
                                height: saved.height,
                            },
                        ));
                    }
                    if saved.maximized {
                        let _ = window.maximize();
                    }
                }

                let _ = window.set_min_size(Some(tauri::Size::Logical(
                    tauri::LogicalSize {
                        width: MIN_WIDTH,
                        height: MIN_HEIGHT,
                    },
                )));

                // One-time migration: if the persisted window state restored
                // an inner size below the new floor (e.g. user's previous
                // version allowed 1000x660), bump the window up to the
                // minimum. `set_min_size` alone doesn't shrink-block an
                // already-undersized window on every platform; explicit
                // `set_size` makes the constraint take effect immediately.
                if let Ok(scale) = window.scale_factor() {
                    if let Ok(inner) = window.inner_size() {
                        let logical = inner.to_logical::<f64>(scale);
                        if logical.width < MIN_WIDTH || logical.height < MIN_HEIGHT {
                            let _ = window.set_size(tauri::Size::Logical(
                                tauri::LogicalSize {
                                    width: logical.width.max(MIN_WIDTH),
                                    height: logical.height.max(MIN_HEIGHT),
                                },
                            ));
                        }
                    }
                }

                // Persist window position / size / maximized on every move,
                // resize, or close, and clamp the minimum size on every
                // resize. The clamp is the belt-and-braces fix for Linux
                // compositors that don't enforce `xdg_toplevel.set_min_size`
                // on CSD windows: when the WM lets the user drag below the
                // floor, we observe the undersize via WindowEvent::Resized
                // and snap the inner size back up. On compliant platforms
                // (Windows, X11, most Wayland) the clamp branch is a no-op
                // because the WM already prevents the undersize.
                //
                // Filesystem write is ~200 bytes via atomic_write — cheap
                // enough to skip a debounce. While maximized we keep the
                // previous unmaximized geometry so unmaximize restores the
                // right size, and we ignore zero-sized resize events (those
                // fire when the window is hidden / minimized and would
                // clobber the saved size).
                let win_for_events = window.clone();
                window.on_window_event(move |event| {
                    use tauri::WindowEvent;
                    if !matches!(
                        event,
                        WindowEvent::Moved(_)
                            | WindowEvent::Resized(_)
                            | WindowEvent::CloseRequested { .. }
                    ) {
                        return;
                    }
                    // Don't persist geometry while the window is minimized or
                    // hidden. Minimized windows report the (-32000, -32000)
                    // position sentinel on Windows and hidden windows can fire
                    // zero-ish events — saving either would clobber the last
                    // good geometry and relaunch the window off-screen. This is
                    // the save-side guard that pairs with the on-screen check
                    // done on restore.
                    if win_for_events.is_minimized().unwrap_or(false)
                        || !win_for_events.is_visible().unwrap_or(true)
                    {
                        return;
                    }

                    // Active min-size clamp on resize. Compare in logical
                    // pixels (DPI-agnostic) and only re-set when the inner
                    // size has actually fallen below the floor — avoids a
                    // feedback loop on compositors that already enforce the
                    // hint, since `set_size` itself fires another Resized.
                    if matches!(event, WindowEvent::Resized(_)) {
                        if let (Ok(scale), Ok(inner)) =
                            (win_for_events.scale_factor(), win_for_events.inner_size())
                        {
                            if inner.width > 0 && inner.height > 0 {
                                let logical = inner.to_logical::<f64>(scale);
                                if logical.width < MIN_WIDTH || logical.height < MIN_HEIGHT {
                                    let _ = win_for_events.set_size(tauri::Size::Logical(
                                        tauri::LogicalSize {
                                            width: logical.width.max(MIN_WIDTH),
                                            height: logical.height.max(MIN_HEIGHT),
                                        },
                                    ));
                                    // Skip persisting this frame — the size we
                                    // just observed is below floor and the
                                    // follow-up Resized from set_size will be
                                    // the one we want to save.
                                    return;
                                }
                            }
                        }
                    }

                    let mut state = services::window_state::load().unwrap_or_default();
                    let maximized = win_for_events.is_maximized().unwrap_or(false);
                    state.maximized = maximized;
                    if !maximized {
                        if let Ok(p) = win_for_events.outer_position() {
                            state.x = Some(p.x);
                            state.y = Some(p.y);
                        }
                        if let Ok(s) = win_for_events.inner_size() {
                            if s.width > 0 && s.height > 0 {
                                // Defense in depth: never persist a size below
                                // the floor. If a transient undersize slipped
                                // past the active clamp above (e.g. event
                                // ordering on a non-compliant compositor), we
                                // still refuse to write it to disk, so reopens
                                // can never start the user inside the bug.
                                let (mut w, mut h) = (s.width, s.height);
                                if let Ok(scale) = win_for_events.scale_factor() {
                                    let min_w = (MIN_WIDTH * scale).round() as u32;
                                    let min_h = (MIN_HEIGHT * scale).round() as u32;
                                    if w < min_w {
                                        w = min_w;
                                    }
                                    if h < min_h {
                                        h = min_h;
                                    }
                                }
                                state.width = w;
                                state.height = h;
                            }
                        }
                    }
                    let _ = services::window_state::save(&state);
                });
            }

            // Create system tray
            use tauri::menu::{MenuBuilder, MenuItemBuilder};

            let show = MenuItemBuilder::with_id("show", "Show Vermeil").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

            let _tray = tauri::tray::TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Vermeil")
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // App
            show_window,
            // Auth
            auth::start_ms_login,
            auth::get_active_account,
            auth::get_all_accounts,
            auth::set_active_account,
            auth::add_offline_account,
            auth::set_account_skin,
            auth::remove_account,
            auth::logout,
            // Instances
            instances::list_instances,
            instances::create_instance,
            instances::get_instance,
            instances::delete_instance,
            instances::update_instance_memory,
            instances::update_instance_options,
            instances::rename_instance,
            instances::set_instance_icon,
            instances::clear_instance_icon,
            instances::clone_instance,
            instances::install_modpack,
            instances::install_cf_modpack,
            instances::prepare_instance,
            instances::set_ingame_cape,
            instances::set_ingame_cape_enabled,
            instances::clear_ingame_cape,
            instances::get_ingame_cape,
            instances::companion_supported_versions,
            // CurseForge import
            cf_import::import_cf_zip,
            cf_import::import_cf_code,
            // Launch
            launch::launch_instance,
            launch::install_mod_to_instance,
            launch::install_cf_mod_to_instance,
            launch::remove_mod_from_instance,
            launch::sync_instance_mods,
            launch::remove_all_content,
            launch::check_mod_updates,
            launch::apply_mod_update,
            launch::toggle_mod_in_instance,
            launch::get_instance_logs,
            launch::get_crash_report,
            launch::stop_instance,
            launch::minimize_to_tray,
            launch::current_log_target,
            launch::read_instance_log,
            launch::close_logs_window,
            launch::get_resolved_jvm_args,
            launch::get_preset_jvm_args,
            launch::get_known_preset_args,
            launch::get_effective_memory,
            // Meta
            meta::get_game_versions,
            meta::get_fabric_loader_versions,
            meta::get_fabric_game_versions,
            meta::get_quilt_loader_versions,
            meta::get_neoforge_versions,
            meta::get_neoforge_game_versions,
            meta::get_forge_versions,
            meta::get_forge_game_versions,
            meta::get_quilt_game_versions,
            meta::get_java_news,
            meta::get_article_body,
            // Mods
            mods::search_mods,
            mods::search_modpacks,
            mods::search_curseforge,
            // Settings
            settings::get_settings,
            settings::save_settings,
            settings::get_app_directory,
            settings::get_cache_size,
            settings::purge_cache,
            settings::get_system_memory,
            settings::load_download_history,
            settings::save_download_history,
            // Java location finder
            java::detect_java_installations,
            java::validate_java_path,
            java::set_java_path,
            java::install_recommended_java,
            java::delete_java_install,
            java::prune_invalid_java_paths,
            // Skins & capes
            skins::get_skin_profile,
            skins::upload_skin,
            skins::equip_local_skin,
            skins::reset_skin,
            skins::equip_cape,
            skins::unequip_cape,
            skins::list_local_skins,
            skins::add_local_skin,
            skins::remove_local_skin,
            skins::get_account_skin,
            skins::list_custom_capes,
            skins::save_custom_cape,
            skins::remove_custom_cape,
            skins::read_custom_cape_source,
            // Files
            files::list_instance_files,
            files::list_instance_worlds,
            files::open_instance_folder,
            // Auto-updater
            app_updater::start_update_download,
            app_updater::apply_pending_update,
            app_updater::clear_pending_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {});
}
 
