//! Skin and cape management for Microsoft accounts.
//!
//! ## Architecture
//!
//! The backend always returns
//! skin and cape textures as **base64 `data:image/png;` URLs** to the
//! frontend, never raw `https://textures.minecraft.net/...` URLs. This way
//! the webview never makes a request to Mojang's CDN and we sidestep every
//! CORS and scheme issue (Mojang inconsistently returns `http://` URLs even
//! though the host supports HTTPS, and CDN headers vary across regions).
//!
//! Flow per call:
//!
//! 1. Fetch the Mojang profile JSON (text → `MojangProfile` internal struct).
//! 2. For every skin/cape URL, download the PNG bytes via the shared reqwest
//!    client (which has no same-origin policy and tolerates http/https).
//! 3. Base64-encode the bytes into `data:image/png;base64,...` URLs.
//! 4. Hand the resulting `PlayerProfile` to the frontend. The frontend uses
//!    these strings as image sources directly — no further round-trips.
//!
//! ## Microsoft-only
//!
//! Mojang's profile API has no concept of offline-account UUIDs and any
//! request would 401. The frontend hides the screen for offline accounts,
//! but every service entry point also bails defensively via `require_microsoft`.
//!
//! ## Local skin library
//!
//! In addition to the remote operations, we keep a per-account local library
//! at `<data>/skins/<account_id>/<sha1>.png` plus a `skins.json` index. This
//! lets users switch between previously-uploaded skins without keeping the
//! original file around. The library bytes are also surfaced as base64 data
//! URLs to the frontend, same pattern as remote textures.

use crate::services::auth::MinecraftProfile;
use crate::util::http::HTTP;
use crate::util::paths;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

/// Timestamp (unix secs) of the last local skin upload. Auto-capture is
/// suppressed for a short window after an upload because Mojang re-encodes
/// uploaded PNGs, which changes the SHA-1 hash and would create a visual
/// duplicate in the library.
static LAST_UPLOAD_EPOCH: AtomicU64 = AtomicU64::new(0);

const PROFILE_URL: &str = "https://api.minecraftservices.com/minecraft/profile";
const SKIN_UPLOAD_URL: &str = "https://api.minecraftservices.com/minecraft/profile/skins";
const SKIN_RESET_URL: &str =
    "https://api.minecraftservices.com/minecraft/profile/skins/active";
const CAPES_ACTIVE_URL: &str =
    "https://api.minecraftservices.com/minecraft/profile/capes/active";

// ───────────────────────── Types ────────────────────────────────────────

/// Skin model variant. Mirrors Mojang's `CLASSIC` (4px arms) vs `SLIM` (3px).
///
/// Mojang's profile endpoint returns these as **uppercase strings** in JSON
/// (`"variant": "CLASSIC"`). The serde rename has to match — earlier
/// `lowercase` set up by us silently broke profile fetches with "error
/// decoding response body".
///
/// `Unknown` catches any future variant Mojang adds so the whole profile
/// parse doesn't fail just because we haven't kept up. Defensive fallback.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum SkinVariant {
    Classic,
    Slim,
    #[serde(other)]
    Unknown,
}

impl SkinVariant {
    /// The lowercase string Mojang's `POST /skins` form expects (`"classic"`
    /// or `"slim"`). Wire format on the way out is *opposite* of the way in —
    /// inbound JSON is uppercase, outbound multipart-form is lowercase.
    fn as_form_value(self) -> Result<&'static str, String> {
        match self {
            SkinVariant::Classic => Ok("classic"),
            SkinVariant::Slim => Ok("slim"),
            SkinVariant::Unknown => Err(
                "Cannot equip skin with unrecognized variant — pick Classic or Slim explicitly."
                    .to_string(),
            ),
        }
    }
}

// ─── Internal Mojang profile shape ─────────────────────────────────────
//
// What Mojang returns from `GET /minecraft/profile`. We never expose this
// to the frontend directly — `to_player_profile()` turns the URL fields
// into base64 data URLs first.

#[derive(Debug, Deserialize)]
struct MojangProfile {
    id: String,
    name: String,
    #[serde(default)]
    skins: Vec<MojangSkin>,
    #[serde(default)]
    capes: Vec<MojangCape>,
}

