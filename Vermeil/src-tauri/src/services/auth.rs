//! Microsoft/Xbox/Minecraft authentication using the Xbox SISU protocol.
//! Independent implementation of the public Microsoft Xbox Live + Minecraft
//! Services authentication flow:
//! - P-256 ECDSA device key for signed requests
//! - Xbox SISU authenticate/authorize flow
//! - Desktop redirect URI (no localhost server needed)
//! - Tauri webview window for sign-in (handled in commands/auth.rs)

use base64::{Engine as _, engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD as BASE64_URL_SAFE_NO_PAD}};
use chrono::{DateTime, Utc};
use p256::ecdsa::{SigningKey, VerifyingKey, Signature, signature::Signer};
use p256::pkcs8::{EncodePrivateKey, DecodePrivateKey, LineEnding};
use p256::elliptic_curve::rand_core::OsRng;
use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::Digest;
use std::collections::HashMap;
use std::fs;
use uuid::Uuid;

use crate::util::paths;

// Xbox/Microsoft constants
const MICROSOFT_CLIENT_ID: &str = "00000000402b5328";
const AUTH_REPLY_URL: &str = "https://login.live.com/oauth20_desktop.srf";
const REQUESTED_SCOPE: &str = "service::user.auth.xboxlive.com::MBI_SSL";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MinecraftProfile {
    pub id: String,
    pub name: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
    #[serde(default)]
    pub is_offline: bool,
    pub skin_path: Option<String>,
    #[serde(default = "default_true")]
    pub active: bool,
}

fn default_true() -> bool { true }

/// Data needed to complete the login flow after the user signs in
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginFlow {
    pub auth_url: String,
    pub verifier: String,
    pub session_id: String,
}

/// Device key for signing Xbox requests
struct DeviceKey {
    id: Uuid,
    key: SigningKey,
    x: String,
    y: String,
}

/// Device token from Xbox
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct DeviceToken {
    pub token: String,
}

/// SISU authenticate response
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct SisuAuthResponse {
    pub msa_oauth_redirect: String,
}

/// SISU authorize response
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct SisuAuthorizeResponse {
    pub title_token: XboxToken,
    pub user_token: XboxToken,
}

/// Xbox token with display claims
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct XboxToken {
    pub token: String,
    pub display_claims: HashMap<String, serde_json::Value>,
}

/// OAuth token response
#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
}

/// Minecraft token response
#[derive(Debug, Deserialize)]
struct MinecraftTokenResponse {
    pub access_token: String,
}

/// Minecraft profile response
#[derive(Debug, Deserialize)]
struct McProfileResponse {
    pub id: String,
    pub name: String,
}

// === PUBLIC API ===

/// Begin the login flow. Returns the auth URL and flow data needed to complete login.
pub async fn begin_login() -> Result<LoginFlow, String> {
    // Generate or load device key
    let key = get_or_create_device_key()?;

    // Get device token
    let current_date = Utc::now();
    let device_token = get_device_token(&key, current_date).await?;

    // Generate PKCE verifier and challenge
    let verifier = generate_verifier();
    let challenge = {
        let hash = sha2::Sha256::digest(verifier.as_bytes());
        BASE64_URL_SAFE_NO_PAD.encode(hash)
    };

    // SISU authenticate — get the redirect URL
    let (session_id, redirect_url) = sisu_authenticate(
        &device_token,
        &challenge,
        &key,
        current_date,
    ).await?;

    Ok(LoginFlow {
        auth_url: redirect_url,
        verifier,
        session_id,
    })
}

/// Complete the login flow after receiving the auth code from the webview.
pub async fn finish_login(code: &str, flow: &LoginFlow) -> Result<MinecraftProfile, String> {
    let key = get_or_create_device_key()?;
    let current_date = Utc::now();
    let device_token_str = get_device_token(&key, current_date).await?;

    // Exchange code for OAuth token
    let oauth = exchange_code(code, &flow.verifier).await?;

    // SISU authorize
    let sisu = sisu_authorize(
        Some(&flow.session_id),
        &oauth.access_token,
        &device_token_str,
        &key,
        current_date,
    ).await?;

    // XSTS authorize
    let xsts = xsts_authorize(&sisu, &device_token_str, &key, current_date).await?;

    // Minecraft token
    let mc_token = minecraft_token(&xsts).await?;

    // Minecraft profile
    let profile = get_mc_profile(&mc_token.access_token).await?;

    let expires_at = Utc::now().timestamp() + oauth.expires_in as i64;

    Ok(MinecraftProfile {
        id: profile.id,
        name: profile.name,
        access_token: mc_token.access_token,
        refresh_token: Some(oauth.refresh_token),
        expires_at,
        is_offline: false,
        skin_path: None,
        active: true,
    })
}

