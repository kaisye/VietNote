use serde_json::Value;

/// SSE framing must survive arbitrary HTTP chunk boundaries, including inside UTF-8 characters.
#[derive(Default)]
pub(crate) struct SseDecoder {
    pending: Vec<u8>,
    data: Vec<String>,
}
impl SseDecoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        self.pending.extend_from_slice(chunk);
        if self.pending.len() > 1_000_000 {
            return Err("Dữ liệu stream quá lớn".into());
        }
        let mut events = Vec::new();
        while let Some(index) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line = self.pending.drain(..=index).collect::<Vec<_>>();
            let line = std::str::from_utf8(&line[..line.len() - 1])
                .map_err(|_| "Dữ liệu stream không hợp lệ")?
                .trim_end_matches('\r');
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(self.data.join("\n"));
                    self.data.clear();
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data
                    .push(data.strip_prefix(' ').unwrap_or(data).to_string());
            }
        }
        Ok(events)
    }
}

#[derive(Default)]
pub(crate) struct StreamAnswer {
    pub content: String,
    pub finish_reason: Option<String>,
    pub done: bool,
}
impl StreamAnswer {
    /// The proxy emits a small protocol rather than exposing the provider's entire response.
    pub fn accept(&mut self, event: &str) -> Result<bool, String> {
        if event == "[DONE]" {
            self.done = true;
            return Ok(false);
        }
        let value: Value =
            serde_json::from_str(event).map_err(|_| "Dữ liệu stream không hợp lệ")?;
        if value.get("error").is_some() {
            return Err("Mất kết nối khi AI đang trả lời".into());
        }
        if let Some(reason) = value.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
        }
        let delta = value
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        self.content.push_str(delta);
        Ok(!delta.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fragmented_utf8_crlf_comments_and_multiple_events() {
        let wire = ": keepalive\r\ndata: {\"content\":\"Tiếng Việt\"}\r\n\r\ndata: {\"finish_reason\":\"length\"}\n\ndata: [DONE]\n\n";
        let mut decoder = SseDecoder::default();
        let mut answer = StreamAnswer::default();
        let mut updates = 0;
        for byte in wire.as_bytes() {
            for event in decoder.push(&[*byte]).unwrap() {
                if answer.accept(&event).unwrap() {
                    updates += 1;
                }
            }
        }
        assert_eq!(answer.content, "Tiếng Việt");
        assert_eq!(answer.finish_reason.as_deref(), Some("length"));
        assert!(answer.done);
        assert_eq!(updates, 1);
    }
    #[test]
    fn detects_mid_stream_errors_without_discarding_received_text() {
        let mut answer = StreamAnswer::default();
        answer.accept(r#"{"content":"Đã nhận"}"#).unwrap();
        assert!(answer.accept(r#"{"error":"stream_interrupted"}"#).is_err());
        assert_eq!(answer.content, "Đã nhận");
        assert!(!answer.done);
    }
    #[test]
    fn supports_multiline_data_and_rejects_malformed_events() {
        let mut decoder = SseDecoder::default();
        let events = decoder
            .push(b"data: {\n data: ignored\ndata: \"content\":\"x\"}\n\n")
            .unwrap();
        let mut answer = StreamAnswer::default();
        answer.accept(&events[0]).unwrap();
        assert_eq!(answer.content, "x");
        assert!(answer.accept("broken JSON").is_err());
    }
}