#[derive(Debug, Deserialize)]
struct MojangSkin {
    id: String,
    state: String,
    url: String,
    variant: SkinVariant,
}

#[derive(Debug, Deserialize)]
struct MojangCape {
    id: String,
    state: String,
    url: String,
    alias: String,
}

// ─── Frontend-facing types ──────────────────────────────────────────────

/// One skin entry on the Mojang profile, with the texture already inlined
/// as a base64 `data:image/png;` URL ready for the webview to render.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteSkin {
    pub id: String,
    pub state: String,
    /// `data:image/png;base64,...` — never a remote URL. The frontend can
    /// drop this directly into `<img src>` or skinview3d's `loadSkin`.
    pub texture: String,
    pub variant: SkinVariant,
}

/// One cape entry on the Mojang profile, texture inlined like `RemoteSkin`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteCape {
    pub id: String,
    pub state: String,
    pub texture: String,
    pub alias: String,
}

/// The whole player profile as the frontend sees it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerProfile {
    pub id: String,
    pub name: String,
    pub skins: Vec<RemoteSkin>,
    pub capes: Vec<RemoteCape>,
}

/// One entry in the local skin library — a previously-equipped skin we kept
/// on disk so the user can switch back to it without re-uploading.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalSkin {
    /// SHA-1 of the PNG bytes — also the filename.
    pub hash: String,
    /// User-friendly name (defaults to the imported file's stem).
    pub name: String,
    pub variant: SkinVariant,
    /// `data:image/png;base64,...` for inline rendering. Same pattern as
    /// remote textures so the frontend never has to special-case local files.
    pub texture: String,
    /// Unix epoch seconds when this skin was added.
    pub created_at: i64,
}

// Internal representation of the saved-skins index file. Stores filesystem
// paths, not data URLs (we read+encode on the way out).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LocalSkinEntry {
    hash: String,
    name: String,
    variant: SkinVariant,
    /// Absolute path to the PNG file on disk.
    path: String,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SkinLibraryFile {
    skins: Vec<LocalSkinEntry>,
}

// ───────────────────────── Mojang API ───────────────────────────────────

/// Fetch the active player profile for the given account. Every skin / cape
/// has its texture inlined as a base64 data URL — frontend never has to
/// touch `textures.minecraft.net`.
///
/// On Mojang errors the response body is included in the error string so
/// future API changes (variant casing, new fields, etc.) are easier to
/// diagnose.
pub async fn fetch_profile(account: &MinecraftProfile) -> Result<PlayerProfile, String> {
    require_microsoft(account)?;

    // Short-TTL cache that dedupes the mutation-then-refetch pattern: a
    // mutation re-fetches the profile to return it, then the frontend refetches
    // again moments later. Without this we'd hit Mojang twice within a second
    // and risk a 429.
    //
    // Crucially, every mutation calls `invalidate_profile_cache` first, so the
    // post-mutation fetch is always a fresh network read. The cache therefore
    // only ever serves a copy that's known to still be current — it never
    // returns a profile that predates a change the user just made.
    let cache = profile_cache();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    {
        let guard = cache.lock().await;
        if let Some((ts, cached)) = guard.get(&account.id) {
            if now.saturating_sub(*ts) < 3 {
                return Ok(cached.clone());
            }
        }
    }

    let result = fetch_profile_uncached(account).await?;

    // Auto-capture: if the active skin isn't already in the local library,
    // download and persist it. This builds a skin history over time even for
    // skins changed externally (minecraft.net, another launcher).
    if let Some(active) = result.skins.iter().find(|s| s.state == "ACTIVE") {
        let account_id = account.id.clone();
        let texture_data_url = active.texture.clone();
        let variant = active.variant;
        tokio::spawn(async move {
            if let Err(e) = auto_capture_skin(&account_id, &texture_data_url, variant) {
                tracing::debug!("Auto-capture skin skipped: {}", e);
            }
        });
    }

    cache.lock().await.insert(account.id.clone(), (now, result.clone()));

    Ok(result)
}

/// The actual network call to Mojang's profile endpoint. Retries once on 429
/// with a 3-second backoff before surfacing the error.
async fn fetch_profile_uncached(account: &MinecraftProfile) -> Result<PlayerProfile, String> {
    let result = fetch_profile_once(account).await;

    match &result {
        Err(e) if e.contains("rate-limiting") => {
            // Single retry after 3s backoff
            tracing::debug!("Profile fetch got 429, retrying in 3s");
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            fetch_profile_once(account).await
        }
        _ => result,
    }
}

