//! VietNote account: Supabase email-code sign-in and credit-metered Soniox keys.
//! The long-lived Soniox key lives only in the `soniox-key` Edge Function; the
//! app holds a Supabase session and trades it for single-use temporary keys.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SERVICE: &str = "local.vietnote.desktop";
const SESSION_ACCOUNT: &str = "vietnote-session";

#[derive(Serialize, Deserialize)]
struct Session {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    email: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    configured: bool,
    email: Option<String>,
    balance_seconds: Option<i64>,
}

// Public by design (row-level security guards the data); env vars override them.
const SUPABASE_URL: &str = "https://pyknksfyqlsfqodcsawm.supabase.co";
const SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5a25rc2Z5cWxzZnFvZGNzYXdtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3MzI4OTcsImV4cCI6MjEwNjMwODg5N30.kTs7eHTXO6YLt3D2BdM-utJoTv_NNSN4IW9piZUET0c";

fn setting(name: &str, default: &str) -> Option<String> {
    let value = std::env::var(name).ok().filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default.to_string());
    Some(value.trim().trim_end_matches('/').to_string()).filter(|value| !value.is_empty())
}

fn config() -> Option<(String, String)> {
    Some((setting("VIETNOTE_SUPABASE_URL", SUPABASE_URL)?, setting("VIETNOTE_SUPABASE_ANON_KEY", SUPABASE_ANON_KEY)?))
}

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, SESSION_ACCOUNT).map_err(|_| "Không truy cập được kho mật khẩu hệ thống".to_string())
}

fn load_session() -> Option<Session> {
    serde_json::from_str(&entry().ok()?.get_password().ok()?).ok()
}

fn save_session(session: &Session) -> Result<(), String> {
    let text = serde_json::to_string(session).map_err(|e| e.to_string())?;
    entry()?.set_password(&text).map_err(|_| "Không lưu được phiên đăng nhập".into())
}

fn clear_session() {
    if let Ok(entry) = entry() { let _ = entry.delete_credential(); }
}

/// The worker uses VietNote credit when the user is signed in and has no own Soniox key.
pub fn signed_in() -> bool { config().is_some() && load_session().is_some() }

/// "Can't reach VietNote" plus the innermost cause (TLS, DNS, proxy), so a user's screenshot says why.
fn unreachable(error: reqwest::Error) -> String {
    let mut cause: &dyn std::error::Error = &error;
    while let Some(inner) = cause.source() { cause = inner; }
    format!("Không kết nối được máy chủ VietNote ({cause})")
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())
}

async fn auth_post(path: &str, body: Value) -> Result<Value, String> {
    let (url, anon) = config().ok_or("Bản build chưa cấu hình máy chủ VietNote")?;
    let response = client()?.post(format!("{url}/auth/v1/{path}")).header("apikey", anon)
        .json(&body).send().await.map_err(unreachable)?;
    let status = response.status();
    let value: Value = response.json().await.unwrap_or(Value::Null);
    if status.is_success() { return Ok(value); }
    let message = value.get("msg").or_else(|| value.get("error_description")).or_else(|| value.get("message"))
        .and_then(Value::as_str).unwrap_or("");
    Err(if status.as_u16() == 429 { "Bạn thao tác quá nhanh, hãy thử lại sau ít phút".into() }
        else if path.starts_with("verify") { "Mã xác nhận không đúng hoặc đã hết hạn".into() }
        else { format!("Máy chủ từ chối yêu cầu (HTTP {status}) {message}").trim().to_string() })
}

fn session_from(value: &Value, fallback_email: &str) -> Result<Session, String> {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    let expires_in = value.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);
    Ok(Session {
        access_token: text("access_token").ok_or("Máy chủ không trả về phiên đăng nhập")?,
        refresh_token: text("refresh_token").ok_or("Máy chủ không trả về phiên đăng nhập")?,
        expires_at: value.get("expires_at").and_then(Value::as_u64).unwrap_or(now() + expires_in),
        email: value.pointer("/user/email").and_then(Value::as_str).unwrap_or(fallback_email).to_string(),
    })
}

