mod account;
mod ai_stream;
mod note_chat;
mod diarization_model;
mod file_job;
mod island;
mod playback;
mod voice_pack;
mod writer;
use base64::Engine;
use clipclip::{start_with_tap, Config, Recording, Source};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

/// Console children of a GUI app open their own console window on Windows; keep them hidden.
fn hide_console(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[derive(Default)]
struct NativeState {
    child: Mutex<Option<Child>>,
    writer: Arc<Mutex<Option<TcpStream>>>,
    // Kept apart so the user can turn each source off and on mid-recording.
    microphone: Mutex<Option<Recording>>,
    system: Mutex<Option<Recording>>,
    // Set while a recording runs; new sources send their audio through it.
    capture_tx: Mutex<Option<mpsc::SyncSender<(String, Vec<f32>, f64)>>>,
    capture_forwarder: Mutex<Option<std::thread::JoinHandle<()>>>,
    pending_audio: Arc<AtomicUsize>,
    worker_epoch: Arc<AtomicUsize>,
    // The worker announces itself once; a reloaded page asks for it again.
    connected: Arc<Mutex<Option<Value>>>,
}

/// Developer override: a provider key in the environment bypasses the VietNote server.
fn env_key(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|key| !key.trim().is_empty())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredNotes { notes: Vec<Value>, groups: Vec<Value> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptSegment {
    id: String,
    timestamp: String,
    started_at: f64,
    audio_source: String,
    raw_text: String,
    clean_text: String,
    #[serde(default)]
    speaker: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SummaryBullet { id: String, text: String, evidence_ids: Vec<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct UnresolvedTopic {
    id: String,
    text: String,
    topic: String,
    options: Vec<String>,
    status: String,
    evidence_ids: Vec<String>,
}
impl Default for UnresolvedTopic {
    fn default() -> Self { Self { id: String::new(), text: String::new(), topic: String::new(), options: vec![], status: "No final decision".into(), evidence_ids: vec![] } }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ActionItem { id: String, owner: Option<String>, task: String, deadline: Option<String>, evidence_ids: Vec<String> }

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct DeferredItem { id: String, text: String, target: Option<String>, evidence_ids: Vec<String> }

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct MeetingSummary {
    /// Short meeting name suggested to the user when saving.
    title: String,
    tldr: String,
    key_points: Vec<SummaryBullet>,
    decisions: Vec<SummaryBullet>,
    tentative_decisions: Vec<SummaryBullet>,
    unresolved_topics: Vec<UnresolvedTopic>,
    action_items: Vec<ActionItem>,
    open_questions: Vec<SummaryBullet>,
    deferred: Vec<DeferredItem>,
}

fn app_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn legacy_data() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    { std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Application Support/LiveTranslator")) }
    #[cfg(not(target_os = "macos"))]
    { None }
}

fn read_array(path: &Path) -> Vec<Value> {
    fs::read(path).ok().and_then(|data| serde_json::from_slice::<Vec<Value>>(&data).ok()).unwrap_or_default()
}

fn migrate_swift_date(note: &mut Value, key: &str) {
    if let Some(seconds) = note.get(key).and_then(Value::as_f64) {
        // Foundation's default JSONEncoder stores seconds since 2001-01-01.
        let unix_ms = ((seconds + 978_307_200.0) * 1000.0) as i64;
        if let Some(date) = chrono::DateTime::from_timestamp_millis(unix_ms) {
            note[key] = Value::String(date.to_rfc3339());
        }
    }
}

#[tauri::command]
fn load_notes(app: tauri::AppHandle) -> Result<StoredNotes, String> {
    let dir = app_data(&app)?;
    let legacy = legacy_data();
    let notes_path = if dir.join("meeting-notes.json").exists() { dir.join("meeting-notes.json") }
        else { legacy.as_ref().map(|p| p.join("meeting-notes.json")).unwrap_or_else(|| dir.join("meeting-notes.json")) };
    let groups_path = if dir.join("note-groups.json").exists() { dir.join("note-groups.json") }
        else { legacy.as_ref().map(|p| p.join("note-groups.json")).unwrap_or_else(|| dir.join("note-groups.json")) };
    let mut notes = read_array(&notes_path);
    for note in &mut notes {
        migrate_swift_date(note, "createdAt");
        migrate_swift_date(note, "updatedAt");
        if note.get("updatedAt").is_none() { note["updatedAt"] = note["createdAt"].clone(); }
    }
    Ok(StoredNotes { notes, groups: read_array(&groups_path) })
}

#[tauri::command]
fn save_notes(app: tauri::AppHandle, payload: StoredNotes) -> Result<(), String> {
    let dir = app_data(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (name, data) in [("meeting-notes.json", json!(payload.notes)), ("note-groups.json", json!(payload.groups))] {
        let path = dir.join(name);
        let temp = dir.join(format!("{name}.tmp"));
        fs::write(&temp, serde_json::to_vec(&data).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        #[cfg(target_os = "windows")]
        if path.exists() { fs::remove_file(&path).map_err(|e| e.to_string())?; }
        fs::rename(temp, path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn project_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = std::env::var_os("VIETNOTE_PROJECT_ROOT") {
        let path = PathBuf::from(root);
        if path.join("asr/server.py").exists() { return Ok(path); }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    if dev.join("asr/server.py").exists() { return Ok(dev); }
    let resource = app.path().resource_dir().map_err(|e| e.to_string())?;
    if resource.join("asr/server.py").exists() { return Ok(resource); }
    if resource.join("_up_/asr/server.py").exists() { return Ok(resource.join("_up_")); }
    Err("Không tìm thấy asr/server.py trong tài nguyên ứng dụng".into())
}

fn worker_executable(root: &Path) -> Result<(PathBuf, bool), String> {
    let packaged = if cfg!(windows) {
        root.join("worker-dist/vietnote-worker/vietnote-worker.exe")
    } else {
        root.join("worker-dist/vietnote-worker/vietnote-worker")
    };
    let bundled = if cfg!(windows) { root.join(".venv/Scripts/python.exe") } else { root.join(".venv/bin/python") };
    // Dev runs must execute the live asr/ sources; a stale worker-dist freeze
    // would silently hide new worker features (e.g. Nemotron diarization).
    // Local release builds resolve the root to this source tree too, so they must
    // not run the freeze either; installed apps have no .venv and use it.
    if bundled.exists() { return Ok((bundled, false)); }
    if packaged.exists() { return Ok((packaged, true)); }
    if let Some(path) = std::env::var_os("VIETNOTE_PYTHON") {
        let path = PathBuf::from(path);
        if path.exists() { return Ok((path, false)); }
    }
    Err("Thiếu bộ xử lý âm thanh đi kèm ứng dụng".into())
}

#[tauri::command]
fn start_worker(app: tauri::AppHandle, state: tauri::State<'_, NativeState>) -> Result<(), String> {
    let mut slot = state.child.lock().map_err(|e| e.to_string())?;
    if slot.as_mut().is_some_and(|child| child.try_wait().ok().flatten().is_none()) {
        if let Some(message) = state.connected.lock().map_err(|e| e.to_string())?.clone() { let _ = app.emit("worker-message", message); }
        return Ok(());
    }
    let root = project_root(&app)?;
    let (worker, packaged_worker) = worker_executable(&root)?;
    // A locked/unavailable OS credential store must not prevent offline ASR.
    let groq_key = env_key("GROQ_API_KEY");
    let soniox_key = env_key("SONIOX_API_KEY");
    let token = format!("{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
    let logs = app_data(&app)?.join("logs");
    fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    // Preserve earlier sessions when the worker restarts; otherwise the only
    // evidence for intermittent ASR repetition disappears on every launch.
    let mut logfile = fs::OpenOptions::new().create(true).append(true)
        .open(logs.join("worker.log")).map_err(|e| e.to_string())?;
    writeln!(logfile, "\n[WORKER START] {}", chrono::Local::now())
        .map_err(|e| e.to_string())?;
    let stderr_log = logfile.try_clone().map_err(|e| e.to_string())?;
    let cache = if root.join(".venv").exists() { root.join(".cache/huggingface") } else { app_data(&app)?.join("cache/huggingface") };
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let mut command = Command::new(worker);
    hide_console(&mut command);
    if !packaged_worker { command.args(["-u", "asr/server.py"]); }
    command.current_dir(&root)
        .env("ASR_TOKEN", &token)
        .env("PYTHONUTF8", "1")
        .env("HF_HOME", cache)
        .stdout(Stdio::piped()).stderr(Stdio::from(stderr_log));
    if let Some(key) = groq_key.filter(|key| !key.trim().is_empty()) {
        command.env("GROQ_API_KEY", key);
    } else {
        command.env_remove("GROQ_API_KEY");
    }
    command.env_remove("SONIOX_MANAGED");
    if let Some(key) = soniox_key.filter(|key| !key.trim().is_empty()) {
        command.env("SONIOX_API_KEY", key);
    } else {
        command.env_remove("SONIOX_API_KEY");
        // Stream on VietNote credit with temporary keys from the server.
        command.env("SONIOX_MANAGED", "1");
    }
    if let Some(model) = diarization_model::installed_model(&app, &root) { command.env("NEMOTRON_MODEL", model); }
    if let Some(voice) = voice_pack::installed(&app, &root) { command.env("TTS_MODEL_DIR", voice); }
    if let Some(library) = diarization_model::runtime_library(&root) { command.env("NEMOTRON_LIBRARY", library); }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("Không đọc được ASR stdout")?;
    *slot = Some(child);
    drop(slot);
    let writer = state.writer.clone();
    let connected = state.connected.clone();
    if let Ok(mut cached) = connected.lock() { *cached = None; }
    let epoch_counter = state.worker_epoch.clone();
    let epoch = epoch_counter.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        if epoch_counter.load(Ordering::SeqCst) == epoch { let _ = app.emit("worker-status", "Loading services…"); }
        let mut ready = false;
        let mut lines = BufReader::new(stdout);
        let mut buffer = Vec::new();
        // Decode lossily: one badly encoded line must not end the reader and hide the rest.
        while lines.read_until(b'\n', &mut buffer).is_ok_and(|read| read > 0) {
            let line = String::from_utf8_lossy(&buffer).trim_end_matches(['\r', '\n']).to_string();
            buffer.clear();
            // Python writes ASR diagnostics to stdout; retain them alongside
            // stderr so a future repeated segment can be traced to its source.
            let _ = writeln!(logfile, "{line}");
            if epoch_counter.load(Ordering::SeqCst) != epoch { break; }
            let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
            if event.get("type").and_then(Value::as_str) != Some("ready") { continue; }
            let Some(port) = event.get("port").and_then(Value::as_u64) else { continue };
            ready = true;
            // Serve the socket on its own thread and keep draining stdout: an unread
            // pipe blocks the worker's print() once it fills, and the log would lose
            // every diagnostic written after startup.
            let (app, writer, connected, epoch_counter, token) = (app.clone(), writer.clone(), connected.clone(), epoch_counter.clone(), token.clone());
            std::thread::spawn(move || {
                match TcpStream::connect(("127.0.0.1", port as u16)) {
                    Ok(mut stream) => {
                        let _ = stream.set_nodelay(true);
                        let hello = json!({"type":"hello", "token":token});
                        let _ = writeln!(stream, "{hello}");
                        match stream.try_clone() {
                            Ok(reader) => {
                                if let Ok(mut slot) = writer.lock() { if epoch_counter.load(Ordering::SeqCst) == epoch { *slot = Some(stream); } }
                                for line in BufReader::new(reader).lines().map_while(Result::ok) {
                                    if epoch_counter.load(Ordering::SeqCst) != epoch { break; }
                                    let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                                    if message.get("type").and_then(Value::as_str) == Some("connected") {
                                        if let Ok(mut cached) = connected.lock() { *cached = Some(message.clone()); }
                                    }
                                    if !handle_credit_message(&message, &writer) { let _ = app.emit("worker-message", message); }
                                }
                                if epoch_counter.load(Ordering::SeqCst) == epoch {
                                    if let Ok(mut slot) = writer.lock() { *slot = None; }
                                    if let Ok(mut cached) = connected.lock() { *cached = None; }
                                    let _ = app.emit("worker-status", "Service connection closed");
                                }
                            }
                            Err(_) => { let _ = app.emit("worker-status", "Service connection failed"); }
                        }
                    }
                    Err(_) => { let _ = app.emit("worker-status", "Service connection failed"); }
                }
            });
        }
        // The worker died while loading: say so instead of loading forever.
        if !ready && epoch_counter.load(Ordering::SeqCst) == epoch {
            let _ = writeln!(logfile, "[WORKER EXITED] before it was ready");
            let _ = app.emit("worker-status", "Service failed to start");
        }
    });
    Ok(())
}

/// The worker asks Rust (which holds the account session) for Soniox keys.
fn handle_credit_message(message: &Value, writer: &Arc<Mutex<Option<TcpStream>>>) -> bool {
    let text = |key: &str| message.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    match message.get("type").and_then(Value::as_str) {
        Some("soniox_key_request") => {
            let (request_id, source, writer) = (text("request_id"), text("source"), writer.clone());
            tauri::async_runtime::spawn(async move {
                let mut reply = account::soniox_grant(&source).await;
                reply["type"] = json!("soniox_key");
                reply["request_id"] = json!(request_id);
                if let Ok(mut slot) = writer.lock() {
                    if let Some(stream) = slot.as_mut() { let _ = writeln!(stream, "{reply}"); }
                }
            });
            true
        }
        Some("soniox_key_release") => {
            let grant_id = text("grant_id");
            tauri::async_runtime::spawn(async move { account::soniox_release(&grant_id).await });
            true
        }
        _ => false,
    }
}

fn restart_worker_for_account(app: tauri::AppHandle, state: tauri::State<'_, NativeState>) -> Result<(), String> {
    stop_worker(state.clone())?;
    start_worker(app, state)
}

fn ensure_idle(state: &tauri::State<'_, NativeState>) -> Result<(), String> {
    if !capturing(state)? { Ok(()) }
    else { Err("Hãy dừng ghi âm trước khi đổi tài khoản".into()) }
}

#[tauri::command]
async fn account_verify(app: tauri::AppHandle, state: tauri::State<'_, NativeState>, email: String, code: String) -> Result<(), String> {
    ensure_idle(&state)?;
    account::verify(&email, &code).await?;
    restart_worker_for_account(app, state)
}

#[tauri::command]
fn account_sign_out(app: tauri::AppHandle, state: tauri::State<'_, NativeState>) -> Result<(), String> {
    ensure_idle(&state)?;
    account::sign_out();
    restart_worker_for_account(app, state)
}

#[tauri::command]
fn diarization_model_status(app: tauri::AppHandle) -> Result<diarization_model::DiarizationModelStatus, String> {
    let root = project_root(&app)?;
    diarization_model::status(&app, &root)
}

/// Reloads the worker so Nemotron picks up (or drops) the model, unless a recording is running.
fn reload_worker_when_idle(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<NativeState>();
    if capturing(&state)? { return Ok(()); }
    stop_worker(state.clone())?;
    start_worker(app.clone(), state)
}

#[tauri::command]
async fn download_diarization_model(app: tauri::AppHandle) -> Result<diarization_model::DiarizationModelStatus, String> {
    diarization_model::download(&app).await?;
    reload_worker_when_idle(&app)?;
    diarization_model_status(app)
}

#[tauri::command]
fn cancel_diarization_download() { diarization_model::cancel(); }

#[tauri::command]
fn remove_diarization_model(app: tauri::AppHandle) -> Result<diarization_model::DiarizationModelStatus, String> {
    diarization_model::remove(&app)?;
    reload_worker_when_idle(&app)?;
    diarization_model_status(app)
}

#[tauri::command]
fn voice_pack_status(app: tauri::AppHandle) -> Result<voice_pack::VoicePackStatus, String> {
    let root = project_root(&app)?;
    voice_pack::status(&app, &root)
}

/// The worker is told where the voice is when speech is turned on, so no reload is needed.
#[tauri::command]
async fn download_voice_pack(app: tauri::AppHandle) -> Result<voice_pack::VoicePackStatus, String> {
    voice_pack::download(&app).await?;
    voice_pack_status(app)
}

#[tauri::command]
fn cancel_voice_pack_download() { voice_pack::cancel(); }

#[tauri::command]
fn remove_voice_pack(app: tauri::AppHandle) -> Result<voice_pack::VoicePackStatus, String> {
    voice_pack::remove(&app)?;
    voice_pack_status(app)
}

#[tauri::command]
fn send_worker(state: tauri::State<'_, NativeState>, payload: Value) -> Result<(), String> {
    let mut slot = state.writer.lock().map_err(|e| e.to_string())?;
    let stream = slot.as_mut().ok_or("ASR chưa sẵn sàng")?;
    writeln!(stream, "{payload}").map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_worker(state: tauri::State<'_, NativeState>) -> Result<(), String> {
    state.worker_epoch.fetch_add(1, Ordering::SeqCst);
    let _ = end_capture(&state);
    *state.writer.lock().map_err(|e| e.to_string())? = None;
    *state.connected.lock().map_err(|e| e.to_string())? = None;
    if let Some(mut child) = state.child.lock().map_err(|e| e.to_string())?.take() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            child.kill().map_err(|e| e.to_string())?;
        }
        let _ = child.wait();
    }
    Ok(())
}

/// Core Audio input never shows the microphone prompt itself: when it asks on the app's
/// behalf, macOS answers "policy disallows prompt" and delivers silence. Only an
/// AVFoundation request from the app can show the prompt, so make it before capture.
#[cfg(target_os = "macos")]
fn ensure_microphone_access() -> Result<(), String> {
    use block2::RcBlock;
    use objc2::{class, msg_send, runtime::Bool};
    use objc2_foundation::NSString;
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}
    const DENIED: &str = "VietNote chưa được dùng micro. Mở Cài đặt hệ thống → Quyền riêng tư & Bảo mật → Micro, bật VietNote rồi thử lại.";
    let audio = NSString::from_str("soun"); // AVMediaTypeAudio
    let device = class!(AVCaptureDevice);
    // AVAuthorizationStatus: 0 not determined, 1 restricted, 2 denied, 3 authorized.
    let status: isize = unsafe { msg_send![device, authorizationStatusForMediaType: &*audio] };
    match status {
        3 => Ok(()),
        0 => {
            let (tx, rx) = mpsc::channel();
            let reply = RcBlock::new(move |granted: Bool| { let _ = tx.send(granted.as_bool()); });
            let _: () = unsafe { msg_send![device, requestAccessForMediaType: &*audio, completionHandler: &*reply] };
            if rx.recv_timeout(Duration::from_secs(120)).unwrap_or(false) { Ok(()) } else { Err(DENIED.into()) }
        }
        _ => Err(DENIED.into()),
    }
}

fn start_source(source: Source, label: &'static str, tx: mpsc::SyncSender<(String, Vec<f32>, f64)>) -> Result<Recording, String> {
    let config = Config { source, sample_rate: 16_000, segment: Duration::from_secs(30), ..Config::default() };
    start_with_tap(config, |_| {}, Box::new(move |frames| {
        let captured = frames.captured_at.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64();
        let _ = tx.try_send((label.to_string(), frames.samples.to_vec(), captured));
    })).map_err(|e| e.to_string())
}

fn capturing(state: &tauri::State<'_, NativeState>) -> Result<bool, String> {
    Ok(state.capture_tx.lock().map_err(|e| e.to_string())?.is_some())
}

fn start_microphone(tx: mpsc::SyncSender<(String, Vec<f32>, f64)>) -> Result<Recording, String> {
    #[cfg(target_os = "macos")]
    ensure_microphone_access()?;
    start_source(Source::Mic, "microphone", tx)
}

#[tauri::command]
fn start_capture(state: tauri::State<'_, NativeState>, source: String) -> Result<(), String> {
    let mut slot = state.capture_tx.lock().map_err(|e| e.to_string())?;
    if slot.is_some() { return Err("Đang ghi âm".into()); }
    if !matches!(source.as_str(), "microphone" | "system" | "both") { return Err("Nguồn âm thanh không hợp lệ".into()); }
    let (tx, rx) = mpsc::sync_channel::<(String, Vec<f32>, f64)>(25);
    let writer = state.writer.clone();
    let pending = state.pending_audio.clone();
    let microphone = if source == "system" { None } else { Some(start_microphone(tx.clone())?) };
    let system = if source == "microphone" { None } else { Some(start_source(Source::System, "system", tx.clone())?) };
    *state.microphone.lock().map_err(|e| e.to_string())? = microphone;
    *state.system.lock().map_err(|e| e.to_string())? = system;
    *slot = Some(tx);
    drop(slot);
    let forwarder = std::thread::spawn(move || {
        while let Ok((source, samples, captured_at)) = rx.recv() {
            if pending.fetch_add(1, Ordering::Relaxed) >= 25 { pending.fetch_sub(1, Ordering::Relaxed); continue; }
            let mut bytes = Vec::with_capacity(samples.len() * 4);
            for sample in samples { bytes.extend_from_slice(&sample.to_le_bytes()); }
            let payload = json!({"type":"audio", "source":source, "pcm":base64::engine::general_purpose::STANDARD.encode(bytes), "captured_at":captured_at});
            if let Ok(mut slot) = writer.lock() {
                if let Some(stream) = slot.as_mut() { let _ = writeln!(stream, "{payload}"); }
            }
            pending.fetch_sub(1, Ordering::Relaxed);
        }
    });
    *state.capture_forwarder.lock().map_err(|e| e.to_string())? = Some(forwarder);
    Ok(())
}

/// Turns the microphone off or on while a recording runs; other sources keep going.
#[tauri::command]
fn set_microphone(state: tauri::State<'_, NativeState>, enabled: bool) -> Result<(), String> {
    let tx = state.capture_tx.lock().map_err(|e| e.to_string())?.clone().ok_or("Chưa ghi âm")?;
    let mut microphone = state.microphone.lock().map_err(|e| e.to_string())?;
    if !enabled { *microphone = None; }
    else if microphone.is_none() { *microphone = Some(start_microphone(tx)?); }
    Ok(())
}

/// Turns system audio off or on while a recording runs; the microphone keeps going.
#[tauri::command]
fn set_system_audio(state: tauri::State<'_, NativeState>, enabled: bool) -> Result<(), String> {
    let tx = state.capture_tx.lock().map_err(|e| e.to_string())?.clone().ok_or("Chưa ghi âm")?;
    let mut system = state.system.lock().map_err(|e| e.to_string())?;
    if !enabled { *system = None; }
    else if system.is_none() { *system = Some(start_source(Source::System, "system", tx)?); }
    Ok(())
}

/// Stops every source; the forwarder ends once the last sender is dropped.
fn end_capture(state: &tauri::State<'_, NativeState>) -> Result<(), String> {
    *state.system.lock().map_err(|e| e.to_string())? = None;
    *state.microphone.lock().map_err(|e| e.to_string())? = None;
    *state.capture_tx.lock().map_err(|e| e.to_string())? = None;
    if let Some(thread) = state.capture_forwarder.lock().map_err(|e| e.to_string())?.take() {
        thread.join().map_err(|_| "Audio forwarding failed".to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn stop_capture(state: tauri::State<'_, NativeState>) -> Result<(), String> {
    end_capture(&state)
}

async fn ai_completion(system: &str, user: String, max_tokens: u32, json: bool) -> Result<String, String> {
    account::ai_complete(system, user, max_tokens, json).await
}

fn parse_json_object(text: &str) -> Result<Value, String> {
    let start = text.find('{').ok_or("Model không trả về JSON object")?;
    let end = text.rfind('}').ok_or("JSON từ model bị thiếu dấu đóng")?;
    serde_json::from_str(&text[start..=end]).map_err(|error| format!("JSON summary không hợp lệ: {error}"))
}

fn keep_evidence(ids: &mut Vec<String>, allowed: &HashSet<String>) {
    ids.retain(|id| allowed.contains(id));
    ids.sort();
    ids.dedup();
}

fn evidence_lists(summary: &mut MeetingSummary) -> Vec<&mut Vec<String>> {
    let mut lists: Vec<&mut Vec<String>> = Vec::new();
    for items in [&mut summary.key_points, &mut summary.decisions, &mut summary.tentative_decisions, &mut summary.open_questions] {
        lists.extend(items.iter_mut().map(|item| &mut item.evidence_ids));
    }
    lists.extend(summary.unresolved_topics.iter_mut().map(|item| &mut item.evidence_ids));
    lists.extend(summary.action_items.iter_mut().map(|item| &mut item.evidence_ids));
    lists.extend(summary.deferred.iter_mut().map(|item| &mut item.evidence_ids));
    lists
}

/// Rewrites evidence IDs through `map`, dropping IDs it does not know.
fn map_evidence(summary: &mut MeetingSummary, map: &HashMap<String, String>) {
    for ids in evidence_lists(summary) {
        *ids = ids.iter().filter_map(|id| map.get(id).cloned()).collect();
    }
}

/// Drops empty strings, nulls and empty arrays so an unchanged previous summary costs fewer tokens.
fn compact_json(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.into_iter()
            .map(|(key, value)| (key, compact_json(value)))
            .filter(|(_, value)| !matches!(value, Value::Null) && value.as_array().map_or(true, |items| !items.is_empty()) && value.as_str().map_or(true, |text| !text.is_empty()))
            .collect()),
        Value::Array(items) => Value::Array(items.into_iter().map(compact_json).collect()),
        other => other,
    }
}

#[cfg(test)]
fn validate_summary(summary: MeetingSummary, segments: &[TranscriptSegment]) -> MeetingSummary {
    let allowed: HashSet<String> = segments.iter().map(|segment| segment.id.clone()).collect();
    validate_summary_with(summary, &allowed)
}

fn clean_title(title: &str) -> String {
    let title = title.trim().trim_matches(|c: char| matches!(c, '"' | '\'' | '“' | '”' | '.' | '#' | '*')).trim();
    title.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(80).collect()
}

fn validate_summary_with(mut summary: MeetingSummary, allowed: &HashSet<String>) -> MeetingSummary {
    let allowed = allowed.clone();
    summary.title = clean_title(&summary.title);
    let validate_bullets = |items: &mut Vec<SummaryBullet>, evidence_required: bool| {
        for item in items.iter_mut() { keep_evidence(&mut item.evidence_ids, &allowed); }
        items.retain(|item| !item.text.trim().is_empty() && (!evidence_required || !item.evidence_ids.is_empty()));
    };
    validate_bullets(&mut summary.key_points, false);
    validate_bullets(&mut summary.decisions, true);
    validate_bullets(&mut summary.tentative_decisions, true);
    validate_bullets(&mut summary.open_questions, false);
    for item in &mut summary.unresolved_topics {
        keep_evidence(&mut item.evidence_ids, &allowed);
        item.status = "No final decision".into();
        if item.text.trim().is_empty() { item.text = item.topic.clone(); }
    }
    summary.unresolved_topics.retain(|item| !item.topic.trim().is_empty() && !item.evidence_ids.is_empty());
    for item in &mut summary.action_items { keep_evidence(&mut item.evidence_ids, &allowed); }
    summary.action_items.retain(|item| !item.task.trim().is_empty() && !item.evidence_ids.is_empty());
    for item in &mut summary.deferred { keep_evidence(&mut item.evidence_ids, &allowed); }
    summary.deferred.retain(|item| !item.text.trim().is_empty() && !item.evidence_ids.is_empty());
    summary
}

#[tauri::command]
async fn summarize_segments(segments: Vec<TranscriptSegment>, previous_summary: Option<MeetingSummary>) -> Result<MeetingSummary, String> {
    if segments.is_empty() { return Ok(previous_summary.unwrap_or_default()); }
    // Segment IDs are UUIDs; the model sees short aliases (s1, s2, …) instead, which
    // are mapped back after parsing. Evidence already cited by the previous summary
    // keeps its alias so incremental merges can carry old items forward.
    let mut previous_summary = previous_summary;
    let mut alias_of: HashMap<String, String> = HashMap::new();
    let mut real_of: HashMap<String, String> = HashMap::new();
    let mut alias = |id: &str| -> String {
        if let Some(existing) = alias_of.get(id) { return existing.clone(); }
        let short = format!("s{}", alias_of.len() + 1);
        alias_of.insert(id.to_string(), short.clone());
        real_of.insert(short.clone(), id.to_string());
        short
    };
    let mut allowed: HashSet<String> = segments.iter().map(|segment| segment.id.clone()).collect();
    if let Some(summary) = previous_summary.as_mut() {
        for ids in evidence_lists(summary) {
            allowed.extend(ids.iter().cloned());
            *ids = ids.iter().map(|id| alias(id)).collect();
        }
    }
    let transcript = segments.iter().map(|segment| {
        let source = match segment.audio_source.as_str() { "microphone" => "mic", "file" => "file", _ => "máy" };
        let speaker = segment.speaker.as_deref().map(|speaker| format!(" {speaker}")).unwrap_or_default();
        format!("[{}]{speaker} ({source}): {}", alias(&segment.id), segment.clean_text)
    }).collect::<Vec<_>>().join("\n");
    let incremental = previous_summary.is_some();
    let previous = previous_summary.as_ref()
        .and_then(|summary| serde_json::to_value(summary).ok())
        .map(|value| compact_json(value).to_string())
        .unwrap_or_else(|| "null".into());
    let merge_rule = if incremental {
        "- BẢN TÓM TẮT HIỆN CÓ đã bao quát phần trước của cuộc họp; transcript cũ không được gửi lại. Giữ nguyên các mục cũ cùng evidenceIds của chúng, chỉ sửa hoặc bỏ khi transcript mới phủ định, chốt lại hay làm rõ. Thêm mục mới từ transcript mới và cập nhật tldr cho toàn bộ cuộc họp."
    } else {
        "- Transcript là nguồn sự thật duy nhất."
    };
    let system = r#"Bạn là thư ký cuộc họp AI/Tech cực kỳ thận trọng. Tạo meeting note ngắn, dễ scan và có thể kiểm chứng.

QUY TẮC BẮT BUỘC:
- Toàn bộ nội dung do bạn viết trong tldr, text, topic, options, task và các trường nội dung khác phải bằng tiếng Việt, bất kể transcript dùng ngôn ngữ nào. Chỉ giữ nguyên tên riêng và thuật ngữ kỹ thuật không nên dịch.
- Chỉ tạo decision khi transcript có lời chốt/đồng ý rõ ràng. Một người nêu preference không phải consensus.
- Nếu nhiều option được bàn mà chưa chốt, đưa vào unresolvedTopics với status chính xác là "No final decision".
- Preference chưa commit phải nằm ở tentativeDecisions, không phải decisions.
- Không phát minh decision, action item, owner, deadline, blocker, next step hoặc conclusion.
- Action item chỉ có owner/deadline khi transcript nói rõ. Dùng null khi thiếu.
- Preserve uncertainty. Khi phân vân, dùng unresolved thay vì đoán.
- Mỗi decision, tentative decision, unresolved topic, action item và deferred item phải có evidenceIds lấy nguyên văn từ ID trong dấu [] ở transcript.
- Không dùng nhãn nguồn (mic)/(máy) làm tên người. Chỉ ghi owner khi tên người xuất hiện rõ trong lời nói.
- Nhãn Người nói N là ước lượng âm thanh, riêng theo từng nguồn; không suy ra tên thật hoặc owner từ nhãn này. Một đoạn có thể chứa nhiều người nói.
- title: tên cuộc họp tiếng Việt 3–8 từ nêu chủ đề chính và mục đích (ví dụ "Chốt kiến trúc thanh toán quý 4"), không ngày giờ, không dấu ngoặc kép, không chung chung kiểu "Cuộc họp nhóm". Chưa rõ chủ đề thì để rỗng.
MERGE_RULE
- Không tạo section giả để lấp chỗ trống. Dùng mảng rỗng.

Chỉ trả về một JSON object, không markdown, đúng camelCase schema:
{"title":"string","tldr":"string","keyPoints":[{"id":"string","text":"string","evidenceIds":["segment-id"]}],"decisions":[],"tentativeDecisions":[],"unresolvedTopics":[{"id":"string","text":"string","topic":"string","options":["string"],"status":"No final decision","evidenceIds":["segment-id"]}],"actionItems":[{"id":"string","owner":null,"task":"string","deadline":null,"evidenceIds":["segment-id"]}],"openQuestions":[],"deferred":[{"id":"string","text":"string","target":null,"evidenceIds":["segment-id"]}]}"#;
    let system = system.replace("MERGE_RULE", merge_rule);
    let user = if incremental {
        format!("BẢN TÓM TẮT HIỆN CÓ:\n{previous}\n\nTRANSCRIPT MỚI CÓ ID:\n{transcript}")
    } else {
        format!("TRANSCRIPT CÓ ID:\n{transcript}")
    };
    let raw = ai_completion( &system, user, 1800, true).await?;
    let value = parse_json_object(&raw)?;
    let mut summary: MeetingSummary = serde_json::from_value(value).map_err(|error| format!("Summary không đúng schema: {error}"))?;
    map_evidence(&mut summary, &real_of);
    Ok(validate_summary_with(summary, &allowed))
}

/// Names the meeting from a transcript excerpt alone: a few output tokens, so the
/// save dialog does not wait for a full summary.
#[tauri::command]
async fn suggest_title(transcript: String) -> Result<String, String> {
    let transcript: String = transcript.chars().rev().take(6000).collect::<Vec<_>>().into_iter().rev().collect();
    if transcript.trim().is_empty() { return Ok(String::new()); }
    let raw = ai_completion(
        "Đặt tên cuộc họp tiếng Việt 3–8 từ nêu chủ đề chính và mục đích (ví dụ: Chốt kiến trúc thanh toán quý 4), dựa trên transcript. Không ngày giờ, không dấu ngoặc kép, không chung chung kiểu \"Cuộc họp nhóm\". Chỉ trả về tên.",
        format!("TRANSCRIPT:\n{transcript}"),
        40,
        false,
    ).await?;
    Ok(clean_title(raw.lines().next().unwrap_or_default()))
}

#[tauri::command]
async fn translate_text(text: String, source_language: String, previous_context: String) -> Result<String, String> {
    let source = match source_language.as_str() {
        "en" => "tiếng Anh",
        "zh" => "tiếng Trung giản thể",
        _ => return Err("Ngôn ngữ nguồn không hỗ trợ dịch".into()),
    };
    let context = if previous_context.trim().is_empty() {
        "Không có đoạn trước.".to_string()
    } else {
        format!("Đoạn ngay trước đó (chỉ dùng làm ngữ cảnh, không dịch lại):\n{previous_context}")
    };
    ai_completion(
        &format!("Bạn là biên tập viên bản ghi và phiên dịch viên từ {source} sang tiếng Việt. Đầu vào là một đoạn ghép từ nhiều kết quả ASR liên tiếp. Hãy dùng toàn bộ ngữ cảnh để sửa các lỗi nhận diện rõ ràng, nối lại câu bị ngắt, thêm dấu câu, rồi dịch cả đoạn sang tiếng Việt tự nhiên. Giữ nguyên tên riêng, số liệu và thuật ngữ chuyên môn. Không bịa nội dung. Chỉ trả về bản dịch tiếng Việt hoàn chỉnh của ĐOẠN CẦN DỊCH; không dịch lại ngữ cảnh và không giải thích."),
        format!("{context}\n\nĐOẠN CẦN DỊCH:\n{text}"),
        300,
        false,
    ).await
}

#[tauri::command]
fn open_permission(kind: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let section = if kind == "screen" { "Privacy_ScreenCapture" } else { "Privacy_Microphone" };
        Command::new("open").arg(format!("x-apple.systempreferences:com.apple.preference.security?{section}")).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        let page = if kind == "screen" { "ms-settings:sound" } else { "ms-settings:privacy-microphone" };
        hide_console(Command::new("cmd").args(["/C", "start", "", page])).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Chat answers may contain links; the webview cannot open `target="_blank"` itself.
#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:"))
        || url.len() > 2048 || url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"') {
        return Err("Link không hợp lệ".into());
    }
    #[cfg(target_os = "macos")]
    Command::new("open").arg(&url).spawn().map_err(|e| e.to_string())?;
    // rundll32 takes the URL as one argument, unlike `cmd /C start`, which would interpret `&`.
    #[cfg(target_os = "windows")]
    hide_console(Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url])).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Native Save dialog, starting in Downloads. The page only suggests the name, so it cannot
/// choose an arbitrary path to write to.
fn pick_save_path(app: &tauri::AppHandle, file_name: &str) -> Result<Option<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;
    let name: String = file_name.chars().map(|c| if matches!(c, '/' | '\\' | ':') || c.is_control() { ' ' } else { c }).collect();
    let extension = Path::new(&name).extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
    let mut dialog = app.dialog().file().set_file_name(name.trim());
    if !extension.is_empty() { dialog = dialog.add_filter(extension.to_uppercase(), &[extension.as_str()]); }
    if let Ok(dir) = app.path().download_dir() { dialog = dialog.set_directory(dir); }
    let Some(path) = dialog.blocking_save_file() else { return Ok(None) };
    path.into_path().map(Some).map_err(|e| e.to_string())
}

/// Saves an exported report (bytes from the page) where the user picks.
#[tauri::command]
async fn save_export(app: tauri::AppHandle, file_name: String, data: String) -> Result<Option<String>, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    let Some(path) = pick_save_path(&app, &file_name)? else { return Ok(None) };
    fs::write(&path, bytes).map_err(|e| format!("Không lưu được file: {e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Prints the page (its print stylesheet shows only the report) straight to a PDF file,
/// without the print panel, which needs a printer selected before "Save as PDF" is reachable.
#[cfg(target_os = "macos")]
#[tauri::command]
async fn save_pdf(app: tauri::AppHandle, webview: tauri::Webview, file_name: String) -> Result<Option<String>, String> {
    let Some(path) = pick_save_path(&app, &file_name)? else { return Ok(None) };
    // The user already confirmed replacing it; removing it lets us tell when the new file is complete.
    let _ = fs::remove_file(&path);
    let target = path.clone();
    webview.with_webview(move |platform| unsafe { print_to_pdf(platform.inner(), platform.ns_window(), &target) }).map_err(|e| e.to_string())?;
    // WebKit only renders printed pages from a modal run on the main loop, which reports back
    // through an Objective-C delegate. Waiting for the finished file is simpler.
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(150));
        if let Ok(bytes) = fs::read(&path) {
            if bytes.len() > 16 && bytes[bytes.len().saturating_sub(64)..].windows(5).any(|w| w == b"%%EOF") {
                return Ok(Some(path.to_string_lossy().into_owned()));
            }
        }
    }
    Err("Không tạo được file PDF".into())
}

#[cfg(target_os = "macos")]
unsafe fn print_to_pdf(webview: *mut std::ffi::c_void, window: *mut std::ffi::c_void, path: &Path) {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob, NSWindow};
    use objc2_foundation::{NSCopying, NSString, NSURL};
    use objc2_web_kit::WKWebView;
    let webview = &*(webview as *const WKWebView);
    let window = &*(window as *const NSWindow);
    let info = NSPrintInfo::sharedPrintInfo().copy();
    info.setJobDisposition(NSPrintSaveJob);
    // Page margins come from the report's `@page` rule.
    info.setTopMargin(0.0); info.setBottomMargin(0.0); info.setLeftMargin(0.0); info.setRightMargin(0.0);
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    let url: &AnyObject = &url;
    info.dictionary().insert(NSPrintJobSavingURL, url);
    let operation = webview.printOperationWithPrintInfo(&info);
    operation.setShowsPrintPanel(false);
    operation.setShowsProgressPanel(false);
    operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(window, None, None, std::ptr::null_mut());
}

/// Shows the file just exported in Finder / Explorer.
#[tauri::command]
fn reveal_file(path: String) -> Result<(), String> {
    if !Path::new(&path).is_file() { return Err("Không tìm thấy file".into()); }
    #[cfg(target_os = "macos")]
    Command::new("open").args(["-R", &path]).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    hide_console(Command::new("explorer").arg(format!("/select,{path}"))).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// WKWebView ignores `window.print()`, so printing (and "Save as PDF") goes through the native panel.
#[tauri::command]
fn print_page(webview: tauri::Webview) -> Result<(), String> {
    webview.print().map_err(|e| e.to_string())
}

/// The ad-hoc signature changes with every build, so after an update macOS keeps showing
/// the old microphone grant but feeds the new binary silence. Dropping the stale grant
/// makes the next capture ask again. Screen recording is left alone: it still works.
#[cfg(target_os = "macos")]
fn reset_microphone_after_update(app: &tauri::AppHandle) {
    if cfg!(debug_assertions) { return; }
    let Ok(dir) = app_data(app) else { return };
    let marker = dir.join("last-run-version");
    let version = app.package_info().version.to_string();
    if fs::read_to_string(&marker).ok().as_deref() == Some(version.as_str()) { return; }
    let _ = Command::new("tccutil").args(["reset", "Microphone", &app.config().identifier]).status();
    let _ = fs::create_dir_all(&dir).and_then(|_| fs::write(&marker, &version));
}

/// Spoken translations were dropped; free the ~870 MB ZeroTTS model earlier versions cached.
fn remove_retired_tts_model(app: &tauri::AppHandle) {
    let Ok(dir) = app_data(app) else { return };
    let model = dir.join("cache/huggingface/hub/models--zeroweight-ai--ZeroTTS");
    if model.exists() { std::thread::spawn(move || { let _ = fs::remove_dir_all(model); }); }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            remove_retired_tts_model(app.handle());
            #[cfg(target_os = "macos")]
            reset_microphone_after_update(app.handle());
            #[cfg(target_os = "macos")]
            island::create(app.handle())?;
            Ok(())
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(island::shortcut_plugin())
        .manage(NativeState::default())
        .invoke_handler(tauri::generate_handler![load_notes, save_notes, account::account_status, account::account_signed_in, account::account_send_code, account::account_offers, account::account_buy, account::account_order_status, account_verify, account_sign_out, start_worker, stop_worker, send_worker, start_capture, stop_capture, set_microphone, set_system_audio, note_chat::ask_note, summarize_segments, suggest_title, translate_text, open_permission, open_link, save_export, reveal_file, print_page, #[cfg(target_os = "macos")] save_pdf, file_job::pick_audio_file, file_job::file_job_start, file_job::file_job_upload, file_job::file_job_status, file_job::file_job_cleanup, file_job::file_job_cancel, writer::write_document, diarization_model_status, download_diarization_model, cancel_diarization_download, remove_diarization_model, island::island_screens, island::island_set_frame, island::island_set_visible, island::island_focus, island::island_release, island::island_open_main, island::island_cursor, island::island_ignore_cursor, playback::play_audio, playback::stop_audio, voice_pack_status, download_voice_pack, cancel_voice_pack_download, remove_voice_pack])
        .on_window_event(|window, event| {
            // Closing the main window quits VietNote; the island goes with it.
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(island) = window.app_handle().get_webview_window(island::LABEL) { let _ = island.destroy(); }
                let state = window.app_handle().state::<NativeState>();
                if let Ok(mut system) = state.system.lock() { *system = None; }
                if let Ok(mut microphone) = state.microphone.lock() { *microphone = None; }
                if let Ok(mut tx) = state.capture_tx.lock() { *tx = None; }
                if let Ok(mut writer) = state.writer.lock() { *writer = None; }
                if let Ok(mut child) = state.child.lock() {
                    if let Some(mut process) = child.take() { let _ = process.kill(); let _ = process.wait(); }
                };
            }
        })
        .run(tauri::generate_context!())
        .expect("VietNote failed to launch");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(id: &str) -> TranscriptSegment {
        TranscriptSegment { id: id.into(), timestamp: "09:00".into(), started_at: 0.0, audio_source: "system".into(), raw_text: "raw".into(), clean_text: "clean".into(), speaker: None }
    }

    #[test]
    fn validation_rejects_unsupported_important_items() {
        let summary = MeetingSummary {
            decisions: vec![
                SummaryBullet { id: "valid".into(), text: "Use FastAPI".into(), evidence_ids: vec!["s1".into()] },
                SummaryBullet { id: "invented".into(), text: "Use Qdrant".into(), evidence_ids: vec!["missing".into()] },
            ],
            action_items: vec![ActionItem { id: "a1".into(), owner: Some("Minh".into()), task: "Test both".into(), deadline: None, evidence_ids: vec!["s2".into()] }],
            ..MeetingSummary::default()
        };
        let validated = validate_summary(summary, &[segment("s1"), segment("s2")]);
        assert_eq!(validated.decisions.len(), 1);
        assert_eq!(validated.decisions[0].text, "Use FastAPI");
        assert_eq!(validated.action_items[0].deadline, None);
    }

    #[test]
    fn unresolved_status_is_always_conservative() {
        let summary = MeetingSummary {
            unresolved_topics: vec![UnresolvedTopic { id: "u1".into(), text: String::new(), topic: "Vector database".into(), options: vec!["Qdrant".into(), "Chroma".into()], status: "Use Qdrant".into(), evidence_ids: vec!["s1".into()] }],
            ..MeetingSummary::default()
        };
        let validated = validate_summary(summary, &[segment("s1")]);
        assert_eq!(validated.unresolved_topics[0].status, "No final decision");
    }

    #[test]
    fn incremental_merge_keeps_prior_evidence_and_drops_unknown_aliases() {
        let mut summary = MeetingSummary {
            decisions: vec![SummaryBullet { id: "d1".into(), text: "Use FastAPI".into(), evidence_ids: vec!["s1".into(), "s9".into()] }],
            ..MeetingSummary::default()
        };
        let real_of = HashMap::from([("s1".to_string(), "old-uuid".to_string())]);
        map_evidence(&mut summary, &real_of);
        let allowed = HashSet::from(["old-uuid".to_string(), "new-uuid".to_string()]);
        let validated = validate_summary_with(summary, &allowed);
        assert_eq!(validated.decisions[0].evidence_ids, vec!["old-uuid".to_string()]);
        let compact = compact_json(serde_json::to_value(&validated).unwrap());
        assert!(compact.get("actionItems").is_none());
        assert!(compact.get("decisions").is_some());
    }

    #[test]
    fn meeting_title_is_trimmed_and_unquoted() {
        assert_eq!(clean_title("  \"Chốt   kiến trúc thanh toán\".  "), "Chốt kiến trúc thanh toán");
        assert_eq!(clean_title(&"a".repeat(200)).len(), 80);
    }
}
