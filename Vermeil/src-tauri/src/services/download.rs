//! Concurrent batch downloader with two-semaphore concurrency model
//! (separate fetch and write bounds).
//!
//! The fetch semaphore bounds simultaneous network requests; the write semaphore
//! bounds simultaneous disk writes. They are separate so a slow disk doesn't
//! starve fetches and a slow network doesn't starve writes.
//!
//! Both limits come from `LauncherSettings.concurrent_downloads` and
//! `concurrent_writes` (defaults 10/10), read once per `download_all` call.

use crate::services::settings_service;
use futures_util::StreamExt;
use reqwest::Client;
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::Semaphore;

/// Hard ceilings — match the UI (Settings.tsx) so a tampered config.json or
/// older settings file doesn't drive the semaphores past safe limits.
const MAX_FETCH: usize = 10;
const MAX_WRITE: usize = 50;
const MAX_RETRIES: u8 = 3;
const RETRY_DELAY_MS: u64 = 500;

#[derive(Debug, Clone)]
pub struct DownloadTask {
    pub url: String,
    pub dest: PathBuf,
    pub expected_sha1: Option<String>,
    pub expected_size: Option<u64>,
}

/// Progress payload emitted via Tauri events during batch downloads.
#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgressPayload {
    pub completed: u32,
    pub total: u32,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub current_file: String,
}

/// Check if a file exists and matches expected hash/size.
///
/// Validation strategy:
/// - If size is known: file must exist and size must match. Hash is NOT
///   re-verified for already-present files because rehashing 1000+ cached
///   asset objects on every install adds seconds of latency before any download
///   can start. SHA-1 is still verified for *fresh* downloads in `persist_bytes`.
/// - If size is unknown but hash is: full hash check (fallback for files where
///   size isn't published, e.g. some loader libraries).
/// - If neither is known: existence is sufficient.
pub fn file_valid(path: &Path, expected_sha1: &Option<String>, expected_size: &Option<u64>) -> bool {
    if !path.exists() {
        return false;
    }

    if let Some(size) = expected_size {
        // Size is the cheap, authoritative check for cached files.
        return std::fs::metadata(path).map(|m| m.len() == *size).unwrap_or(false);
    }

    if let Some(hash) = expected_sha1 {
        if let Ok(data) = std::fs::read(path) {
            let mut hasher = Sha1::new();
            hasher.update(&data);
            let result = format!("{:x}", hasher.finalize());
            return result == *hash;
        }
        return false;
    }

    true
}

/// Fetch the bytes of a URL with retry. The fetch semaphore is held only for
/// the duration of the network read.
async fn fetch_bytes(
    client: &Client,
    url: &str,
    fetch_sem: &Arc<Semaphore>,
) -> Result<Vec<u8>, String> {
    let _permit = fetch_sem.acquire().await.map_err(|e| e.to_string())?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("GET {} failed: {}", url, e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {} for {}", resp.status(), url));
    }

    // Stream bytes into a Vec — keeps memory bounded to one file at a time per worker.
    let mut bytes = Vec::with_capacity(
        resp.content_length().unwrap_or(0) as usize,
    );
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Read chunk: {}", e))?;
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Persist bytes to disk atomically (.part → final). The write semaphore is
/// held for the entire write+rename to prevent partial files being seen.
async fn persist_bytes(
    bytes: &[u8],
    dest: &Path,
    expected_sha1: &Option<String>,
    write_sem: &Arc<Semaphore>,
) -> Result<(), String> {
    let _permit = write_sem.acquire().await.map_err(|e| e.to_string())?;

    if let Some(hash) = expected_sha1 {
        let mut hasher = Sha1::new();
        hasher.update(bytes);
        let result = format!("{:x}", hasher.finalize());
        if &result != hash {
            return Err(format!(
                "Hash mismatch for {}: expected {}, got {}",
                dest.display(),
                hash,
                result
            ));
        }
    }

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }

    let part_path = dest.with_extension(format!(
        "{}.part",
        dest.extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default()
    ));

    tokio::fs::write(&part_path, bytes)
        .await
        .map_err(|e| format!("Write {}: {}", part_path.display(), e))?;

    tokio::fs::rename(&part_path, dest)
        .await
        .map_err(|e| format!("Rename {}: {}", dest.display(), e))?;

    Ok(())
}

/// Download a single file with retries. Skips if the file already exists and
/// validates against the expected size/hash.
///
/// This function is callable directly for one-off downloads; for batches use
/// `download_all` so the semaphores are shared across tasks.
pub async fn download_file(client: &Client, task: &DownloadTask) -> Result<(), String> {
    if file_valid(&task.dest, &task.expected_sha1, &task.expected_size) {
        return Ok(());
    }

    // For one-off calls, create tiny per-call semaphores (limit 1 each).
    // The settings-derived semaphores are only shared inside `download_all`.
    let fetch_sem = Arc::new(Semaphore::new(1));
    let write_sem = Arc::new(Semaphore::new(1));

    download_one(client, task, &fetch_sem, &write_sem).await
}

