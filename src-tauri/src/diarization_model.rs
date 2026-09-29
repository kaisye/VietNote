//! On-demand download of the Nemotron 3 diarization weights.
//!
//! The native runtime ships inside the app; only the GGUF weights are fetched
//! later. They are pinned to the exact Hugging Face revision and SHA-256 that
//! scripts/setup-diarization.sh builds against, so a download can never pair
//! the bundled runtime with an untested model file.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{Emitter, Manager};

// Keep in sync with TASK_MODEL_REV / TASK_MODEL_SHA in scripts/setup-diarization.sh.
pub const MODEL_FILE: &str = "Nemotron-3-Diarization.q8_0.gguf";
const MODEL_REV: &str = "f667ed73aee57d40cc39428eb768b4fd87a0a29e";
const MODEL_SHA256: &str = "08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1";
const MODEL_SIZE: u64 = 107_012_128;
const RUNTIME_LIBRARY: &str = "libnemo_speech_asr_c.dylib";

static DOWNLOADING: AtomicBool = AtomicBool::new(false);
static CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarizationModelStatus {
    installed: bool,
    runtime_available: bool,
    downloading: bool,
    /// Bytes of an interrupted download that the next attempt resumes from.
    partial_bytes: u64,
    size_bytes: u64,
    /// Only a downloaded copy can be removed; a developer .cache copy is left alone.
    removable: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress { downloaded: u64, total: u64 }

fn model_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("models"))
}

fn partial_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(model_dir(app)?.join(format!("{MODEL_FILE}.partial")))
}

fn downloaded_model(app: &tauri::AppHandle) -> Option<PathBuf> {
    let path = model_dir(app).ok()?.join(MODEL_FILE);
    (fs::metadata(&path).ok()?.len() == MODEL_SIZE).then_some(path)
}

/// The downloaded weights, else a developer copy from scripts/setup-diarization.sh.
pub fn installed_model(app: &tauri::AppHandle, root: &Path) -> Option<PathBuf> {
    downloaded_model(app).or_else(|| {
        let dev = root.join(".cache/models").join(MODEL_FILE);
        (fs::metadata(&dev).ok()?.len() == MODEL_SIZE).then_some(dev)
    })
}

/// Release bundles carry a relocated runtime in nemotron-dist; dev runs use the local build.
pub fn runtime_library(root: &Path) -> Option<PathBuf> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) { return None; }
    [root.join("nemotron-dist/lib"), root.join(".cache/nemotron/lib")]
        .into_iter().map(|dir| dir.join(RUNTIME_LIBRARY)).find(|path| path.is_file())
}

pub fn status(app: &tauri::AppHandle, root: &Path) -> Result<DiarizationModelStatus, String> {
    Ok(DiarizationModelStatus {
        installed: installed_model(app, root).is_some(),
        runtime_available: runtime_library(root).is_some(),
        downloading: DOWNLOADING.load(Ordering::SeqCst),
        partial_bytes: fs::metadata(partial_path(app)?).map(|m| m.len()).unwrap_or(0),
        size_bytes: MODEL_SIZE,
        removable: downloaded_model(app).is_some(),
    })
}

pub fn cancel() { CANCELLED.store(true, Ordering::SeqCst); }

pub fn remove(app: &tauri::AppHandle) -> Result<(), String> {
    if DOWNLOADING.load(Ordering::SeqCst) { return Err("Đang tải model, hãy hủy trước khi xóa".into()); }
    for path in [model_dir(app)?.join(MODEL_FILE), partial_path(app)?] {
        match fs::remove_file(&path) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(format!("Không xóa được model: {error}")),
        }
    }
    Ok(())
}

pub async fn download(app: &tauri::AppHandle) -> Result<(), String> {
    if DOWNLOADING.swap(true, Ordering::SeqCst) { return Err("Model đang được tải".into()); }
    CANCELLED.store(false, Ordering::SeqCst);
    let result = download_pinned(app).await;
    DOWNLOADING.store(false, Ordering::SeqCst);
    result
}

async fn download_pinned(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = model_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(MODEL_FILE);
    let partial = partial_path(app)?;
    // Resume: the bytes already on disk are part of the checksum.
    let mut hasher = Sha256::new();
    let mut downloaded = match fs::File::open(&partial) {
        Ok(mut file) => std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?,
        Err(_) => 0,
    };
    if downloaded >= MODEL_SIZE { hasher = Sha256::new(); downloaded = 0; }
    // A mirror (e.g. a company CDN) may serve the same pinned file; the checksum still applies.
    let url = std::env::var("VIETNOTE_DIARIZATION_MODEL_URL").unwrap_or_else(|_|
        format!("https://huggingface.co/nvidia/Nemotron-3-Diarization/resolve/{MODEL_REV}/{MODEL_FILE}"));
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .build().map_err(|e| e.to_string())?;
    let mut request = client.get(&url);
    if downloaded > 0 { request = request.header(reqwest::header::RANGE, format!("bytes={downloaded}-")); }
    let mut response = request.send().await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| format!("Không kết nối được máy chủ tải model: {e}"))?;
    let mut file = if downloaded > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        fs::OpenOptions::new().append(true).open(&partial).map_err(|e| e.to_string())?
    } else {
        // The server ignored the range request: start over.
        hasher = Sha256::new(); downloaded = 0;
        fs::File::create(&partial).map_err(|e| e.to_string())?
    };
    let progress = |downloaded| { let _ = app.emit("diarization-download", DownloadProgress { downloaded, total: MODEL_SIZE }); };
    progress(downloaded);
    let mut reported = downloaded;
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("Mất kết nối khi tải model: {e}"))? {
        if CANCELLED.load(Ordering::SeqCst) { return Err("Đã hủy tải model".into()); }
        downloaded += chunk.len() as u64;
        if downloaded > MODEL_SIZE {
            drop(file); let _ = fs::remove_file(&partial);
            return Err("File model lớn hơn dự kiến; đã hủy để tránh sai phiên bản".into());
        }
        file.write_all(&chunk).map_err(|e| format!("Không ghi được model: {e}"))?;
        hasher.update(&chunk);
        if downloaded - reported >= 1 << 20 { progress(downloaded); reported = downloaded; }
    }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    progress(downloaded);
    if downloaded != MODEL_SIZE { return Err("Tải chưa xong; bấm tải lại để tiếp tục".into()); }
    if format!("{:x}", hasher.finalize()) != MODEL_SHA256 {
        let _ = fs::remove_file(&partial);
        return Err("Model tải về không khớp checksum; đã xóa, vui lòng tải lại".into());
    }
    fs::rename(&partial, &target).map_err(|e| e.to_string())
}
