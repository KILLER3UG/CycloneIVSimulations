use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
#[cfg(not(windows))]
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Serialize)]
pub struct ShellOption {
    pub id: String,
    pub label: String,
    pub path: String,
    pub default: bool,
}

#[derive(Clone, Serialize)]
struct PtyOutputEvent {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExitEvent {
    id: String,
    code: i32,
}

struct PtyInstance {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    pid: Option<u32>,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtyInstance>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn kill_all(&self) {
        let mut drained = Vec::new();
        if let Ok(mut map) = self.sessions.lock() {
            for (_id, inst) in map.drain() {
                drained.push(inst);
            }
        }
        for mut inst in drained {
            terminate_instance(&mut inst);
        }
    }
}

fn terminate_instance(inst: &mut PtyInstance) {
    #[cfg(windows)]
    if let Some(pid) = inst.pid {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    let _ = inst.child.kill();
    let _ = inst.child.wait();
}

fn find_in_path(exe_name: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    for dir in env::split_paths(&path_var) {
        let candidate = dir.join(exe_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn detect_powershell() -> Option<String> {
    #[cfg(windows)]
    {
        if let Some(p) = find_in_path("pwsh.exe") {
            return Some(p.to_string_lossy().into_owned());
        }
        if let Some(p) = find_in_path("powershell.exe") {
            return Some(p.to_string_lossy().into_owned());
        }
        let sys_root = env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        let sys_ps = PathBuf::from(sys_root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        if sys_ps.is_file() {
            return Some(sys_ps.to_string_lossy().into_owned());
        }
        Some("powershell.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        find_in_path("pwsh").map(|p| p.to_string_lossy().into_owned())
    }
}

fn detect_git_bash() -> Option<String> {
    #[cfg(windows)]
    {
        let mut candidates = Vec::new();
        if let Some(git_exe) = find_in_path("git.exe") {
            if let Some(git_dir) = git_exe.parent().and_then(|p| p.parent()) {
                candidates.push(git_dir.join("bin").join("bash.exe"));
                candidates.push(git_dir.join("usr").join("bin").join("bash.exe"));
            }
        }
        if let Ok(pf) = env::var("ProgramFiles") {
            candidates.push(PathBuf::from(&pf).join("Git").join("bin").join("bash.exe"));
        }
        if let Ok(pf86) = env::var("ProgramFiles(x86)") {
            candidates.push(PathBuf::from(&pf86).join("Git").join("bin").join("bash.exe"));
        }
        if let Ok(local) = env::var("LOCALAPPDATA") {
            candidates.push(PathBuf::from(&local).join("Programs").join("Git").join("bin").join("bash.exe"));
        }
        for c in candidates {
            if c.is_file() {
                return Some(c.to_string_lossy().into_owned());
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        find_in_path("bash").map(|p| p.to_string_lossy().into_owned())
    }
}

fn detect_shells() -> Vec<ShellOption> {
    #[cfg(windows)]
    {
        let mut list = Vec::new();
        if let Some(ps) = detect_powershell() {
            list.push(ShellOption {
                id: "powershell".to_string(),
                label: "PowerShell".to_string(),
                path: ps,
                default: true,
            });
        }
        let cmd_path = env::var("COMSPEC")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "cmd.exe".to_string());
        list.push(ShellOption {
            id: "cmd".to_string(),
            label: "Command Prompt".to_string(),
            path: cmd_path,
            default: list.is_empty(),
        });
        if let Some(gb) = detect_git_bash() {
            list.push(ShellOption {
                id: "gitbash".to_string(),
                label: "Git Bash".to_string(),
                path: gb,
                default: false,
            });
        }
        list
    }
    #[cfg(not(windows))]
    {
        let sh = env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        vec![ShellOption {
            id: "default".to_string(),
            label: Path::new(&sh)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("sh")
                .to_string(),
            path: sh,
            default: true,
        }]
    }
}

fn resolve_shell_program(shell_id: Option<&str>) -> (String, Vec<String>) {
    let key = shell_id.unwrap_or("").trim().to_ascii_lowercase();
    match key.as_str() {
        "cmd" | "cmd.exe" => {
            let cmd = env::var("COMSPEC")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "cmd.exe".to_string());
            (cmd, Vec::new())
        }
        "gitbash" | "git-bash" | "bash" => {
            if let Some(gb) = detect_git_bash() {
                (gb, vec!["--login".to_string(), "-i".to_string()])
            } else {
                (detect_powershell().unwrap_or_else(|| "cmd.exe".to_string()), Vec::new())
            }
        }
        _ => {
            #[cfg(windows)]
            {
                (
                    detect_powershell().unwrap_or_else(|| "powershell.exe".to_string()),
                    vec!["-NoLogo".to_string()],
                )
            }
            #[cfg(not(windows))]
            {
                (env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string()), Vec::new())
            }
        }
    }
}

#[tauri::command]
pub fn pty_list_shells() -> Vec<ShellOption> {
    detect_shells()
}

#[tauri::command]
pub fn pty_create(
    app: AppHandle,
    state: State<'_, PtyManager>,
    id: String,
    shell: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    extra_paths: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let pty_system = native_pty_system();
    let pty_size = PtySize {
        rows: rows.unwrap_or(24).max(2),
        cols: cols.unwrap_or(80).max(10),
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(pty_size)
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let (program, args) = resolve_shell_program(shell.as_deref());
    let mut cmd = CommandBuilder::new(&program);
    for arg in &args {
        cmd.arg(arg);
    }

    let requested_cwd = cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .map(|p| {
            if !p.is_dir() {
                let _ = std::fs::create_dir_all(&p);
            }
            p
        })
        .filter(|p| p.is_dir());

    let user_home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|p| p.is_dir());

    let resolved_cwd = requested_cwd
        .or(user_home)
        .or_else(|| env::current_dir().ok())
        .unwrap_or_else(env::temp_dir);
    cmd.cwd(&resolved_cwd);

    // Prepend Quartus bin64 + bundled GHDL bin to the existing system PATH
    let mut path_entries: Vec<PathBuf> = Vec::new();
    if let Some(extras) = extra_paths {
        for raw in extras {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                let p = PathBuf::from(trimmed);
                if p.is_dir() {
                    path_entries.push(p);
                }
            }
        }
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            for cand in [
                exe_dir.join("sidecar").join("cyclone-backend").join("ghdl").join("bin"),
                exe_dir.join("sidecar").join("cyclone-backend").join("_internal").join("ghdl").join("bin"),
                exe_dir.join("ghdl").join("bin"),
            ] {
                if cand.is_dir() {
                    path_entries.push(cand);
                }
            }
        }
    }
    if !path_entries.is_empty() {
        if let Some(existing) = env::var_os("PATH") {
            path_entries.extend(env::split_paths(&existing));
        }
        if let Ok(joined) = env::join_paths(path_entries) {
            cmd.env("PATH", joined);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell '{program}': {e}"))?;
    let pid = child.process_id();
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

    // Replace any existing session with the same id cleanly
    let mut old_inst = None;
    if let Ok(mut map) = state.sessions.lock() {
        old_inst = map.insert(
            id.clone(),
            PtyInstance {
                master: pair.master,
                writer,
                child,
                pid,
            },
        );
    }
    if let Some(mut old) = old_inst {
        terminate_instance(&mut old);
    }

    let sessions_arc = Arc::clone(&state.sessions);
    let term_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let valid_len = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(err) => {
                            if err.error_len().is_none() {
                                err.valid_up_to()
                            } else {
                                pending.len()
                            }
                        }
                    };
                    if valid_len > 0 {
                        let chunk: Vec<u8> = pending.drain(..valid_len).collect();
                        let text = String::from_utf8_lossy(&chunk).into_owned();
                        let _ = app.emit(
                            "pty-output",
                            PtyOutputEvent {
                                id: term_id.clone(),
                                data: text,
                            },
                        );
                    }
                }
                Err(_) => break,
            }
        }
        if !pending.is_empty() {
            let text = String::from_utf8_lossy(&pending).into_owned();
            let _ = app.emit(
                "pty-output",
                PtyOutputEvent {
                    id: term_id.clone(),
                    data: text,
                },
            );
        }
        let exit_code = if let Ok(mut map) = sessions_arc.lock() {
            if let Some(inst) = map.get_mut(&term_id) {
                match inst.child.try_wait() {
                    Ok(Some(status)) => status.exit_code() as i32,
                    _ => 0,
                }
            } else {
                0
            }
        } else {
            0
        };
        let _ = app.emit(
            "pty-exit",
            PtyExitEvent {
                id: term_id,
                code: exit_code,
            },
        );
    });

    Ok(serde_json::json!({
        "ok": true,
        "id": id,
        "cwd": resolved_cwd.to_string_lossy(),
        "shell": program,
        "pid": pid,
    }))
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    let mut map = state.sessions.lock().map_err(|_| "PTY lock poisoned".to_string())?;
    let inst = map
        .get_mut(&id)
        .ok_or_else(|| format!("Terminal session '{id}' not found"))?;
    inst.writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("PTY write failed: {e}"))?;
    let _ = inst.writer.flush();
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.sessions.lock().map_err(|_| "PTY lock poisoned".to_string())?;
    if let Some(inst) = map.get(&id) {
        inst.master
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(10),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("PTY resize failed: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyManager>, id: String) -> Result<(), String> {
    let removed = {
        let mut map = state.sessions.lock().map_err(|_| "PTY lock poisoned".to_string())?;
        map.remove(&id)
    };
    if let Some(mut inst) = removed {
        std::thread::spawn(move || {
            terminate_instance(&mut inst);
        });
    }
    Ok(())
}
