#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use tauri::{Manager, RunEvent, Url};

#[cfg(windows)]
mod win_job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct JobGuard {
        handle: HANDLE,
    }

    unsafe impl Send for JobGuard {}
    unsafe impl Sync for JobGuard {}

    impl JobGuard {
        pub fn new() -> Option<Self> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(handle);
                    return None;
                }
                Some(Self { handle })
            }
        }

        pub fn assign(&self, child: &Child) {
            unsafe {
                let proc_handle = child.as_raw_handle() as HANDLE;
                let _ = AssignProcessToJobObject(self.handle, proc_handle);
            }
        }
    }

    impl Drop for JobGuard {
        fn drop(&mut self) {
            unsafe {
                if !self.handle.is_null() {
                    CloseHandle(self.handle);
                }
            }
        }
    }
}

struct BackendGuard {
    child: Option<Child>,
    #[cfg(windows)]
    _job: Option<win_job::JobGuard>,
}

impl BackendGuard {
    fn shutdown(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for BackendGuard {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct AppBackendState(Arc<Mutex<Option<BackendGuard>>>);

fn resolve_user_data_dir() -> PathBuf {
    if let Ok(v) = env::var("CYCLONE_USER_DATA_DIR") {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Ok(appdata) = env::var("APPDATA") {
        if !appdata.trim().is_empty() {
            return PathBuf::from(appdata).join("CycloneIVStudio");
        }
    }
    if let Ok(profile) = env::var("USERPROFILE") {
        return PathBuf::from(profile)
            .join("AppData")
            .join("Roaming")
            .join("CycloneIVStudio");
    }
    env::temp_dir().join("CycloneIVStudio")
}

fn append_log(log_path: &Path, line: &str) {
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(f, "{line}");
    }
}

fn find_sidecar_exe(resource_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Ok(override_bin) = env::var("CYCLONE_BACKEND_BIN") {
        let p = PathBuf::from(override_bin.trim());
        if p.is_file() {
            return Ok(p);
        }
        return Err(format!(
            "CYCLONE_BACKEND_BIN points to a missing file: {}",
            p.display()
        ));
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(res) = resource_dir {
        candidates.push(res.join("sidecar").join("cyclone-backend").join("cyclone-backend.exe"));
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("sidecar").join("cyclone-backend").join("cyclone-backend.exe"));
            if let Some(p1) = exe_dir.parent() {
                candidates.push(p1.join("sidecar").join("cyclone-backend").join("cyclone-backend.exe"));
                if let Some(p2) = p1.parent() {
                    candidates.push(p2.join("sidecar").join("cyclone-backend").join("cyclone-backend.exe"));
                }
            }
        }
    }

    for cand in &candidates {
        if cand.is_file() {
            let s = cand.to_string_lossy();
            if let Some(stripped) = s.strip_prefix(r"\\?\") {
                return Ok(PathBuf::from(stripped));
            }
            return Ok(cand.clone());
        }
    }

    let searched = candidates
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join("; ");
    Err(format!("Could not locate cyclone-backend.exe (searched: {searched})"))
}

fn js_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn launch_sidecar(
    resource_dir: Option<PathBuf>,
    user_data_dir: &Path,
    log_path: &Path,
    state_ref: Arc<Mutex<Option<BackendGuard>>>,
) -> Result<u16, String> {
    if env::var("CYCLONE_FORCE_BACKEND_FAIL").as_deref() == Ok("1") {
        let msg = "Simulated backend startup failure (CYCLONE_FORCE_BACKEND_FAIL=1)".to_string();
        append_log(log_path, &format!("[tauri] ERROR: {msg}"));
        return Err(msg);
    }

    let sidecar_exe = find_sidecar_exe(resource_dir)?;
    let sidecar_dir = sidecar_exe
        .parent()
        .ok_or_else(|| "Invalid sidecar executable path".to_string())?
        .to_path_buf();

    append_log(
        log_path,
        &format!("[tauri] Starting sidecar: {}", sidecar_exe.display()),
    );

    let mut cmd = Command::new(&sidecar_exe);
    cmd.args([
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--user-data-dir",
        &user_data_dir.to_string_lossy(),
        "--log-level",
        "info",
    ])
    .current_dir(&sidecar_dir)
    .env("CYCLONE_BUNDLE_DIR", &sidecar_dir)
    .env("CYCLONE_USER_DATA_DIR", user_data_dir)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {e}", sidecar_exe.display()))?;

    #[cfg(windows)]
    let job = {
        let j = win_job::JobGuard::new();
        if let Some(ref guard) = j {
            guard.assign(&child);
        }
        j
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Sidecar stdout handle unavailable".to_string())?;
    let stderr = child.stderr.take();

    {
        let mut slot = state_ref.lock().map_err(|_| "State lock poisoned".to_string())?;
        *slot = Some(BackendGuard {
            child: Some(child),
            #[cfg(windows)]
            _job: job,
        });
    }

    if let Some(err_stream) = stderr {
        let err_log = log_path.to_path_buf();
        std::thread::spawn(move || {
            let reader = BufReader::new(err_stream);
            for line in reader.lines().map_while(Result::ok) {
                append_log(&err_log, &format!("[stderr] {line}"));
            }
        });
    }

    let (tx, rx) = mpsc::channel::<Result<u16, String>>();
    let out_log = log_path.to_path_buf();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut sent_port = false;
        for line in reader.lines().map_while(Result::ok) {
            append_log(&out_log, &format!("[stdout] {line}"));
            if !sent_port {
                if let Some(rest) = line.trim().strip_prefix("CYCLONE_PORT=") {
                    if let Ok(port) = rest.trim().parse::<u16>() {
                        if port > 0 {
                            sent_port = true;
                            let _ = tx.send(Ok(port));
                        }
                    }
                }
            }
        }
        if !sent_port {
            let _ = tx.send(Err(
                "Backend process exited before reporting a listening port.".to_string(),
            ));
        }
    });

    match rx.recv_timeout(Duration::from_secs(25)) {
        Ok(Ok(port)) => {
            append_log(log_path, &format!("[tauri] Sidecar listening on 127.0.0.1:{port}"));
            Ok(port)
        }
        Ok(Err(msg)) => {
            append_log(log_path, &format!("[tauri] ERROR: {msg}"));
            if let Ok(mut slot) = state_ref.lock() {
                if let Some(mut guard) = slot.take() {
                    guard.shutdown();
                }
            }
            Err(msg)
        }
        Err(_) => {
            let msg = "Timed out after 25s waiting for backend startup.".to_string();
            append_log(log_path, &format!("[tauri] ERROR: {msg}"));
            if let Ok(mut slot) = state_ref.lock() {
                if let Some(mut guard) = slot.take() {
                    guard.shutdown();
                }
            }
            Err(msg)
        }
    }
}

fn main() {
    let backend_state = Arc::new(Mutex::new(None::<BackendGuard>));
    let app = tauri::Builder::default()
        .manage(AppBackendState(Arc::clone(&backend_state)))
        .setup(move |app| {
            let handle = app.handle().clone();
            let resource_dir = app.path().resource_dir().ok();
            let user_data = resolve_user_data_dir();
            let _ = fs::create_dir_all(user_data.join("logs"));
            let _ = fs::create_dir_all(user_data.join("projects"));
            let log_path = user_data.join("logs").join("backend.log");
            let state_clone = Arc::clone(&backend_state);

            std::thread::spawn(move || {
                match launch_sidecar(resource_dir, &user_data, &log_path, state_clone) {
                    Ok(port) => {
                        let url_str = format!("http://127.0.0.1:{port}/");
                        if let (Some(win), Ok(url)) = (handle.get_webview_window("main"), Url::parse(&url_str)) {
                            let _ = win.navigate(url);
                        }
                    }
                    Err(err_msg) => {
                        std::thread::sleep(Duration::from_millis(250));
                        if let Some(win) = handle.get_webview_window("main") {
                            let js = format!(
                                "window.showBackendError && window.showBackendError({}, {});",
                                js_quote(&err_msg),
                                js_quote(&log_path.to_string_lossy())
                            );
                            let _ = win.eval(&js);
                        }
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building Cyclone IV Studio desktop app");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            let arc = Arc::clone(&app_handle.state::<AppBackendState>().0);
            if let Ok(mut slot) = arc.lock() {
                if let Some(mut guard) = slot.take() {
                    guard.shutdown();
                }
            };
        }
    });
}