/// Single attempt at fetching the profile from Mojang.
async fn fetch_profile_once(account: &MinecraftProfile) -> Result<PlayerProfile, String> {

    let resp = HTTP
        .get(PROFILE_URL)
        .bearer_auth(&account.access_token)
        .header("Accept", "application/json")
        // Profiles refresh frequently in response to user actions; keep the
        // round-trip snappy so a slow network doesn't hang the UI.
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Profile fetch failed: {}", e))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Profile body read failed: {}", e))?;

    if !status.is_success() {
        // Common cases:
        //   401 — token expired or revoked, user needs to sign in again
        //   429 — Mojang rate-limited us (e.g. user spammed cape changes)
        //   5xx — Mojang outage
        if status.as_u16() == 429 {
            return Err(
                "Mojang is rate-limiting your account. Wait a moment before changing skins or capes again."
                    .to_string(),
            );
        }
        return Err(format!(
            "Mojang profile returned HTTP {}: {}",
            status,
            body.chars().take(200).collect::<String>()
        ));
    }

    let mojang: MojangProfile = serde_json::from_str(&body).map_err(|e| {
        format!(
            "Profile JSON parse failed: {}. Raw body (first 200 chars): {}",
            e,
            body.chars().take(200).collect::<String>()
        )
    })?;

    inline_textures(mojang).await
}

/// Take the raw Mojang profile and turn each remote texture URL into a base64
/// data URL. Done concurrently so a profile with 10 capes doesn't block on
/// 10 sequential GETs.
async fn inline_textures(mojang: MojangProfile) -> Result<PlayerProfile, String> {
    let skin_futures = mojang.skins.into_iter().map(|s| async move {
        let texture = fetch_texture_as_data_url(&s.url).await?;
        Ok::<_, String>(RemoteSkin {
            id: s.id,
            state: s.state,
            texture,
            variant: s.variant,
        })
    });
    let cape_futures = mojang.capes.into_iter().map(|c| async move {
        let texture = fetch_texture_as_data_url(&c.url).await?;
        Ok::<_, String>(RemoteCape {
            id: c.id,
            state: c.state,
            texture,
            alias: c.alias,
        })
    });

    let skins = futures_util::future::try_join_all(skin_futures).await?;
    let capes = futures_util::future::try_join_all(cape_futures).await?;

    Ok(PlayerProfile {
        id: mojang.id,
        name: mojang.name,
        skins,
        capes,
    })
}

/// Download a Mojang texture and return it as a `data:image/png;base64,...`
/// URL. Accepts both `http://` and `https://textures.minecraft.net/...` —
/// upgrades to HTTPS before the request goes out. Anything else is rejected
/// so this can't be turned into a generic HTTP proxy.
///
/// Results are cached in-memory keyed by the upgraded URL — Mojang skin and
/// cape texture URLs are content-addressed (the path includes the SHA hash
/// of the bytes), so once we've seen a URL the bytes won't change. This is
/// critical for not getting rate-limited (HTTP 429) when the user spams
/// cape changes: every `fetch_profile` would otherwise re-download every
/// cape texture from scratch.
async fn fetch_texture_as_data_url(url: &str) -> Result<String, String> {
    let upgraded = if let Some(rest) = url.strip_prefix("http://textures.minecraft.net/") {
        format!("https://textures.minecraft.net/{}", rest)
    } else if url.starts_with("https://textures.minecraft.net/") {
        url.to_string()
    } else {
        return Err(format!("Refusing to fetch non-Mojang texture URL: {}", url));
    };

    // Cache hit?
    {
        let cache = texture_cache().lock().await;
        if let Some(cached) = cache.get(&upgraded) {
            return Ok(cached.clone());
        }
    }

    let resp = HTTP
        .get(&upgraded)
        .header("Accept", "image/png")
        .send()
        .await
        .map_err(|e| format!("Texture fetch failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Texture fetch HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Texture body read failed: {}", e))?;

    let data_url = bytes_to_data_url(&bytes);

    // Insert into cache. Bounded loosely — the cache holds skin + cape
    // textures the user has seen; for any one player this is on the order
    // of a dozen URLs. We don't bother evicting because Mojang URLs are
    // content-addressed (immutable per URL) and a launcher session is
    // bounded.
    {
        let mut cache = texture_cache().lock().await;
        cache.insert(upgraded, data_url.clone());
    }

    Ok(data_url)
}

