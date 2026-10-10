//! On-demand download of the read-aloud voice pack.
//!
//! The pack is one zip pinned by size and SHA-256, so a download can never pair the
//! worker with an untested voice. It is unpacked into app data and the archive deleted.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{Emitter, Manager};

const PACK_VERSION: &str = "v1";
const PACK_FILE: &str = "voice-pack-v1.bin";
const PACK_SHA256: &str = "efa5e0add3c6e59a8e68ebc2db4b0355e5213faa8e1b6a742df558cd120b5619";
const PACK_SIZE: u64 = 189_613_275;
/// Where release builds fetch the pack; VIETNOTE_VOICE_PACK_URL overrides it for testing.
const PACK_URL: Option<&str> = Some("https://assets.vietnote-app.workers.dev/voice-pack-v1.bin");
/// Written last, so a half-unpacked folder is never taken for a pack.
const COMPLETE_MARKER: &str = ".complete";

static DOWNLOADING: AtomicBool = AtomicBool::new(false);
static CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicePackStatus {
    /// Folder the worker loads the voice from, once installed.
    path: Option<String>,
    /// This build knows where to download the pack from.
    available: bool,
    downloading: bool,
    partial_bytes: u64,
    size_bytes: u64,
    /// Only a downloaded copy can be removed; a developer copy is left alone.
    removable: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress { downloaded: u64, total: u64, unpacking: bool }

fn pack_url() -> Option<String> {
    std::env::var("VIETNOTE_VOICE_PACK_URL").ok().filter(|url| !url.is_empty()).or_else(|| PACK_URL.map(str::to_string))
}

fn voice_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("voice"))
}

fn partial_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(voice_dir(app)?.join(format!("{PACK_FILE}.partial")))
}

fn downloaded_pack(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = voice_dir(app).ok()?.join(PACK_VERSION);
    dir.join(COMPLETE_MARKER).is_file().then_some(dir)
}

/// The downloaded pack, else a developer copy in .cache.
pub fn installed(app: &tauri::AppHandle, root: &Path) -> Option<PathBuf> {
    downloaded_pack(app).or_else(|| {
        let dev = root.join(".cache/zerotts-int8");
        dev.join("config.json").is_file().then_some(dev)
    })
}

pub fn status(app: &tauri::AppHandle, root: &Path) -> Result<VoicePackStatus, String> {
    let path = installed(app, root);
    Ok(VoicePackStatus {
        available: path.is_some() || pack_url().is_some(),
        path: path.map(|path| path.to_string_lossy().into_owned()),
        downloading: DOWNLOADING.load(Ordering::SeqCst),
        partial_bytes: fs::metadata(partial_path(app)?).map(|m| m.len()).unwrap_or(0),
        size_bytes: PACK_SIZE,
        removable: downloaded_pack(app).is_some(),
    })
}

pub fn cancel() { CANCELLED.store(true, Ordering::SeqCst); }

pub fn remove(app: &tauri::AppHandle) -> Result<(), String> {
    if DOWNLOADING.load(Ordering::SeqCst) { return Err("Đang tải giọng đọc, hãy hủy trước khi xóa".into()); }
    let dir = voice_dir(app)?;
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Không xóa được giọng đọc: {error}")),
    }
}

pub async fn download(app: &tauri::AppHandle) -> Result<(), String> {
    if DOWNLOADING.swap(true, Ordering::SeqCst) { return Err("Giọng đọc đang được tải".into()); }
    CANCELLED.store(false, Ordering::SeqCst);
    let result = download_pinned(app).await;
    DOWNLOADING.store(false, Ordering::SeqCst);
    result
}