async fn download_one(
    client: &Client,
    task: &DownloadTask,
    fetch_sem: &Arc<Semaphore>,
    write_sem: &Arc<Semaphore>,
) -> Result<(), String> {
    if file_valid(&task.dest, &task.expected_sha1, &task.expected_size) {
        return Ok(());
    }

    let mut last_err = String::new();
    for attempt in 0..=MAX_RETRIES {
        match fetch_bytes(client, &task.url, fetch_sem).await {
            Ok(bytes) => {
                match persist_bytes(&bytes, &task.dest, &task.expected_sha1, write_sem).await {
                    Ok(()) => return Ok(()),
                    Err(e) => last_err = e,
                }
            }
            Err(e) => last_err = e,
        }

        if attempt < MAX_RETRIES {
            tokio::time::sleep(Duration::from_millis(RETRY_DELAY_MS)).await;
        }
    }

    Err(format!("Download failed after {} retries: {}", MAX_RETRIES, last_err))
}

/// Resolve concurrency limits from settings, clamped to per-field hard caps.
async fn resolve_concurrency() -> (usize, usize) {
    match settings_service::load().await {
        Ok(s) => {
            let dl = (s.concurrent_downloads as usize).clamp(1, MAX_FETCH);
            let wr = (s.concurrent_writes as usize).clamp(1, MAX_WRITE);
            (dl, wr)
        }
        Err(e) => {
            tracing::warn!("Could not load settings for concurrency: {}; using defaults", e);
            (10, 10)
        }
    }
}

/// Download multiple files concurrently, emitting `download-progress` events.
///
/// Concurrency is bounded by two semaphores derived from settings:
/// - fetch (`concurrent_downloads`) bounds in-flight network requests
/// - write (`concurrent_writes`) bounds in-flight disk writes
///
/// Progress events are throttled to roughly one per ~50ms to avoid event spam.
pub async fn download_all(
    tasks: Vec<DownloadTask>,
    app: Option<tauri::AppHandle>,
) -> Result<(), String> {
    let total = tasks.len() as u32;
    if total == 0 {
        return Ok(());
    }

    let (fetch_limit, write_limit) = resolve_concurrency().await;
    tracing::info!(
        "Batch download: {} files, fetch={}, write={}",
        total,
        fetch_limit,
        write_limit
    );

    let fetch_sem = Arc::new(Semaphore::new(fetch_limit));
    let write_sem = Arc::new(Semaphore::new(write_limit));
    let completed = Arc::new(AtomicU32::new(0));
    let bytes_done = Arc::new(AtomicU64::new(0));
    let bytes_total: u64 = tasks.iter().filter_map(|t| t.expected_size).sum();
    let last_emit = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(1)));
    let app = Arc::new(app);

    let client = crate::util::http::HTTP.clone();

    let stream_limit = fetch_limit.max(write_limit);

    let errors = Arc::new(Mutex::new(Vec::<String>::new()));

    futures_util::stream::iter(tasks.into_iter())
        .for_each_concurrent(stream_limit, |task| {
            let client = client.clone();
            let fetch_sem = fetch_sem.clone();
            let write_sem = write_sem.clone();
            let completed = completed.clone();
            let bytes_done = bytes_done.clone();
            let last_emit = last_emit.clone();
            let app = app.clone();
            let errors = errors.clone();
            let task_size = task.expected_size.unwrap_or(0);
            let dest_name = task
                .dest
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_default();

            async move {
                let result = download_one(&client, &task, &fetch_sem, &write_sem).await;

                let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
                bytes_done.fetch_add(task_size, Ordering::Relaxed);

                if let Err(e) = result {
                    tracing::error!("Failed to download {}: {}", task.url, e);
                    if let Ok(mut errs) = errors.lock() {
                        errs.push(e);
                    }
                }

                // Throttle progress emissions to ~20Hz to avoid IPC spam.
                let should_emit = {
                    let now = Instant::now();
                    let force = done == total;
                    if let Ok(mut last) = last_emit.lock() {
                        if force || now.duration_since(*last) >= Duration::from_millis(50) {
                            *last = now;
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                };

                if should_emit {
                    if let Some(ref handle) = *app {
                        let _ = handle.emit(
                            "download-progress",
                            DownloadProgressPayload {
                                completed: done,
                                total,
                                bytes_done: bytes_done.load(Ordering::Relaxed),
                                bytes_total,
                                current_file: dest_name,
                            },
                        );
                    }
                }
            }
        })
        .await;

    let errs = errors.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
    if errs.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{} of {} downloads failed. First error: {}",
            errs.len(),
            total,
            errs[0]
        ))
    }
}