/// Lazy-initialized in-memory texture cache. Process-lifetime, no on-disk
/// persistence (a relaunch refreshes everything cheaply enough).
fn texture_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Lazy-initialized in-memory cache of recently-fetched profiles, keyed by
/// account id and holding `(unix_secs, profile)`. See `fetch_profile` for the
/// short-TTL rationale.
fn profile_cache() -> &'static Mutex<HashMap<String, (u64, PlayerProfile)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (u64, PlayerProfile)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drop any cached profile for this account so the next `fetch_profile` does a
/// real network read. Called right after every profile-mutating Mojang call
/// (skin upload, reset, cape equip/unequip): the cached copy predates the
/// change and would otherwise make the UI show the old skin or cape as still
/// active until the TTL lapses.
async fn invalidate_profile_cache(account_id: &str) {
    profile_cache().lock().await.remove(account_id);
}

fn bytes_to_data_url(bytes: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Upload a skin PNG and equip it. The PNG is read from `png_bytes` so the
/// caller can decide whether it came from disk, the local library, or
/// somewhere else. Returns the refreshed profile so the UI updates without
/// a separate fetch.
pub async fn upload_and_equip_skin(
    account: &MinecraftProfile,
    png_bytes: Vec<u8>,
    variant: SkinVariant,
) -> Result<PlayerProfile, String> {
    require_microsoft(account)?;
    validate_skin_dimensions(&png_bytes)?;

    let part = reqwest::multipart::Part::bytes(png_bytes)
        .file_name("skin.png")
        .mime_str("image/png")
        .map_err(|e| format!("Bad mime: {}", e))?;
    let form = reqwest::multipart::Form::new()
        .text("variant", variant.as_form_value()?)
        .part("file", part);

    let resp = HTTP
        .post(SKIN_UPLOAD_URL)
        .bearer_auth(&account.access_token)
        .header("Accept", "application/json")
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Skin upload failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Mojang rejected skin upload (HTTP {}). Make sure the PNG is 64x64 or 64x32.",
            resp.status()
        ));
    }
    // Don't trust the response body shape — Mojang has shipped multiple
    // versions over the years. Fetch fresh after a successful PUT so we
    // always know the canonical profile.
    drop(resp);

    // Suppress auto-capture for the next few seconds. The skin was already
    // saved to the local library by the caller; the profile refetch below
    // would trigger auto_capture with Mojang's re-encoded PNG which has
    // different bytes (and thus a different hash), creating a visual duplicate.
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    LAST_UPLOAD_EPOCH.store(now, Ordering::Relaxed);

    invalidate_profile_cache(&account.id).await;
    fetch_profile(account).await
}

/// Reset the active skin back to the default Steve / Alex.
///
/// Mojang's DELETE endpoint returns 204 No Content (empty body) on success,
/// so we can't parse the response as JSON. Instead we issue a fresh
/// profile fetch after the mutation succeeds.
pub async fn reset_skin(account: &MinecraftProfile) -> Result<PlayerProfile, String> {
    require_microsoft(account)?;

    let resp = HTTP
        .delete(SKIN_RESET_URL)
        .bearer_auth(&account.access_token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Skin reset failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Mojang reset returned HTTP {}", resp.status()));
    }
    drop(resp);

    invalidate_profile_cache(&account.id).await;
    fetch_profile(account).await
}

/// Equip a cape by its Mojang-side cape ID. Like `reset_skin`, the response
/// shape is unreliable across Mojang API versions (sometimes returns the new
/// profile, sometimes just `{ "type": "Success" }`). Fetch fresh afterwards.
pub async fn equip_cape(
    account: &MinecraftProfile,
    cape_id: &str,
) -> Result<PlayerProfile, String> {
    require_microsoft(account)?;

    let body = serde_json::json!({ "capeId": cape_id });
    let resp = HTTP
        .put(CAPES_ACTIVE_URL)
        .bearer_auth(&account.access_token)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Cape equip failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Mojang cape equip returned HTTP {}", resp.status()));
    }
    drop(resp);

    invalidate_profile_cache(&account.id).await;
    fetch_profile(account).await
}

