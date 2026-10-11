//! Which apps are playing sound, so one can be left out of system-audio capture: YouTube in a
//! browser while the meeting runs in its own app. macOS only; elsewhere the list stays empty.
use serde::Serialize;

#[derive(Serialize)]
pub struct AudioApp {
    /// The app's bundle ID; its helper processes count as the app.
    id: String,
    name: String,
}

/// Apps sending sound to an output right now, VietNote aside.
#[tauri::command]
pub fn audio_apps() -> Vec<AudioApp> {
    #[cfg(target_os = "macos")]
    return playing_apps();
    #[cfg(not(target_os = "macos"))]
    Vec::new()
}

/// Leaves these apps (bundle IDs) out of system audio, including a recording already running.
#[tauri::command]
pub fn set_excluded_apps(apps: Vec<String>) {
    #[cfg(target_os = "macos")]
    cpal::set_excluded_apps(apps);
    #[cfg(not(target_os = "macos"))]
    let _ = apps;
}

#[cfg(target_os = "macos")]
const WEBKIT: &str = "com.apple.WebKit";

#[cfg(target_os = "macos")]
fn playing_apps() -> Vec<AudioApp> {
    use objc2_app_kit::{NSApplicationActivationPolicy, NSWorkspace};
    let own = std::process::id() as i32;
    // Apps with a Dock icon. A browser plays its tabs from a helper whose bundle ID extends the
    // browser's (com.google.Chrome.helper), so the sound is credited to that app.
    let running: Vec<(String, String)> = NSWorkspace::sharedWorkspace()
        .runningApplications()
        .iter()
        .filter(|app| app.activationPolicy() == NSApplicationActivationPolicy::Regular)
        .filter_map(|app| Some((app.bundleIdentifier()?.to_string(), app.localizedName().map(|name| name.to_string()).unwrap_or_default())))
        .collect();
    let mut apps: Vec<AudioApp> = Vec::new();
    for process in cpal::audio_processes() {
        if !process.playing || process.pid == own || process.bundle_id.is_empty() || process.bundle_id == "local.vietnote.desktop" {
            continue;
        }
        let owner = running
            .iter()
            .filter(|(id, _)| process.bundle_id == *id || process.bundle_id.strip_prefix(id.as_str()).is_some_and(|rest| rest.starts_with('.')))
            .max_by_key(|(id, _)| id.len());
        let (id, name) = match owner {
            Some((id, name)) => (id.clone(), name.clone()),
            // Safari (and any WebKit web view) plays from a shared WebKit process.
            None if process.bundle_id.starts_with(WEBKIT) => (WEBKIT.to_string(), "Safari".to_string()),
            // Background services (dictation, alerts) are not something to pick.
            None => continue,
        };
        if !apps.iter().any(|app| app.id == id) {
            apps.push(AudioApp { id, name });
        }
    }
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    /// Run with sound playing somewhere: `cargo test playing_apps -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn lists_playing_apps() {
        for process in cpal::audio_processes().iter().filter(|p| p.playing) {
            println!("process {} {} playing", process.pid, process.bundle_id);
        }
        for app in super::playing_apps() {
            println!("app {} ({})", app.name, app.id);
        }
    }
}
