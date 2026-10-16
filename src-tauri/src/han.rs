//! Keeps Chinese characters out of Vietnamese answers. Models reading Chinese sources (or just
//! drifting) sometimes slip a word of Hán tự into a Vietnamese sentence: "vẫn có食欲 tốt". Each
//! sentence that carries one is rewritten in Vietnamese by one small extra request; the rest of
//! the text is left exactly as it was.

use serde_json::{json, Value};
use std::ops::Range;

/// Added to every request: most slips never happen with it.
pub const VIETNAMESE_ONLY: &str = "Viết hoàn toàn bằng tiếng Việt (hoặc ngôn ngữ người dùng yêu cầu); không chèn chữ Hán, chữ Nhật hay từ tiếng Trung vào câu, kể cả khi nguồn là tiếng Trung.";

const REPAIR: &str = "Bạn sửa câu tiếng Việt bị chèn nhầm chữ Hán (tiếng Trung/Nhật). Viết lại TỪNG câu hoàn toàn bằng tiếng Việt tự nhiên: dịch nghĩa chữ Hán theo ngữ cảnh câu, giữ nguyên ý, số liệu, tên riêng, ký hiệu Markdown (-, **, #, [ ] …) và liên kết dạng [..](..). Không thêm, không bỏ ý. Trả về JSON {\"sentences\": [\"…\"]} đúng số lượng và thứ tự câu nhận được.";

/// Hán tự and kana; Vietnamese, Latin and punctuation are untouched.
pub fn is_han(c: char) -> bool {
    matches!(c as u32, 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x2FA1F)
}

pub fn has_han(text: &str) -> bool { text.chars().any(is_han) }

/// When the user asks about Chinese or Japanese, those characters are the answer.
pub fn wants_han(request: &str) -> bool {
    if has_han(request) { return true; }
    let request = request.to_lowercase();
    ["tiếng trung", "tiếng hoa", "trung văn", "chữ hán", "hán tự", "hán việt", "tiếng nhật", "chữ nhật", "chinese", "mandarin", "pinyin", "japanese", "kanji"]
        .iter().any(|word| request.contains(word))
}

/// The sentences of `text` that carry Hán tự, as byte ranges: lines split after . ! ? and their
/// full-width forms, trimmed of surrounding spaces.
fn han_sentences(text: &str) -> Vec<Range<usize>> {
    let mut found = Vec::new();
    let mut push = |start: usize, end: usize| {
        let piece = &text[start..end];
        let trimmed = piece.trim();
        if trimmed.is_empty() || !has_han(trimmed) { return; }
        let lead = piece.len() - piece.trim_start().len();
        found.push(start + lead..start + lead + trimmed.len());
    };
    let mut start = 0;
    let mut chars = text.char_indices().peekable();
    while let Some((index, c)) = chars.next() {
        let after = index + c.len_utf8();
        let ends = match c {
            '\n' | '。' | '！' | '？' => true,
            '.' | '!' | '?' => chars.peek().is_none_or(|(_, next)| next.is_whitespace()),
            _ => false,
        };
        if ends { push(start, after); start = after; }
    }
    push(start, text.len());
    found
}

/// Puts the rewritten sentences back; a rewrite that still carries Hán tự keeps the original.
fn apply(text: &str, ranges: &[Range<usize>], rewrites: &[String]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for (range, rewrite) in ranges.iter().zip(rewrites) {
        out.push_str(&text[at..range.start]);
        let rewrite = rewrite.trim();
        out.push_str(if rewrite.is_empty() || has_han(rewrite) { &text[range.clone()] } else { rewrite });
        at = range.end;
    }
    out.push_str(&text[at..]);
    out
}

/// Rewrites the sentences with Hán tự across `texts`, in one request. On any failure the
/// texts stay as they were: a stray word is better than a lost answer.
pub async fn repair_all(texts: &mut [String]) {
    let ranges: Vec<Vec<Range<usize>>> = texts.iter().map(|text| han_sentences(text)).collect();
    let sentences: Vec<&str> = texts.iter().zip(&ranges).flat_map(|(text, ranges)| ranges.iter().map(move |range| &text[range.clone()])).collect();
    if sentences.is_empty() { return; }
    let size: usize = sentences.iter().map(|sentence| sentence.chars().count()).sum();
    let max_tokens = (size as u32 * 2 + 200).min(4000);
    let Ok(raw) = crate::account::ai_complete("han_repair", REPAIR, json!({ "sentences": sentences }).to_string(), max_tokens, true).await else { return };
    let Some(rewrites) = parse_rewrites(&raw, sentences.len()) else { return };
    let mut rewrites = rewrites.into_iter();
    for (text, ranges) in texts.iter_mut().zip(&ranges) {
        if ranges.is_empty() { continue; }
        let mine: Vec<String> = rewrites.by_ref().take(ranges.len()).collect();
        *text = apply(text, ranges, &mine);
    }
}

