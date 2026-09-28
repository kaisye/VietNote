//! Native TTS playback.
//!
//! WKWebView renders WebAudio inside com.apple.WebKit.GPU, a separate process the
//! system-audio tap cannot attribute to VietNote, so translated speech played by
//! the page was captured and recognized again. Playing from this process lets the
//! vendored cpal tap exclude it by PID.
use base64::Engine;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Deserialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioChunk {
    pcm: String,
    /// "f32" (ZeroTTS, little-endian Float32) or "s16" (Gemini Live, little-endian Int16).
    format: String,
    sample_rate: u32,
}

struct Output {
    queue: Arc<Mutex<VecDeque<f32>>>,
    rate: u32,
    alive: Arc<AtomicBool>,
}

static OUTPUT: OnceLock<Mutex<Option<Output>>> = OnceLock::new();

fn open_output() -> Result<Output, String> {
    let (tx, rx) = mpsc::channel();
    // cpal streams are not Send on every platform; one thread owns it until the
    // device reports an error, after which the next play reopens the default device.
    std::thread::spawn(move || {
        let opened = (|| {
            let device = cpal::default_host().default_output_device().ok_or("Không tìm thấy thiết bị phát âm thanh")?;
            let supported = device.default_output_config().map_err(|e| e.to_string())?;
            if supported.sample_format() != cpal::SampleFormat::F32 {
                return Err(format!("Chưa hỗ trợ định dạng loa {:?}", supported.sample_format()));
            }
            let config = supported.config();
            let channels = config.channels.max(1) as usize;
            let queue = Arc::new(Mutex::new(VecDeque::<f32>::new()));
            let alive = Arc::new(AtomicBool::new(true));
            let (reader, failed) = (queue.clone(), alive.clone());
            let stream = device.build_output_stream::<f32, _, _>(config, move |data: &mut [f32], _| {
                let mut queue = reader.lock().unwrap_or_else(|e| e.into_inner());
                for frame in data.chunks_mut(channels) { frame.fill(queue.pop_front().unwrap_or(0.0)); }
            }, move |_| failed.store(false, Ordering::SeqCst), None).map_err(|e| e.to_string())?;
            stream.play().map_err(|e| e.to_string())?;
            Ok((stream, Output { queue, rate: config.sample_rate, alive }))
        })();
        match opened {
            Ok((stream, output)) => {
                let alive = output.alive.clone();
                let _ = tx.send(Ok(output));
                while alive.load(Ordering::SeqCst) { std::thread::sleep(Duration::from_millis(500)); }
                drop(stream);
            }
            Err(error) => { let _ = tx.send(Err(error)); }
        }
    });
    rx.recv().map_err(|e| e.to_string())?
}

fn decode(chunk: &AudioChunk) -> Result<Vec<f32>, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(&chunk.pcm).map_err(|e| e.to_string())?;
    Ok(match chunk.format.as_str() {
        "f32" => bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect(),
        "s16" => bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect(),
        other => return Err(format!("Định dạng PCM không hợp lệ: {other}")),
    })
}

/// Linear resampling; `speed` > 1 plays faster (and higher), like WebAudio playbackRate.
fn resample(samples: &[f32], from: u32, to: u32, speed: f32) -> Vec<f32> {
    if samples.is_empty() { return Vec::new(); }
    let step = from as f64 * speed.clamp(0.5, 2.0) as f64 / to as f64;
    let count = (samples.len() as f64 / step) as usize;
    (0..count).map(|i| {
        let position = i as f64 * step;
        let index = position as usize;
        let next = samples.get(index + 1).copied().unwrap_or(samples[index]);
        samples[index] + (next - samples[index]) * (position - index as f64) as f32
    }).collect()
}

#[tauri::command]
pub fn play_audio(chunks: Vec<AudioChunk>, rate: f32) -> Result<(), String> {
    let mut slot = OUTPUT.get_or_init(|| Mutex::new(None)).lock().map_err(|e| e.to_string())?;
    if !slot.as_ref().is_some_and(|output| output.alive.load(Ordering::SeqCst)) { *slot = Some(open_output()?); }
    let output = slot.as_ref().expect("output opened above");
    for chunk in &chunks {
        let samples = resample(&decode(chunk)?, chunk.sample_rate, output.rate, rate);
        output.queue.lock().map_err(|e| e.to_string())?.extend(samples);
    }
    Ok(())
}

#[tauri::command]
pub fn stop_audio() -> Result<(), String> {
    let Some(slot) = OUTPUT.get() else { return Ok(()) };
    let slot = slot.lock().map_err(|e| e.to_string())?;
    if let Some(output) = slot.as_ref() { output.queue.lock().map_err(|e| e.to_string())?.clear(); }
    Ok(())
}
