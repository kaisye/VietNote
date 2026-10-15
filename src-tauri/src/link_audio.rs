//! Fetching the audio of a video or recording from a link (YouTube, a lecture page, a direct
//! file) so it can be transcribed like a picked file. The downloader is fetched on first use,
//! checked against its published checksum, and kept up to date.
use crate::file_job::{AudioFile, MAX_BYTES};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::Manager;

const RELEASES: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
#[cfg(target_os = "macos")]
const TOOL: &str = "yt-dlp_macos";
#[cfg(target_os = "windows")]
const TOOL: &str = "yt-dlp.exe";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const TOOL: &str = "yt-dlp_linux";
/// Sites change often; an older downloader updates itself before the next fetch.
const UPDATE_AFTER: Duration = Duration::from_secs(7 * 24 * 3600);
/// Transcription takes recordings up to five hours.
const MAX_SECONDS: f64 = 5.0 * 3600.0;

static FETCHING: Mutex<Option<Child>> = Mutex::new(None);
static CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LinkProgress {
    /// "preparing" while the downloader itself is fetched, then "downloading".
    stage: &'static str,
    percent: u8,
}

pub(crate) fn tools_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("tools"))
}

fn downloads_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("links"))
}

pub(crate) fn command(tool: &Path) -> Command {
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut command = Command::new(tool);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // No console window.
    }
    command
}

/// The downloader, fetched and verified on first use, updated once it is a week old.
pub(crate) async fn ensure_tool(dir: &Path, progress: &impl Fn(LinkProgress)) -> Result<PathBuf, String> {
    let tool = dir.join(TOOL);
    if tool.is_file() {
        let age = std::fs::metadata(&tool).and_then(|m| m.modified()).ok().and_then(|at| at.elapsed().ok());
        if age.is_some_and(|age| age > UPDATE_AFTER) {
            progress(LinkProgress { stage: "preparing", percent: 0 });
            let path = tool.clone();
            // A failed update keeps the copy we have; the next fetch tries again in a week.
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let _ = command(&path).arg("--update").stdout(Stdio::null()).stderr(Stdio::null()).status();
                if let Ok(file) = std::fs::File::options().write(true).open(&path) { let _ = file.set_modified(SystemTime::now()); }
            }).await;
        }
        return Ok(tool);
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).read_timeout(Duration::from_secs(60)).build().map_err(|e| e.to_string())?;
    let offline = |_| "Không tải được công cụ lấy âm thanh. Hãy kiểm tra mạng rồi thử lại.".to_string();
    let sums = client.get(format!("{RELEASES}/SHA2-256SUMS")).send().await.and_then(reqwest::Response::error_for_status).map_err(offline)?
        .text().await.map_err(offline)?;
    let expected = expected_sha256(&sums, TOOL).ok_or("Không xác minh được công cụ lấy âm thanh.")?;
    let mut response = client.get(format!("{RELEASES}/{TOOL}")).send().await.and_then(reqwest::Response::error_for_status).map_err(offline)?;
    let total = response.content_length().unwrap_or(0).max(1);
    let partial = dir.join(format!("{TOOL}.partial"));
    let mut file = std::fs::File::create(&partial).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0u64;
    progress(LinkProgress { stage: "preparing", percent: 0 });
    while let Some(chunk) = response.chunk().await.map_err(offline)? {
        if CANCELLED.load(Ordering::SeqCst) { drop(file); let _ = std::fs::remove_file(&partial); return Err("cancelled".into()); }
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        progress(LinkProgress { stage: "preparing", percent: (downloaded * 100 / total).min(100) as u8 });
    }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    if format!("{:x}", hasher.finalize()) != expected {
        let _ = std::fs::remove_file(&partial);
        return Err("Công cụ lấy âm thanh tải về bị lỗi; hãy thử lại.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&partial, &tool).map_err(|e| e.to_string())?;
    Ok(tool)
}

/// The checksum a `SHA2-256SUMS` list gives for one file.
fn expected_sha256(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, file) = line.split_once(char::is_whitespace)?;
        (file.trim().trim_start_matches('*') == name && hash.len() == 64).then(|| hash.to_ascii_lowercase())
    })
}

