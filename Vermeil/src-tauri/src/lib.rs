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
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
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
                // on a 4k monitor at 200% scale as it does at 100%.
                const MIN_WIDTH: f64 = 1100.0;
                const MIN_HEIGHT: f64 = 720.0;
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
            // CurseForge import
            cf_import::import_cf_zip,
            cf_import::import_cf_code,
            // Launch
            launch::launch_instance,
            launch::install_mod_to_instance,
            launch::install_cf_mod_to_instance,
            launch::remove_mod_from_instance,
            launch::remove_all_content,
            launch::check_mod_updates,
            launch::apply_mod_update,
            launch::toggle_mod_in_instance,
            launch::get_instance_logs,
            launch::get_crash_report,
            launch::stop_instance,
            launch::minimize_to_tray,
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
        .run(|app_handle, event| {
            // The auto-updater installs the buffered payload at exit so the
            // webview's file locks on vermeil.exe are released first. Without
            // this, NSIS silently fails to overwrite the running binary on
            // Windows and the user perceives "update applied but UI is the
            // same old version". See `services/app_updater.rs` for details.
            if let tauri::RunEvent::Exit = event {
                services::app_updater::install_on_exit(app_handle);
            }
        });
}
 
