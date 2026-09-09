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
            "startup_status",
            "macos_permissions",
        ]),
    ))
    .expect("tauri-build");
}
