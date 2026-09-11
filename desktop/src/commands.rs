//! What the dashboard page inside this app may ask of it — the commands
//! an approved server's runtime capability exposes. The page uses
//! them to drive a ward's local Chromium directly (scripts/app/browser-cdp.ts),
//! so frames and input never leave this machine.

use serde::Serialize;
use tauri::State;

use crate::chromium::{self, Shared};

#[derive(Serialize)]
pub struct WardBrowser {
    /// The browser websocket, on this machine, for the page to speak CDP to.
    ws: String,
    platform: &'static str,
}

/// The ward's local Chromium, launched if needed. Rejects with the reason
/// ("downloading 42%") while the browser is not ready yet.
#[tauri::command]
pub async fn ward_browser(
    ward: String,
    dsf: Option<f64>,
    window: tauri::WebviewWindow,
    shared: State<'_, Shared>,
) -> Result<WardBrowser, String> {
    if !chromium::allows_origin(&shared, &window.url().map_err(|e| e.to_string())?).await {
        return Err("This server is not the active browser route".into());
    }
    // The page's display scale, clamped like wards.ts browserScale (1–2, quarter steps).
    let dsf = dsf.filter(|v| v.is_finite()).map_or(1.0, |v| (v.clamp(1.0, 2.0) * 4.0).round() / 4.0);
    let (port, path) = chromium::acquire(&shared, &ward, dsf).await?;
    // The page's own socket is not a counted user (it cannot say goodbye
    // reliably); ward_touch keeps the instance off the reaper's list instead.
    chromium::release(&shared, &ward).await;
    Ok(WardBrowser {
        ws: format!("ws://127.0.0.1:{port}{path}"),
        platform: crate::tunnel::platform(),
    })
}

/// The page is still on it — resets the ward instance's idle clock.
#[tauri::command]
pub async fn ward_touch(
    ward: String,
    window: tauri::WebviewWindow,
    shared: State<'_, Shared>,
) -> Result<(), String> {
    if !chromium::allows_origin(&shared, &window.url().map_err(|e| e.to_string())?).await {
        return Err("This server is not the active browser route".into());
    }
    chromium::touch(&shared, &ward).await;
    Ok(())
}

pub(crate) async fn workspace_allowed(
    window: &tauri::WebviewWindow,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    let url = window.url().map_err(|_| "Window unavailable")?;
    let local = crate::runtime::local_url(app, "/").await?;
    if url.origin() == local.origin() || chromium::allows_origin(&app.state::<Shared>(), &url).await
    {
        Ok(())
    } else {
        Err("This server is not connected to this desktop".into())
    }
}

/// Export only to a destination the user selects in the native Save dialog.
#[tauri::command]
pub async fn save_document_export(
    name: String,
    data: String,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    use base64::Engine;
    use std::io::Write;
    use tauri_plugin_dialog::DialogExt;
    workspace_allowed(&window, &app).await?;
    if name.is_empty()
        || name.len() > 240
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
        || data.len() > 48 * 1024 * 1024
    {
        return Err("Invalid export filename or file too large".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "Invalid export data")?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("Exports are limited to 32 MiB".into());
    }
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(name)
        .set_parent(&window)
        .save_file(move |path| {
            let _ = send.send(path);
        });
    let Some(path) = receive.await.map_err(|_| "Save dialog unavailable")? else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|_| "Choose a local file destination")?;
    let parent = path.parent().ok_or("Invalid file destination")?;
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| "Unable to prepare export")?;
    let temporary = parent.join(format!(
        ".rimeward-export-{:032x}.tmp",
        u128::from_le_bytes(random)
    ));
    let mut created = false;
    let result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        created = true;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &path)
    })();
    if result.is_err() && created {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("Could not save export: {error}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn print_document_export(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    workspace_allowed(&window, &app).await?;
    #[cfg(target_os = "macos")]
    return window.print().map_err(|error| error.to_string());
    #[cfg(not(target_os = "macos"))]
    window
        .eval("window.print()")
        .map_err(|error| error.to_string())
}
/// A ward window uses the caller's authenticated dashboard origin and runtime.
#[tauri::command]
pub async fn open_ward_window(
    ward: String,
    title: String,
    account: String,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use std::hash::{Hash, Hasher};
    use tauri::Manager;
    workspace_allowed(&window, &app).await?;
    if account.is_empty() || account.len() > 20 || !account.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Invalid account".into());
    }
    if ward.is_empty()
        || ward.len() > 32
        || !ward
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("Invalid ward".into());
    }
    let mut url = window.url().map_err(|e| e.to_string())?;
    if url.path().trim_end_matches('/') != "/dash"
        && !(url.path().starts_with("/runtime/")
            && url.path().trim_end_matches('/').ends_with("/dash"))
    {
        return Err("Open wards from the dashboard".into());
    }
    url.set_query(None);
    url.set_fragment(None);
    url.query_pairs_mut().append_pair("ward", &ward);
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    url.as_str().hash(&mut hash);
    account.hash(&mut hash);
    let label = format!("ward-{:x}", hash.finish());
    let target = match app.get_webview_window(&label) {
        Some(existing) => existing,
        None => tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::External(url))
            .title(format!(
                "{} — Rimeward",
                title.chars().take(160).collect::<String>()
            ))
            .inner_size(960.0, 720.0)
            .min_inner_size(320.0, 240.0)
            .resizable(true)
            .build()
            .map_err(|e| e.to_string())?,
    };
    target.unminimize().map_err(|e| e.to_string())?;
    target.show().map_err(|e| e.to_string())?;
    target.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn close_ward_window(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // Closing this view needs no running backend; its capability and label are the boundary.
    if !window.label().starts_with("ward-") {
        return Err("Only a popped-out ward can close itself".into());
    }
    super::show_main(&app);
    window.destroy().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn workspace_navigation(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    workspace_allowed(&window, &app).await?;
    let mut data = crate::runtime::workspace_request(&app, None).await?;
    // Resolve the page's server origin to its paired identity, never a server user ID.
    let url = window.url().map_err(|_| "Window unavailable")?;
    if let Some(entries) = data["workspaces"].as_array() {
        let origin = url.origin().ascii_serialization();
        let device = url
            .path()
            .strip_prefix("/runtime/")
            .and_then(|path| path.split('/').next());
        let current = entries
            .iter()
            .find(|entry| {
                entry["server"].as_str() == Some(origin.as_str())
                    && entry["kind"] == "desktop"
                    && entry["device"].as_str() == device
            })
            .or_else(|| {
                entries.iter().find(|entry| {
                    entry["server"].as_str() == Some(origin.as_str()) && entry["kind"] == "server"
                })
            })
            .and_then(|entry| entry["id"].as_str())
            .map(str::to_string);
        if let Some(current) = current {
            data["current"] = current.into();
        }
    }
    Ok(data)
}
#[tauri::command]
pub async fn open_workspace(
    runtime: String,
    page: Option<String>,
    screen: Option<String>,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    workspace_allowed(&window, &app).await?;
    crate::runtime::workspace_request(
        &app,
        Some(serde_json::json!({"runtime":runtime,"page":page,"screen":screen})),
    )
    .await?;
    Ok(())
}
