use base64::Engine;
use clipclip::{start_with_tap, Config, Recording, Source};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

const GROQ_CHAT_API: &str = "https://api.groq.com/openai/v1";
const GROQ_GPT_OSS_120B: &str = "openai/gpt-oss-120b";
const DEFAULT_TTS_VOICE: &str = "thuc-day-di";

#[derive(Default)]
struct NativeState {
    child: Mutex<Option<Child>>,
    writer: Arc<Mutex<Option<TcpStream>>>,
    captures: Mutex<Vec<Recording>>,
    pending_audio: Arc<AtomicUsize>,
    worker_epoch: Arc<AtomicUsize>,
}

const AI_KEY_SERVICE: &str = "local.vietnote.desktop";
const GROQ_KEY_ACCOUNT: &str = "groq-asr-api-key";
const NINE_ROUTER_KEY_ACCOUNT: &str = "9router-api-key";
const ACCESS_KEY_ACCOUNT: &str = "vietnote-access-key";

fn normalize_ai_provider(provider: &str) -> Result<&'static str, String> {
    match provider.trim().to_lowercase().as_str() {
        "local" | "nine_router" => Ok("nine_router"),
        "groq" => Ok("groq"),
        _ => Err("Nhà cung cấp AI không hợp lệ".into()),
    }
}

fn provider_key_entry(provider: &str) -> Result<keyring::Entry, String> {
    let account = match normalize_ai_provider(provider)? {
        "groq" => GROQ_KEY_ACCOUNT,
        "nine_router" => NINE_ROUTER_KEY_ACCOUNT,
        _ => unreachable!(),
    };
    keyring::Entry::new(AI_KEY_SERVICE, account)
        .map_err(|_| "Không truy cập được kho mật khẩu hệ thống".to_string())
}

fn stored_provider_key(provider: &str) -> Result<Option<String>, String> {
    match provider_key_entry(provider)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Không đọc được API key từ kho mật khẩu hệ thống".into()),
    }
}

fn provider_env_key(provider: &str) -> Option<String> {
    let name = if normalize_ai_provider(provider).ok()? == "groq" { "GROQ_API_KEY" } else { "NINE_ROUTER_API_KEY" };
    std::env::var(name).ok().filter(|key| !key.trim().is_empty())
}

fn built_in_groq_key() -> Option<String> {
    option_env!("VIETNOTE_BUILTIN_GROQ_API_KEY")
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
}

fn resolved_provider_key(provider: &str) -> Option<String> {
    stored_provider_key(provider).ok().flatten()
        .or_else(|| provider_env_key(provider))
        .or_else(|| (provider == "groq").then(built_in_groq_key).flatten())
}

fn stored_groq_key() -> Option<String> { resolved_provider_key("groq") }

#[tauri::command]
fn ai_key_status(provider: String) -> Result<String, String> {
    let provider = normalize_ai_provider(&provider)?;
    if stored_provider_key(provider)?.is_some() { return Ok("saved".into()); }
    if provider_env_key(provider).is_some() { return Ok("environment".into()); }
    if provider == "groq" && built_in_groq_key().is_some() { return Ok("environment".into()); }
    Ok("none".into())
}

fn access_key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(AI_KEY_SERVICE, ACCESS_KEY_ACCOUNT)
        .map_err(|_| "Không truy cập được kho mật khẩu hệ thống".to_string())
}

