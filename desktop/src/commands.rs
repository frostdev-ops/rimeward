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
    window: tauri::WebviewWindow,
    shared: State<'_, Shared>,
) -> Result<WardBrowser, String> {
    if !chromium::allows_origin(&shared, &window.url().map_err(|e| e.to_string())?).await {
        return Err("This server is not the active browser route".into());
    }
    let (port, path) = chromium::acquire(&shared, &ward).await?;
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

async fn workspace_allowed(
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