/// Unequip the active cape. Same response-shape concern as `equip_cape`.
pub async fn unequip_cape(account: &MinecraftProfile) -> Result<PlayerProfile, String> {
    require_microsoft(account)?;

    let resp = HTTP
        .delete(CAPES_ACTIVE_URL)
        .bearer_auth(&account.access_token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Cape unequip failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Mojang cape unequip returned HTTP {}", resp.status()));
    }
    drop(resp);

    invalidate_profile_cache(&account.id).await;
    fetch_profile(account).await
}

// ───────────────────────── Local skin library ───────────────────────────

/// Decode a base64 data URL back to raw PNG bytes. Returns None if the format
/// is wrong or the prefix doesn't match.
fn data_url_to_bytes(data_url: &str) -> Option<Vec<u8>> {
    let prefix = "data:image/png;base64,";
    let encoded = data_url.strip_prefix(prefix)?;
    base64::engine::general_purpose::STANDARD.decode(encoded).ok()
}

/// Auto-capture the active skin into the local library if it isn't already
/// saved. Called in the background after every profile fetch so the user's
/// skin history grows over time — including skins set externally.
fn auto_capture_skin(account_id: &str, texture_data_url: &str, variant: SkinVariant) -> Result<(), String> {
    // Skip if a skin was just uploaded — the upload path already saved to
    // the library and Mojang's re-encoded bytes would create a false duplicate.
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let last_upload = LAST_UPLOAD_EPOCH.load(Ordering::Relaxed);
    if now.saturating_sub(last_upload) < 10 {
        return Ok(());
    }

    let png_bytes = data_url_to_bytes(texture_data_url)
        .ok_or_else(|| "Not a valid base64 PNG data URL".to_string())?;

    // Compute hash to check if it's already in the library
    let mut hasher = Sha1::new();
    hasher.update(&png_bytes);
    let hash = hex_lower(&hasher.finalize());

    let lib = load_library(account_id);
    if lib.skins.iter().any(|s| s.hash == hash) {
        return Ok(()); // Already captured
    }

    // Not in library — add it
    let name = format!("Skin {}", &hash[..6]);
    add_local_skin(account_id, &name, &png_bytes, variant)?;
    tracing::debug!("Auto-captured active skin {} for account {}", &hash[..8], &account_id[..8]);
    Ok(())
}

fn skins_dir(account_id: &str) -> PathBuf {
    paths::data_dir().join("skins").join(account_id)
}

fn library_path(account_id: &str) -> PathBuf {
    skins_dir(account_id).join("skins.json")
}

