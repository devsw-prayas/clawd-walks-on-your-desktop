use chrono::Timelike;
use serde::Serialize;
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedState {
    pub mode: String,
    pub total_instances: u32,
    pub cli_count: u32,
    pub is_desktop_running: bool,
    pub focused_process: String,
    pub spotify_playing: bool,
    pub hour: u32,
    pub battery_pct: u32,
    pub is_charging: bool,
}

fn get_process_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut size,
        );
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        if ok.is_ok() && size > 0 {
            let path = OsString::from_wide(&buf[..size as usize])
                .to_string_lossy()
                .into_owned();
            let filename = path.rsplit('\\').next().unwrap_or(&path);
            Some(filename.trim_end_matches(".exe").to_string())
        } else {
            None
        }
    }
}

fn get_foreground_window_info() -> (String, String, u32) {
    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.0.is_null() {
            return (String::new(), String::new(), 0);
        }

        let mut title_buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut title_buf);
        let title = if len > 0 {
            OsString::from_wide(&title_buf[..len as usize])
                .to_string_lossy()
                .into_owned()
        } else {
            String::new()
        };

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));

        let proc_name = get_process_name(pid).unwrap_or_default();

        (title, proc_name, pid)
    }
}

fn detect_spotify_playing() -> bool {
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };

    static FOUND: AtomicBool = AtomicBool::new(false);
    FOUND.store(false, Ordering::SeqCst);

    unsafe extern "system" fn enum_callback(
        hwnd: HWND,
        _: windows::Win32::Foundation::LPARAM,
    ) -> windows::core::BOOL { unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return windows::core::BOOL(1);
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));

        if let Some(name) = get_process_name_for_enum(pid) {
            if name.eq_ignore_ascii_case("Spotify") {
                let mut title_buf = [0u16; 512];
                let len = GetWindowTextW(hwnd, &mut title_buf);
                if len > 0 {
                    let title = OsString::from_wide(&title_buf[..len as usize])
                        .to_string_lossy()
                        .into_owned();
                    if !title.is_empty()
                        && title != "Spotify"
                        && title != "Spotify Free"
                        && title != "Spotify Premium"
                    {
                        FOUND.store(true, Ordering::SeqCst);
                        return windows::core::BOOL(0);
                    }
                }
            }
        }
        windows::core::BOOL(1)
    }}

    unsafe fn get_process_name_for_enum(pid: u32) -> Option<String> { unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut size,
        );
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        if ok.is_ok() && size > 0 {
            let path = OsString::from_wide(&buf[..size as usize])
                .to_string_lossy()
                .into_owned();
            let filename = path.rsplit('\\').next().unwrap_or(&path);
            Some(filename.trim_end_matches(".exe").to_string())
        } else {
            None
        }
    }}

    unsafe {
        let _ = EnumWindows(Some(enum_callback), windows::Win32::Foundation::LPARAM(0));
    }
    FOUND.load(Ordering::SeqCst)
}

fn count_tool_instances(tool: &str) -> (u32, bool) {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let process_name = match tool {
        "opencode" => "opencode.exe",
        _ => "claude.exe",
    };

    let mut total: u32 = 0;

    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return (0, false);
        };

        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let name_end = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = OsString::from_wide(&entry.szExeFile[..name_end])
                    .to_string_lossy()
                    .into_owned();

                if name.eq_ignore_ascii_case(process_name) {
                    total += 1;
                }

                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snap);
    }

    let desktop_running = check_desktop_window(tool);
    let cli_count = if desktop_running && total > 5 {
        total.saturating_sub(6)
    } else if desktop_running {
        0
    } else {
        total
    };

    (cli_count, desktop_running)
}

fn check_desktop_window(tool: &str) -> bool {
    use windows::core::w;
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;

    let title = match tool {
        "claude-cli" | "claude-app" => w!("Claude"),
        "opencode" => w!("OC"),
        _ => w!("Claude"),
    };

    unsafe {
        if let Ok(hwnd) = FindWindowW(None, title) {
            if !hwnd.0.is_null() {
                return true;
            }
        }
        false
    }
}

fn get_battery_info() -> (u32, bool) {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    unsafe {
        let mut status = SYSTEM_POWER_STATUS::default();
        if GetSystemPowerStatus(&mut status).is_ok() {
            let pct = if status.BatteryLifePercent == 255 {
                100
            } else {
                status.BatteryLifePercent as u32
            };
            let charging = status.ACLineStatus == 1;
            (pct, charging)
        } else {
            (100, true)
        }
    }
}

pub fn poll_system_state(tool: &str) -> DerivedState {
    let (title, proc_name, _pid) = get_foreground_window_info();
    let spotify_playing = detect_spotify_playing();
    let (cli_count, desktop_running) = count_tool_instances(tool);
    let (battery_pct, is_charging) = get_battery_info();
    let hour = chrono::Local::now().hour();

    let is_focused = match tool {
        "claude-cli" => {
            title.contains("Claude Code")
                || (proc_name.eq_ignore_ascii_case("claude") && title.contains("Code"))
        }
        "claude-app" => {
            proc_name.eq_ignore_ascii_case("claude") && !title.contains("Code")
        }
        "opencode" => {
            let t = title.to_lowercase();
            t.contains("opencode") || proc_name.eq_ignore_ascii_case("opencode")
        }
        _ => false,
    };

    let mode = if is_focused {
        "action"
    } else if desktop_running
        || cli_count > 0
        || proc_name == "explorer"
        || title.is_empty()
    {
        "awake"
    } else {
        "asleep"
    };

    DerivedState {
        mode: mode.to_string(),
        total_instances: cli_count.max(1),
        cli_count,
        is_desktop_running: desktop_running,
        focused_process: proc_name,
        spotify_playing,
        hour,
        battery_pct,
        is_charging,
    }
}