#[tauri::command]
fn access_key_status() -> Result<bool, String> {
    match access_key_entry()?.get_password() {
        Ok(value) => Ok(!value.trim().is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => Err("Không đọc được key VietNote từ kho mật khẩu hệ thống".into()),
    }
}

#[tauri::command]
fn set_access_key(access_key: String) -> Result<bool, String> {
    let key = access_key.trim();
    if key.is_empty() { return Err("Vui lòng nhập key".into()); }
    if key.chars().any(char::is_whitespace) { return Err("Key không được chứa khoảng trắng".into()); }
    access_key_entry()?.set_password(key)
        .map_err(|_| "Không lưu được key vào kho mật khẩu hệ thống")?;
    Ok(true)
}

#[tauri::command]
fn set_ai_api_key(app: tauri::AppHandle, state: tauri::State<'_, NativeState>, provider: String, api_key: Option<String>) -> Result<String, String> {
    if !state.captures.lock().map_err(|e| e.to_string())?.is_empty() {
        return Err("Hãy dừng ghi âm trước khi đổi API key".into());
    }
    let provider = normalize_ai_provider(&provider)?;
    let key = api_key.unwrap_or_default().trim().to_string();
    if !key.is_empty() && key.chars().any(char::is_whitespace) {
        return Err("API key không được chứa khoảng trắng".into());
    }
    if provider == "groq" && !key.is_empty() && !key.starts_with("gsk_") {
        return Err("Groq API key không đúng định dạng (bắt đầu bằng gsk_)".into());
    }
    let entry = provider_key_entry(provider)?;
    if key.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => (),
            Err(_) => return Err("Không xóa được API key khỏi kho mật khẩu hệ thống".into()),
        }
    } else {
        entry.set_password(&key).map_err(|_| "Không lưu được API key vào kho mật khẩu hệ thống")?;
    }
    if provider == "groq" {
        stop_worker(state.clone())?;
        start_worker(app, state)?;
    }
    ai_key_status(provider.into())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredNotes { notes: Vec<Value>, groups: Vec<Value> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SummaryAiConfig {
    api_url: String,
    model: String,
    #[serde(default = "default_summary_provider")]
    provider: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TtsVoiceOption {
    id: String,
    display_name: String,
    description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TtsVoiceConfig {
    selected_id: String,
    voices: Vec<TtsVoiceOption>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTtsVoice { selected_id: String }

fn tts_voice_definitions() -> [(&'static str, &'static str, &'static str, &'static str); 2] {
    [
        ("thuc-day-di", "Giọng Nam", "Trung niên", "thuc-day-di.zip"),
        ("ngoc-huyen", "Giọng Nữ", "Kể truyện · review phim", "Ngoc-Huyen-7owuK1LaOPOaQjeSzmQ4.zip"),
    ]
}

fn selected_tts_voice_id(app: &tauri::AppHandle) -> Result<String, String> {
    let path = app_data(app)?.join("tts-voice.json");
    let selected = fs::read(path).ok()
        .and_then(|data| serde_json::from_slice::<StoredTtsVoice>(&data).ok())
        .map(|settings| settings.selected_id)
        .unwrap_or_else(|| DEFAULT_TTS_VOICE.into());
    Ok(tts_voice_definitions().iter().find(|voice| voice.0 == selected).map(|voice| voice.0).unwrap_or(DEFAULT_TTS_VOICE).into())
}

fn tts_voice_config(app: &tauri::AppHandle) -> Result<TtsVoiceConfig, String> {
    Ok(TtsVoiceConfig {
        selected_id: selected_tts_voice_id(app)?,
        voices: tts_voice_definitions().iter().map(|voice| TtsVoiceOption {
            id: voice.0.into(), display_name: voice.1.into(), description: voice.2.into(),
        }).collect(),
    })
}

#[tauri::command]
fn get_tts_voice_config(app: tauri::AppHandle) -> Result<TtsVoiceConfig, String> { tts_voice_config(&app) }

#[tauri::command]
fn set_tts_voice(app: tauri::AppHandle, state: tauri::State<'_, NativeState>, voice_id: String) -> Result<TtsVoiceConfig, String> {
    if !state.captures.lock().map_err(|e| e.to_string())?.is_empty() {
        return Err("Hãy dừng ghi âm trước khi đổi giọng đọc".into());
    }
    let definition = tts_voice_definitions().into_iter().find(|voice| voice.0 == voice_id)
        .ok_or("Giọng đọc không hợp lệ")?;
    let root = project_root(&app)?;
    if !root.join("voices").join(definition.3).exists() {
        return Err(format!("Không tìm thấy gói giọng {}", definition.1));
    }
    let dir = app_data(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(
        dir.join("tts-voice.json"),
        serde_json::to_vec(&json!({ "selectedId": definition.0 })).map_err(|e| e.to_string())?,
    ).map_err(|e| e.to_string())?;
    stop_worker(state.clone())?;
    start_worker(app.clone(), state)?;
    tts_voice_config(&app)
}

fn default_summary_provider() -> String { "groq".into() }

impl Default for SummaryAiConfig {
    fn default() -> Self { Self { api_url: GROQ_CHAT_API.into(), model: GROQ_GPT_OSS_120B.into(), provider: default_summary_provider() } }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptSegment {
    id: String,
    timestamp: String,
    started_at: f64,
    audio_source: String,
    raw_text: String,
    clean_text: String,
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

fn summary_ai_config(app: &tauri::AppHandle) -> Result<SummaryAiConfig, String> {
    let path = app_data(app)?.join("summary-ai.json");
    let mut config: SummaryAiConfig = fs::read(path).ok().and_then(|data| serde_json::from_slice(&data).ok()).unwrap_or_default();
    if config.provider == "local" { config.provider = "nine_router".into(); }
    Ok(config)
}

#[tauri::command]
fn get_summary_ai_config(app: tauri::AppHandle) -> Result<SummaryAiConfig, String> { summary_ai_config(&app) }

#[tauri::command]
fn set_summary_ai_config(app: tauri::AppHandle, config: SummaryAiConfig) -> Result<SummaryAiConfig, String> {
    let provider = normalize_ai_provider(&config.provider)?.to_string();
    let model = config.model.trim().to_string();
    if model.is_empty() { return Err("Tên model không được trống".into()); }
    let api_url = match provider.as_str() {
        "nine_router" => {
            let url = config.api_url.trim().trim_end_matches('/').to_string();
            if !(url.starts_with("http://") || url.starts_with("https://")) { return Err("API phải bắt đầu bằng http:// hoặc https://".into()); }
            url
        }
        "groq" => {
            if model != GROQ_GPT_OSS_120B { return Err("Hiện Groq chỉ được cấu hình sẵn cho openai/gpt-oss-120b".into()); }
            GROQ_CHAT_API.into()
        }
        _ => unreachable!(),
    };
    let next = SummaryAiConfig { api_url, model, provider };
    let dir = app_data(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("summary-ai.json"), serde_json::to_vec(&next).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(next)
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
    if packaged.exists() { return Ok((packaged, true)); }
    let bundled = if cfg!(windows) { root.join(".venv/Scripts/python.exe") } else { root.join(".venv/bin/python") };
    if bundled.exists() { return Ok((bundled, false)); }
    if let Some(path) = std::env::var_os("VIETNOTE_PYTHON") {
        let path = PathBuf::from(path);
        if path.exists() { return Ok((path, false)); }
    }
    Err("Thiếu bộ xử lý âm thanh đi kèm ứng dụng".into())
}

#[tauri::command]
fn start_worker(app: tauri::AppHandle, state: tauri::State<'_, NativeState>) -> Result<(), String> {
    let mut slot = state.child.lock().map_err(|e| e.to_string())?;
    if slot.as_mut().is_some_and(|child| child.try_wait().ok().flatten().is_none()) { return Ok(()); }
    let root = project_root(&app)?;
    let (worker, packaged_worker) = worker_executable(&root)?;
    let selected_voice = selected_tts_voice_id(&app)?;
    let voice_file = tts_voice_definitions().into_iter().find(|voice| voice.0 == selected_voice)
        .map(|voice| voice.3).unwrap_or("thuc-day-di.zip");
    // A locked/unavailable OS credential store must not prevent offline ASR.
    let groq_key = stored_groq_key();
    let token = format!("{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
    let logs = app_data(&app)?.join("logs");
    fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    // Preserve earlier sessions when the worker restarts; otherwise the only
    // evidence for intermittent ASR repetition disappears on every launch.
    let mut logfile = fs::OpenOptions::new().create(true).append(true)
        .open(logs.join("worker.log")).map_err(|e| e.to_string())?;
    writeln!(logfile, "\n[WORKER START] {} · voice={selected_voice}", chrono::Local::now())
        .map_err(|e| e.to_string())?;
    let stderr_log = logfile.try_clone().map_err(|e| e.to_string())?;
    let cache = if root.join(".venv").exists() { root.join(".cache/huggingface") } else { app_data(&app)?.join("cache/huggingface") };
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let mut command = Command::new(worker);
    if !packaged_worker { command.args(["-u", "asr/server.py"]); }
    command.current_dir(&root)
        .env("ASR_TOKEN", &token)
        .env("HF_HOME", cache)
        .env("TTS_VOICE_PATH", root.join("voices").join(voice_file))
        .stdout(Stdio::piped()).stderr(Stdio::from(stderr_log));
    if let Some(key) = groq_key.filter(|key| !key.trim().is_empty()) {
        command.env("GROQ_API_KEY", key);
    } else {
        command.env_remove("GROQ_API_KEY");
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("Không đọc được ASR stdout")?;
    *slot = Some(child);
    drop(slot);
    let writer = state.writer.clone();
    let epoch_counter = state.worker_epoch.clone();
    let epoch = epoch_counter.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        if epoch_counter.load(Ordering::SeqCst) == epoch { let _ = app.emit("worker-status", "Loading services…"); }
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            // Python writes ASR/TTS diagnostics to stdout; retain them alongside
            // stderr so a future repeated segment can be traced to its source.
            let _ = writeln!(logfile, "{line}");
            if epoch_counter.load(Ordering::SeqCst) != epoch { break; }
            let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
            if event.get("type").and_then(Value::as_str) != Some("ready") { continue; }
            let Some(port) = event.get("port").and_then(Value::as_u64) else { continue };
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
                                if let Ok(message) = serde_json::from_str::<Value>(&line) { let _ = app.emit("worker-message", message); }
                            }
                            if epoch_counter.load(Ordering::SeqCst) == epoch {
                                if let Ok(mut slot) = writer.lock() { *slot = None; }
                                let _ = app.emit("worker-status", "Service connection closed");
                            }
                        }
                        Err(_) => { let _ = app.emit("worker-status", "Service connection failed"); }
                    }
                }
                Err(_) => { let _ = app.emit("worker-status", "Service connection failed"); }
            }
            break;
        }
    });
    Ok(())
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
    state.captures.lock().map_err(|e| e.to_string())?.clear();
    *state.writer.lock().map_err(|e| e.to_string())? = None;
    if let Some(mut child) = state.child.lock().map_err(|e| e.to_string())?.take() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            child.kill().map_err(|e| e.to_string())?;
        }
        let _ = child.wait();
    }
    Ok(())
}