fn parse_rewrites(raw: &str, count: usize) -> Option<Vec<String>> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    let value: Value = serde_json::from_str(&raw[start..=end]).ok()?;
    let list: Vec<String> = value.get("sentences")?.as_array()?.iter().map(|item| item.as_str().unwrap_or_default().to_string()).collect();
    (list.len() == count).then_some(list)
}

pub async fn repair(text: String) -> String {
    if !has_han(&text) { return text; }
    let mut texts = [text];
    repair_all(&mut texts).await;
    let [text] = texts;
    text
}

/// Every string in a JSON answer, except ids, which name transcript lines.
pub async fn repair_json(value: &mut Value) {
    fn collect(value: &Value, key: &str, out: &mut Vec<String>) {
        match value {
            Value::String(text) if !is_id(key) => out.push(text.clone()),
            Value::Array(items) => items.iter().for_each(|item| collect(item, key, out)),
            Value::Object(map) => map.iter().for_each(|(key, item)| collect(item, key, out)),
            _ => {}
        }
    }
    fn restore(value: &mut Value, key: &str, texts: &mut impl Iterator<Item = String>) {
        match value {
            Value::String(text) if !is_id(key) => if let Some(next) = texts.next() { *text = next },
            Value::Array(items) => items.iter_mut().for_each(|item| restore(item, key, texts)),
            Value::Object(map) => map.iter_mut().for_each(|(key, item)| restore(item, key, texts)),
            _ => {}
        }
    }
    fn is_id(key: &str) -> bool { key == "id" || key.ends_with("Ids") || key.ends_with("_ids") }
    let mut texts = Vec::new();
    collect(value, "", &mut texts);
    if !texts.iter().any(|text| has_han(text)) { return; }
    repair_all(&mut texts).await;
    restore(value, "", &mut texts.into_iter());
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "Mục tiêu là sống khỏe. Vẫn có食欲 tốt để thưởng thức美食, xem phim.\n- Đúng về thống kê (\"đại概率\").\nKhông có chữ lạ.";

    #[test]
    fn finds_only_the_sentences_with_han() {
        let found: Vec<&str> = han_sentences(SAMPLE).into_iter().map(|range| &SAMPLE[range]).collect();
        assert_eq!(found, ["Vẫn có食欲 tốt để thưởng thức美食, xem phim.", "- Đúng về thống kê (\"đại概率\")."]);
        assert!(han_sentences("Phiên bản 2.5 ổn.\nKhông lỗi.").is_empty());
        // Decimal points do not split a sentence.
        assert_eq!(han_sentences("Tăng 9.6 năm 胖 thêm. Hết"), [0.."Tăng 9.6 năm 胖 thêm.".len()]);
    }

    #[test]
    fn puts_rewrites_back_and_keeps_a_failed_one() {
        let ranges = han_sentences(SAMPLE);
        let fixed = apply(SAMPLE, &ranges, &["Vẫn ăn ngon miệng để thưởng thức món ngon, xem phim.".into(), "- Vẫn 概率.".into()]);
        assert_eq!(fixed, "Mục tiêu là sống khỏe. Vẫn ăn ngon miệng để thưởng thức món ngon, xem phim.\n- Đúng về thống kê (\"đại概率\").\nKhông có chữ lạ.");
    }

    #[test]
    fn knows_when_chinese_is_wanted() {
        assert!(wants_han("Câu đó tiếng Trung viết thế nào?"));
        assert!(wants_han("食欲 nghĩa là gì"));
        assert!(!wants_han("Tóm tắt các quyết định chính"));
        assert!(!has_han("Tiếng Việt có dấu: ắ ặ ẫ ữ ự ỹ"));
    }

    #[test]
    fn reads_rewrites_only_when_the_count_matches() {
        assert_eq!(parse_rewrites("```json\n{\"sentences\":[\"a\",\"b\"]}\n```", 2), Some(vec!["a".into(), "b".into()]));
        assert_eq!(parse_rewrites("{\"sentences\":[\"a\"]}", 2), None);
    }
}
