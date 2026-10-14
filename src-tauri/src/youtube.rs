//! Watching a YouTube video with Vietnamese subtitles. The video plays from YouTube itself; only
//! its captions are fetched, so every line is translated before it is spoken.
use crate::link_audio::{command, ensure_tool, friendly_error, tools_dir};
use serde::Serialize;
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::Duration;

/// The longest a single recognised word is taken to last.
const WORD_SECONDS: f64 = 1.2;

#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct Piece {
    /// Seconds into the video.
    start: f64,
    end: f64,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Captions {
    video_id: String,
    title: String,
    duration: Option<f64>,
    /// The captions' language, e.g. "en"; "vi" needs no translation.
    language: String,
    /// "manual" captions come in lines, "auto" ones in words without punctuation; "none" when the
    /// video has none, so its words must be heard from its audio.
    kind: &'static str,
    pieces: Vec<Piece>,
}

/// The 11-character id in the common forms of a YouTube link.
pub(crate) fn video_id(url: &str) -> Option<String> {
    let url = url.trim();
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = host.trim_start_matches("www.").trim_start_matches("m.").trim_start_matches("music.");
    let id = match host {
        "youtu.be" => path.split(['?', '&', '#', '/']).next(),
        "youtube.com" | "youtube-nocookie.com" => {
            if let Some(query) = path.strip_prefix("watch?").or_else(|| path.split_once("watch?").map(|(_, query)| query)) {
                query.split(['&', '#']).find_map(|pair| pair.strip_prefix("v="))
            } else {
                ["shorts/", "live/", "embed/", "v/"].iter().find_map(|prefix| path.strip_prefix(prefix)).and_then(|id| id.split(['?', '&', '#', '/']).next())
            }
        }
        _ => None,
    }?;
    (id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).then(|| id.to_string())
}

/// The base of a language tag: "en-US" → "en".
fn base(tag: &str) -> &str { tag.split(['-', '_']).next().unwrap_or(tag) }

/// The best caption track: Vietnamese made by people, then the spoken language's own captions
/// made by people, then YouTube's speech recognition of it. Returns its URL and language.
fn pick_track(info: &Value) -> Option<(String, String, &'static str)> {
    let json3 = |formats: &Value| formats.as_array()?.iter().find(|f| f["ext"] == "json3")?["url"].as_str().map(String::from);
    let manual = info["subtitles"].as_object().into_iter().flatten().filter(|(key, _)| *key != "live_chat").collect::<Vec<_>>();
    let auto = info["automatic_captions"].as_object();
    let spoken = info["language"].as_str().map(base).filter(|tag| !tag.is_empty());

    let from_manual = |wanted: &dyn Fn(&str) -> bool| manual.iter().find(|(key, _)| wanted(key)).and_then(|(key, formats)| Some((json3(formats)?, base(key).to_string(), "manual")));
    if let Some(found) = from_manual(&|key| base(key) == "vi") { return Some(found); }
    if let Some(spoken) = spoken {
        if let Some(found) = from_manual(&|key| base(key) == spoken) { return Some(found); }
    }
    if let Some(auto) = auto {
        // "<lang>-orig" is the recognition itself; the other automatic tracks are machine translations of it.
        let original = auto.iter().find(|(key, _)| key.ends_with("-orig")).map(|(key, formats)| (key.trim_end_matches("-orig"), formats))
            .or_else(|| spoken.and_then(|spoken| auto.get_key_value(spoken).map(|(key, formats)| (key.as_str(), formats))));
        if let Some((key, formats)) = original {
            if let Some(url) = json3(formats) { return Some((url, base(key).to_string(), "auto")); }
        }
    }
    from_manual(&|key| base(key) == "en").or_else(|| if manual.len() == 1 { from_manual(&|_| true) } else { None })
}