/// Refresh an expired token using the refresh_token.
pub async fn refresh_token(refresh_token: &str) -> Result<MinecraftProfile, String> {
    let key = get_or_create_device_key()?;
    let current_date = Utc::now();
    let device_token_str = get_device_token(&key, current_date).await?;

    // Refresh OAuth token
    let oauth = oauth_refresh(refresh_token).await?;

    // SISU authorize (no session_id for refresh)
    let sisu = sisu_authorize(
        None,
        &oauth.access_token,
        &device_token_str,
        &key,
        current_date,
    ).await?;

    // XSTS authorize
    let xsts = xsts_authorize(&sisu, &device_token_str, &key, current_date).await?;

    // Minecraft token
    let mc_token = minecraft_token(&xsts).await?;

    // Minecraft profile
    let profile = get_mc_profile(&mc_token.access_token).await?;

    let expires_at = Utc::now().timestamp() + oauth.expires_in as i64;

    Ok(MinecraftProfile {
        id: profile.id,
        name: profile.name,
        access_token: mc_token.access_token,
        refresh_token: Some(oauth.refresh_token),
        expires_at,
        is_offline: false,
        skin_path: None,
        active: true,
    })
}

// === DEVICE KEY MANAGEMENT ===

fn get_or_create_device_key() -> Result<DeviceKey, String> {
    let key_path = paths::data_dir().join(".device_key.pem");

    if key_path.exists() {
        let pem = fs::read_to_string(&key_path).map_err(|e| format!("Read device key: {}", e))?;
        let signing_key = SigningKey::from_pkcs8_pem(&pem)
            .map_err(|e| format!("Parse device key: {}", e))?;
        let public_key = VerifyingKey::from(&signing_key);
        let encoded = public_key.to_encoded_point(false);

        // Load or generate UUID
        let id_path = paths::data_dir().join(".device_id");
        let id = if id_path.exists() {
            let s = fs::read_to_string(&id_path).unwrap_or_default();
            Uuid::parse_str(s.trim()).unwrap_or_else(|_| Uuid::new_v4())
        } else {
            let id = Uuid::new_v4();
            let _ = fs::write(&id_path, id.to_string());
            id
        };

        Ok(DeviceKey {
            id,
            key: signing_key,
            x: BASE64_URL_SAFE_NO_PAD.encode(encoded.x().ok_or("No x coord")?),
            y: BASE64_URL_SAFE_NO_PAD.encode(encoded.y().ok_or("No y coord")?),
        })
    } else {
        let id = Uuid::new_v4();
        let signing_key = SigningKey::random(&mut OsRng);
        let public_key = VerifyingKey::from(&signing_key);
        let encoded = public_key.to_encoded_point(false);

        // Save key
        let _ = fs::create_dir_all(paths::data_dir());
        let pem = signing_key.to_pkcs8_pem(LineEnding::LF)
            .map_err(|e| format!("Serialize key: {}", e))?;
        fs::write(&key_path, pem.as_bytes()).map_err(|e| format!("Write key: {}", e))?;
        let _ = fs::write(paths::data_dir().join(".device_id"), id.to_string());

        Ok(DeviceKey {
            id,
            key: signing_key,
            x: BASE64_URL_SAFE_NO_PAD.encode(encoded.x().ok_or("No x coord")?),
            y: BASE64_URL_SAFE_NO_PAD.encode(encoded.y().ok_or("No y coord")?),
        })
    }
}

// === XBOX/SISU PROTOCOL ===

async fn get_device_token(key: &DeviceKey, current_date: DateTime<Utc>) -> Result<String, String> {
    let body = json!({
        "Properties": {
            "AuthMethod": "ProofOfPossession",
            "Id": format!("{{{}}}", key.id.to_string().to_uppercase()),
            "DeviceType": "Win32",
            "Version": "10.16.0",
            "ProofKey": {
                "kty": "EC",
                "x": key.x,
                "y": key.y,
                "crv": "P-256",
                "alg": "ES256",
                "use": "sig"
            }
        },
        "RelyingParty": "http://auth.xboxlive.com",
        "TokenType": "JWT"
    });

    let resp = send_signed_request(
        "https://device.auth.xboxlive.com/device/authenticate",
        "/device/authenticate",
        &body,
        key,
        current_date,
    ).await?;

    let token: DeviceToken = serde_json::from_str(&resp.body)
        .map_err(|e| format!("Parse device token: {} — body: {}", e, resp.body))?;

    Ok(token.token)
}

