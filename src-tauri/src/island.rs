//! VietNote Island: a small floating window, shaped like the MacBook notch, that shows the
//! live transcript and takes questions without switching away from the video being watched.
//! The main window owns all meeting state and streams it to the island over events.
//!
//! On macOS the window is turned into a non-activating panel: it floats above full-screen
//! apps on every Space, and typing into it never brings VietNote's main window forward.
//! On Windows it is a topmost window that clicks don't activate; it takes the keyboard only
//! while the question box is open, and gives it back once the user clicks elsewhere.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub const LABEL: &str = "island";

/// ⌥Space (Ctrl+Shift+Space on Windows, where Alt+Space opens the window menu) opens the
/// island's question box from any app.
fn shortcut() -> Shortcut {
    #[cfg(target_os = "macos")]
    { Shortcut::new(Some(Modifiers::ALT), Code::Space) }
    #[cfg(not(target_os = "macos"))]
    { Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space) }
}

pub fn shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, pressed, event| {
            if *pressed == shortcut() && event.state() == ShortcutState::Pressed {
                let _ = app.emit_to(LABEL, "island:shortcut", ());
            }
        })
        .build()
}

/// Created hidden at launch; the main window shows it once the island is switched on.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::default())
        .title("VietNote Island")
        .inner_size(200.0, 36.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .accept_first_mouse(true)
        .focused(false)
        .visible(false)
        .build()?;
    #[cfg(target_os = "macos")]
    unsafe { mac::make_panel(window.ns_window()?) };
    #[cfg(not(target_os = "macos"))]
    {
        // A click must not pull focus from the video underneath (it would leave full screen).
        window.set_focusable(false)?;
        let island = window.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::Focused(false) = event { let _ = island.set_focusable(false); }
        });
    }
    Ok(())
}