/// Caption events in YouTube's json3 form, as timed pieces: one per line, or one per word when
/// the words carry their own times.
fn pieces(track: &Value) -> Vec<Piece> {
    let mut pieces = Vec::new();
    for event in track["events"].as_array().into_iter().flatten() {
        let (Some(start), Some(segs)) = (event["tStartMs"].as_f64(), event["segs"].as_array()) else { continue };
        let end = start + event["dDurationMs"].as_f64().unwrap_or(0.0);
        let words = segs.iter().filter_map(|seg| Some((start + seg["tOffsetMs"].as_f64().unwrap_or(0.0), seg["utf8"].as_str()?))).collect::<Vec<_>>();
        let timed = segs.iter().skip(1).any(|seg| seg["tOffsetMs"].is_number());
        if timed {
            for (index, (at, text)) in words.iter().enumerate() {
                // The last word of an event would otherwise last until the next event, seconds later.
                let until = words.get(index + 1).map_or(end, |(next, _)| *next).min(at + WORD_SECONDS * 1000.0);
                push(&mut pieces, *at, until, text);
            }
        } else {
            push(&mut pieces, start, end, &words.iter().map(|(_, text)| *text).collect::<String>());
        }
    }
    pieces.sort_by(|a, b| a.start.total_cmp(&b.start));
    pieces
}

fn push(pieces: &mut Vec<Piece>, start: f64, end: f64, text: &str) {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if !text.is_empty() { pieces.push(Piece { start: start / 1000.0, end: end.max(start) / 1000.0, text }); }
}

/// Reads the video's captions. Fails with "not_youtube" or "not_embeddable" when it cannot be
/// watched this way, otherwise with a message for people.
#[tauri::command]
pub(crate) async fn youtube_captions(app: tauri::AppHandle, url: String) -> Result<Captions, String> {
    let id = video_id(&url).ok_or("not_youtube")?;
    let tool = ensure_tool(&tools_dir(&app)?, &|_| {}).await?;
    let page = format!("https://www.youtube.com/watch?v={id}");
    let output = tauri::async_runtime::spawn_blocking(move || {
        command(&tool).args(["-J", "--skip-download", "--no-playlist", "--no-warnings", "--no-config", "--"]).arg(page)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).output()
    }).await.map_err(|e| e.to_string())?.map_err(|e| format!("Không chạy được công cụ đọc video: {e}"))?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(friendly_error(error.lines().filter(|line| line.starts_with("ERROR")).last().unwrap_or(&error)));
    }
    let info: Value = serde_json::from_slice(&output.stdout).map_err(|_| friendly_error(""))?;
    if info["playable_in_embed"] == Value::Bool(false) { return Err("not_embeddable".into()); }
    let title = info["title"].as_str().unwrap_or_default().to_string();
    let duration = info["duration"].as_f64();
    let Some((track, language, kind)) = pick_track(&info) else {
        let language = info["language"].as_str().map(base).unwrap_or_default().to_string();
        return Ok(Captions { video_id: id, title, duration, language, kind: "none", pieces: Vec::new() });
    };
    let client = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
    let offline = |_| "Không tải được phụ đề của video. Hãy kiểm tra mạng rồi thử lại.".to_string();
    let track: Value = client.get(track).header("User-Agent", "Mozilla/5.0").send().await.and_then(reqwest::Response::error_for_status).map_err(offline)?
        .json().await.map_err(offline)?;
    let pieces = pieces(&track);
    let kind = if pieces.is_empty() { "none" } else { kind };
    Ok(Captions { video_id: id, title, duration, language, kind, pieces })
}

