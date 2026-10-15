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

/// A parameter of a caption URL, e.g. `lang` or `tlang`.
fn query<'a>(url: &'a str, name: &str) -> Option<&'a str> {
    url.split(['?', '&']).find_map(|pair| pair.strip_prefix(name)?.strip_prefix('='))
}

/// The language of the video's own audio. A video can carry dubs in other languages too; its
/// original track is marked as preferred (and "original").
fn original_language(info: &Value) -> Option<String> {
    info["formats"].as_array().into_iter().flatten()
        .filter(|format| format["acodec"] != "none")
        .filter_map(|format| Some((format["language"].as_str().filter(|tag| !tag.is_empty())?, format)))
        .max_by_key(|(_, format)| (format["language_preference"].as_i64().unwrap_or(-1), format["format_note"].as_str().unwrap_or_default().contains("original")))
        .map(|(language, _)| base(language).to_string())
}

/// The best caption track: Vietnamese made by people, then the spoken language's own captions
/// made by people, then YouTube's speech recognition of it. Returns its URL and language.
///
/// YouTube recognises every audio track of a video (its dubs too) and machine-translates the
/// recognition into every language (those tracks carry `tlang`); only the recognition of the
/// original audio is the source.
fn pick_track(info: &Value) -> Option<(String, String, &'static str)> {
    let json3 = |formats: &Value| formats.as_array()?.iter().find(|f| f["ext"] == "json3")?["url"].as_str().map(String::from);
    let manual = info["subtitles"].as_object().into_iter().flatten().filter(|(key, _)| *key != "live_chat").collect::<Vec<_>>();
    let recognitions = info["automatic_captions"].as_object().into_iter().flatten()
        .filter_map(|(key, formats)| Some((key, json3(formats)?)))
        .filter(|(_, url)| query(url, "tlang").is_none())
        .map(|(key, url)| { let language = query(&url, "lang").map(base).unwrap_or_else(|| base(key.trim_end_matches("-orig"))).to_string(); (key.ends_with("-orig"), url, language) })
        .collect::<Vec<_>>();
    // The audio says what is spoken; the language a channel declares is often unset or wrong,
    // so it only breaks a tie between recognitions.
    let audio = original_language(info);
    let declared = info["language"].as_str().map(base).filter(|tag| !tag.is_empty()).map(String::from);
    // "<lang>-orig" is the recognition itself when YouTube lists it.
    let recognised = |language: &str| recognitions.iter().filter(|(_, _, of)| of == language).max_by_key(|(orig, _, _)| *orig).map(|(_, url, of)| (url.clone(), of.clone()));
    let recognised = audio.as_deref().and_then(recognised)
        .or_else(|| declared.as_deref().and_then(recognised))
        .or_else(|| recognised("en"))
        .or_else(|| recognitions.iter().max_by_key(|(orig, _, _)| *orig).map(|(_, url, of)| (url.clone(), of.clone())));
    let spoken = audio.or_else(|| recognised.as_ref().map(|(_, language)| language.clone())).or(declared);

    let from_manual = |wanted: &dyn Fn(&str) -> bool| manual.iter().find(|(key, _)| wanted(key)).and_then(|(key, formats)| Some((json3(formats)?, base(key).to_string(), "manual")));
    if let Some(found) = from_manual(&|key| base(key) == "vi") { return Some(found); }
    if let Some(spoken) = &spoken {
        if let Some(found) = from_manual(&|key| base(key) == spoken) { return Some(found); }
    }
    if let Some((url, language)) = recognised { return Some((url, language, "auto")); }
    // Captions in another language are someone's translation: English still reads well as a
    // source, others (a community's Ukrainian, say) would show as the "original". Then the
    // video is better heard. A lone track is taken only when nothing says what is spoken.
    from_manual(&|key| base(key) == "en").or_else(|| if manual.len() == 1 && spoken.is_none() { from_manual(&|_| true) } else { None })
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
    let system = format!("Bạn là phiên dịch viên phụ đề kiêm lồng tiếng video từ ngôn ngữ có mã \"{language}\" sang tiếng Việt. Đầu vào là JSON gồm các câu phụ đề liên tiếp (lines) và vài câu ngay trước đó (context, chỉ để hiểu, không dịch). Phụ đề có thể do máy nhận dạng giọng nói nên thiếu dấu câu hoặc nghe nhầm; dùng ngữ cảnh để hiểu đúng. Mỗi bản dịch sẽ vừa hiện làm phụ đề vừa được đọc thành tiếng trong khoảng thời gian nói câu gốc. Dịch tự nhiên, gọn, dễ đọc thành lời; ưu tiên cách diễn đạt ngắn có thể nói với nhịp bình thường, tránh dịch sát từng chữ, từ lặp và phần diễn giải không có trong câu gốc. Giữ đủ ý, sắc thái quan trọng, tên riêng, số liệu và thuật ngữ chuyên môn; không lược bỏ thông tin thiết yếu chỉ để rút ngắn. Câu chỉ là tiếng động như [Music] thì dịch thành [Nhạc]. Mỗi câu đầu vào có đúng một câu dịch, cùng thứ tự; không gộp, không tách, không bỏ câu. Chỉ trả về JSON {{\"lines\":[\"…\"]}}.");
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
    let system = format!("Bạn là biên tập viên phụ đề kiêm phiên dịch lồng tiếng video từ ngôn ngữ có mã \"{language}\" sang tiếng Việt. Đầu vào là JSON: words là lời nói do máy nhận dạng, từng từ có số thứ tự [n], chưa có dấu câu và có thể nghe nhầm; context là vài câu ngay trước đó, chỉ để hiểu. Hãy chia words thành các câu phụ đề liên tiếp, phủ hết từ đầu đến cuối, không bỏ từ nào. Mỗi câu phụ đề trọn một ý, thường 6–16 từ; câu nói dài thì tách ở chỗ ngắt tự nhiên. Với mỗi câu, trả về from (số thứ tự của từ đầu tiên), source (câu gốc đã thêm dấu câu và sửa lỗi nhận dạng rõ ràng) và vi (bản dịch tiếng Việt vừa hiện làm phụ đề vừa được đọc thành tiếng trong khoảng thời gian nói câu gốc). Viết vi tự nhiên, gọn, dễ đọc thành lời với nhịp bình thường; tránh dịch sát từng chữ, từ lặp và diễn giải không có trong câu gốc, nhưng giữ đủ ý và sắc thái quan trọng. Giữ nguyên tên riêng, số liệu và thuật ngữ chuyên môn; tiếng động như [Music] để riêng một câu và dịch thành [Nhạc]. Bỏ từ đệm vô nghĩa như uh, um trong bản dịch. Chỉ trả về JSON {{\"lines\":[{{\"from\":0,\"source\":\"…\",\"vi\":\"…\"}}]}}.");
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
    /// YouTube's recognition in `lang`, machine-translated into `to` when given.
    fn recognition(lang: &str, to: Option<&str>) -> Value {
        track(&format!("https://www.youtube.com/api/timedtext?v=x&kind=asr&lang={lang}{}&fmt=json3", to.map(|to| format!("&tlang={to}")).unwrap_or_default()))
    }

    #[test]
    fn prefers_vietnamese_then_the_spoken_language_then_recognition() {
        let info = json!({ "language": "en", "subtitles": { "fr": track("fr"), "en-US": track("en-US"), "vi": track("vi") }, "automatic_captions": { "en-orig": track("auto") } });
        assert_eq!(pick_track(&info), Some(("vi".into(), "vi".into(), "manual")));
        let info = json!({ "language": "en", "subtitles": { "fr": track("fr"), "en-US": track("en-US") }, "automatic_captions": { "en-orig": track("auto") } });
        assert_eq!(pick_track(&info), Some(("en-US".into(), "en".into(), "manual")));
        let info = json!({ "language": "ja", "subtitles": { "fr": track("fr"), "en": track("en") }, "automatic_captions": { "ja-orig": track("auto"), "vi": track("vi-auto") } });
        assert_eq!(pick_track(&info), Some(("auto".into(), "ja".into(), "auto")));
    }

    #[test]
    fn takes_the_recognition_of_the_original_audio_among_dubs() {
        let audio = |language: &str, preference: i64, note: &str| json!({ "acodec": "opus", "language": language, "language_preference": preference, "format_note": note });
        let info = json!({ "language": "en-US", "subtitles": {},
            "formats": [{ "acodec": "none", "language": null }, audio("ar", -1, "Arabic - dubbed-auto"), audio("en-US", 10, "English original (default)"), audio("uk", -1, "Ukrainian")],
            "automatic_captions": { "ar-orig": recognition("ar", None), "en-orig": recognition("en", None), "uk-orig": recognition("uk", None), "vi": recognition("en", Some("vi")) } });
        assert_eq!(original_language(&info).as_deref(), Some("en"));
        let (url, language, _) = pick_track(&info).unwrap();
        assert_eq!(language, "en");
        assert!(url.contains("lang=en") && !url.contains("tlang"));
    }

    #[test]
    fn takes_the_spoken_language_from_recognition_not_the_declared_one() {
        // Declared Arabic, spoken English, no "-orig" listed: the Arabic tracks are translations.
        let info = json!({ "language": "ar", "subtitles": { "ar": track("ar-manual") }, "automatic_captions": {
            "ar": recognition("en", Some("ar")), "en": recognition("en", None), "vi": recognition("en", Some("vi")) } });
        let (url, language, kind) = pick_track(&info).unwrap();
        assert_eq!((language.as_str(), kind), ("en", "auto"));
        assert!(!url.contains("tlang"));
        // Spoken English, no recognition, only a community's Ukrainian: no source to translate from.
        let info = json!({ "language": "en", "subtitles": { "uk": track("uk") }, "automatic_captions": {} });
        assert_eq!(pick_track(&info), None);
        // Declared nothing: the same.
        let info = json!({ "language": null, "subtitles": {}, "automatic_captions": { "ar": recognition("en", Some("ar")), "en": recognition("en", None) } });
        assert_eq!(pick_track(&info).map(|(_, language, _)| language).as_deref(), Some("en"));
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
