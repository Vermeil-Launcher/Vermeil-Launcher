use reqwest::Client;

/// Single source of truth for the launcher's User-Agent. Drives every
/// outbound request through `HTTP` and the `${launcher_version}` token in
/// the Minecraft launch arguments. Bound to `CARGO_PKG_VERSION` so a
/// version bump in `Cargo.toml` propagates everywhere automatically — no
/// manual edits to comments or string literals per release.
pub const LAUNCHER_NAME: &str = "Vermeil";
pub const LAUNCHER_VERSION: &str = env!("CARGO_PKG_VERSION");

lazy_static::lazy_static! {
    /// Shared HTTP client used across all services.
    /// Single instance with connection pooling and a consistent User-Agent.
    pub static ref HTTP: Client = Client::builder()
        .user_agent(format!("{}/{}", LAUNCHER_NAME, LAUNCHER_VERSION))
        .pool_max_idle_per_host(5)
        .build()
        .expect("Failed to create HTTP client");
}
