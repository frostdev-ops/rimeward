//! Rimeward desktop: a supervised local backend, persistent native workspaces,
//! and optional live access through paired remote Rimeward servers.

mod chromium;
mod commands;
mod computer;
mod input_guardian;
#[cfg(target_os = "macos")]
mod permissions;
mod remote_control;
#[cfg(target_os = "linux")]
mod remote_eis;
mod remote_files;
mod remote_media;
mod remote_session;
#[cfg(target_os = "linux")]
mod remote_wayland;
mod runtime;
mod tunnel;

use std::sync::atomic::{AtomicU8, Ordering};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

#[derive(Default)]
struct Shutdown(AtomicU8);

#[cfg(desktop)]
use tauri::menu::MenuItem;

/// The tray's status line; the tunnel task rewrites it.
#[cfg(desktop)]
struct TrayStatus(MenuItem<tauri::Wry>);

pub fn run() {
    if std::env::args_os().nth(1).as_deref()
        == Some(std::ffi::OsStr::new("--rimeward-input-guardian"))
    {
        std::process::exit(input_guardian::run());
    }
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None,
    ));
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Shutdown::default())
        .manage(runtime::Workspace::default())
        .manage(runtime::Startup::default())
        .invoke_handler(tauri::generate_handler![
            commands::ward_browser,
            commands::ward_touch,
            commands::workspace_navigation,
            commands::open_workspace,
            runtime::startup_status,
            #[cfg(target_os = "macos")]
            permissions::macos_permissions
        ])
        .setup(|app| {
            computer::initialize(app.path().app_data_dir()?);
            remote_media::initialize(runtime::resources(app.handle())?.join("media"));
            #[cfg(desktop)]
            setup_tray(app.handle())?;
            // The dashboard's origin is the one Chrome will let onto a ward's
            // DevTools socket — the page inside this window drives it directly.
            let origin = app
                .config()
                .app
                .windows
                .first()
                .and_then(|w| match &w.url {
                    tauri::WebviewUrl::External(u) => Some(u.origin().ascii_serialization()),
                    _ => None,
                })
                .unwrap_or_default();
            let (shared, changes) = chromium::Chromium::new(app.path().app_data_dir()?, origin);
            app.manage(shared.clone());
            app.manage(changes);
            tauri::async_runtime::spawn(chromium::reap_loop(shared));
            app.manage(tunnel::Tunnel::default());
            app.manage(runtime::Runtime(std::sync::Arc::new(
                tokio::sync::Mutex::new(None),
            )));
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = runtime::launch(handle.clone()).await {
                    runtime::startup_failed(&handle, error.as_ref());
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close = hide: the tunnel only helps while the app is alive.
            #[cfg(desktop)]
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            #[cfg(not(desktop))]
            let _ = (window, event);
        })
        .build(tauri::generate_context!())
        .expect("error while building Rimeward");
    app.run(|app, event| match event {
        // macOS: the dock icon brings a hidden window back.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(app),
        RunEvent::ExitRequested { api, .. } => {
            // Keep the UI event loop alive while child processes flush their state.
            // Blocking here produced the macOS hang report during Quit.
            let shutdown = app.state::<Shutdown>();
            if shutdown.0.load(Ordering::Acquire) == 2 {
                return;
            }
            api.prevent_exit();
            if shutdown
                .0
                .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                let app = app.clone();
                computer::disconnect();
                tauri::async_runtime::spawn(async move {
                    tunnel::stop(&app).await;
                    runtime::shutdown(&app).await;
                    let shared = app.state::<chromium::Shared>().inner().clone();
                    chromium::shutdown(&shared).await;
                    app.state::<Shutdown>().0.store(2, Ordering::Release);
                    app.exit(0);
                });
            }
        }
        _ => {}
    });
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The tray's status line (a no-op off desktop).
pub fn set_status(app: &AppHandle, text: &str) {
    #[cfg(desktop)]
    if let Some(t) = app.try_state::<TrayStatus>() {
        let _ = t.0.set_text(text);
    }
    #[cfg(not(desktop))]
    let _ = (app, text);
}

#[cfg(desktop)]
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, Menu};
    use tauri::tray::TrayIconBuilder;
    use tauri_plugin_autostart::ManagerExt;

    let status = MenuItem::with_id(app, "status", "Starting Rimeward…", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Rimeward", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start at login",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Rimeward", true, None::<&str>)?;
    let stop_control = MenuItem::with_id(
        app,
        "stop-control",
        "Stop remote access",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&status, &open, &autostart, &stop_control, &quit])?;
    app.manage(TrayStatus(status));
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("bundle icon"))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "stop-control" => computer::stop(),
            "autostart" => {
                let launch = app.autolaunch();
                let _ = if launch.is_enabled().unwrap_or(false) {
                    launch.disable()
                } else {
                    launch.enable()
                };
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}