/// A fresh access token, refreshing (once, even when both streams ask) when near expiry.
async fn access_token() -> Result<String, String> {
    static REFRESH: OnceLock<tauri::async_runtime::Mutex<()>> = OnceLock::new();
    let _guard = REFRESH.get_or_init(Default::default).lock().await;
    let session = load_session().ok_or("signed_out")?;
    if session.expires_at > now() + 60 { return Ok(session.access_token); }
    match auth_post("token?grant_type=refresh_token", json!({"refresh_token": session.refresh_token})).await {
        Ok(value) => {
            let fresh = session_from(&value, &session.email)?;
            save_session(&fresh)?;
            Ok(fresh.access_token)
        }
        // Only an explicit rejection signs out; a network error keeps the session.
        Err(error) if error.starts_with("Máy chủ từ chối") => { clear_session(); Err("signed_out".into()) }
        Err(error) => Err(error),
    }
}

/// Calls the `soniox-key` Edge Function; errors are short machine codes.
async fn credit_call(body: Value) -> Result<Value, String> { function_call("soniox-key", body).await }

/// Calls a signed-in Edge Function; errors are short machine codes.
async fn function_call(name: &str, body: Value) -> Result<Value, String> {
    let (url, anon) = config().ok_or("not_configured")?;
    let token = access_token().await?;
    let response = client()?.post(format!("{url}/functions/v1/{name}"))
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

/// Reply for the worker's `soniox_key_request`.
pub async fn soniox_grant(source: &str) -> Value {
    match credit_call(json!({"action": "grant", "source": source})).await {
        Ok(value) => json!({
            "api_key": value.get("api_key"), "grant_id": value.get("grant_id"),
            "seconds": value.get("seconds"), "balance_seconds": value.get("balance_seconds"),
        }),
        Err(error) => json!({"error": error}),
    }
}

/// Chat completion through the `ai-complete` Edge Function; the model and the
/// provider key are fixed on the server.
pub struct AiCompletion {
    pub content: String,
    pub finish_reason: Option<String>,
}

pub async fn ai_complete(system: &str, user: String, max_tokens: u32, json: bool) -> Result<String, String> {
    ai_complete_with_metadata(system, user, max_tokens, json).await.map(|result| result.content)
}

pub async fn ai_complete_with_metadata(system: &str, user: String, max_tokens: u32, json: bool) -> Result<AiCompletion, String> {
    const SIGN_IN: &str = "Hãy đăng nhập tài khoản VietNote ở góc trái dưới";
    let (url, anon) = config().ok_or("Bản build chưa cấu hình máy chủ VietNote")?;
    let token = access_token().await.map_err(|error| if error == "signed_out" { SIGN_IN.to_string() } else { error })?;
    let response = client()?.post(format!("{url}/functions/v1/ai-complete"))
        .timeout(Duration::from_secs(90))
        .header("apikey", anon).bearer_auth(token)
        .json(&json!({"system": system, "user": user, "max_tokens": max_tokens, "json": json}))
        .send().await.map_err(unreachable)?;
    let status = response.status().as_u16();
    let value: Value = response.json().await.unwrap_or(Value::Null);
    match status {
        200..=299 => completion_from(&value),
        401 => Err(SIGN_IN.into()),
        402 => Err("Đã hết phút sử dụng".into()),
        429 => Err("Đang xử lý quá nhiều yêu cầu, hãy thử lại sau ít phút".into()),
        _ => Err(format!("Dịch vụ xử lý tạm thời không khả dụng (HTTP {status})")),
    }
}

/// Stream real provider output from the authenticated proxy to a per-request Tauri channel.
pub async fn ai_complete_stream<F>(system: &str, user: String, max_tokens: u32, progress: F) -> Result<AiCompletion, String>
where F: FnMut(&str) {
    let (url, anon) = config().ok_or("Bản build chưa cấu hình máy chủ VietNote")?;
    let token = access_token().await.map_err(|error| if error == "signed_out" { "Hãy đăng nhập tài khoản VietNote ở góc trái dưới".into() } else { error })?;
    let response = client()?.post(format!("{url}/functions/v1/ai-complete"))
        .timeout(Duration::from_secs(90))
        .header("apikey", anon).bearer_auth(token)
        .json(&json!({"system": system, "user": user, "max_tokens": max_tokens, "json": false, "stream": true}))
        .send().await.map_err(unreachable)?;
    match response.status().as_u16() {
        200..=299 => {},
        401 => return Err("Hãy đăng nhập tài khoản VietNote ở góc trái dưới".into()),
        402 => return Err("Đã hết phút sử dụng".into()),
        429 => return Err("Đang xử lý quá nhiều yêu cầu, hãy thử lại sau ít phút".into()),
        status => return Err(format!("Dịch vụ xử lý tạm thời không khả dụng (HTTP {status})")),
    }
    if !response.headers().get("content-type").and_then(|header| header.to_str().ok()).unwrap_or_default().starts_with("text/event-stream") {
        return Err("Máy chủ chưa hỗ trợ streaming. Cần cập nhật dịch vụ AI.".into());
    }
    consume_ai_stream(response, progress).await
}

async fn consume_ai_stream<F>(mut response: reqwest::Response, mut progress: F) -> Result<AiCompletion, String>
where F: FnMut(&str) {
    let mut decoder = crate::ai_stream::SseDecoder::default();
    let mut answer = crate::ai_stream::StreamAnswer::default();
    let mut error = None;
    'read: loop {
        match response.chunk().await {
            Ok(Some(bytes)) => match decoder.push(&bytes) {
                Ok(events) => for event in events {
                    match answer.accept(&event) {
                        Ok(true) => progress(&answer.content),
                        Ok(false) => {},
                        Err(message) => { error = Some(message); break 'read; },
                    }
                    if answer.done { break 'read; }
                },
                Err(message) => { error = Some(message); break; },
            },
            Ok(None) => break,
            Err(_) => { error = Some("Mất kết nối khi AI đang trả lời".into()); break; },
        }
    }
    if answer.content.trim().is_empty() { return Err(error.unwrap_or_else(|| "Dịch vụ xử lý không trả về nội dung".into())); }
    // A dropped stream remains usable; the chat can continue it using the source note.
    Ok(AiCompletion { content: answer.content, finish_reason: if answer.done && error.is_none() { answer.finish_reason } else { Some("length".into()) } })
}

fn completion_from(value: &Value) -> Result<AiCompletion, String> {
    let content = value.get("content").and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty())
        .ok_or("Dịch vụ xử lý không trả về nội dung")?;
    Ok(AiCompletion {
        content: content.to_string(),
        finish_reason: value.get("finish_reason").and_then(Value::as_str).map(str::to_string),
    })
}

pub async fn soniox_release(grant_id: &str) {
    let _ = credit_call(json!({"action": "release", "grant_id": grant_id})).await;
}

#[tauri::command]
pub fn account_signed_in() -> bool { signed_in() }

/// Credit packages on sale, with any promotion applied.
#[tauri::command]
pub async fn account_offers() -> Result<Value, String> {
    Ok(function_call("payos", json!({"action": "offers"})).await?.get("offers").cloned().unwrap_or(Value::Array(vec![])))
}

/// Creates a payOS order and opens its checkout page in the browser.
#[tauri::command]
pub async fn account_buy(package_id: String) -> Result<i64, String> {
    let order = function_call("payos", json!({"action": "create", "package_id": package_id})).await?;
    let url = order.get("checkout_url").and_then(Value::as_str).ok_or("payment_unavailable")?;
    if !url.starts_with("https://") { return Err("payment_unavailable".into()); }
    open_browser(url)?;
    order.get("order_code").and_then(Value::as_i64).ok_or_else(|| "payment_unavailable".into())
}

/// `{status: pending|paid|cancelled, balance_seconds}` of the user's order.
#[tauri::command]
pub async fn account_order_status(order_code: i64) -> Result<Value, String> {
    function_call("payos", json!({"action": "status", "order_code": order_code})).await
}

fn open_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(url).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn account_status() -> Result<AccountStatus, String> {
    let configured = config().is_some();
    let Some(session) = load_session().filter(|_| configured) else {
        return Ok(AccountStatus { configured, email: None, balance_seconds: None });
    };
    let balance = credit_call(json!({"action": "balance"})).await;
    if balance.as_ref().err().is_some_and(|error| error == "signed_out") {
        clear_session();
        return Ok(AccountStatus { configured, email: None, balance_seconds: None });
    }
    Ok(AccountStatus {
        configured,
        email: Some(session.email),
        balance_seconds: balance.ok().and_then(|value| value.get("balance_seconds").and_then(Value::as_i64)),
    })
}

fn normalized_email(email: &str) -> Result<String, String> {
    let email = email.trim().to_lowercase();
    let valid = email.split_once('@').is_some_and(|(name, domain)| !name.is_empty() && domain.contains('.'))
        && !email.chars().any(char::is_whitespace);
    if valid { Ok(email) } else { Err("Email không hợp lệ".into()) }
}

#[tauri::command]
pub async fn account_send_code(email: String) -> Result<(), String> {
    let email = normalized_email(&email)?;
    auth_post("otp", json!({"email": email, "create_user": true})).await.map(|_| ())
}

pub async fn verify(email: &str, code: &str) -> Result<(), String> {
    let email = normalized_email(email)?;
    let code: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    if code.is_empty() { return Err("Vui lòng nhập mã xác nhận".into()); }
    // The default Supabase email carries only a link; accept its hashed token too.
    let body = match link_token(&code) {
        Some(hash) => json!({"type": "email", "token_hash": hash}),
        None => json!({"type": "email", "email": email, "token": code}),
    };
    let value = auth_post("verify", body).await?;
    save_session(&session_from(&value, &email)?)
}

fn link_token(input: &str) -> Option<String> {
    let query = input.split_once('?')?.1;
    query.split('&').find_map(|pair| pair.strip_prefix("token=")).filter(|token| !token.is_empty()).map(str::to_string)
}

pub fn sign_out() { clear_session(); }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_http_stream_reports_progress_before_response_completion() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (ack, wait) = std::sync::mpsc::channel();
        let first = "data: {\"content\":\"**Lan**\"}\n\n";
        let tail = "data: {\"content\":\" gửi báo cáo.\"}\n\ndata: {\"finish_reason\":\"stop\"}\n\ndata: [DONE]\n\n";
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut request = [0u8; 4096];
            stream.read(&mut request).unwrap();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{first}", first.len() + tail.len()).unwrap();
            stream.flush().unwrap();
            wait.recv_timeout(Duration::from_secs(3)).expect("client buffered the stream instead of reporting progress");
            stream.write_all(tail.as_bytes()).unwrap();
        });
        let mut snapshots = Vec::new();
        let answer = tauri::async_runtime::block_on(async {
            let response = client().unwrap().get(format!("http://{address}")).send().await.unwrap();
            consume_ai_stream(response, |partial| {
                snapshots.push(partial.to_string());
                if snapshots.len() == 1 { ack.send(()).unwrap(); }
            }).await.unwrap()
        });
        server.join().unwrap();
        assert_eq!(snapshots, vec!["**Lan**", "**Lan** gửi báo cáo."]);
        assert_eq!(answer.content, "**Lan** gửi báo cáo.");
        assert_eq!(answer.finish_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn completion_preserves_truncation_metadata_and_accepts_plain_text() {
        let result = completion_from(&json!({"content": "  Tóm tắt chưa xong {", "finish_reason": "length"})).unwrap();
        assert_eq!(result.content, "Tóm tắt chưa xong {");
        assert_eq!(result.finish_reason.as_deref(), Some("length"));
        assert!(completion_from(&json!({"content": "x"})).unwrap().finish_reason.is_none());
        assert!(completion_from(&json!({"content": " "})).is_err());
    }

    #[test]
    fn email_is_normalized_and_validated() {
        assert_eq!(normalized_email("  An@Example.COM ").unwrap(), "an@example.com");
        assert!(normalized_email("an@example").is_err());
        assert!(normalized_email("a n@example.com").is_err());
    }

    #[test]
    fn sign_in_link_yields_its_token_hash() {
        let link = "https://x.supabase.co/auth/v1/verify?token=pkce_abc123&type=magiclink&redirect_to=http://localhost:3000";
        assert_eq!(link_token(link).as_deref(), Some("pkce_abc123"));
        assert_eq!(link_token("123456"), None);
    }

    #[test]
    fn session_reads_supabase_verify_response() {
        let value = json!({"access_token": "a", "refresh_token": "r", "expires_in": 3600, "user": {"email": "x@y.vn"}});
        let session = session_from(&value, "fallback@y.vn").unwrap();
        assert_eq!((session.email.as_str(), session.refresh_token.as_str()), ("x@y.vn", "r"));
        assert!(session.expires_at > now());
    }
}
