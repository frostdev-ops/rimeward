//! Self-update. The bundled runtime knows the newest desktop release (one
//! cached GitHub lookup, shared with the dashboard's chip); this module asks
//! it, then lets tauri-plugin-updater verify the release's signed manifest and
//! bundle. Policy: notify (default) — tray + OS notification, install on
//! request; download — fetch ahead, install on quit or on request; off.
//! Nothing installs mid-session unless the user asks: the runtime, tunnel and
//! Chromium are shut down gracefully first, exactly as on Quit.
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(6 * 3600);

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    Off,
    #[default]
    Notify,
    Download,
}

#[derive(Default, Serialize, Deserialize)]
struct Prefs {
    #[serde(default)]
    policy: Policy,
    /// The last notification key ("1.2.3" available, "ready:1.2.3" downloaded).
    notified: Option<String>,
    /// (version, sha256) of the bundle kept under updates/ — the download cache.
    cached: Option<(String, String)>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Default, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    #[default]
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    Installing,
    Failed,
}

#[derive(Clone, Serialize, Default)]
pub struct Status {
    current: String,
    version: Option<String>,
    notes: Option<String>,
    url: Option<String>,
    phase: Phase,
    progress: u8,
    policy: Policy,
    error: Option<String>,
}

pub struct Updates {
    dir: PathBuf,
    prefs_file: PathBuf,
    status: Mutex<Status>,
    prefs: Mutex<Prefs>,
    update: tokio::sync::Mutex<Option<Update>>,
}

impl Updates {
    fn policy(&self) -> Policy {
        self.prefs.lock().unwrap().policy
    }
    fn set<F: FnOnce(&mut Status)>(&self, f: F) {
        f(&mut self.status.lock().unwrap());
    }
    fn phase(&self) -> Phase {
        self.status.lock().unwrap().phase
    }
    fn save_prefs(&self) {
        let prefs = self.prefs.lock().unwrap();
        if let Ok(json) = serde_json::to_vec(&*prefs) {
            let _ = std::fs::write(&self.prefs_file, json);
        }
    }
    /// The cached bundle for `version`, if its bytes still match what was verified.
    fn cached_bundle(&self, version: &str) -> Option<PathBuf> {
        let (v, digest) = self.prefs.lock().unwrap().cached.clone()?;
        if v != version {
            return None;
        }
        let file = self.dir.join(format!("{version}.bin"));
        let bytes = std::fs::read(&file).ok()?;
        (hex(&sha2::Sha256::digest(&bytes)) == digest).then_some(file)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// What the runtime answers at /api/update/desktop.
#[derive(Deserialize)]
struct Offer {
    available: bool,
    url: Option<String>,
    notes: Option<String>,
    manifest: Option<String>,
}

async fn ask_runtime(app: &AppHandle) -> Result<Offer, String> {
    let (origin, token) = app
        .state::<crate::runtime::Workspace>()
        .0
        .lock()
        .await
        .clone()
        .ok_or("Local workspace is starting")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| "Local connection failed")?;
    let response = client
        .get(
            origin
                .join("/api/update/desktop")
                .map_err(|_| "Invalid local address")?,
        )
        .header("x-rimeward-native-token", token)
        .send()
        .await
        .map_err(|_| "Local workspace is unavailable")?;
    if !response.status().is_success() {
        return Err(format!("Update check failed ({})", response.status()));
    }
    response
        .json::<Offer>()
        .await
        .map_err(|_| "Invalid update response".into())
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}
fn notify_once(app: &AppHandle, key: &str, title: &str, body: &str) {
    let state = app.state::<Updates>();
    {
        let mut prefs = state.prefs.lock().unwrap();
        if prefs.notified.as_deref() == Some(key) {
            return;
        }
        prefs.notified = Some(key.to_string());
    }
    state.save_prefs();
    notify(app, title, body);
}

/// Ask the runtime, then the updater. `manual` also checks under the Off policy.
pub async fn check(app: &AppHandle, manual: bool) -> Result<(), String> {
    let state = app.state::<Updates>();
    if state.policy() == Policy::Off && !manual {
        return Ok(());
    }
    if matches!(state.phase(), Phase::Downloading | Phase::Installing) {
        return Ok(());
    }
    state.set(|s| {
        s.phase = Phase::Checking;
        s.error = None;
    });
    let result = check_inner(app, &state).await;
    if let Err(error) = &result {
        state.set(|s| {
            s.phase = if s.version.is_some() {
                Phase::Available
            } else {
                Phase::Failed
            };
            s.error = Some(error.clone());
        });
    }
    result
}

async fn check_inner(app: &AppHandle, state: &Updates) -> Result<(), String> {
    let offer = ask_runtime(app).await?;
    if !offer.available {
        state.set(|s| {
            s.phase = Phase::Idle;
            s.version = None;
        });
        crate::set_update_item(app, "Check for updates…", true);
        return Ok(());
    }
    let manifest = offer
        .manifest
        .ok_or("The release carries no updater manifest")?;
    let endpoint = url::Url::parse(&manifest).map_err(|_| "Invalid manifest address")?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        state.set(|s| {
            s.phase = Phase::Idle;
            s.version = None;
        });
        crate::set_update_item(app, "Check for updates…", true);
        return Ok(());
    };
    let version = update.version.clone();
    state.set(|s| {
        s.version = Some(version.clone());
        s.notes = update.body.clone().or(offer.notes);
        s.url = offer.url;
        s.phase = Phase::Available;
        s.progress = 0;
    });
    *state.update.lock().await = Some(update);
    if state.cached_bundle(&version).is_some() {
        state.set(|s| s.phase = Phase::Ready);
        crate::set_update_item(app, &format!("Restart to update to {version}"), true);
        return Ok(());
    }
    crate::set_update_item(app, &format!("Update to Rimeward {version}…"), true);
    notify_once(
        app,
        &version,
        &format!("Rimeward {version} is available"),
        "Install it from the Rimeward tray menu or the dashboard's update chip.",
    );
    if state.policy() == Policy::Download {
        download(app).await?;
    }
    Ok(())
}