async fn download_pinned(app: &tauri::AppHandle) -> Result<(), String> {
    let url = pack_url().ok_or("Bản cài này chưa hỗ trợ tải giọng đọc")?;
    let dir = voice_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let partial = partial_path(app)?;
    // Resume: the bytes already on disk are part of the checksum.
    let mut hasher = Sha256::new();
    let mut downloaded = match fs::File::open(&partial) {
        Ok(mut file) => std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?,
        Err(_) => 0,
    };
    if downloaded >= PACK_SIZE { hasher = Sha256::new(); downloaded = 0; }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .build().map_err(|e| e.to_string())?;
    let mut request = client.get(&url);
    if downloaded > 0 { request = request.header(reqwest::header::RANGE, format!("bytes={downloaded}-")); }
    let mut response = request.send().await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|_| "Không kết nối được máy chủ tải giọng đọc".to_string())?;
    let mut file = if downloaded > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        fs::OpenOptions::new().append(true).open(&partial).map_err(|e| e.to_string())?
    } else {
        // The server ignored the range request: start over.
        hasher = Sha256::new(); downloaded = 0;
        fs::File::create(&partial).map_err(|e| e.to_string())?
    };
    let progress = |downloaded, unpacking| { let _ = app.emit("voice-pack-download", DownloadProgress { downloaded, total: PACK_SIZE, unpacking }); };
    progress(downloaded, false);
    let mut reported = downloaded;
    while let Some(chunk) = response.chunk().await.map_err(|_| "Mất kết nối khi tải giọng đọc".to_string())? {
        if CANCELLED.load(Ordering::SeqCst) { return Err("Đã hủy tải giọng đọc".into()); }
        downloaded += chunk.len() as u64;
        if downloaded > PACK_SIZE {
            drop(file); let _ = fs::remove_file(&partial);
            return Err("Gói giọng đọc lớn hơn dự kiến; đã hủy để tránh sai phiên bản".into());
        }
        file.write_all(&chunk).map_err(|e| format!("Không ghi được giọng đọc: {e}"))?;
        hasher.update(&chunk);
        if downloaded - reported >= 1 << 20 { progress(downloaded, false); reported = downloaded; }
    }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    progress(downloaded, false);
    if downloaded != PACK_SIZE { return Err("Tải chưa xong; bấm tải lại để tiếp tục".into()); }
    if format!("{:x}", hasher.finalize()) != PACK_SHA256 {
        let _ = fs::remove_file(&partial);
        return Err("Gói giọng đọc tải về bị lỗi; đã xóa, vui lòng tải lại".into());
    }
    progress(downloaded, true);
    let unpacked = tauri::async_runtime::spawn_blocking({
        let (partial, dir) = (partial.clone(), dir.clone());
        move || unpack(&partial, &dir)
    }).await.map_err(|e| e.to_string())?;
    unpacked?;
    let _ = fs::remove_file(&partial);
    Ok(())
}

/// Unpacks into a temporary folder, then swaps it in whole.
fn unpack(archive: &Path, dir: &Path) -> Result<(), String> {
    let staging = dir.join(format!("{PACK_VERSION}.unpacking"));
    let target = dir.join(PACK_VERSION);
    let _ = fs::remove_dir_all(&staging);
    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "Gói giọng đọc bị lỗi; vui lòng tải lại".to_string())?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|e| e.to_string())?;
        // enclosed_name rejects absolute paths and `..`, so nothing lands outside the folder.
        let Some(relative) = entry.enclosed_name() else { continue };
        let path = staging.join(relative);
        if entry.is_dir() { fs::create_dir_all(&path).map_err(|e| e.to_string())?; continue; }
        if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        let mut out = fs::File::create(&path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("Không giải nén được giọng đọc: {e}"))?;
    }
    if !staging.join("config.json").is_file() { return Err("Gói giọng đọc thiếu tệp; vui lòng tải lại".into()); }
    fs::write(staging.join(COMPLETE_MARKER), PACK_SHA256).map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&target);
    fs::rename(&staging, &target).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpacks_whole_and_keeps_entries_inside_the_folder() {
        let dir = std::env::temp_dir().join(format!("voice-pack-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("pack.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("config.json", options).unwrap();
        zip.write_all(b"{}").unwrap();
        zip.start_file("voices/a/meta.json", options).unwrap();
        zip.write_all(b"{}").unwrap();
        zip.start_file("../escaped.txt", options).unwrap();
        zip.write_all(b"x").unwrap();
        zip.finish().unwrap();

        unpack(&archive, &dir).unwrap();
        let target = dir.join(PACK_VERSION);
        assert!(target.join(COMPLETE_MARKER).is_file());
        assert!(target.join("voices/a/meta.json").is_file());
        assert!(!dir.join("escaped.txt").exists());
        assert!(!dir.join(format!("{PACK_VERSION}.unpacking")).exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