fn load_library(account_id: &str) -> SkinLibraryFile {
    let p = library_path(account_id);
    if !p.exists() {
        return SkinLibraryFile::default();
    }
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_library(account_id: &str, lib: &SkinLibraryFile) -> Result<(), String> {
    let dir = skins_dir(account_id);
    fs::create_dir_all(&dir).map_err(|e| format!("Create skins dir: {}", e))?;
    let json = serde_json::to_string_pretty(lib).map_err(|e| e.to_string())?;
    fs::write(library_path(account_id), json).map_err(|e| format!("Write library: {}", e))
}

fn entry_to_local_skin(entry: &LocalSkinEntry) -> Option<LocalSkin> {
    let bytes = fs::read(&entry.path).ok()?;
    Some(LocalSkin {
        hash: entry.hash.clone(),
        name: entry.name.clone(),
        variant: entry.variant,
        texture: bytes_to_data_url(&bytes),
        created_at: entry.created_at,
    })
}

/// Read the skin library for one account. Cleans up entries whose PNG file
/// is gone (e.g. user manually deleted it) on the way out.
pub fn list_local_skins(account_id: &str) -> Vec<LocalSkin> {
    let mut lib = load_library(account_id);
    let before = lib.skins.len();
    lib.skins.retain(|s| std::path::Path::new(&s.path).exists());
    if lib.skins.len() != before {
        let _ = save_library(account_id, &lib);
    }
    lib.skins
        .iter()
        .filter_map(entry_to_local_skin)
        .collect()
}

/// Add a PNG to the local library. Returns the resulting [`LocalSkin`] so
/// the frontend can immediately render it. Hash-based dedupe means
/// uploading the same skin twice doesn't create duplicates.
pub fn add_local_skin(
    account_id: &str,
    name: &str,
    png_bytes: &[u8],
    variant: SkinVariant,
) -> Result<LocalSkin, String> {
    validate_skin_dimensions(png_bytes)?;

    let mut hasher = Sha1::new();
    hasher.update(png_bytes);
    let hash = hex_lower(&hasher.finalize());

    let dir = skins_dir(account_id);
    fs::create_dir_all(&dir).map_err(|e| format!("Create skins dir: {}", e))?;

    let png_path = dir.join(format!("{}.png", hash));
    if !png_path.exists() {
        fs::write(&png_path, png_bytes).map_err(|e| format!("Write skin: {}", e))?;
    }

    let entry = LocalSkinEntry {
        hash: hash.clone(),
        name: name.to_string(),
        variant,
        path: png_path.to_string_lossy().to_string(),
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
    };

    let mut lib = load_library(account_id);
    if let Some(existing) = lib.skins.iter_mut().find(|s| s.hash == hash) {
        // Same texture as before — refresh metadata in case the user
        // re-imported with different name/variant.
        existing.variant = variant;
        existing.name = name.to_string();
    } else {
        lib.skins.push(entry.clone());
    }
    save_library(account_id, &lib)?;

    Ok(LocalSkin {
        hash,
        name: name.to_string(),
        variant,
        texture: bytes_to_data_url(png_bytes),
        created_at: entry.created_at,
    })
}

/// Remove a skin from the local library. The PNG file is also deleted.
pub fn remove_local_skin(account_id: &str, hash: &str) -> Result<(), String> {
    let mut lib = load_library(account_id);
    if let Some(pos) = lib.skins.iter().position(|s| s.hash == hash) {
        let entry = lib.skins.remove(pos);
        save_library(account_id, &lib)?;
        if std::path::Path::new(&entry.path).exists() {
            let _ = fs::remove_file(&entry.path);
        }
    }
    Ok(())
}

/// Read a local skin's PNG bytes for re-upload to Mojang.
pub fn read_local_skin(account_id: &str, hash: &str) -> Result<(Vec<u8>, SkinVariant), String> {
    let lib = load_library(account_id);
    let entry = lib
        .skins
        .iter()
        .find(|s| s.hash == hash)
        .ok_or_else(|| format!("Local skin {} not found", hash))?;
    let bytes = fs::read(&entry.path).map_err(|e| format!("Read skin: {}", e))?;
    Ok((bytes, entry.variant))
}

// ───────────────────────── Helpers ──────────────────────────────────────

fn require_microsoft(account: &MinecraftProfile) -> Result<(), String> {
    if account.is_offline {
        return Err(
            "Skin and cape changes require a Microsoft account. Sign in with Microsoft to continue."
                .to_string(),
        );
    }
    if account.access_token.is_empty() || account.access_token == "offline" {
        return Err("This account has no Microsoft access token. Sign in again.".to_string());
    }
    Ok(())
}

/// Validate that the PNG decodes and matches a Minecraft skin layout.
/// Mojang accepts 64×64 (post-1.8) or 64×32 (pre-1.8 legacy). Anything else
/// gets rejected so we don't waste a round-trip.
fn validate_skin_dimensions(png_bytes: &[u8]) -> Result<(), String> {
    // Minimal PNG IHDR parse — width/height are at offsets 16 and 20 (BE u32).
    if png_bytes.len() < 24 || &png_bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("Not a valid PNG file".to_string());
    }
    let width = u32::from_be_bytes([
        png_bytes[16],
        png_bytes[17],
        png_bytes[18],
        png_bytes[19],
    ]);
    let height = u32::from_be_bytes([
        png_bytes[20],
        png_bytes[21],
        png_bytes[22],
        png_bytes[23],
    ]);
    if width != 64 || (height != 64 && height != 32) {
        return Err(format!(
            "Skin must be 64x64 or 64x32 — this image is {}x{}",
            width, height
        ));
    }
    Ok(())
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}
