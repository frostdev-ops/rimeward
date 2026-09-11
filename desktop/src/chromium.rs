//! The Chromium this app runs for "My computer" browser wards: the Chrome
//! for Testing build the SERVER names (HELLO carries the version its
//! playwright-core pins), downloaded once into the app's data dir, and one
//! headless instance per ward on its own profile — every login stays here.
//! The server's Playwright reaches it through a `cdp:<ward>` tunnel stream
//! (tunnel.rs); the dashboard page inside this app reaches it directly.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::StreamExt;
use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use tokio::sync::{watch, Mutex};

const IDLE: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Deserialize)]
pub struct Spec {
    pub version: String,
    pub base: String,
}

#[derive(Clone)]
pub enum State {
    Missing,
    Downloading(u8),
    Ready,
    Error(String),
}

struct Instance {
    child: Child,
    port: u16,
    ws_path: String,
    /// Streams and local viewers on it right now.
    open: u32,
    idle_since: Instant,
}

pub struct Chromium {
    data: PathBuf,
    pub bundled_extensions: PathBuf,
    /// The dashboard's origin, allowed onto the DevTools socket (Chrome 111+
    /// refuses a browser page's Origin otherwise).
    origin: String,
    profile_scope: String,
    spec: Option<Spec>,
    state: State,
    instances: HashMap<String, Instance>,
    changed: watch::Sender<u64>,
}

pub type Shared = Arc<Mutex<Chromium>>;
/// Bumps on every state change; the tunnel session forwards each as STATUS.
pub struct Changes(pub watch::Receiver<u64>);

impl Chromium {
    pub fn new(data: PathBuf, origin: String) -> (Shared, Changes) {
        let (tx, rx) = watch::channel(0);
        let c = Chromium {
            data,
            bundled_extensions: PathBuf::new(),
            origin,
            profile_scope: String::new(),
            spec: None,
            state: State::Missing,
            instances: HashMap::new(),
            changed: tx,
        };
        (Arc::new(Mutex::new(c)), Changes(rx))
    }

    pub fn status_json(&self, platform: &str) -> String {
        let (state, pct) = match &self.state {
            State::Missing => ("missing", None),
            State::Downloading(p) => ("downloading", Some(*p)),
            State::Ready => ("ready", None),
            State::Error(_) => ("error", None),
        };
        serde_json::json!({
            "platform": platform,
            "chromium": { "state": state, "pct": pct, "version": self.spec.as_ref().map(|s| s.version.as_str()) },
        })
        .to_string()
    }

    fn dir(&self) -> Option<PathBuf> {
        self.spec
            .as_ref()
            .map(|s| self.data.join("chromium").join(&s.version))
    }

    fn exe(&self) -> Option<PathBuf> {
        let dir = self.dir()?;
        let exe = archive().1.iter().fold(dir, |p, part| p.join(part));
        exe.is_file().then_some(exe)
    }

    fn bump(&self) {
        self.changed.send_modify(|n| *n += 1);
    }
}

pub async fn set_server(shared: &Shared, origin: String, device: String) {
    let mut c = shared.lock().await;
    // Separate paired accounts and servers even if their ward IDs match.
    c.profile_scope =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!("{origin}/{device}"));
    c.origin = origin;
}

pub async fn disconnected(shared: &Shared) {
    for instance in shared.lock().await.instances.values_mut() {
        instance.open = 0;
        instance.idle_since = Instant::now();
    }
}

pub async fn allows_origin(shared: &Shared, url: &url::Url) -> bool {
    shared.lock().await.origin == url.origin().ascii_serialization()
}

/// Which archive and which file inside it, per platform — playwright-core's
/// own table (lib/coreBundle.js EXECUTABLE_PATHS) for Chrome for Testing.
fn archive() -> (&'static str, &'static [&'static str]) {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => (
            "mac-arm64/chrome-mac-arm64.zip",
            &[
                "chrome-mac-arm64",
                "Google Chrome for Testing.app",
                "Contents",
                "MacOS",
                "Google Chrome for Testing",
            ],
        ),
        ("macos", _) => (
            "mac-x64/chrome-mac-x64.zip",
            &[
                "chrome-mac-x64",
                "Google Chrome for Testing.app",
                "Contents",
                "MacOS",
                "Google Chrome for Testing",
            ],
        ),
        ("windows", _) => ("win64/chrome-win64.zip", &["chrome-win64", "chrome.exe"]),
        _ => ("linux64/chrome-linux64.zip", &["chrome-linux64", "chrome"]),
    }
}

