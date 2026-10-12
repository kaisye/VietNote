//! Faster speech at the same pitch (WSOLA): overlapping slices of the voice are laid down
//! closer together than they were taken, each nudged to where it lines up with the last.
//! Resampling would speed it up too, but raises the voice with it.

/// Slice length and how far a slice may move to line up, in seconds.
const FRAME_SECONDS: f64 = 0.03;
const SEARCH_SECONDS: f64 = 0.01;

/// Time-stretches one stream of speech chunk by chunk, carrying the overlap between chunks.
pub struct Stretcher {
    rate: u32,
    frame: usize,
    search: usize,
    window: Vec<f32>,
    input: Vec<f32>,
    /// Where the next slice would be taken at the exact speed, and where the last one was.
    nominal: f64,
    previous: Option<usize>,
    /// The fading second half of the last slice, added to the next one's rising half.
    tail: Vec<f32>,
    /// Input taken in and output given out over the line, so it ends where its speech does.
    pushed: usize,
    emitted: usize,
}

impl Stretcher {
    pub fn new(rate: u32) -> Self {
        let frame = ((rate as f64 * FRAME_SECONDS) as usize).max(16) & !1;
        let window = (0..frame).map(|i| (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / frame as f64).cos()) as f32).collect();
        Self { rate, frame, search: (rate as f64 * SEARCH_SECONDS) as usize, window, input: Vec::new(), nominal: 0.0, previous: None, tail: Vec::new(), pushed: 0, emitted: 0 }
    }

    pub fn rate(&self) -> u32 { self.rate }

    /// Adds speech and returns what is ready to play; up to a slice or two waits for what follows.
    pub fn push(&mut self, samples: &[f32], speed: f32) -> Vec<f32> {
        self.input.extend_from_slice(samples);
        self.pushed += samples.len();
        let out = self.run_until(speed.clamp(0.5, 2.0) as f64, usize::MAX);
        self.emitted += out.len();
        out
    }

    /// The end of a line: plays out everything held back.
    pub fn finish(&mut self, speed: f32) -> Vec<f32> {
        if self.input.is_empty() && self.tail.is_empty() { return Vec::new(); }
        let end = self.input.len();
        // Silence after the end lets the last slices be taken in full.
        self.input.extend(std::iter::repeat(0.0).take(self.frame + 2 * self.search));
        let mut out = self.run_until(speed.clamp(0.5, 2.0) as f64, end);
        out.append(&mut self.tail);
        // What follows the speech is only the silence added above.
        let length = (self.pushed as f64 / speed.clamp(0.5, 2.0) as f64) as usize;
        out.truncate(length.saturating_sub(self.emitted));
        *self = Self::new(self.rate);
        out
    }

    /// Lays down slices while there is input for them, stopping once slices start past `end`.
    fn run_until(&mut self, speed: f64, end: usize) -> Vec<f32> {
        let half = self.frame / 2;
        let mut out = Vec::new();
        loop {
            let nominal = self.nominal as usize;
            if nominal >= end { break; }
            let start = match self.previous {
                None => {
                    if self.input.len() < self.frame { break; }
                    // The first slice plays as it is, so a line does not fade in.
                    out.extend_from_slice(&self.input[..half]);
                    0
                }
                Some(previous) => {
                    let natural = previous + half;
                    let (low, high) = (nominal.saturating_sub(self.search), nominal + self.search);
                    if high.max(natural) + self.frame > self.input.len() { break; }
                    let start = self.best_match(natural, low, high);
                    out.extend(self.tail.iter().zip(&self.window[..half]).zip(&self.input[start..start + half]).map(|((tail, w), x)| tail + w * x));
                    start
                }
            };
            self.tail = self.input[start + half..start + self.frame].iter().zip(&self.window[half..]).map(|(x, w)| x * w).collect();
            self.previous = Some(start);
            self.nominal += half as f64 * speed;
            self.trim();
        }
        out
    }

    /// The slice start in `low..=high` that best continues the slice that would follow at `natural`.
    fn best_match(&self, natural: usize, low: usize, high: usize) -> usize {
        let target = &self.input[natural..natural + self.frame];
        let (mut best, mut best_score) = (low, f32::MIN);
        for start in low..=high {
            let candidate = &self.input[start..start + self.frame];
            // Every other sample is enough to line up the waveform.
            let (mut dot, mut energy) = (0.0f32, 1e-9f32);
            for i in (0..self.frame).step_by(2) { dot += target[i] * candidate[i]; energy += candidate[i] * candidate[i]; }
            let score = dot / energy.sqrt();
            if score > best_score { best_score = score; best = start; }
        }
        best
    }

    /// Drops input no later slice can reach.
    fn trim(&mut self) {
        let keep = (self.nominal as usize).saturating_sub(self.search).min(self.previous.unwrap_or(0));
        if keep < self.rate as usize { return; }
        self.input.drain(..keep);
        self.nominal -= keep as f64;
        self.previous = self.previous.map(|p| p - keep);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, hz: f32, seconds: f32) -> Vec<f32> {
        (0..(rate as f32 * seconds) as usize).map(|i| (std::f32::consts::TAU * hz * i as f32 / rate as f32).sin() * 0.5).collect()
    }
    fn crossings(samples: &[f32]) -> usize { samples.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count() }

    #[test]
    fn faster_speech_is_shorter_at_the_same_pitch() {
        let rate = 24_000;
        let input = tone(rate, 220.0, 3.0);
        let mut stretcher = Stretcher::new(rate);
        // Fed in uneven chunks, as the voice streams in.
        let mut out = Vec::new();
        for chunk in input.chunks(1_337) { out.extend(stretcher.push(chunk, 1.4)); }
        out.extend(stretcher.finish(1.4));
        let seconds = out.len() as f32 / rate as f32;
        assert!((seconds - 3.0 / 1.4).abs() < 0.06, "{seconds}");
        let pitch = crossings(&out) as f32 / seconds;
        assert!((pitch - 220.0).abs() < 4.0, "{pitch}");
        // No clicks where slices meet: a 220 Hz tone at 0.5 never jumps this far between samples.
        assert!(out.windows(2).all(|w| (w[1] - w[0]).abs() < 0.06));
    }

    #[test]
    fn a_line_plays_out_in_full_and_the_next_starts_fresh() {
        let rate = 24_000;
        let mut stretcher = Stretcher::new(rate);
        let mut out = stretcher.push(&tone(rate, 200.0, 0.5), 1.0);
        out.extend(stretcher.finish(1.0));
        assert!((out.len() as i64 - 12_000).abs() < 50, "{}", out.len());
        assert!(stretcher.finish(1.0).is_empty());
    }
}
