//! The parent owns authorization and input. The helper owns only negotiated media pipelines.
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};

static LOCATION: OnceLock<PathBuf> = OnceLock::new();
static HELPER: Mutex<Option<Helper>> = Mutex::new(None);
#[cfg(target_os = "linux")]
static SNAPSHOT: Mutex<()> = Mutex::new(());
struct Grant {
    expires: u64,
    input: bool,
    temporary: bool,
    display: u64,
    events: VecDeque<Value>,
    last_input: u64,
    inputs: u16,
}
#[derive(Default)]
struct State {
    grants: HashMap<String, Grant>,
    dead: bool,
    ready: bool,
    closing: bool,
}
struct Helper {
    child: Child,
    commands: mpsc::SyncSender<Value>,
    state: Arc<Mutex<State>>,
}
impl Drop for Helper {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.closing = true;
            for session in state.grants.keys() {
                crate::computer::release_remote_owner(session);
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
pub fn initialize(path: PathBuf) {
    let _ = LOCATION.set(path);
}
fn executable() -> Option<PathBuf> {
    LOCATION
        .get()
        .map(|p| {
            p.join(if cfg!(target_os = "windows") {
                "rimeward-media.exe"
            } else {
                "rimeward-media"
            })
        })
        .filter(|p| p.is_file())
}
pub fn available() -> bool {
    executable().is_some()
}
fn clock() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn launch() -> Result<Helper, String> {
    let binary = executable().ok_or("Bundled media helper unavailable")?;
    let location = binary.parent().ok_or("Invalid media helper path")?;
    let mut command = Command::new(&binary);
    #[cfg(target_os = "linux")]
    let pipewire = if crate::remote_wayland::is_wayland() {
        Some(crate::remote_wayland::pipewire_fd()?)
    } else {
        None
    };
    command.env_clear();
    for key in [
        "HOME",
        "USERPROFILE",
        "SYSTEMROOT",
        "WINDIR",
        "TMPDIR",
        "TEMP",
        "DISPLAY",
        "XAUTHORITY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
        "PULSE_SERVER",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut paths = vec![location.to_path_buf(), location.join("bin")];
    if let Some(windows) = std::env::var_os("SYSTEMROOT") {
        paths.push(Path::new(&windows).join("System32"));
    }
    command.env(
        "PATH",
        std::env::join_paths(paths).map_err(|e| e.to_string())?,
    );
    command.env(
        "RIMEWARD_MEDIA_PLUGIN_DIR",
        location.join("lib/gstreamer-1.0"),
    );
    command.env(
        "GST_PLUGIN_SCANNER_1_0",
        location.join(if cfg!(target_os = "windows") {
            "libexec/gstreamer-1.0/gst-plugin-scanner.exe"
        } else {
            "libexec/gstreamer-1.0/gst-plugin-scanner"
        }),
    );
    command.env(
        "GST_REGISTRY_1_0",
        std::env::temp_dir().join(format!("rimeward-gst-registry-{}.bin", std::process::id())),
    );
    command.env("LD_LIBRARY_PATH", location.join("lib"));
    command.env("SPA_PLUGIN_DIR", location.join("lib/spa-0.2"));
    command.env("PIPEWIRE_MODULE_DIR", location.join("lib/pipewire-0.3"));
    command.env("PIPEWIRE_CONFIG_DIR", location.join("share/pipewire"));
    #[cfg(target_os = "linux")]
    if let Some(pipewire) = &pipewire {
        use std::os::fd::AsRawFd;
        use std::os::unix::process::CommandExt;
        let fd = pipewire.as_raw_fd();
        command.env("RIMEWARD_PIPEWIRE_FD", fd.to_string());
        // Only this portal-granted descriptor is inherited. Parent retains the session authority.
        unsafe {
            command.pre_exec(move || {
                if libc::fcntl(fd, libc::F_SETFD, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Media helper failed: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("Media helper input unavailable")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Media helper output unavailable")?;
    let state = Arc::new(Mutex::new(State::default()));
    let (commands, input) = mpsc::sync_channel::<Value>(32);
    let write_state = state.clone();
    std::thread::spawn(move || {
        for value in input {
            if writeln!(stdin, "{value}")
                .and_then(|_| stdin.flush())
                .is_err()
            {
                break;
            }
        }
        if let Ok(mut state) = write_state.lock() {
            state.dead = true;
        }
    });
    let read_state = state.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut raw = Vec::new();
            let read = Read::by_ref(&mut reader)
                .take(3 * 1024 * 1024 + 1)
                .read_until(b'\n', &mut raw);
            if !matches!(read,Ok(n) if n>0 && n<=3*1024*1024) {
                break;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&raw) else {
                break;
            };
            let Ok(mut state) = read_state.lock() else {
                break;
            };
            if state.dead || state.closing {
                break;
            }
            if value["event"] == "ready" {
                state.ready = value["protocol"] == 1 && value["gstreamer"] == "1.28.6";
                continue;
            }
            let Some(session) = value["session"].as_str() else {
                continue;
            };
            let Some(grant) = state
                .grants
                .get_mut(session)
                .filter(|g| g.expires > clock())
            else {
                continue;
            };
            if value["event"] == "input" {
                if !grant.input {
                    continue;
                }
                let now = clock();
                if now.saturating_sub(grant.last_input) >= 1000 {
                    grant.last_input = now;
                    grant.inputs = 0;
                }
                grant.inputs += 1;
                if grant.inputs > 250 {
                    state.dead = true;
                    break;
                }
                let mut input = value["input"].clone();
                if !input.is_object() {
                    continue;
                }
                input["owner"] = session.into();
                input["display"] = grant.display.into();
                // A data channel cannot acquire ownership or change a grant. All input re-enters the shared controller.
                // Keep the grant locked through dispatch so stop/expiry cannot race an accepted input.
                if let Err(reason) = crate::computer::request("computer-event", &input) {
                    if grant.events.len() >= 128 {
                        state.dead = true;
                    } else {
                        grant
                            .events
                            .push_back(json!({"event":"input-rejected","reason":reason}));
                    }
                }
            } else {
                if value["event"] == "closed" || value["event"] == "error" {
                    grant.input = false;
                    crate::computer::release_remote_owner(session);
                }
                if grant.events.len() >= 128 {
                    state.dead = true;
                    break;
                }
                grant.events.push_back(value);
            }
        }
        if let Ok(mut state) = read_state.lock() {
            state.dead = true;
            if !state.closing {
                for session in state.grants.keys() {
                    crate::computer::release_remote_owner(session);
                }
            }
        }
    });
    Ok(Helper {
        child,
        commands,
        state,
    })
}
pub fn stop() {
    if let Ok(mut helper) = HELPER.try_lock() {
        helper.take();
    }
}
pub fn tick(now: u64, enabled: bool) {
    let Ok(mut helper) = HELPER.try_lock() else {
        return;
    };
    let Some(h) = helper.as_mut() else {
        return;
    };
    if !enabled {
        helper.take();
        return;
    }
    let mut state = match h.state.lock() {
        Ok(state) => state,
        Err(_) => return,
    };
    if state.dead {
        drop(state);
        helper.take();
        return;
    }
    let expired: Vec<String> = state
        .grants
        .iter()
        .filter(|(_, g)| g.expires <= now)
        .map(|(s, _)| s.clone())
        .collect();
    for session in expired {
        state.grants.remove(&session);
        crate::computer::release_remote_owner(&session);
        let _ = h
            .commands
            .try_send(json!({"command":"stop","session":session}));
    }
    if state.grants.is_empty() {
        drop(state);
        helper.take();
    }
}
pub fn request(value: &Value) -> Result<Value, String> {
    let mut helper = HELPER.lock().map_err(|_| "Media helper unavailable")?;
    let command = value["command"].as_str().ok_or("Missing media command")?;
    if !matches!(
        command,
        "start" | "snapshot" | "poll" | "answer" | "ice" | "stop"
    ) {
        return Err("Unknown media command".into());
    }
    let session = value["session"]
        .as_str()
        .filter(|s| s.len() == 36 && s.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-'))
        .ok_or("Invalid media session")?;
    if command == "stop" && helper.is_none() {
        return Ok(json!({"stopped":true}));
    }
    let expires = value["expires"]
        .as_u64()
        .filter(|e| *e > clock() && *e <= clock() + 31000)
        .ok_or("Media authorization expired")?;
    if helper.is_none() {
        if !matches!(command, "start" | "snapshot") {
            return Err("Media session unavailable".into());
        }
        *helper = Some(launch()?);
    }
    let h = helper.as_mut().ok_or("Media helper unavailable")?;
    let mut state = h.state.lock().map_err(|_| "Media helper unavailable")?;
    if state.dead {
        return Err("Media helper stopped".into());
    }
    if command == "start" || command == "snapshot" {
        if (command == "start" && state.grants.values().filter(|g| !g.temporary).count() >= 4)
            || state.grants.contains_key(session)
        {
            return Err("Media session already open or viewer limit reached".into());
        }
        state.grants.insert(
            session.into(),
            Grant {
                expires,
                input: value["input"] == true,
                temporary: command == "snapshot",
                display: value["display"]
                    .as_u64()
                    .ok_or("Missing authorized display")?,
                events: VecDeque::new(),
                last_input: clock(),
                inputs: 0,
            },
        );
    }
    let grant = state
        .grants
        .get_mut(session)
        .filter(|g| g.expires > clock())
        .ok_or("Media session expired")?;
    if command == "poll" {
        h.commands
            .try_send(json!({"command":"renew","session":session}))
            .map_err(|_| "Media helper is busy")?;
        grant.expires = grant.expires.max(expires);
        let events: Vec<Value> = grant.events.drain(..).collect();
        return Ok(json!({"ready":state.ready,"events":events}));
    }
    if command == "stop" {
        grant.input = false;
        crate::computer::release_remote_owner(session);
    }
    if h.commands.try_send(value.clone()).is_err() {
        if command == "start" || command == "snapshot" {
            state.grants.remove(session);
        } else if command == "stop" {
            state.dead = true;
        }
        return Err("Media helper is busy".into());
    }
    if command == "stop" {
        state.grants.remove(session);
    } else {
        grant.expires = grant.expires.max(expires);
    }
    Ok(json!({"queued":true}))
}
#[cfg(target_os = "linux")]
pub fn snapshot(display: u64, width: u64, height: u64) -> Result<Value, String> {
    let _capture = SNAPSHOT.lock().map_err(|_| "Snapshot unavailable")?;
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let session = format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    request(
        &json!({"command":"snapshot","session":session,"display":display,"width":width,"height":height,"expires":clock()+3000,"input":false}),
    )?;
    let state = HELPER
        .lock()
        .map_err(|_| "Media helper unavailable")?
        .as_ref()
        .ok_or("Media helper unavailable")?
        .state
        .clone();
    let began = std::time::Instant::now();
    let result = loop {
        let mut state = state.lock().map_err(|_| "Media helper unavailable")?;
        if state.dead || !crate::computer::remote_enabled() {
            break Err("Media helper stopped".into());
        }
        if let Some(grant) = state.grants.get_mut(&session) {
            if let Some(event) = grant.events.pop_front() {
                if event["event"] == "snapshot" {
                    break Ok(event["frame"].clone());
                }
                if event["event"] == "error" {
                    break Err(event["reason"].as_str().unwrap_or("Snapshot failed").into());
                }
            }
        } else {
            break Err("Snapshot authorization expired".into());
        }
        drop(state);
        if began.elapsed() > std::time::Duration::from_secs(3) {
            break Err("Snapshot timed out".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    if let Ok(mut state) = state.lock() {
        state.grants.remove(&session);
    }
    result
}
