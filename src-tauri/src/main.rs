#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::os::windows::process::CommandExt;

mod sensors;

use sensors::keypress::{KeyCommand, KeypressSensor};
use sensors::system_state::poll_system_state;
use sensors::token_stats::get_token_summary;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager, PhysicalPosition, WebviewWindow};

static IS_DRAGGING: AtomicBool = AtomicBool::new(false);
static DRAG_OFFSET: Mutex<Option<(f64, f64)>> = Mutex::new(None);

// --- Config loading ---

fn config_path() -> std::path::PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));

    let candidates = [
        exe_dir.as_ref().map(|d| d.join("clawd.config.json")),
        exe_dir.as_ref().map(|d| d.join("_up_").join("clawd.config.json")),
        Some(std::path::PathBuf::from("clawd.config.json")),
        exe_dir
            .as_ref()
            .map(|d| d.join("..").join("clawd.config.json")),
    ];

    for candidate in candidates.iter().flatten() {
        if candidate.exists() {
            return candidate.clone();
        }
    }

    // No file found — default to exe directory
    exe_dir.unwrap_or_else(|| std::path::PathBuf::from("clawd.config.json"))
}

fn load_config() -> serde_json::Value {
    let path = config_path();
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(val) = serde_json::from_str(&content) {
            return val;
        }
    }

    serde_json::json!({
        "tool": "claude-cli",
        "clickAction": "claude-cli",
        "poll": { "systemState": 2500, "cursor": 33, "keypress": 80, "tokens": 60000 },
        "window": { "width": 220, "height": 260, "margin": 24 }
    })
}

fn save_config_value(key: &str, value: &str) -> bool {
    let path = config_path();
    let mut config = load_config();
    config[key] = serde_json::Value::String(value.to_string());

    if let Ok(content) = serde_json::to_string_pretty(&config) {
        std::fs::write(&path, content).is_ok()
    } else {
        false
    }
}

// --- State ---

// --- Cursor position via Win32 ---

#[derive(Serialize, Clone)]
struct CursorPos {
    x: i32,
    y: i32,
}

fn get_cursor_position() -> CursorPos {
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    use windows::Win32::Foundation::POINT;

    unsafe {
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        CursorPos { x: pt.x, y: pt.y }
    }
}

// --- Tauri commands ---

#[tauri::command]
fn get_window_bounds(window: WebviewWindow) -> serde_json::Value {
    let pos = window.outer_position().unwrap_or(PhysicalPosition::new(0, 0));
    let size = window.outer_size().unwrap_or(tauri::PhysicalSize::new(220, 260));
    serde_json::json!({
        "x": pos.x,
        "y": pos.y,
        "width": size.width,
        "height": size.height
    })
}

#[tauri::command]
fn get_screen_bounds(window: WebviewWindow) -> serde_json::Value {
    if let Some(monitor) = window.primary_monitor().ok().flatten() {
        let size = monitor.size();
        serde_json::json!({ "width": size.width, "height": size.height })
    } else {
        serde_json::json!({ "width": 1920, "height": 1080 })
    }
}

