//! Transcribing a recorded file: the app picks the file, the `soniox-file` Edge
//! Function reserves credit, the file streams through it to Soniox's async API,
//! and the app polls until the transcript is ready.
use crate::account;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

/// Soniox accepts files up to 500 MB.
const MAX_BYTES: u64 = 500 * 1024 * 1024;
const EXTENSIONS: [&str; 11] = ["mp3", "m4a", "wav", "aac", "flac", "ogg", "opus", "webm", "mp4", "mov", "aiff"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioFile {
    path: String,
    name: String,
    size: u64,
    /// None when the container does not state its length (the server then settles afterwards).
    duration_seconds: Option<f64>,
    /// When the recording was last written, roughly when the meeting ended.
    modified_ms: Option<u64>,
}

/// Reads the length from the container header without decoding the audio.
fn duration_seconds(path: &Path) -> Option<f64> {
    use symphonia::core::{formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint};
    let file = std::fs::File::open(path).ok()?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|e| e.to_str()) { hint.with_extension(extension); }
    let probed = symphonia::default::get_probe()
        .format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default()).ok()?;
    let track = probed.format.default_track()?;
    let params = &track.codec_params;
    let frames = params.n_frames?;
    let seconds = match (params.time_base, params.sample_rate) {
        (Some(base), _) => { let time = base.calc_time(frames); time.seconds as f64 + time.frac }
        (None, Some(rate)) => frames as f64 / rate as f64,
        _ => return None,
    };
    (seconds > 0.0).then_some(seconds)
}

#[tauri::command]
pub(crate) async fn pick_audio_file(app: tauri::AppHandle) -> Result<Option<AudioFile>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().add_filter("Âm thanh hoặc video", &EXTENSIONS).blocking_pick_file();
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let metadata = std::fs::metadata(&path).map_err(|e| format!("Không đọc được file: {e}"))?;
    let size = metadata.len();
    let modified_ms = metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|age| age.as_millis() as u64);
    if size > MAX_BYTES { return Err("File lớn hơn 500 MB. Hãy cắt hoặc nén file rồi thử lại.".into()); }
    let probe = path.clone();
    let duration = tauri::async_runtime::spawn_blocking(move || duration_seconds(&probe)).await.unwrap_or(None);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("audio").to_string();
    Ok(Some(AudioFile { path: path.to_string_lossy().into_owned(), name, size, duration_seconds: duration, modified_ms }))
}

async fn call(body: Value, timeout: Duration) -> Result<Value, String> {
    let (url, anon) = account::config().ok_or("not_configured")?;
    let token = account::access_token().await?;
    let response = reqwest::Client::builder().timeout(timeout).build().map_err(|e| e.to_string())?
        .post(format!("{url}/functions/v1/soniox-file"))
        .header("apikey", anon).bearer_auth(token).json(&body).send().await
        .map_err(|_| "offline".to_string())?;
    let status = response.status().as_u16();
    let value: Value = response.json().await.unwrap_or(Value::Null);
    match status {
        200..=299 => Ok(value),
        401 => Err("signed_out".into()),
        402 => Err("insufficient_credit".into()),
        _ => Err(value.get("error").and_then(Value::as_str).unwrap_or("unavailable").to_string()),
    }
}

#[tauri::command]
pub(crate) async fn file_job_start(filename: String, estimated_seconds: Option<f64>) -> Result<Value, String> {
    call(json!({"action": "start", "filename": filename, "estimated_seconds": estimated_seconds}), Duration::from_secs(20)).await
}

/// Streams the file to the Edge Function, reporting upload progress (0–100).
#[tauri::command]
pub(crate) async fn file_job_upload(job_id: String, path: String, language: String, translate: bool, on_progress: tauri::ipc::Channel<u8>) -> Result<(), String> {
    use futures_util::stream;
    use std::io::Read;
    let (url, anon) = account::config().ok_or("not_configured")?;
    let token = account::access_token().await?;
    let file = std::fs::File::open(&path).map_err(|e| format!("Không mở được file: {e}"))?;
    let total = file.metadata().map_err(|e| e.to_string())?.len().max(1);
    let name = Path::new(&path).file_name().and_then(|n| n.to_str()).unwrap_or("audio").to_string();
    let chunks = stream::unfold((file, 0u64, 0u8), move |(mut file, sent, reported)| {
        let channel = on_progress.clone();
        async move {
            let mut buffer = vec![0u8; 256 * 1024];
            match file.read(&mut buffer) {
                Ok(0) => None,
                Ok(read) => {
                    buffer.truncate(read);
                    let sent = sent + read as u64;
                    let percent = (sent * 100 / total) as u8;
                    if percent != reported { let _ = channel.send(percent); }
                    Some((Ok::<_, std::io::Error>(buffer), (file, sent, percent)))
                }
                Err(error) => Some((Err(error), (file, sent, reported))),
            }
        }
    });
    let query = [("action", "upload"), ("job_id", job_id.as_str()), ("language", language.as_str()), ("translate", if translate { "1" } else { "0" })];
    // No overall timeout: a long recording on a slow uplink takes minutes.
    let response = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?
        .post(format!("{url}/functions/v1/soniox-file")).query(&query)
        .header("apikey", anon).bearer_auth(token)
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", total.to_string())
        .header("x-filename", urlencode(&name))
        .body(reqwest::Body::wrap_stream(chunks))
        .send().await.map_err(|_| "upload_interrupted".to_string())?;
    if response.status().is_success() { return Ok(()); }
    let value: Value = response.json().await.unwrap_or(Value::Null);
    Err(value.get("error").and_then(Value::as_str).unwrap_or("upload_failed").to_string())
}

fn urlencode(text: &str) -> String {
    text.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[tauri::command]
pub(crate) async fn file_job_status(job_id: String) -> Result<Value, String> {
    // A finished long recording returns its whole transcript in this reply.
    call(json!({"action": "status", "job_id": job_id}), Duration::from_secs(120)).await
}

#[tauri::command]
pub(crate) async fn file_job_cleanup(job_id: String) -> Result<(), String> {
    call(json!({"action": "cleanup", "job_id": job_id}), Duration::from_secs(20)).await.map(|_| ())
}

#[tauri::command]
pub(crate) async fn file_job_cancel(job_id: String) -> Result<(), String> {
    call(json!({"action": "cancel", "job_id": job_id}), Duration::from_secs(20)).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_wav_length_from_its_header() {
        let path = std::env::temp_dir().join("vietnote-length-test.wav");
        let rate = 16_000u32;
        let samples = vec![0i16; rate as usize * 3 / 2];
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + samples.len() as u32 * 2).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(samples.len() as u32 * 2).to_le_bytes());
        for sample in &samples { bytes.extend_from_slice(&sample.to_le_bytes()); }
        std::fs::write(&path, bytes).unwrap();
        let seconds = duration_seconds(&path).unwrap();
        std::fs::remove_file(&path).ok();
        assert!((seconds - 1.5).abs() < 0.01, "{seconds}");
    }

    #[test]
    fn encodes_vietnamese_file_names_for_a_header() {
        assert_eq!(urlencode("họp 1.m4a"), "h%E1%BB%8Dp%201.m4a");
    }
}