/// A display in top-left logical coordinates, the space the island positions itself in.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IslandScreen {
    pub key: String,
    pub frame: Rect,
    /// The part not covered by the menu bar or the Dock.
    pub visible: Rect,
    /// The camera housing, when the display has one.
    pub notch: Option<Notch>,
    /// The display with the menu bar.
    pub primary: bool,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Rect { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Notch { pub width: f64, pub height: f64 }

#[tauri::command]
pub fn island_screens(window: WebviewWindow) -> Result<Vec<IslandScreen>, String> {
    #[cfg(target_os = "macos")]
    { let _ = window; mac::screens() }
    #[cfg(not(target_os = "macos"))]
    {
        let monitors = window.available_monitors().map_err(|e| e.to_string())?;
        let primary = window.primary_monitor().ok().flatten().map(|m| m.name().cloned());
        Ok(monitors.iter().map(|m| {
            let scale = m.scale_factor();
            let position = m.position().to_logical::<f64>(scale);
            let size = m.size().to_logical::<f64>(scale);
            let work = m.work_area();
            let (work_position, work_size) = (work.position.to_logical::<f64>(scale), work.size.to_logical::<f64>(scale));
            IslandScreen {
                key: format!("{}x{}@{},{}", size.width, size.height, position.x, position.y),
                frame: Rect { x: position.x, y: position.y, width: size.width, height: size.height },
                visible: Rect { x: work_position.x, y: work_position.y, width: work_size.width, height: work_size.height },
                notch: None,
                primary: primary.as_ref() == Some(&m.name().cloned()),
            }
        }).collect())
    }
}

/// Moves and resizes the island in one step, so it never flashes at the wrong size.
#[tauri::command]
pub fn island_set_frame(window: WebviewWindow, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    if window.label() != LABEL { return Err("Not the island window".into()); }
    #[cfg(target_os = "macos")]
    unsafe { mac::set_frame(window.ns_window().map_err(|e| e.to_string())?, x, y, width, height) };
    #[cfg(not(target_os = "macos"))]
    {
        window.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
        window.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Shows or hides the island, and holds ⌥Space only while it is shown.
#[tauri::command]
pub fn island_set_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or("Island window missing")?;
    let shortcuts = app.global_shortcut();
    if visible {
        #[cfg(target_os = "macos")]
        unsafe { mac::order_front(window.ns_window().map_err(|e| e.to_string())?) };
        #[cfg(not(target_os = "macos"))]
        window.show().map_err(|e| e.to_string())?;
        // Another app may already own ⌥Space; the island still works by clicking.
        if !shortcuts.is_registered(shortcut()) { let _ = shortcuts.register(shortcut()); }
    } else {
        window.hide().map_err(|e| e.to_string())?;
        if shortcuts.is_registered(shortcut()) { let _ = shortcuts.unregister(shortcut()); }
    }
    Ok(())
}

/// Takes the keyboard so the question box can be typed into, leaving the app in front as it is.
#[tauri::command]
pub fn island_focus(window: WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    unsafe { mac::make_key(window.ns_window().map_err(|e| e.to_string())?) };
    #[cfg(not(target_os = "macos"))]
    {
        window.set_focusable(true).map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The mouse pointer in the island's coordinates. A panel behind another app's window gets no
/// hover events, so the island polls this to open when the pointer reaches it.
#[tauri::command]
pub fn island_cursor(window: WebviewWindow) -> Result<(f64, f64), String> {
    #[cfg(target_os = "macos")]
    { let _ = window; mac::cursor() }
    #[cfg(not(target_os = "macos"))]
    {
        let position = window.cursor_position().map_err(|e| e.to_string())?;
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        Ok((position.x / scale, position.y / scale))
    }
}

/// Subtitles let clicks through to the video except over the caption itself.
#[tauri::command]
pub fn island_ignore_cursor(window: WebviewWindow, ignore: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn island_open_main(app: AppHandle) -> Result<(), String> {
    let main = app.get_webview_window("main").ok_or("Main window missing")?;
    let _ = main.unminimize();
    main.show().map_err(|e| e.to_string())?;
    main.set_focus().map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{IslandScreen, Notch, Rect};
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
    use objc2::{ffi, msg_send, sel, ClassType};
    use objc2_app_kit::{NSPanel, NSScreen};
    use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};
    use std::ffi::c_void;
    use std::sync::OnceLock;

    // NSWindowStyleMaskNonactivatingPanel
    const NON_ACTIVATING: usize = 1 << 7;
    // canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary
    const BEHAVIOR: usize = (1 << 0) | (1 << 4) | (1 << 6) | (1 << 8);
    // NSStatusWindowLevel: above the menu bar, so the island can sit over the notch.
    const LEVEL: isize = 25;

    extern "C-unwind" fn yes(_: &AnyObject, _: Sel) -> Bool { Bool::YES }
    extern "C-unwind" fn no(_: &AnyObject, _: Sel) -> Bool { Bool::NO }

    fn panel_class() -> &'static AnyClass {
        static CLASS: OnceLock<usize> = OnceLock::new();
        let class = *CLASS.get_or_init(|| {
            let mut builder = ClassBuilder::new(c"VietNoteIslandPanel", NSPanel::class()).expect("island panel class");
            unsafe {
                builder.add_method(sel!(canBecomeKeyWindow), yes as extern "C-unwind" fn(_, _) -> _);
                builder.add_method(sel!(canBecomeMainWindow), no as extern "C-unwind" fn(_, _) -> _);
            }
            builder.register() as *const AnyClass as usize
        });
        unsafe { &*(class as *const AnyClass) }
    }

    /// Only an NSPanel with the non-activating style can float over another app's full-screen
    /// Space and take typing without activating VietNote, so the window's class is swapped.
    pub unsafe fn make_panel(window: *mut c_void) {
        let window = window as *mut AnyObject;
        ffi::object_setClass(window, panel_class());
        let window = &*window;
        let mask: usize = msg_send![window, styleMask];
        let _: () = msg_send![window, setStyleMask: mask | NON_ACTIVATING];
        // The style only takes effect at creation; this tells the window server too, so clicking
        // the island never activates VietNote or switches to the Space of its main window.
        let prevents = sel!(_setPreventsActivation:);
        let responds: bool = msg_send![window, respondsToSelector: prevents];
        if responds { let _: () = msg_send![window, _setPreventsActivation: true]; }
        let _: () = msg_send![window, setCollectionBehavior: BEHAVIOR];
        let _: () = msg_send![window, setLevel: LEVEL];
        let _: () = msg_send![window, setHidesOnDeactivate: false];
        let _: () = msg_send![window, setHasShadow: false];
        let _: () = msg_send![window, setMovable: false];
    }

    fn primary_height(mtm: MainThreadMarker) -> f64 {
        NSScreen::screens(mtm).iter().next().map(|screen| screen.frame().size.height).unwrap_or(0.0)
    }

    pub fn screens() -> Result<Vec<IslandScreen>, String> {
        let mtm = MainThreadMarker::new().ok_or("Screens are read on the main thread")?;
        let top = primary_height(mtm);
        Ok(NSScreen::screens(mtm).iter().enumerate().map(|(index, screen)| {
            let frame = screen.frame();
            let visible = screen.visibleFrame();
            let insets = screen.safeAreaInsets();
            let frame_top = frame.origin.y + frame.size.height;
            let notch = (insets.top > 0.0).then(|| {
                let side = screen.auxiliaryTopLeftArea().size.width + screen.auxiliaryTopRightArea().size.width;
                Notch { width: (frame.size.width - side).max(0.0), height: insets.top }
            });
            let (x, y, width, height) = (frame.origin.x, top - frame_top, frame.size.width, frame.size.height);
            IslandScreen {
                key: format!("{width}x{height}@{x},{y}"),
                frame: Rect { x, y, width, height },
                visible: Rect {
                    x: visible.origin.x,
                    y: top - (visible.origin.y + visible.size.height),
                    width: visible.size.width,
                    height: visible.size.height,
                },
                notch,
                primary: index == 0,
            }
        }).collect())
    }

    pub fn cursor() -> Result<(f64, f64), String> {
        let mtm = MainThreadMarker::new().ok_or("The pointer is read on the main thread")?;
        let point: NSPoint = unsafe { msg_send![objc2::class!(NSEvent), mouseLocation] };
        Ok((point.x, primary_height(mtm) - point.y))
    }

    pub unsafe fn set_frame(window: *mut c_void, x: f64, y: f64, width: f64, height: f64) {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let window = &*(window as *mut AnyObject);
        // Cocoa measures from the bottom-left corner of the primary display.
        let frame = NSRect::new(NSPoint::new(x, primary_height(mtm) - y - height), NSSize::new(width, height));
        let _: () = msg_send![window, setFrame: frame, display: true];
    }

    /// Shows the island without taking the keyboard from the app in front.
    pub unsafe fn order_front(window: *mut c_void) {
        let window = &*(window as *mut AnyObject);
        let _: () = msg_send![window, orderFrontRegardless];
    }

    pub unsafe fn make_key(window: *mut c_void) {
        let window = &*(window as *mut AnyObject);
        let _: () = msg_send![window, makeKeyAndOrderFront: std::ptr::null::<AnyObject>()];
    }
}