/// Fetch and verify the bundle into updates/<version>.bin (skipped when the
/// cache already holds it). Signature verification is the plugin's, over the
/// bytes it downloaded; the digest re-checks the cached file before reuse.
pub async fn download(app: &AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<Updates>();
    let update = state
        .update
        .lock()
        .await
        .clone()
        .ok_or("No update to download")?;
    let version = update.version.clone();
    if let Some(file) = state.cached_bundle(&version) {
        state.set(|s| s.phase = Phase::Ready);
        return Ok(file);
    }
    state.set(|s| {
        s.phase = Phase::Downloading;
        s.progress = 0;
    });
    let progress = app.clone();
    let mut got = 0usize;
    let bytes = update
        .download(
            move |chunk, total| {
                got += chunk;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let pct = (got as u64 * 100 / total).min(100) as u8;
                    progress.state::<Updates>().set(|s| s.progress = pct);
                }
            },
            || {},
        )
        .await
        .map_err(|e| {
            state.set(|s| {
                s.phase = Phase::Available;
                s.error = Some(e.to_string());
            });
            e.to_string()
        })?;
    std::fs::create_dir_all(&state.dir).map_err(|e| e.to_string())?;
    let file = state.dir.join(format!("{version}.bin"));
    std::fs::write(&file, &bytes).map_err(|e| e.to_string())?;
    let digest = hex(&sha2::Sha256::digest(&bytes));
    drop(bytes);
    for entry in std::fs::read_dir(&state.dir)
        .into_iter()
        .flatten()
        .flatten()
    {
        if entry.path() != file {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    state.prefs.lock().unwrap().cached = Some((version.clone(), digest));
    state.save_prefs();
    state.set(|s| {
        s.phase = Phase::Ready;
        s.progress = 100;
    });
    crate::set_update_item(app, &format!("Restart to update to {version}"), true);
    notify_once(
        app,
        &format!("ready:{version}"),
        &format!("Rimeward {version} is ready"),
        "It installs when you quit Rimeward, or restart now from the tray menu.",
    );
    Ok(file)
}

/// Download if needed, shut the workspace down gracefully, install, relaunch.
/// Windows: the installer takes over and this process exits inside `install`.
pub async fn install_now(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Updates>();
    if state.phase() == Phase::Installing {
        return Ok(());
    }
    let file = download(app).await?;
    let update = state
        .update
        .lock()
        .await
        .clone()
        .ok_or("No update to install")?;
    state.set(|s| s.phase = Phase::Installing);
    crate::set_update_item(app, "Installing update…", false);
    let bytes = tokio::fs::read(&file).await.map_err(|e| e.to_string())?;
    crate::teardown(app).await;
    if let Err(error) = update.restart_after_install(true).install(bytes) {
        // The workspace is already down: relaunch the current build instead of
        // leaving a dead window.
        state.set(|s| {
            s.phase = Phase::Failed;
            s.error = Some(error.to_string());
        });
        app.restart();
    }
    let _ = std::fs::remove_file(&file);
    app.restart();
}

/// On Quit, after the workspace is down: a bundle downloaded ahead installs
/// now, without relaunching.
pub async fn install_on_quit(app: &AppHandle) {
    let state = app.state::<Updates>();
    if state.phase() != Phase::Ready {
        return;
    }
    let Some(update) = state.update.lock().await.clone() else {
        return;
    };
    let Some(file) = state.cached_bundle(&update.version) else {
        return;
    };
    if let Ok(bytes) = std::fs::read(&file) {
        if update.restart_after_install(false).install(bytes).is_ok() {
            let _ = std::fs::remove_file(&file);
        }
    }
}

pub fn set_policy(app: &AppHandle, policy: Policy) {
    let state = app.state::<Updates>();
    state.prefs.lock().unwrap().policy = policy;
    state.save_prefs();
    state.set(|s| s.policy = policy);
    crate::set_update_auto(app, policy == Policy::Download);
    if policy == Policy::Download && state.phase() == Phase::Available {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = download(&app).await;
        });
    }
}