fn start_source(source: Source, label: &'static str, tx: mpsc::SyncSender<(String, Vec<f32>, f64)>) -> Result<Recording, String> {
    let config = Config { source, sample_rate: 16_000, segment: Duration::from_secs(30), ..Config::default() };
    start_with_tap(config, |_| {}, Box::new(move |frames| {
        let captured = frames.captured_at.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64();
        let _ = tx.try_send((label.to_string(), frames.samples.to_vec(), captured));
    })).map_err(|e| e.to_string())
}

#[tauri::command]
fn start_capture(state: tauri::State<'_, NativeState>, source: String) -> Result<(), String> {
    let mut captures = state.captures.lock().map_err(|e| e.to_string())?;
    if !captures.is_empty() { return Err("Đang ghi âm".into()); }
    let (tx, rx) = mpsc::sync_channel::<(String, Vec<f32>, f64)>(25);
    let writer = state.writer.clone();
    let pending = state.pending_audio.clone();
    let mut next = Vec::new();
    if source == "microphone" || source == "both" { next.push(start_source(Source::Mic, "microphone", tx.clone())?); }
    if source == "system" || source == "both" {
        match start_source(Source::System, "system", tx.clone()) {
            Ok(recording) => next.push(recording),
            Err(error) => { drop(next); return Err(error); }
        }
    }
    if next.is_empty() { return Err("Nguồn âm thanh không hợp lệ".into()); }
    *captures = next;
    drop(captures);
    std::thread::spawn(move || {
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
    Ok(())
}

#[tauri::command]
fn stop_capture(state: tauri::State<'_, NativeState>) -> Result<(), String> {
    state.captures.lock().map_err(|e| e.to_string())?.clear();
    Ok(())
}

async fn ai_completion(app: &tauri::AppHandle, system: &str, user: String, max_tokens: u32) -> Result<String, String> {
    let config = summary_ai_config(app)?;
    let endpoint = if config.api_url.ends_with("/chat/completions") { config.api_url } else { format!("{}/chat/completions", config.api_url) };
    let is_groq = config.provider == "groq";
    let body = if is_groq {
        // GPT-OSS spends completion tokens on reasoning before producing content. Low effort plus
        // a larger cap prevents short translations from ending with an empty content field.
        json!({
            "model": config.model,
            "messages": [{"role":"user","content":format!("{system}\n\n{user}")}],
            "max_completion_tokens": max_tokens.saturating_mul(2).max(1024),
            "reasoning_effort": "low",
            "include_reasoning": false
        })
    } else {
        json!({"model":config.model, "messages":[{"role":"system","content":system},{"role":"user","content":user}], "max_tokens":max_tokens})
    };
    let client = reqwest::Client::builder().timeout(Duration::from_secs(90)).build().map_err(|e| e.to_string())?;
    let request = client.post(endpoint).json(&body);
    let response = if is_groq {
        let key = resolved_provider_key("groq")
            .filter(|key| !key.trim().is_empty())
            .ok_or("Dịch vụ xử lý tạm thời chưa sẵn sàng.")?;
        request.bearer_auth(key).send().await.map_err(|_| "Không kết nối được dịch vụ xử lý".to_string())?
    } else {
        let request = match stored_provider_key("nine_router").ok().flatten().or_else(|| provider_env_key("nine_router")) {
            Some(key) => request.bearer_auth(key),
            None => request,
        };
        request.send().await.map_err(|e| format!("Không gọi được 9Router: {e}"))?
    };
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("Dịch vụ xử lý tạm thời không khả dụng (HTTP {status})"));
    }
    let data: Value = response.json().await.map_err(|e| e.to_string())?;
    data.pointer("/choices/0/message/content").and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty()).map(str::to_string)
        .ok_or_else(|| {
            let finish = data.pointer("/choices/0/finish_reason").and_then(Value::as_str).unwrap_or("không rõ");
            format!("Model không trả về nội dung (finish_reason: {finish})")
        })
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