/// A message for people from the downloader's last error line.
pub(crate) fn friendly_error(error: &str) -> String {
    let lower = error.to_lowercase();
    let message = if lower.contains("unsupported url") || lower.contains("is not a valid url") {
        "Link này không chứa video hay âm thanh nào VietNote đọc được."
    } else if lower.contains("private") || lower.contains("sign in") || lower.contains("login") || lower.contains("members-only") || lower.contains("cookies") {
        "Video này cần đăng nhập hoặc ở chế độ riêng tư. Hãy tải file về máy rồi chọn file."
    } else if lower.contains("live event") || lower.contains("is live") || lower.contains("premieres") {
        "Video đang phát trực tiếp hoặc chưa công chiếu. Hãy thử lại khi đã có bản ghi."
    } else if lower.contains("404") || lower.contains("unavailable") || lower.contains("removed") || lower.contains("not available") {
        "Không tìm thấy video: link có thể đã bị xoá hoặc bị chặn ở khu vực này."
    } else if lower.contains("max-filesize") || lower.contains("larger than max") {
        "Âm thanh trong link lớn hơn 500 MB. Hãy tải về, cắt nhỏ rồi chọn file."
    } else if lower.contains("unable to download") || lower.contains("timed out") || lower.contains("connection") || lower.contains("network") {
        "Mất kết nối khi lấy âm thanh. Hãy kiểm tra mạng rồi thử lại."
    } else {
        "Không lấy được âm thanh từ link này. Hãy thử link khác hoặc tải file về rồi chọn file."
    };
    message.to_string()
}

fn clean_name(title: &str) -> String {
    let name: String = title.chars().map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { ' ' } else { c }).collect();
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let name: String = name.chars().take(120).collect();
    if name.is_empty() { "Âm thanh từ link".into() } else { name }
}

/// Downloads the audio behind `url` (best audio only, no video when the site offers it).
#[tauri::command]
pub(crate) async fn fetch_link_audio(app: tauri::AppHandle, url: String, on_progress: tauri::ipc::Channel<LinkProgress>) -> Result<AudioFile, String> {
    let url = url.trim().to_string();
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.contains(char::is_whitespace) {
        return Err("Hãy dán một đường link bắt đầu bằng https://".into());
    }
    if FETCHING.lock().map_err(|e| e.to_string())?.is_some() { return Err("Đang lấy âm thanh từ một link khác.".into()); }
    CANCELLED.store(false, Ordering::SeqCst);
    let progress = move |value: LinkProgress| { let _ = on_progress.send(value); };
    let tool = ensure_tool(&tools_dir(&app)?, &progress).await?;
    fetch(&tool, &downloads_dir(&app)?, url, progress).await
}