/// Translates caption lines to Vietnamese, one translation per line. `context` holds the lines
/// just before them, so a sentence split across batches still reads right.
#[tauri::command]
pub(crate) async fn translate_captions(lines: Vec<String>, language: String, context: Vec<String>) -> Result<Vec<String>, String> {
    if lines.is_empty() { return Ok(Vec::new()); }
    let system = format!("Bạn là phiên dịch viên phụ đề video từ ngôn ngữ có mã \"{language}\" sang tiếng Việt. Đầu vào là JSON gồm các câu phụ đề liên tiếp (lines) và vài câu ngay trước đó (context, chỉ để hiểu, không dịch). Phụ đề có thể do máy nhận dạng giọng nói nên thiếu dấu câu hoặc nghe nhầm; dùng ngữ cảnh để hiểu đúng. Dịch từng câu sang tiếng Việt tự nhiên, ngắn gọn như phụ đề phim; giữ nguyên tên riêng, số liệu và thuật ngữ chuyên môn; câu chỉ là tiếng động như [Music] thì dịch thành [Nhạc]. Mỗi câu đầu vào có đúng một câu dịch, cùng thứ tự; không gộp, không tách, không bỏ câu. Chỉ trả về JSON {{\"lines\":[\"…\"]}}.");
    let user = json!({ "context": context, "lines": lines }).to_string();
    let mut last = String::new();
    // A reply with the wrong number of lines would put subtitles on the wrong sentences: ask once more.
    for _ in 0..2 {
        let raw = crate::account::ai_complete(&system, user.clone(), 4000, true).await?;
        let value: Value = raw.find('{').zip(raw.rfind('}')).and_then(|(start, end)| serde_json::from_str(&raw[start..=end]).ok()).unwrap_or(Value::Null);
        let mut translated: Vec<String> = value["lines"].as_array().into_iter().flatten().map(|line| line.as_str().unwrap_or_default().trim().to_string()).collect();
        if translated.len() == lines.len() {
            crate::han::repair_all(&mut translated).await;
            return Ok(translated);
        }
        last = format!("{} câu thay vì {}", translated.len(), lines.len());
    }
    Err(format!("Bản dịch phụ đề bị lệch ({last})"))
}

#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct SpeechLine {
    /// The index of its first word.
    from: usize,
    source: String,
    translation: String,
}

/// Subtitles from the model's reply: they must start at the first word and move forward.
fn speech_lines(value: &Value, words: usize) -> Vec<SpeechLine> {
    let mut lines: Vec<SpeechLine> = Vec::new();
    for item in value["lines"].as_array().into_iter().flatten() {
        let Some(from) = item["from"].as_u64().map(|from| from as usize) else { continue };
        let translation = item["vi"].as_str().unwrap_or_default().trim().to_string();
        if translation.is_empty() || from >= words || lines.last().is_some_and(|last| from <= last.from) { continue }
        lines.push(SpeechLine { from: if lines.is_empty() { 0 } else { from }, source: item["source"].as_str().unwrap_or_default().trim().to_string(), translation });
    }
    lines
}

