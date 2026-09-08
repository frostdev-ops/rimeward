//! macOS permission requests originate only in the signed, local app window.
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Deserialize, Serialize)]
struct Checkpoint {
    path: String,
    size: tauri::LogicalSize<f64>,
    position: tauri::LogicalPosition<f64>,
    maximized: bool,
    fullscreen: bool,
}

fn valid_path(path: &str) -> bool {
    let Ok(base) = url::Url::parse("http://localhost/") else {
        return false;
    };
    let Ok(url) = base.join(path) else {
        return false;
    };
    path.len() <= 2048
        && path.starts_with('/')
        && url.origin() == base.origin()
        && matches!(
            url.path(),
            "/dash" | "/desktop/start" | "/account" | "/devices"
        )
        && url
            .query_pairs()
            .all(|(key, _)| matches!(key.as_ref(), "setup" | "workspace"))
}

pub fn checkpoint(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    static WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _write = WRITE
        .lock()
        .map_err(|_| "Workspace checkpoint unavailable")?;
    let url = window.url().map_err(|e| e.to_string())?;
    let path = &url[url::Position::BeforePath..];
    if !valid_path(path) {
        return Err("This screen cannot be restored. Open your dashboard first.".into());
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let state = Checkpoint {
        path: path.into(),
        size: window
            .inner_size()
            .map_err(|e| e.to_string())?
            .to_logical(scale),
        position: window
            .outer_position()
            .map_err(|e| e.to_string())?
            .to_logical(scale),
        maximized: window.is_maximized().unwrap_or(false),
        fullscreen: window.is_fullscreen().unwrap_or(false),
    };
    let file = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("permission-relaunch.json");
    let temporary = file.with_extension("tmp");
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    output
        .write_all(&serde_json::to_vec(&state).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    output.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(temporary, file).map_err(|e| e.to_string())
}

pub fn restore(app: &tauri::AppHandle, bootstrap: &mut url::Url) {
    let Ok(profile) = app.path().app_data_dir() else {
        return;
    };
    let file = profile.join("permission-relaunch.json");
    if std::fs::metadata(&file).map_or(true, |metadata| metadata.len() > 8192) {
        return;
    }
    let Ok(bytes) = std::fs::read(&file) else {
        return;
    };
    let Ok(state) = serde_json::from_slice::<Checkpoint>(&bytes) else {
        return;
    };
    if !valid_path(&state.path) {
        return;
    }
    bootstrap
        .query_pairs_mut()
        .append_pair("restore", &state.path);
    if let Some(window) = app.get_webview_window("main") {
        let size = state.size;
        if size.width.is_finite() && size.height.is_finite() {
            let _ = window.set_size(tauri::LogicalSize::new(
                size.width.clamp(480., 10000.),
                size.height.clamp(400., 10000.),
            ));
        }
        // A disconnected monitor must not strand the restored window off-screen.
        if window
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .any(|m| {
                let p = m.position().to_logical::<f64>(m.scale_factor());
                let s = m.size().to_logical::<f64>(m.scale_factor());
                state.position.x >= p.x
                    && state.position.y >= p.y
                    && state.position.x + 100. <= p.x + s.width
                    && state.position.y + 60. <= p.y + s.height
            })
        {
            let _ = window.set_position(state.position);
        }
        if state.maximized {
            let _ = window.maximize();
        }
        let _ = window.set_fullscreen(state.fullscreen);
    }
    let _ = std::fs::remove_file(file);
}

#[tauri::command]
pub async fn macos_permissions(
    action: String,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let local = crate::runtime::local_url(&app, "/").await?;
    if !local_window(
        window.label(),
        &window.url().map_err(|e| e.to_string())?,
        &local,
    ) {
        return Err("Open permission setup in this Mac's local Rimeward window.".into());
    }
    match action.as_str() {
        "status" => {}
        "checkpoint" => checkpoint(&app, &window)?,
        "relaunch" => {
            checkpoint(&app, &window)?;
            app.request_restart();
        }
        "screen" | "input" => {
            checkpoint(&app, &window)?;
            tauri::async_runtime::spawn_blocking(move || {
                if action == "screen" {
                    objc2_core_graphics::CGRequestScreenCaptureAccess();
                } else {
                    use objc2_core_foundation::{CFBoolean, CFDictionary, CFString};
                    #[link(name = "ApplicationServices", kind = "framework")]
                    extern "C" {
                        static kAXTrustedCheckOptionPrompt: &'static CFString;
                        fn AXIsProcessTrustedWithOptions(
                            options: &CFDictionary<CFString, CFBoolean>,
                        ) -> bool;
                    }
                    let options = CFDictionary::from_slices(
                        &[unsafe { kAXTrustedCheckOptionPrompt }],
                        &[CFBoolean::new(true)],
                    );
                    unsafe {
                        AXIsProcessTrustedWithOptions(&options);
                    }
                }
            })
            .await
            .map_err(|e| e.to_string())?;
        }
        "settings-screen" | "settings-input" => {
            checkpoint(&app, &window)?;
            use tauri_plugin_opener::OpenerExt;
            let pane = if action == "settings-screen" {
                "Privacy_ScreenCapture"
            } else {
                "Privacy_Accessibility"
            };
            app.opener()
                .open_url(
                    format!("x-apple.systempreferences:com.apple.preference.security?{pane}"),
                    None::<&str>,
                )
                .map_err(|e| e.to_string())?;
        }
        _ => return Err("Unknown permission action".into()),
    }
    Ok(
        serde_json::json!({"screen":crate::computer::screen_permission(), "input":crate::computer::input_permission()}),
    )
}

fn local_window(label: &str, source: &url::Url, local: &url::Url) -> bool {
    label == "main" && source.origin() == local.origin()
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_the_local_main_window_can_request_permissions() {
        let local = url::Url::parse("http://127.0.0.1:61284/").unwrap();
        for (label, source, allowed) in [
            ("main", "http://127.0.0.1:61284/dash", true),
            ("other", "http://127.0.0.1:61284/dash", false),
            ("main", "https://frostdev.io/dash", false),
            ("main", "http://127.0.0.1:61285/dash", false),
            ("main", "http://localhost:61284/dash", false),
        ] {
            assert_eq!(
                super::local_window(label, &url::Url::parse(source).unwrap(), &local),
                allowed
            );
        }
    }
    #[test]
    fn restoration_never_replays_requests_or_credentials() {
        for path in [
            "/dash#p=work",
            "/dash?workspace=work#p=work",
            "/desktop/start?setup=1",
            "/account",
        ] {
            assert!(super::valid_path(path));
        }
        for path in [
            "//evil.test/dash",
            "/\\evil.test/dash",
            "/api/logout",
            "/api/native/bootstrap?token=secret",
            "/dash?token=secret",
            "https://evil.test/dash",
        ] {
            assert!(!super::valid_path(path));
        }
    }
}