/// HELLO: the server named a build. Ready if it is here, else fetch it once.
pub async fn set_spec(shared: &Shared, spec: Spec) {
    let mut c = shared.lock().await;
    c.spec = Some(spec.clone());
    if c.exe().is_some() {
        c.state = State::Ready;
        c.bump();
        return;
    }
    if matches!(c.state, State::Downloading(_)) {
        return;
    }
    c.state = State::Downloading(0);
    c.bump();
    drop(c);
    tokio::spawn(download(shared.clone(), spec));
}

async fn download(shared: Shared, spec: Spec) {
    let dir = shared.lock().await.dir().expect("spec set");
    let result = fetch(&shared, &spec, &dir).await;
    let mut c = shared.lock().await;
    c.state = match result {
        Ok(()) if c.exe().is_some() => State::Ready,
        Ok(()) => State::Error("archive had no browser in it".into()),
        Err(e) => State::Error(e),
    };
    if let State::Error(e) = &c.state {
        eprintln!("[chromium] {e}");
    }
    c.bump();
}

async fn fetch(shared: &Shared, spec: &Spec, dir: &Path) -> Result<(), String> {
    let (suffix, _) = archive();
    let url = format!("{}{}", spec.base, suffix);
    let zip = dir.with_extension("zip");
    std::fs::create_dir_all(dir.parent().unwrap()).map_err(|e| e.to_string())?;
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&zip)
        .await
        .map_err(|e| e.to_string())?;
    let mut body = resp.bytes_stream();
    let (mut got, mut shown) = (0u64, 0u8);
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        let pct = got
            .saturating_mul(100)
            .checked_div(total)
            .unwrap_or(0)
            .min(100) as u8;
        if pct >= shown + 2 {
            shown = pct;
            let mut c = shared.lock().await;
            c.state = State::Downloading(pct);
            c.bump();
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    // ponytail: the platform's own unzip keeps the .app's symlinks and modes
    // intact; the `zip` crate if a platform ever lacks one.
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let status = match std::env::consts::OS {
        "macos" => {
            Command::new("ditto")
                .args(["-x", "-k"])
                .arg(&zip)
                .arg(dir)
                .status()
                .await
        }
        "windows" => {
            Command::new("tar")
                .arg("-xf")
                .arg(&zip)
                .arg("-C")
                .arg(dir)
                .status()
                .await
        }
        _ => {
            Command::new("unzip")
                .arg("-q")
                .arg(&zip)
                .arg("-d")
                .arg(dir)
                .status()
                .await
        }
    }
    .map_err(|e| format!("extract: {e}"))?;
    let _ = std::fs::remove_file(&zip);
    if !status.success() {
        return Err(format!("extract failed: {status}"));
    }
    // Older builds go; the server only ever names one.
    if let Ok(entries) = std::fs::read_dir(dir.parent().unwrap()) {
        for e in entries.flatten() {
            if e.path() != dir {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    Ok(())
}

/// The ward's instance, launched if needed: its DevTools port and browser
/// websocket path. Counts one more user of it until `release`.
/// `dsf` is the display scale the ward's page asked for (1–2); it only takes
/// effect on a launch, because the screencast follows the Chromium process's
/// scale (`--force-device-scale-factor`), never a per-page emulation.
pub async fn acquire(shared: &Shared, ward: &str, dsf: f64, sound: bool) -> Result<(u16, String), String> {
    if ward.is_empty()
        || ward.len() > 32
        || !ward
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("bad ward id".into());
    }
    let mut c = shared.lock().await;
    let exe = match (&c.state, c.exe()) {
        (State::Ready, Some(exe)) => exe,
        (State::Downloading(p), _) => return Err(format!("downloading Chromium {p}%")),
        (State::Error(e), _) => return Err(format!("Chromium: {e}")),
        _ => return Err("Chromium not ready yet".into()),
    };
    if let Some(i) = c.instances.get_mut(ward) {
        if matches!(i.child.try_wait(), Ok(None)) {
            i.open += 1;
            return Ok((i.port, i.ws_path.clone()));
        }
        c.instances.remove(ward);
    }
    let profile = c.data.join("profiles").join(&c.profile_scope).join(ward);
    let config = profile.join("rimeward-extensions/enabled.json");
    let extensions: Vec<PathBuf> = if config.exists() {
        serde_json::from_slice::<Vec<String>>(&std::fs::read(config).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|id| valid_extension_id(id))
            .map(|id| profile.join("rimeward-extensions").join(id))
            .collect()
    } else {
        vec![c.bundled_extensions.join("glaze")]
    };
    let (child, port, ws_path) = launch(&exe, &profile, &c.origin, &extensions, dsf, sound).await?;
    c.instances.insert(
        ward.to_string(),
        Instance {
            child,
            port,
            ws_path: ws_path.clone(),
            open: 1,
            idle_since: Instant::now(),
        },
    );
    Ok((port, ws_path))
}

/// Somebody (the page inside this app) is still on it: restart the idle clock.
pub async fn touch(shared: &Shared, ward: &str) {
    if let Some(i) = shared.lock().await.instances.get_mut(ward) {
        i.idle_since = Instant::now();
    }
}

pub async fn release(shared: &Shared, ward: &str) {
    if let Some(i) = shared.lock().await.instances.get_mut(ward) {
        i.open = i.open.saturating_sub(1);
        i.idle_since = Instant::now();
    }
}

async fn launch(
    exe: &Path,
    profile: &Path,
    origin: &str,
    extensions: &[PathBuf],
    dsf: f64,
    sound: bool,
) -> Result<(Child, u16, String), String> {
    std::fs::create_dir_all(profile).map_err(|e| e.to_string())?;
    let active = profile.join("DevToolsActivePort");
    let _ = std::fs::remove_file(&active);
    let mut child = Command::new(exe)
        .arg("--headless=new")
        .arg("--enable-unsafe-extension-debugging")
        .args(if extensions.is_empty() {
            vec![]
        } else {
            vec![format!(
                "--load-extension={}",
                extensions
                    .iter()
                    .map(|p| p.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join(",")
            )]
        })
        .arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg(format!("--remote-allow-origins={origin}"))
        .arg("--window-size=1280,800")
        .args(if dsf > 1.0 {
            vec![format!("--force-device-scale-factor={dsf}")]
        } else {
            vec![]
        })
        // Muted unless the ward asks for sound; on, audio goes to this
        // machine's default output like any Chromium.
        .args(if sound { vec![] } else { vec!["--mute-audio".to_string()] })
        .arg("--disk-cache-size=52428800")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Chromium failed to start: {e}"))?;
    for _ in 0..100 {
        if let Ok(s) = std::fs::read_to_string(&active) {
            let mut lines = s.lines();
            if let (Some(port), Some(path)) = (lines.next(), lines.next()) {
                if let Ok(port) = port.trim().parse::<u16>() {
                    return Ok((child, port, path.trim().to_string()));
                }
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("Chromium exited: {status}"));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = child.kill().await;
    Err("Chromium did not start".into())
}

fn valid_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

/// Only extension files from the approved server, inside this ward's scoped profile.
pub async fn store_extensions(shared: &Shared, ward: &str, bytes: &[u8]) -> Result<(), String> {
    if ward.is_empty()
        || ward.len() > 32
        || !ward
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("Invalid browser ward".into());
    }
    #[derive(Deserialize)]
    struct Package {
        id: String,
        files: HashMap<String, String>,
    }
    #[derive(Deserialize)]
    struct Upload {
        packages: Vec<Package>,
    }
    let upload: Upload = serde_json::from_slice(bytes).map_err(|_| "Invalid extension upload")?;
    if upload.packages.len() > 20 {
        return Err("Too many extensions".into());
    }
    let c = shared.lock().await;
    let root = c
        .data
        .join("profiles")
        .join(&c.profile_scope)
        .join(ward)
        .join("rimeward-extensions");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let mut enabled = Vec::new();
    for package in upload.packages {
        if !valid_extension_id(&package.id)
            || package.files.len() > 2000
            || !package.files.contains_key("manifest.json")
        {
            return Err("Invalid extension package".into());
        }
        let dir = root.join(&package.id);
        let mut files = Vec::new();
        let mut total = 0;
        for (name, content) in package.files {
            if name.len() > 240
                || name.contains(['\\', ':', '<', '>', '"', '|', '?', '*'])
                || name.chars().any(char::is_control)
                || name.split('/').any(|part| {
                    let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
                    part.is_empty()
                        || part == "."
                        || part == ".."
                        || part.ends_with(['.', ' '])
                        || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                        || (stem.len() == 4
                            && (stem.starts_with("COM") || stem.starts_with("LPT"))
                            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
                })
            {
                return Err("Unsafe extension filename".into());
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(content)
                .map_err(|_| "Invalid extension content")?;
            total += bytes.len();
            if total > 30 * 1024 * 1024 {
                return Err("Extension expands beyond 30 MB".into());
            }
            files.push((name, bytes));
        }
        if !files.iter().all(|(name, bytes)| {
            std::fs::read(dir.join(name)).is_ok_and(|existing| existing == *bytes)
        }) {
            let temp = root.join(format!("{}.tmp", package.id));
            let backup = root.join(format!("{}.old", package.id));
            let _ = std::fs::remove_dir_all(&temp);
            for (name, bytes) in files {
                let target = temp.join(name);
                std::fs::create_dir_all(target.parent().ok_or("Invalid path")?)
                    .map_err(|e| e.to_string())?;
                std::fs::write(target, bytes).map_err(|e| e.to_string())?;
            }
            let _ = std::fs::remove_dir_all(&backup);
            if dir.exists() {
                std::fs::rename(&dir, &backup).map_err(|e| e.to_string())?;
            }
            if let Err(error) = std::fs::rename(&temp, &dir) {
                let _ = std::fs::rename(&backup, &dir);
                return Err(error.to_string());
            }
            let _ = std::fs::remove_dir_all(backup);
        }
        enabled.push(package.id);
    }
    let temp = root.join("enabled.tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec(&enabled).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temp, root.join("enabled.json")).map_err(|e| e.to_string())?;
    Ok(())
}

/// Every minute: an instance nobody has used for IDLE goes.
pub async fn reap_loop(shared: Shared) {
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        let mut c = shared.lock().await;
        let mut gone = Vec::new();
        for (ward, i) in c.instances.iter_mut() {
            let dead = !matches!(i.child.try_wait(), Ok(None));
            if dead || (i.open == 0 && i.idle_since.elapsed() > IDLE) {
                let _ = i.child.start_kill();
                gone.push(ward.clone());
            }
        }
        for w in gone {
            c.instances.remove(&w);
        }
    }
}

/// App exit: nothing of ours outlives the app.
pub async fn shutdown(shared: &Shared) {
    let mut c = shared.lock().await;
    for (_, mut i) in c.instances.drain() {
        let _ = i.child.kill().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn approved_server_scopes_commands_and_profiles() {
        let (shared, _) = Chromium::new(PathBuf::new(), String::new());
        let first: url::Url = "https://one.example/dash".parse().unwrap();
        assert!(!allows_origin(&shared, &first).await);
        set_server(
            &shared,
            first.origin().ascii_serialization(),
            "device-a".into(),
        )
        .await;
        let scope = shared.lock().await.profile_scope.clone();
        assert!(allows_origin(&shared, &first).await);
        for url in [
            "http://one.example/dash",
            "https://one.example:8443/dash",
            "https://one.example.evil/dash",
            "http://127.0.0.1/dash",
        ] {
            assert!(!allows_origin(&shared, &url.parse().unwrap()).await);
        }
        set_server(
            &shared,
            first.origin().ascii_serialization(),
            "device-b".into(),
        )
        .await;
        assert_ne!(scope, shared.lock().await.profile_scope);
        set_server(&shared, "https://two.example".into(), "device-a".into()).await;
        assert!(!allows_origin(&shared, &first).await);
        assert_ne!(scope, shared.lock().await.profile_scope);
        assert!(!shared.lock().await.profile_scope.contains('/'));
    }
}
