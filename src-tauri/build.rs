fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "pty_list_shells",
                "pty_create",
                "pty_write",
                "pty_resize",
                "pty_kill",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
