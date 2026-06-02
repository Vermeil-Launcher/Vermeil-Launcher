//! Credential encryption/decryption.
//!
//! On Windows: uses DPAPI (tied to the current user session).
//! On Linux/macOS: stores tokens with restrictive file permissions (chmod 600).
//! The `enc:<base64>` prefix format is used on Windows; on other platforms
//! tokens are stored as plaintext (protected by OS file permissions).
//!
//! Plaintext values (no prefix) are transparently encrypted on first read
//! when running on Windows (migration).

#[cfg(windows)]
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
#[cfg(windows)]
use windows_dpapi::{encrypt_data, decrypt_data, Scope};

const ENC_PREFIX: &str = "enc:";

/// Encrypt a plaintext credential string for storage.
/// On Windows: uses DPAPI, returns `enc:<base64>`.
/// On Linux/macOS: returns plaintext (file permissions provide protection).
pub fn encrypt_credential(plaintext: &str) -> Result<String, String> {
    if plaintext.is_empty() || plaintext == "offline" || plaintext == "0" {
        return Ok(plaintext.to_string());
    }

    #[cfg(windows)]
    {
        let encrypted = encrypt_data(plaintext.as_bytes(), Scope::User, None)
            .map_err(|e| format!("DPAPI encrypt failed: {}", e))?;
        Ok(format!("{}{}", ENC_PREFIX, BASE64.encode(&encrypted)))
    }

    #[cfg(not(windows))]
    {
        // On non-Windows, rely on file permissions (chmod 600 on accounts.json)
        Ok(plaintext.to_string())
    }
}

/// Decrypt a credential string.
/// On Windows: if it has the `enc:` prefix, decrypt via DPAPI.
/// On all platforms: plaintext values (no prefix) are returned as-is.
pub fn decrypt_credential(stored: &str) -> Result<String, String> {
    if stored.is_empty() || stored == "offline" || stored == "0" {
        return Ok(stored.to_string());
    }

    #[cfg(windows)]
    {
        if let Some(b64) = stored.strip_prefix(ENC_PREFIX) {
            let encrypted = BASE64.decode(b64)
                .map_err(|e| format!("Base64 decode failed: {}", e))?;
            let decrypted = decrypt_data(&encrypted, Scope::User, None)
                .map_err(|e| format!("DPAPI decrypt failed: {}", e))?;
            return String::from_utf8(decrypted)
                .map_err(|e| format!("UTF-8 decode failed: {}", e));
        }
    }

    // Plaintext — either not yet migrated (Windows) or normal storage (Linux/macOS)
    Ok(stored.to_string())
}

/// Returns true if the value is already encrypted (has the `enc:` prefix).
pub fn is_encrypted(stored: &str) -> bool {
    stored.starts_with(ENC_PREFIX)
}