fn validate_summary(mut summary: MeetingSummary, segments: &[TranscriptSegment]) -> MeetingSummary {
    let allowed: HashSet<String> = segments.iter().map(|segment| segment.id.clone()).collect();
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
async fn summarize_segments(app: tauri::AppHandle, segments: Vec<TranscriptSegment>, previous_summary: Option<MeetingSummary>) -> Result<MeetingSummary, String> {
    if segments.is_empty() { return Ok(previous_summary.unwrap_or_default()); }
    let transcript = segments.iter().map(|segment| format!(
        "[{}] [{}] [{}] {}", segment.id, segment.timestamp, segment.audio_source, segment.clean_text
    )).collect::<Vec<_>>().join("\n");
    let previous = previous_summary.as_ref()
        .map(|summary| serde_json::to_string(summary).unwrap_or_default())
        .unwrap_or_else(|| "null".into());
    let system = r#"Bạn là thư ký cuộc họp AI/Tech cực kỳ thận trọng. Tạo meeting note ngắn, dễ scan và có thể kiểm chứng.

QUY TẮC BẮT BUỘC:
- Chỉ tạo decision khi transcript có lời chốt/đồng ý rõ ràng. Một người nêu preference không phải consensus.
- Nếu nhiều option được bàn mà chưa chốt, đưa vào unresolvedTopics với status chính xác là "No final decision".
- Preference chưa commit phải nằm ở tentativeDecisions, không phải decisions.
- Không phát minh decision, action item, owner, deadline, blocker, next step hoặc conclusion.
- Action item chỉ có owner/deadline khi transcript nói rõ. Dùng null khi thiếu.
- Preserve uncertainty. Khi phân vân, dùng unresolved thay vì đoán.
- Mỗi decision, tentative decision, unresolved topic, action item và deferred item phải có evidenceIds lấy nguyên văn từ ID trong dấu [] ở transcript.
- Không dùng nhãn microphone/system làm tên người. Chỉ ghi owner khi tên người xuất hiện rõ trong lời nói.
- Previous summary chỉ là bản nháp để hợp nhất và có thể sai; transcript mới cùng evidence mới là nguồn sự thật.
- Không tạo section giả để lấp chỗ trống. Dùng mảng rỗng.

Chỉ trả về một JSON object, không markdown, đúng camelCase schema:
{"tldr":"string","keyPoints":[{"id":"string","text":"string","evidenceIds":["segment-id"]}],"decisions":[],"tentativeDecisions":[],"unresolvedTopics":[{"id":"string","text":"string","topic":"string","options":["string"],"status":"No final decision","evidenceIds":["segment-id"]}],"actionItems":[{"id":"string","owner":null,"task":"string","deadline":null,"evidenceIds":["segment-id"]}],"openQuestions":[],"deferred":[{"id":"string","text":"string","target":null,"evidenceIds":["segment-id"]}]}"#;
    let user = format!("BẢN NHÁP TRƯỚC (có thể null):\n{previous}\n\nTRANSCRIPT CÓ ID:\n{transcript}");
    let raw = ai_completion(&app, system, user, 1800).await?;
    let value = parse_json_object(&raw)?;
    let summary: MeetingSummary = serde_json::from_value(value).map_err(|error| format!("Summary không đúng schema: {error}"))?;
    Ok(validate_summary(summary, &segments))
}

#[tauri::command]
async fn translate_text(app: tauri::AppHandle, text: String, source_language: String, previous_context: String) -> Result<String, String> {
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
    ai_completion(&app,
        &format!("Bạn là biên tập viên bản ghi và phiên dịch viên từ {source} sang tiếng Việt. Đầu vào là một đoạn ghép từ nhiều kết quả ASR liên tiếp. Hãy dùng toàn bộ ngữ cảnh để sửa các lỗi nhận diện rõ ràng, nối lại câu bị ngắt, thêm dấu câu, rồi dịch cả đoạn sang tiếng Việt tự nhiên. Giữ nguyên tên riêng, số liệu và thuật ngữ chuyên môn. Không bịa nội dung. Chỉ trả về bản dịch tiếng Việt hoàn chỉnh của ĐOẠN CẦN DỊCH; không dịch lại ngữ cảnh và không giải thích."),
        format!("{context}\n\nĐOẠN CẦN DỊCH:\n{text}"),
        300,
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
        Command::new("cmd").args(["/C", "start", "", page]).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(NativeState::default())
        .invoke_handler(tauri::generate_handler![load_notes, save_notes, get_summary_ai_config, set_summary_ai_config, get_tts_voice_config, set_tts_voice, ai_key_status, set_ai_api_key, access_key_status, set_access_key, start_worker, stop_worker, send_worker, start_capture, stop_capture, summarize_segments, translate_text, open_permission])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.app_handle().state::<NativeState>();
                if let Ok(mut captures) = state.captures.lock() { captures.clear(); }
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
        TranscriptSegment { id: id.into(), timestamp: "09:00".into(), started_at: 0.0, audio_source: "system".into(), raw_text: "raw".into(), clean_text: "clean".into() }
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
}
