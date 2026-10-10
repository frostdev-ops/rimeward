fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // Cua's ScreenCaptureKit bridge links the system Swift concurrency runtime.
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
    // Naming page commands here generates the permissions granted by capabilities.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "ward_browser",
            "ward_touch",
            "workspace_navigation",
            "open_workspace",
            "open_ward_window",
            "save_document_export",
            "print_document_export",
            "close_ward_window",
            "startup_status",
            "update_status",
            "update_action",
            "macos_permissions",
        ]),
    ))
    .expect("tauri-build");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Tauri links Common Controls v6 only to bins; library unit tests need it too.
        let resource = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"))
            .join("resource.lib");
        assert!(resource.is_file(), "Tauri Windows resource is missing");
        println!("cargo:rustc-link-arg={}", resource.display());
    }
}
