fn main() {
    // Naming page commands here generates the permissions granted by capabilities.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "ward_browser",
            "ward_touch",
            "workspace_navigation",
            "open_workspace",
            "startup_status",
        ]),
    ))
    .expect("tauri-build");
}