async fn fetch(tool: &Path, dir: &Path, url: String, progress: impl Fn(LinkProgress) + Send + 'static) -> Result<AudioFile, String> {
    // Only the latest link is kept; its file is uploaded before another one is fetched.
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    progress(LinkProgress { stage: "downloading", percent: 0 });

    let mut child = command(tool)
        .args(["--no-playlist", "--no-warnings", "--no-config", "--newline", "--progress", "--no-part", "--no-mtime"])
        .args(["--format", "bestaudio[ext=m4a]/bestaudio/best[height<=480]/best"])
        .args(["--max-filesize", &MAX_BYTES.to_string(), "--match-filter", "!is_live"])
        .args(["--progress-template", "download:P %(progress.downloaded_bytes)s %(progress.total_bytes,total_bytes_estimate)s"])
        .args(["--print", "video:T %(duration)s %(title)s", "--print", "after_move:F %(filepath)s"])
        .args(["--output", &dir.join("%(id).60s.%(ext)s").to_string_lossy()])
        .arg("--").arg(&url)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("Không chạy được công cụ lấy âm thanh: {e}"))?;
    let stdout = child.stdout.take().ok_or("no output")?;
    let stderr = child.stderr.take().ok_or("no output")?;
    *FETCHING.lock().map_err(|e| e.to_string())? = Some(child);
    let errors = std::thread::spawn(move || BufReader::new(stderr).lines().map_while(Result::ok).filter(|line| line.starts_with("ERROR")).last());

    let read = tauri::async_runtime::spawn_blocking(move || {
        let (mut title, mut duration, mut path, mut too_long) = (String::new(), None, None, false);
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix("T ") {
                let (seconds, name) = rest.split_once(' ').unwrap_or((rest, ""));
                duration = seconds.parse::<f64>().ok();
                title = name.to_string();
                if duration.is_some_and(|seconds| seconds > MAX_SECONDS) { too_long = true; cancel_link_audio(); }
            } else if let Some(rest) = line.strip_prefix("P ") {
                let mut parts = rest.split(' ').map(|n| n.parse::<f64>().ok());
                if let (Some(Some(done)), Some(Some(total))) = (parts.next(), parts.next()) {
                    if total > 0.0 { progress(LinkProgress { stage: "downloading", percent: (done / total * 100.0).clamp(0.0, 100.0) as u8 }); }
                }
            } else if let Some(rest) = line.strip_prefix("F ") {
                path = Some(PathBuf::from(rest));
            }
        }
        (title, duration, path, too_long)
    }).await.map_err(|e| e.to_string())?;
    let child = FETCHING.lock().map_err(|e| e.to_string())?.take();
    let status = child.map(|mut child| child.wait());
    let error = errors.join().ok().flatten();
    let (title, duration, path, too_long) = read;

    if too_long { return Err("Video dài hơn 5 giờ. Hãy chọn đoạn ngắn hơn.".into()); }
    if CANCELLED.load(Ordering::SeqCst) { return Err("cancelled".into()); }
    let path = match path {
        Some(path) if path.is_file() && status.is_some_and(|status| status.is_ok_and(|s| s.success())) => path,
        // No file and no error: the filters left it out (a live stream).
        _ => return Err(error.map(|line| friendly_error(&line)).unwrap_or_else(|| friendly_error("is live"))),
    };
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("m4a");
    let name = format!("{}.{extension}", clean_name(&title));
    AudioFile::fetched(&path, name, duration, url)
}

/// Stops a fetch in progress; its promise rejects with "cancelled".
#[tauri::command]
pub(crate) fn cancel_link_audio() {
    CANCELLED.store(true, Ordering::SeqCst);
    if let Ok(mut fetching) = FETCHING.lock() {
        if let Some(child) = fetching.as_mut() { let _ = child.kill(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_files_checksum_in_the_list() {
        let sums = "aaaa  yt-dlp\n".to_string() + &"b".repeat(64) + "  yt-dlp_macos\n" + &"c".repeat(64) + "  yt-dlp_macos.zip\n";
        assert_eq!(expected_sha256(&sums, "yt-dlp_macos"), Some("b".repeat(64)));
        assert_eq!(expected_sha256(&sums, "yt-dlp.exe"), None);
    }

    #[test]
    fn explains_common_failures_without_naming_tools() {
        assert!(friendly_error("ERROR: [youtube] abc: Private video. Sign in if you've been granted access").contains("riêng tư"));
        assert!(friendly_error("ERROR: Unsupported URL: https://example.com").contains("không chứa"));
        assert!(friendly_error("ERROR: [generic] nope: Unable to download webpage: HTTP Error 404").contains("Không tìm thấy"));
    }

    #[test]
    fn titles_become_safe_file_names() {
        assert_eq!(clean_name("  Họp: kế hoạch / Q4?  "), "Họp  kế hoạch   Q4".split_whitespace().collect::<Vec<_>>().join(" "));
        assert_eq!(clean_name(""), "Âm thanh từ link");
    }

    /// Needs the network: `cargo test fetches_a_short_video -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn fetches_a_short_video() {
        let root = std::env::temp_dir().join("vietnote-link-test");
        let shown = |value: LinkProgress| println!("{} {}%", value.stage, value.percent);
        tauri::async_runtime::block_on(async {
            let tool = ensure_tool(&root.join("tools"), &shown).await.unwrap();
            let file = fetch(&tool, &root.join("links"), "https://www.youtube.com/watch?v=jNQXAC9IVRw".into(), shown).await.unwrap();
            println!("{}", serde_json::to_string(&file).unwrap());
            let missing = fetch(&tool, &root.join("links"), "https://www.youtube.com/watch?v=xxxxxxxxxxx".into(), |_| {}).await.err().unwrap();
            println!("{missing}");
            assert!(missing.contains("Không tìm thấy"));
        });
    }
}