/// The tray's update item: install when something is ready or offered, else check.
pub fn tray_action(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let phase = app.state::<Updates>().phase();
        let _ = if matches!(phase, Phase::Available | Phase::Ready) {
            install_now(&app).await
        } else {
            check(&app, true).await
        };
    });
}
pub fn tray_toggle_auto(app: &AppHandle) {
    let next = if app.state::<Updates>().policy() == Policy::Download {
        Policy::Notify
    } else {
        Policy::Download
    };
    set_policy(app, next);
}

#[tauri::command]
pub async fn update_status(window: tauri::WebviewWindow, app: AppHandle) -> Result<Status, String> {
    crate::commands::workspace_allowed(&window, &app).await?;
    Ok(app.state::<Updates>().status.lock().unwrap().clone())
}

#[tauri::command]
pub async fn update_action(
    action: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    crate::commands::workspace_allowed(&window, &app).await?;
    match action.as_str() {
        "check" => check(&app, true).await,
        "install" => install_now(&app).await,
        "notes" => {
            use tauri_plugin_opener::OpenerExt;
            let url = app
                .state::<Updates>()
                .status
                .lock()
                .unwrap()
                .url
                .clone()
                .ok_or("No release page")?;
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|_| "Could not open your browser".into())
        }
        "policy:off" | "policy:notify" | "policy:download" => {
            set_policy(
                &app,
                match &action[7..] {
                    "off" => Policy::Off,
                    "notify" => Policy::Notify,
                    _ => Policy::Download,
                },
            );
            Ok(())
        }
        _ => Err("Unknown update action".into()),
    }
}

/// Load the prefs, then check once the runtime is up and every six hours after.
pub fn initialize(app: &AppHandle) -> tauri::Result<()> {
    let data = app.path().app_data_dir()?;
    let prefs_file = data.join("updates.json");
    let prefs: Prefs = std::fs::read(&prefs_file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let status = Status {
        current: app.package_info().version.to_string(),
        policy: prefs.policy,
        ..Default::default()
    };
    crate::set_update_auto(app, prefs.policy == Policy::Download);
    app.manage(Updates {
        dir: data.join("updates"),
        prefs_file,
        status: Mutex::new(status),
        prefs: Mutex::new(prefs),
        update: tokio::sync::Mutex::new(None),
    });
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..150 {
            if handle
                .state::<crate::runtime::Workspace>()
                .0
                .lock()
                .await
                .is_some()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        loop {
            let _ = check(&handle, false).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn prefs_round_trip_and_defaults() {
        let prefs: super::Prefs = serde_json::from_str("{}").unwrap();
        assert_eq!(prefs.policy, super::Policy::Notify);
        assert!(prefs.cached.is_none());
        let json = serde_json::to_string(&super::Prefs {
            policy: super::Policy::Download,
            notified: Some("ready:1.2.3".into()),
            cached: Some(("1.2.3".into(), "ab".into())),
        })
        .unwrap();
        assert!(json.contains("\"policy\":\"download\""));
        let back: super::Prefs = serde_json::from_str(&json).unwrap();
        assert_eq!(back.cached.unwrap().0, "1.2.3");
        assert_eq!(super::hex(&[0, 255, 16]), "00ff10");
    }
}