#[tauri::command]
fn drag_start(offset_x: f64, offset_y: f64) {
    *DRAG_OFFSET.lock().unwrap() = Some((offset_x, offset_y));
    IS_DRAGGING.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn drag_end() {
    *DRAG_OFFSET.lock().unwrap() = None;
    IS_DRAGGING.store(false, Ordering::Relaxed);
}

#[tauri::command]
fn drag_move() {
    // No-op: drag handled in cursor loop now
}

#[tauri::command]
fn walk_to(window: WebviewWindow, x: f64, y: f64) {
    let _ = window.set_position(PhysicalPosition::new(x as i32, y as i32));
}

#[tauri::command]
fn open_tool() {
    let config = load_config();
    let action = config["clickAction"].as_str().unwrap_or("claude-cli");

    let (program, args) = match action {
        "claude-app" => ("cmd", vec!["/C", "start", "claude:"]),
        "opencode" => ("cmd", vec!["/C", "start", "cmd", "/k", "opencode"]),
        _ => ("cmd", vec!["/C", "start", "cmd", "/k", "claude"]),
    };

    let _ = std::process::Command::new(program)
        .args(&args)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .spawn();
}

#[tauri::command]
fn get_config() -> serde_json::Value {
    load_config()
}

#[tauri::command]
fn save_config(key: String, value: String) -> bool {
    save_config_value(&key, &value)
}

#[tauri::command]
fn set_ignore_mouse_events(window: WebviewWindow, ignore: bool) {
    if ignore {
        let _ = window.set_ignore_cursor_events(true);
    } else {
        let _ = window.set_ignore_cursor_events(false);
    }
}

// --- Main ---

fn main() {
    let config = load_config();

    let poll_cursor = config["poll"]["cursor"].as_u64().unwrap_or(33);
    let poll_system = config["poll"]["systemState"].as_u64().unwrap_or(2500);
    let poll_keypress = config["poll"]["keypress"].as_u64().unwrap_or(80);
    let poll_tokens = config["poll"]["tokens"].as_u64().unwrap_or(60000);
    let win_margin = config["window"]["margin"].as_i64().unwrap_or(24) as i32;

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_window_bounds,
            get_screen_bounds,
            drag_start,
            drag_end,
            drag_move,
            walk_to,
            open_tool,
            get_config,
            save_config,
            set_ignore_mouse_events,
        ])
        .setup(move |app| {
            let window = app.get_webview_window("main").unwrap();

            // Position at bottom-right
            if let Some(monitor) = window.primary_monitor().ok().flatten() {
                let size = monitor.size();
                let scale = monitor.scale_factor();
                let w = (size.width as f64 / scale) as i32;
                let h = (size.height as f64 / scale) as i32;
                let _ = window.set_position(PhysicalPosition::new(
                    w - 220 - win_margin,
                    h - 260 - win_margin,
                ));
            }

            // Start click-through (Rust cursor loop toggles it)
            let _ = window.set_ignore_cursor_events(true);

            // --- Cursor tracking loop (also manages click-through and drag) ---
            let cursor_window = window.clone();
            let handle = app.handle().clone();
            let cursor_ms = poll_cursor;
            std::thread::spawn(move || {
                let mut cursor_over = false;
                loop {
                    let pos = get_cursor_position();
                    let _ = handle.emit("cursor-pos", &pos);

                    if IS_DRAGGING.load(Ordering::Relaxed) {
                        // Drag: move window directly, zero IPC
                        if let Some((ox, oy)) = *DRAG_OFFSET.lock().unwrap() {
                            let _ = cursor_window.set_position(PhysicalPosition::new(
                                (pos.x as f64 - ox) as i32,
                                (pos.y as f64 - oy) as i32,
                            ));
                        }
                    } else {
                        // Click-through toggle
                        if let (Ok(wp), Ok(ws)) =
                            (cursor_window.outer_position(), cursor_window.outer_size())
                        {
                            let inside = pos.x >= wp.x
                                && pos.x < wp.x + ws.width as i32
                                && pos.y >= wp.y
                                && pos.y < wp.y + ws.height as i32;
                            if inside != cursor_over {
                                cursor_over = inside;
                                let _ = cursor_window.set_ignore_cursor_events(!inside);
                            }
                        }
                    }

                    std::thread::sleep(std::time::Duration::from_millis(cursor_ms));
                }
            });

            // --- System state polling loop ---
            let handle = app.handle().clone();
            let system_ms = poll_system;
            std::thread::spawn(move || {
                loop {
                    let t = load_config()["tool"].as_str().unwrap_or("claude-cli").to_string();
                    let state = poll_system_state(&t);
                    let _ = handle.emit("system-state", state);
                    std::thread::sleep(std::time::Duration::from_millis(system_ms));
                }
            });

            // --- Keypress polling loop ---
            let handle = app.handle().clone();
            let key_ms = poll_keypress;
            std::thread::spawn(move || {
                let mut sensor = KeypressSensor::new();
                loop {
                    if let Some(cmd) = sensor.poll() {
                        let event = match cmd {
                            KeyCommand::Copy => "clipboard-copy",
                            KeyCommand::Paste => "clipboard-paste",
                            KeyCommand::Screenshot => "screenshot-taken",
                        };
                        let _ = handle.emit(event, ());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(key_ms));
                }
            });

            // --- Token stats polling loop ---
            let handle = app.handle().clone();
            let token_ms = poll_tokens;
            std::thread::spawn(move || {
                loop {
                    let t = load_config()["tool"].as_str().unwrap_or("claude-cli").to_string();
                    let stats = get_token_summary(&t);
                    let _ = handle.emit("token-stats", stats);
                    std::thread::sleep(std::time::Duration::from_millis(token_ms));
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running Clawd");
}