async fn sisu_authenticate(
    device_token: &str,
    challenge: &str,
    key: &DeviceKey,
    current_date: DateTime<Utc>,
) -> Result<(String, String), String> {
    let body = json!({
        "AppId": MICROSOFT_CLIENT_ID,
        "DeviceToken": device_token,
        "Offers": [REQUESTED_SCOPE],
        "Query": {
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": generate_verifier(),
            "prompt": "select_account"
        },
        "RedirectUri": AUTH_REPLY_URL,
        "Sandbox": "RETAIL",
        "TokenType": "code",
        "TitleId": "1794566092",
    });

    let resp = send_signed_request(
        "https://sisu.xboxlive.com/authenticate",
        "/authenticate",
        &body,
        key,
        current_date,
    ).await?;

    // Extract session ID from headers
    let session_id = resp.headers.get("X-SessionId")
        .and_then(|v| v.to_str().ok())
        .ok_or("No X-SessionId header in SISU response")?
        .to_string();

    let redirect: SisuAuthResponse = serde_json::from_str(&resp.body)
        .map_err(|e| format!("Parse SISU auth: {} — body: {}", e, resp.body))?;

    Ok((session_id, redirect.msa_oauth_redirect))
}

async fn exchange_code(code: &str, verifier: &str) -> Result<OAuthTokenResponse, String> {
    let params = [
        ("client_id", MICROSOFT_CLIENT_ID),
        ("code", code),
        ("code_verifier", verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", AUTH_REPLY_URL),
        ("scope", REQUESTED_SCOPE),
    ];

    let resp = crate::util::http::HTTP
        .post("https://login.live.com/oauth20_token.srf")
        .header("Accept", "application/json")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("OAuth token exchange failed: {}", e))?;

    let text = resp.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str(&text)
        .map_err(|e| format!("Parse OAuth token: {} — body: {}", e, text))
}

async fn oauth_refresh(refresh_token: &str) -> Result<OAuthTokenResponse, String> {
    let params = [
        ("client_id", MICROSOFT_CLIENT_ID),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
        ("redirect_uri", AUTH_REPLY_URL),
        ("scope", REQUESTED_SCOPE),
    ];

    let resp = crate::util::http::HTTP
        .post("https://login.live.com/oauth20_token.srf")
        .header("Accept", "application/json")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("OAuth refresh failed: {}", e))?;

    let text = resp.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str(&text)
        .map_err(|e| format!("Parse OAuth refresh: {} — body: {}", e, text))
}

async fn sisu_authorize(
    session_id: Option<&str>,
    access_token: &str,
    device_token: &str,
    key: &DeviceKey,
    current_date: DateTime<Utc>,
) -> Result<SisuAuthorizeResponse, String> {
    let body = json!({
        "AccessToken": format!("t={}", access_token),
        "AppId": MICROSOFT_CLIENT_ID,
        "DeviceToken": device_token,
        "ProofKey": {
            "kty": "EC",
            "x": key.x,
            "y": key.y,
            "crv": "P-256",
            "alg": "ES256",
            "use": "sig"
        },
        "Sandbox": "RETAIL",
        "SessionId": session_id,
        "SiteName": "user.auth.xboxlive.com",
        "RelyingParty": "http://xboxlive.com",
        "UseModernGamertag": true
    });

    let resp = send_signed_request(
        "https://sisu.xboxlive.com/authorize",
        "/authorize",
        &body,
        key,
        current_date,
    ).await?;

    serde_json::from_str(&resp.body)
        .map_err(|e| format!("Parse SISU authorize: {} — body: {}", e, resp.body))
}

async fn xsts_authorize(
    sisu: &SisuAuthorizeResponse,
    device_token: &str,
    key: &DeviceKey,
    current_date: DateTime<Utc>,
) -> Result<XboxToken, String> {
    let body = json!({
        "RelyingParty": "rp://api.minecraftservices.com/",
        "TokenType": "JWT",
        "Properties": {
            "SandboxId": "RETAIL",
            "UserTokens": [sisu.user_token.token],
            "DeviceToken": device_token,
            "TitleToken": sisu.title_token.token,
        },
    });

    let resp = send_signed_request(
        "https://xsts.auth.xboxlive.com/xsts/authorize",
        "/xsts/authorize",
        &body,
        key,
        current_date,
    ).await?;

    serde_json::from_str(&resp.body)
        .map_err(|e| format!("Parse XSTS: {} — body: {}", e, resp.body))
}

