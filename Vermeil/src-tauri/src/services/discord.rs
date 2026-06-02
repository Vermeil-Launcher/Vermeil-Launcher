use discord_presence::Client;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const DISCORD_APP_ID: u64 = 1507103792737419395;

lazy_static::lazy_static! {
    static ref DISCORD: Mutex<Option<Client>> = Mutex::new(None);
    static ref CONNECTED: Mutex<bool> = Mutex::new(false);
    static ref VISIBLE: Mutex<bool> = Mutex::new(false);
}

/// Spawn a background thread that manages Discord RPC based on the setting.
pub fn spawn_watcher() {
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(3));

        let mut backoff_secs: u64 = 5;

        loop {
            std::thread::sleep(std::time::Duration::from_secs(5));

            let enabled = read_setting();
            let connected = *CONNECTED.lock().unwrap();
            let visible = *VISIBLE.lock().unwrap();

            if !connected {
                if enabled {
                    do_connect();
                    if !*CONNECTED.lock().unwrap() {
                        std::thread::sleep(std::time::Duration::from_secs(backoff_secs));
                        backoff_secs = (backoff_secs * 2).min(60);
                    } else {
                        backoff_secs = 5;
                    }
                }
                continue;
            }

            if enabled && !visible {
                show_idle();
                *VISIBLE.lock().unwrap() = true;
            } else if !enabled && visible {
                hide();
                *VISIBLE.lock().unwrap() = false;
            }
        }
    });
}

fn read_setting() -> bool {
    let config_path = crate::util::paths::data_dir().join("config.json");

    if !config_path.exists() { return false; }

    std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
        .and_then(|v| v.get("discord_rpc")?.as_bool())
        .unwrap_or(false)
}

fn do_connect() {
    if *CONNECTED.lock().unwrap() { return; }

    let mut client = Client::new(DISCORD_APP_ID);

    client.on_ready(|_ctx| {
        *CONNECTED.lock().unwrap() = true;
    }).persist();

    client.on_error(|_ctx| {}).persist();

    client.start();

    for _ in 0..8 {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if *CONNECTED.lock().unwrap() { break; }
    }

    if !*CONNECTED.lock().unwrap() { return; }

    *DISCORD.lock().unwrap() = Some(client);

    if read_setting() {
        show_idle();
        *VISIBLE.lock().unwrap() = true;
    }

    tracing::debug!("Discord RPC connected");
}

fn show_idle() {
    let mut guard = DISCORD.lock().unwrap();
    if let Some(ref mut client) = *guard {
        let _ = client.set_activity(|act| {
            act.state("In the launcher")
                .details("Launcher")
                .assets(|a| a.large_image("icon").large_text("Minecraft Launcher"))
        });
    }
}

fn hide() {
    let mut guard = DISCORD.lock().unwrap();
    if let Some(ref mut client) = *guard {
        let _ = client.clear_activity();
    }
}

/// Set presence to "Playing" with instance details and elapsed timer.
pub fn set_playing(instance_name: &str, game_version: &str, loader: &str, mod_count: usize) {
    if !*CONNECTED.lock().unwrap() { return; }
    if !*VISIBLE.lock().unwrap() { return; }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut guard = DISCORD.lock().unwrap();
    if let Some(ref mut client) = *guard {
        let details = instance_name.to_string();
        let state = if loader == "vanilla" {
            format!("Minecraft {}", game_version)
        } else {
            format!("{} {} · {} mods", loader, game_version, mod_count)
        };

        let _ = client.set_activity(|act| {
            act.state(&state)
                .details(&details)
                .assets(|a| {
                    a.large_image("icon")
                        .large_text("Minecraft Launcher")
                        .small_image("play")
                        .small_text("Playing")
                })
                .timestamps(|ts| ts.start(timestamp))
        });
    }
}

/// Reset presence back to idle (call when game exits).
pub fn set_stopped() {
    if !*CONNECTED.lock().unwrap() { return; }
    if !*VISIBLE.lock().unwrap() { return; }
    show_idle();
}
