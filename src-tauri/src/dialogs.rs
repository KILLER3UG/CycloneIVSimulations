use std::path::Path;

fn valid_dir(start_dir: Option<String>) -> Option<std::path::PathBuf> {
    start_dir
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_dir())
}

#[tauri::command]
pub async fn dialog_pick_folder(
    title: Option<String>,
    start_dir: Option<String>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dlg = rfd::FileDialog::new();
        if let Some(t) = title.filter(|s| !s.trim().is_empty()) {
            dlg = dlg.set_title(t);
        } else {
            dlg = dlg.set_title("Select Folder");
        }
        if let Some(dir) = valid_dir(start_dir) {
            dlg = dlg.set_directory(dir);
        }
        Ok(dlg
            .pick_folder()
            .map(|p| p.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("Folder dialog task failed: {e}"))?
}

#[tauri::command]
pub async fn dialog_open_files(
    title: Option<String>,
    start_dir: Option<String>,
    multiple: Option<bool>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dlg = rfd::FileDialog::new()
            .add_filter(
                "Quartus / HDL Files",
                &["vhd", "vhdl", "v", "sv", "qpf", "qsf", "sdc", "mif", "hex"],
            )
            .add_filter("All Files", &["*"]);
        if let Some(t) = title.filter(|s| !s.trim().is_empty()) {
            dlg = dlg.set_title(t);
        } else {
            dlg = dlg.set_title("Open File");
        }
        if let Some(dir) = valid_dir(start_dir) {
            dlg = dlg.set_directory(dir);
        }
        if multiple.unwrap_or(true) {
            Ok(dlg
                .pick_files()
                .unwrap_or_default()
                .into_iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect())
        } else {
            Ok(dlg
                .pick_file()
                .into_iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect())
        }
    })
    .await
    .map_err(|e| format!("Open file dialog task failed: {e}"))?
}

#[tauri::command]
pub async fn dialog_save_file(
    title: Option<String>,
    start_dir: Option<String>,
    default_name: Option<String>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dlg = rfd::FileDialog::new()
            .add_filter(
                "Quartus / HDL Files",
                &["vhd", "vhdl", "v", "sv", "qsf", "sdc", "mif", "hex"],
            )
            .add_filter("All Files", &["*"]);
        if let Some(t) = title.filter(|s| !s.trim().is_empty()) {
            dlg = dlg.set_title(t);
        } else {
            dlg = dlg.set_title("Save As");
        }
        if let Some(dir) = valid_dir(start_dir) {
            dlg = dlg.set_directory(dir);
        }
        if let Some(name) = default_name.filter(|s| !s.trim().is_empty()) {
            let file_name = Path::new(&name)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or(name);
            dlg = dlg.set_file_name(file_name);
        }
        Ok(dlg
            .save_file()
            .map(|p| p.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("Save file dialog task failed: {e}"))?
}