async fn minecraft_token(xsts: &XboxToken) -> Result<MinecraftTokenResponse, String> {
    let uhs = xsts.display_claims.get("xui")
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("uhs"))
        .and_then(|v| v.as_str())
        .ok_or("No UHS in XSTS token")?;

    let resp = crate::util::http::HTTP
        .post("https://api.minecraftservices.com/launcher/login")
        .header("Accept", "application/json")
        .json(&json!({
            "platform": "PC_LAUNCHER",
            "xtoken": format!("XBL3.0 x={};{}", uhs, xsts.token),
        }))
        .send()
        .await
        .map_err(|e| format!("MC token request failed: {}", e))?;

    let text = resp.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str(&text)
        .map_err(|e| format!("Parse MC token: {} — body: {}", e, text))
}

async fn get_mc_profile(mc_token: &str) -> Result<McProfileResponse, String> {
    let resp = crate::util::http::HTTP
        .get("https://api.minecraftservices.com/minecraft/profile")
        .header("Authorization", format!("Bearer {}", mc_token))
        .send()
        .await
        .map_err(|e| format!("MC profile fetch failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("MC profile error ({}): {}", status, text));
    }

    let text = resp.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str(&text)
        .map_err(|e| format!("Parse MC profile: {} — body: {}", e, text))
}

// === SIGNED REQUEST INFRASTRUCTURE ===

struct SignedResponse {
    headers: HeaderMap,
    body: String,
}

async fn send_signed_request(
    url: &str,
    url_path: &str,
    raw_body: &serde_json::Value,
    key: &DeviceKey,
    current_date: DateTime<Utc>,
) -> Result<SignedResponse, String> {
    let body = serde_json::to_vec(raw_body)
        .map_err(|e| format!("Serialize request body: {}", e))?;

    // Windows FILETIME epoch offset (seconds between 1601-01-01 and 1970-01-01)
    let time: u64 = ((current_date.timestamp() as u128 + 11644473600) * 10000000) as u64;

    // Build signature payload
    let mut buffer = Vec::new();
    buffer.extend_from_slice(&1_u32.to_be_bytes());
    buffer.push(0u8);
    buffer.extend_from_slice(&time.to_be_bytes());
    buffer.push(0u8);
    buffer.extend_from_slice(b"POST");
    buffer.push(0u8);
    buffer.extend_from_slice(url_path.as_bytes());
    buffer.push(0u8);
    // No authorization header
    buffer.push(0u8);
    buffer.extend_from_slice(&body);
    buffer.push(0u8);

    // Sign with ECDSA P-256
    let signature: Signature = key.key.sign(&buffer);

    // Build signature header value
    let mut sig_buffer = Vec::new();
    sig_buffer.extend_from_slice(&1_i32.to_be_bytes());
    sig_buffer.extend_from_slice(&time.to_be_bytes());
    sig_buffer.extend_from_slice(&signature.r().to_bytes());
    sig_buffer.extend_from_slice(&signature.s().to_bytes());

    let sig_header = BASE64_STANDARD.encode(&sig_buffer);

    // Send request
    let mut request = crate::util::http::HTTP
        .post(url)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Accept", "application/json")
        .header("Signature", &sig_header);

    // x-xbl-contract-version header for all except sisu/authorize
    if url != "https://sisu.xboxlive.com/authorize" {
        request = request.header("x-xbl-contract-version", "1");
    }

    let resp = request.body(body).send().await
        .map_err(|e| format!("Signed request to {} failed: {}", url, e))?;

    let status = resp.status();
    let headers = resp.headers().clone();
    let text = resp.text().await.map_err(|e| e.to_string())?;

    // Surface the real failure. Xbox rejects signed requests (bad signature,
    // clock skew, throttling) with a non-2xx status and an error body that
    // carries NO X-SessionId header — so without this check the caller fails
    // downstream with a misleading "No X-SessionId header" message that hides
    // the actual cause. A common trigger is a system clock that's off by more
    // than Xbox's allowed skew, which invalidates the FILETIME-stamped
    // signature.
    if !status.is_success() {
        return Err(format!(
            "Xbox auth request to {} was rejected (HTTP {}). This often means the \
             system clock is wrong — check Windows date/time is set to sync \
             automatically. Server response: {}",
            url,
            status.as_u16(),
            if text.is_empty() { "(empty)" } else { text.trim() }
        ));
    }

    Ok(SignedResponse { headers, body: text })
}

// === UTILITIES ===

fn generate_verifier() -> String {
    use rand::Rng;
    let mut rng = rand::rng();
    let bytes: Vec<u8> = (0..64).map(|_| rng.random::<u8>()).collect();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