/// Recognised speech has no punctuation and breaks mid-sentence, so the model splits the words
/// into subtitles itself and translates each; a subtitle is timed by its first word.
#[tauri::command]
pub(crate) async fn translate_speech(words: Vec<String>, language: String, context: Vec<String>) -> Result<Vec<SpeechLine>, String> {
    if words.is_empty() { return Ok(Vec::new()); }
    let system = format!("Bạn là biên tập viên và phiên dịch viên phụ đề video từ ngôn ngữ có mã \"{language}\" sang tiếng Việt. Đầu vào là JSON: words là lời nói do máy nhận dạng, từng từ có số thứ tự [n], chưa có dấu câu và có thể nghe nhầm; context là vài câu ngay trước đó, chỉ để hiểu. Hãy chia words thành các câu phụ đề liên tiếp, phủ hết từ đầu đến cuối, không bỏ từ nào. Mỗi câu phụ đề trọn một ý, thường 6–16 từ; câu nói dài thì tách ở chỗ ngắt tự nhiên. Với mỗi câu, trả về from (số thứ tự của từ đầu tiên), source (câu gốc đã thêm dấu câu và sửa lỗi nhận dạng rõ ràng) và vi (bản dịch tiếng Việt tự nhiên, ngắn gọn như phụ đề phim). Giữ nguyên tên riêng, số liệu và thuật ngữ chuyên môn; tiếng động như [Music] để riêng một câu và dịch thành [Nhạc]. Bỏ từ đệm vô nghĩa như uh, um trong bản dịch. Chỉ trả về JSON {{\"lines\":[{{\"from\":0,\"source\":\"…\",\"vi\":\"…\"}}]}}.");
    let numbered = words.iter().enumerate().map(|(index, word)| format!("[{index}]{word}")).collect::<Vec<_>>().join(" ");
    let user = json!({ "context": context, "words": numbered }).to_string();
    for _ in 0..2 {
        let raw = crate::account::ai_complete(&system, user.clone(), 6000, true).await?;
        let value: Value = raw.find('{').zip(raw.rfind('}')).and_then(|(start, end)| serde_json::from_str(&raw[start..=end]).ok()).unwrap_or(Value::Null);
        let mut lines = speech_lines(&value, words.len());
        if !lines.is_empty() {
            let mut texts: Vec<String> = lines.iter().map(|line| line.translation.clone()).collect();
            crate::han::repair_all(&mut texts).await;
            for (line, text) in lines.iter_mut().zip(texts) { line.translation = text; }
            return Ok(lines);
        }
    }
    Err("Chưa dịch được đoạn phụ đề này".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_id_from_common_links() {
        for url in ["https://www.youtube.com/watch?v=arj7oStGLkU", "https://youtu.be/arj7oStGLkU?si=abc", "https://m.youtube.com/watch?feature=share&v=arj7oStGLkU&t=10s",
            "https://www.youtube.com/shorts/arj7oStGLkU", "https://www.youtube.com/live/arj7oStGLkU?feature=x", "https://www.youtube.com/embed/arj7oStGLkU"] {
            assert_eq!(video_id(url).as_deref(), Some("arj7oStGLkU"), "{url}");
        }
        assert_eq!(video_id("https://vimeo.com/123"), None);
        assert_eq!(video_id("https://www.youtube.com/watch?v=short"), None);
        assert_eq!(video_id("https://www.youtube.com/@channel"), None);
    }

    fn track(key: &str) -> Value { json!([{ "ext": "vtt", "url": "x" }, { "ext": "json3", "url": key }]) }

    #[test]
    fn prefers_vietnamese_then_the_spoken_language_then_recognition() {
        let info = json!({ "language": "en", "subtitles": { "fr": track("fr"), "en-US": track("en-US"), "vi": track("vi") }, "automatic_captions": { "en-orig": track("auto") } });
        assert_eq!(pick_track(&info), Some(("vi".into(), "vi".into(), "manual")));
        let info = json!({ "language": "en", "subtitles": { "fr": track("fr"), "en-US": track("en-US") }, "automatic_captions": { "en-orig": track("auto") } });
        assert_eq!(pick_track(&info), Some(("en-US".into(), "en".into(), "manual")));
        let info = json!({ "language": "ja", "subtitles": { "fr": track("fr"), "en": track("en") }, "automatic_captions": { "ja-orig": track("auto"), "vi": track("vi-auto") } });
        assert_eq!(pick_track(&info), Some(("auto".into(), "ja".into(), "auto")));
        let info = json!({ "language": null, "subtitles": { "live_chat": track("chat") }, "automatic_captions": {} });
        assert_eq!(pick_track(&info), None);
    }

    #[test]
    fn keeps_subtitles_that_move_forward_from_the_first_word() {
        let reply = json!({ "lines": [
            { "from": 2, "source": "This program", "vi": "Chương trình này" },
            { "from": 5, "source": "is brought", "vi": "được mang đến" },
            { "from": 5, "source": "again", "vi": "lặp" },
            { "from": 3, "source": "back", "vi": "lùi" },
            { "from": 9, "source": "past", "vi": "quá" },
            { "from": 7, "source": "empty", "vi": " " },
        ] });
        let lines = speech_lines(&reply, 8);
        assert_eq!(lines.iter().map(|line| line.from).collect::<Vec<_>>(), vec![0, 5]);
        assert_eq!(lines[1].translation, "được mang đến");
    }

    #[test]
    fn splits_recognised_captions_into_words() {
        let track = json!({ "events": [
            { "tStartMs": 1000, "dDurationMs": 2000, "segs": [{ "utf8": "this" }, { "utf8": " program", "tOffsetMs": 400 }] },
            { "tStartMs": 2900, "dDurationMs": 100, "aAppend": 1, "segs": [{ "utf8": "\n" }] },
            { "tStartMs": 5000, "dDurationMs": 1500, "segs": [{ "utf8": "which means I had to write\na lot" }] },
        ] });
        assert_eq!(pieces(&track), vec![
            Piece { start: 1.0, end: 1.4, text: "this".into() },
            Piece { start: 1.4, end: 2.6, text: "program".into() },
            Piece { start: 5.0, end: 6.5, text: "which means I had to write a lot".into() },
        ]);
    }
}
