//! One portal session authorizes capture, input and clipboard. Restore tokens stay local.
use ashpd::desktop::{
    clipboard::Clipboard,
    remote_desktop::{DeviceType, KeyState, RemoteDesktop, SelectDevicesOptions},
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType},
    PersistMode, Session,
};
use base64::Engine;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::os::fd::OwnedFd;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("Portal runtime")
});
static PROFILE: OnceLock<PathBuf> = OnceLock::new();
static STATE: Mutex<State> = Mutex::new(State {
    epoch: 0,
    pending: false,
    error: None,
    session: None,
    portal: None,
    cancel: None,
});
struct State {
    epoch: u64,
    pending: bool,
    error: Option<String>,
    session: Option<Arc<Session<RemoteDesktop>>>,
    portal: Option<Arc<Portal>>,
    cancel: Option<tokio::sync::watch::Sender<bool>>,
}
struct Portal {
    desktop: RemoteDesktop,
    screen: Screencast,
    session: Arc<Session<RemoteDesktop>>,
    displays: Vec<Value>,
    keyboard: bool,
    pointer: bool,
    clipboard: Option<Clipboard>,
    selection: Mutex<Option<(String, Vec<u8>, u64)>>,
    input: Mutex<Input>,
}
enum Input {
    Eis(crate::remote_eis::Eis),
    Notify {
        keys: HashSet<i32>,
        buttons: HashSet<i32>,
    },
}
pub fn is_wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v == "wayland")
}
pub fn initialize(profile: &std::path::Path, enabled: bool) {
    let _ = PROFILE.set(profile.join("remote-portal-token"));
    if enabled && PROFILE.get().is_some_and(|p| p.exists()) {
        start();
    }
}
fn portal() -> Result<Arc<Portal>, String> {
    STATE
        .lock()
        .map_err(|_| "Portal unavailable")?
        .portal
        .clone()
        .ok_or("Allow the Wayland screen/input session on this computer's Connections page")
        .map_err(str::to_owned)
}
fn block<T>(
    future: impl std::future::Future<Output = ashpd::Result<T>>,
    duration: Duration,
) -> Result<T, String> {
    RUNTIME.block_on(async {
        tokio::time::timeout(duration, future)
            .await
            .map_err(|_| "Portal operation timed out".to_string())?
            .map_err(|e| e.to_string())
    })
}
pub fn stop() {
    let session = if let Ok(mut state) = STATE.lock() {
        state.epoch += 1;
        state.pending = false;
        state.portal = None;
        if let Some(cancel) = state.cancel.take() {
            cancel.send_replace(true);
        }
        state.session.take()
    } else {
        None
    };
    if let Some(session) = session {
        RUNTIME.spawn(async move {
            let _ = session.close().await;
        });
    }
}
pub fn start() {
    let epoch = {
        let Ok(mut state) = STATE.lock() else {
            return;
        };
        if state.pending || state.portal.is_some() {
            return;
        }
        state.pending = true;
        state.error = None;
        state.epoch += 1;
        state.epoch
    };
    RUNTIME.spawn(async move {
        let result = open(epoch).await;
        let mut state = match STATE.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        if state.epoch != epoch {
            return;
        }
        state.pending = false;
        match result {
            Ok(portal) => state.portal = Some(portal),
            Err(error) => {
                state.error = Some(error);
                if let Some(cancel) = state.cancel.take() {
                    cancel.send_replace(true);
                }
                if let Some(session) = state.session.take() {
                    RUNTIME.spawn(async move {
                        let _ = session.close().await;
                    });
                }
            }
        }
    });
}
async fn open(epoch: u64) -> Result<Arc<Portal>, String> {
    let (cancel, cancelled) = tokio::sync::watch::channel(false);
    {
        let mut state = STATE.lock().map_err(|_| "Portal unavailable")?;
        if state.epoch != epoch {
            return Err("Portal request cancelled".into());
        }
        state.cancel = Some(cancel);
    }
    let desktop = RemoteDesktop::new().await.map_err(|e| e.to_string())?;
    let screen = Screencast::with_connection(desktop.connection().clone())
        .await
        .map_err(|e| e.to_string())?;
    let session = Arc::new(
        desktop
            .create_session(Default::default())
            .await
            .map_err(|e| e.to_string())?,
    );
    {
        let mut state = STATE.lock().map_err(|_| "Portal unavailable")?;
        if state.epoch != epoch {
            return Err("Portal request cancelled".into());
        }
        state.session = Some(session.clone());
    }
    // Subscribe before Start, so closing a permission prompt cannot resurrect an active session.
    let watched = session.clone();
    let mut closed_cancel = cancelled.clone();
    RUNTIME.spawn(async move {
        if let Ok(closed) = watched.receive_closed().await {
            futures_util::pin_mut!(closed);
            let closed = tokio::select! { closed = closed.next() => closed, _ = closed_cancel.changed() => None };
            if closed.is_some() {
                if let Ok(mut state) = STATE.lock() {
                    if state.epoch == epoch {
                        state.epoch += 1;
                        state.pending = false;
                        state.portal = None;
                        state.session = None;
                        if let Some(cancel) = state.cancel.take() { cancel.send_replace(true); }
                        state.error = Some("The compositor ended screen access".into());
                    }
                }
                crate::computer::release_remote_input();
                crate::remote_media::stop();
            }
        }
    });
    let token = PROFILE
        .get()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .filter(|s| s.len() <= 4096);
    // Restore tokens are single-use. A failed attempt must not replay the consumed token.
    if let Some(path) = PROFILE.get() {
        if path.exists() {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    desktop
        .select_devices(
            &session,
            SelectDevicesOptions::default()
                .set_devices(DeviceType::Keyboard | DeviceType::Pointer)
                .set_persist_mode(PersistMode::ExplicitlyRevoked)
                .set_restore_token(token.as_deref()),
        )
        .await
        .map_err(|e| e.to_string())?
        .response()
        .map_err(|e| e.to_string())?;
    screen
        .select_sources(
            &session,
            SelectSourcesOptions::default()
                .set_sources(Some(SourceType::Monitor.into()))
                .set_multiple(true)
                .set_cursor_mode(CursorMode::Embedded),
        )
        .await
        .map_err(|e| e.to_string())?
        .response()
        .map_err(|e| e.to_string())?;
    let clipboard = match Clipboard::with_connection(desktop.connection().clone()).await {
        Ok(clipboard)
            if clipboard
                .request(&session, Default::default())
                .await
                .is_ok() =>
        {
            Some(clipboard)
        }
        _ => None,
    };
    let response = desktop
        .start(&session, None, Default::default())
        .await
        .map_err(|e| e.to_string())?
        .response()
        .map_err(|e| e.to_string())?;
    if STATE.lock().map_err(|_| "Portal unavailable")?.epoch != epoch {
        return Err("Portal request cancelled".into());
    }
    if let Some(token) = response.restore_token() {
        if let Some(path) = PROFILE.get() {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
                .map_err(|e| e.to_string())?;
            file.write_all(token.as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
        }
    }
    let mut displays = Vec::new();
    for stream in response.streams() {
        let (width, height) = stream
            .size()
            .ok_or("Compositor omitted the screen coordinate size")?;
        if width <= 0 || height <= 0 || displays.len() >= 32 {
            return Err("Invalid portal display geometry".into());
        }
        let (x, y) = stream.position().unwrap_or((0, 0));
        displays.push(json!({"display":stream.pipe_wire_node_id(),"x":x,"y":y,"width":width,"height":height,"scale":1,"rotation":0,"mapping":stream.mapping_id()}));
    }
    if displays.is_empty() {
        return Err("No screen was selected in the compositor permission dialog".into());
    }
    let input = match desktop.connect_to_eis(&session, Default::default()).await {
        Ok(fd) => Input::Eis(
            tokio::task::spawn_blocking(move || crate::remote_eis::Eis::connect(fd))
                .await
                .map_err(|e| e.to_string())??,
        ),
        Err(error) if eis_unavailable(&error) => Input::Notify {
            keys: HashSet::new(),
            buttons: HashSet::new(),
        },
        Err(error) => return Err(error.to_string()),
    };
    let portal = Arc::new(Portal {
        desktop,
        screen,
        session,
        displays,
        keyboard: response.devices().contains(DeviceType::Keyboard),
        pointer: response.devices().contains(DeviceType::Pointer),
        clipboard: if response.is_clipboard_enabled() {
            clipboard
        } else {
            None
        },
        selection: Mutex::new(None),
        input: Mutex::new(input),
    });
    if portal.clipboard.is_some() {
        let owner = Arc::downgrade(&portal);
        RUNTIME.spawn(async move {
            let Some(portal) = owner.upgrade() else {
                return;
            };
            let Some(clipboard) = &portal.clipboard else {
                return;
            };
            let Ok(transfers) = clipboard
                .receive_selection_transfer::<RemoteDesktop>()
                .await
            else {
                return;
            };
            let Ok(path) = serde_json::to_value(portal.session.as_ref()) else { return; };
            let mut cancelled = cancelled;
            if *cancelled.borrow() { return; }
            futures_util::pin_mut!(transfers);
            loop {
                let next =
                    tokio::select! { next = transfers.next() => next, _ = cancelled.changed() => None };
                let Some((session, mime, serial)) = next else {
                    break;
                };
                if serde_json::to_value(&session).ok().as_ref() != Some(&path) {
                    continue;
                }
                let bytes = portal.selection.lock().ok().and_then(|data| {
                    data.as_ref()
                        .filter(|(m, _, generation)| {
                            m == &mime
                                && *generation == crate::computer::generation()
                                && crate::computer::remote_enabled()
                        })
                        .map(|(_, bytes, _)| bytes.clone())
                });
                let success = if let Some(bytes) = bytes {
                    match clipboard.selection_write(&portal.session, serial).await {
                        Ok(fd) => {
                            let fd: OwnedFd = fd.into();
                            let mut file = tokio::fs::File::from_std(std::fs::File::from(fd));
                            tokio::time::timeout(Duration::from_secs(3), file.write_all(&bytes))
                                .await
                                .is_ok_and(|r| r.is_ok())
                        }
                        Err(_) => false,
                    }
                } else {
                    false
                };
                let _ = clipboard
                    .selection_write_done(&portal.session, serial, success)
                    .await;
            }
        });
    }
    Ok(portal)
}
fn eis_unavailable(error: &ashpd::Error) -> bool {
    match error {
        ashpd::Error::RequiresVersion(_, _) => true,
        ashpd::Error::Zbus(ashpd::zbus::Error::MethodError(name, _, _))
        | ashpd::Error::Portal(ashpd::PortalError::ZBus(ashpd::zbus::Error::MethodError(
            name,
            _,
            _,
        ))) => matches!(
            name.as_str(),
            "org.freedesktop.DBus.Error.UnknownMethod"
                | "org.freedesktop.portal.Error.NotSupported"
        ),
        _ => false,
    }
}
pub fn status() -> Value {
    let Ok(state) = STATE.lock() else {
        return json!({"ready":false});
    };
    let Some(portal) = &state.portal else {
        return json!({"ready":false,"pending":state.pending,"error":state.error,"epoch":state.epoch});
    };
    let (input, text, generation) = match portal.input.lock() {
        Ok(mut input) => match &mut *input {
            Input::Eis(eis) => (
                eis.refresh().is_ok()
                    && portal.keyboard
                    && portal.pointer
                    && eis.keyboard()
                    && eis.pointer_available(),
                eis.text_available(),
                eis.generation,
            ),
            Input::Notify { .. } => (portal.keyboard && portal.pointer, true, 0),
        },
        Err(_) => (false, false, 0),
    };
    json!({"ready":true,"input":input,"text":text,"clipboard":portal.clipboard.is_some(),"displays":portal.displays,"epoch":state.epoch,"inputGeneration":generation})
}
pub fn pipewire_fd() -> Result<OwnedFd, String> {
    let p = portal()?;
    block(
        p.screen
            .open_pipe_wire_remote(&p.session, Default::default()),
        Duration::from_secs(2),
    )
}
pub fn clear_clipboard() {
    if let Ok(p) = portal() {
        if let Ok(mut selection) = p.selection.lock() {
            *selection = None;
        }
    }
}
pub fn release() {
    let Ok(p) = portal() else {
        return;
    };
    let Ok(mut input) = p.input.lock() else {
        return;
    };
    let result = match &mut *input {
        Input::Eis(eis) => eis.release(),
        Input::Notify { keys, buttons } => {
            let keys: Vec<i32> = keys.drain().collect();
            let buttons: Vec<i32> = buttons.drain().collect();
            block(
                async {
                    for code in keys {
                        p.desktop
                            .notify_keyboard_keycode(
                                &p.session,
                                code,
                                KeyState::Released,
                                Default::default(),
                            )
                            .await?;
                    }
                    for code in buttons {
                        p.desktop
                            .notify_pointer_button(
                                &p.session,
                                code,
                                KeyState::Released,
                                Default::default(),
                            )
                            .await?;
                    }
                    Ok(())
                },
                Duration::from_millis(150),
            )
        }
    };
    if result.is_err() {
        drop(input);
        stop();
    }
}
pub fn events(display: u64, events: &[Value]) -> Result<(), String> {
    let p = portal()?;
    let geometry = p
        .displays
        .iter()
        .find(|d| d["display"] == display)
        .ok_or("Portal display unavailable")?;
    let mut input = p.input.lock().map_err(|_| "Portal input unavailable")?;
    let result = (|| {
        for event in events {
            if !crate::computer::remote_enabled() {
                return Err("Remote access stopped".into());
            }
            let down = event["down"].as_bool().unwrap_or(false);
            let key_state = if down {
                KeyState::Pressed
            } else {
                KeyState::Released
            };
            match event["type"].as_str() {
                Some("move") => {
                    let x = event["x"]
                        .as_f64()
                        .filter(|n| n.is_finite() && (0.0..1.0).contains(n))
                        .ok_or("Invalid pointer x")?;
                    let y = event["y"]
                        .as_f64()
                        .filter(|n| n.is_finite() && (0.0..1.0).contains(n))
                        .ok_or("Invalid pointer y")?;
                    match &mut *input {
                        Input::Eis(eis) => {
                            eis.pointer(geometry["mapping"].as_str(), p.displays.len() == 1, x, y)?
                        }
                        Input::Notify { .. } => block(
                            p.desktop.notify_pointer_motion_absolute(
                                &p.session,
                                display as u32,
                                x * geometry["width"].as_f64().ok_or("Invalid geometry")?,
                                y * geometry["height"].as_f64().ok_or("Invalid geometry")?,
                                Default::default(),
                            ),
                            Duration::from_millis(150),
                        )?,
                    }
                }
                Some("key") => {
                    let code = i32::from(crate::computer::physical_key(
                        event["code"].as_str().ok_or("Physical key code required")?,
                    )?) - 8;
                    if event["down"].as_bool().is_none() || code < 0 {
                        return Err("Invalid key event".into());
                    }
                    match &mut *input {
                        Input::Eis(eis) => eis.key(code as u32, down)?,
                        Input::Notify { keys, .. } => {
                            if down {
                                keys.insert(code);
                            } else {
                                keys.remove(&code);
                            }
                            block(
                                p.desktop.notify_keyboard_keycode(
                                    &p.session,
                                    code,
                                    key_state,
                                    Default::default(),
                                ),
                                Duration::from_millis(150),
                            )?;
                        }
                    }
                }
                Some("button") => {
                    let code = match event["button"].as_u64() {
                        Some(0) => 272,
                        Some(1) => 274,
                        Some(2) => 273,
                        _ => return Err("Invalid button".into()),
                    };
                    if event["down"].as_bool().is_none() {
                        return Err("Missing button state".into());
                    }
                    match &mut *input {
                        Input::Eis(eis) => eis.button(code as u32, down)?,
                        Input::Notify { buttons, .. } => {
                            if down {
                                buttons.insert(code);
                            } else {
                                buttons.remove(&code);
                            }
                            block(
                                p.desktop.notify_pointer_button(
                                    &p.session,
                                    code,
                                    key_state,
                                    Default::default(),
                                ),
                                Duration::from_millis(150),
                            )?;
                        }
                    }
                }
                Some("scroll") => {
                    let amount = event["amount"]
                        .as_f64()
                        .filter(|n| n.is_finite() && n.abs() <= 100.0)
                        .ok_or("Invalid scroll")?;
                    let (x, y) = match event["axis"].as_str() {
                        Some("x") => (amount * 40.0, 0.0),
                        Some("y") => (0.0, amount * 40.0),
                        _ => return Err("Invalid scroll axis".into()),
                    };
                    match &mut *input {
                        Input::Eis(eis) => eis.scroll(x as f32, y as f32)?,
                        Input::Notify { .. } => block(
                            p.desktop
                                .notify_pointer_axis(&p.session, x, y, Default::default()),
                            Duration::from_millis(150),
                        )?,
                    }
                }
                Some("text") => {
                    let text = event["text"]
                        .as_str()
                        .filter(|s| s.chars().count() <= 4000 && !s.contains('\0'))
                        .ok_or("Invalid text")?;
                    match &mut *input {
                        Input::Eis(eis) => eis.text(text)?,
                        Input::Notify { .. } => block(
                            async {
                                for c in text.chars() {
                                    let sym = if (c as u32) < 256 {
                                        c as u32
                                    } else {
                                        0x01000000 | c as u32
                                    };
                                    p.desktop
                                        .notify_keyboard_keysym(
                                            &p.session,
                                            sym as i32,
                                            KeyState::Pressed,
                                            Default::default(),
                                        )
                                        .await?;
                                    p.desktop
                                        .notify_keyboard_keysym(
                                            &p.session,
                                            sym as i32,
                                            KeyState::Released,
                                            Default::default(),
                                        )
                                        .await?;
                                }
                                Ok(())
                            },
                            Duration::from_millis(150),
                        )?,
                    }
                }
                _ => return Err("Unsupported portal input event".into()),
            }
        }
        Ok(())
    })();
    drop(input);
    // A timed-out Notify press may have landed. Closing the session releases compositor input,
    // including keysyms, instead of guessing whether it is safe to replay the release.
    if result.is_err() {
        stop();
    }
    result
}
pub fn agent_input(value: &Value, current: &Value) -> Result<(), String> {
    let display = current["display"].as_u64().ok_or("Missing display")?;
    let image = &value["geometry"];
    let point = |x: &Value, y: &Value| -> Result<Value, String> {
        let x = x.as_f64().ok_or("Missing x")?;
        let y = y.as_f64().ok_or("Missing y")?;
        let width = image["imageWidth"]
            .as_f64()
            .filter(|n| *n > 0.0)
            .ok_or("Missing image width")?;
        let height = image["imageHeight"]
            .as_f64()
            .filter(|n| *n > 0.0)
            .ok_or("Missing image height")?;
        if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 || x >= width || y >= height {
            return Err("Coordinates must be inside the observed image".into());
        }
        Ok(json!({"type":"move","x":x / width,"y":y / height}))
    };
    match value["action"].as_str() {
        Some("click" | "move" | "drag") => {
            let start = point(&value["x"], &value["y"])?;
            let destination = if value["action"] == "drag" {
                Some(point(&value["toX"], &value["toY"])?)
            } else {
                None
            };
            let button = match value["button"].as_str().unwrap_or("left") {
                "left" => 0,
                "middle" => 1,
                "right" => 2,
                _ => return Err("Invalid button".into()),
            };
            let clicks = if value["clicks"].is_null() {
                1
            } else {
                value["clicks"]
                    .as_u64()
                    .filter(|v| (1..=2).contains(v))
                    .ok_or("Use one or two clicks")?
            };
            events(display, std::slice::from_ref(&start))?;
            if let Some(end) = destination {
                events(
                    display,
                    &[json!({"type":"button","button":button,"down":true})],
                )?;
                for step in 1..=20 {
                    std::thread::sleep(Duration::from_millis(15));
                    let t = f64::from(step) / 20.0;
                    events(
                        display,
                        &[
                            json!({"type":"move", "x":start["x"].as_f64().unwrap() * (1.0-t) + end["x"].as_f64().unwrap() * t, "y":start["y"].as_f64().unwrap() * (1.0-t) + end["y"].as_f64().unwrap() * t}),
                        ],
                    )?;
                }
                events(
                    display,
                    &[json!({"type":"button","button":button,"down":false})],
                )?;
            } else if value["action"] == "click" {
                for click in 0..clicks {
                    if click > 0 {
                        std::thread::sleep(Duration::from_millis(80));
                    }
                    events(
                        display,
                        &[
                            json!({"type":"button","button":button,"down":true}),
                            json!({"type":"button","button":button,"down":false}),
                        ],
                    )?;
                }
            }
        }
        Some("text") => events(display, &[json!({"type":"text","text":value["text"]})])?,
        Some("key") => {
            let keys = value["keys"]
                .as_array()
                .filter(|v| !v.is_empty() && v.len() <= 5)
                .ok_or("Use 1–5 keys")?;
            let codes = keys
                .iter()
                .map(|key| agent_key(key.as_str().ok_or("Invalid key")?))
                .collect::<Result<Vec<_>, _>>()?;
            for code in &codes {
                events(display, &[json!({"type":"key","code":code,"down":true})])?;
            }
            for code in codes.iter().rev() {
                events(display, &[json!({"type":"key","code":code,"down":false})])?;
            }
        }
        Some("scroll") => {
            let position = point(&value["x"], &value["y"])?;
            let amount = value["amount"]
                .as_i64()
                .filter(|n| (1..=20).contains(n))
                .ok_or("Scroll amount must be 1–20")?;
            let (axis, sign) = match value["direction"].as_str() {
                Some("up") => ("y", -1),
                Some("down") => ("y", 1),
                Some("left") => ("x", -1),
                Some("right") => ("x", 1),
                _ => return Err("Invalid scroll direction".into()),
            };
            events(
                display,
                &[
                    position,
                    json!({"type":"scroll","axis":axis,"amount":amount * sign}),
                ],
            )?;
        }
        _ => return Err("Unknown input action".into()),
    }
    Ok(())
}
fn agent_key(key: &str) -> Result<String, String> {
    let code = match key {
        "Control" => "ControlLeft".into(),
        "Alt" => "AltLeft".into(),
        "Shift" => "ShiftLeft".into(),
        "Meta" => "SuperLeft".into(),
        s if s.len() == 1 && s.as_bytes()[0].is_ascii_alphabetic() => {
            format!("Key{}", s.to_ascii_uppercase())
        }
        s if s.len() == 1 && s.as_bytes()[0].is_ascii_digit() => format!("Digit{s}"),
        s => s.to_owned(),
    };
    crate::computer::physical_key(&code)?;
    Ok(code)
}
pub fn clipboard(value: &Value) -> Result<Value, String> {
    let p = portal()?;
    let clipboard = p
        .clipboard
        .as_ref()
        .ok_or("This compositor does not support remote clipboard exchange")?;
    let mime = value["mime"].as_str().ok_or("Missing clipboard type")?;
    let limit = match mime {
        "text/plain" => 1024 * 1024,
        "image/png" => 8 * 1024 * 1024,
        _ => return Err("Unsupported clipboard type".into()),
    };
    if value["direction"] == "receive" {
        let bytes = RUNTIME.block_on(async {
            let fd: OwnedFd = clipboard
                .selection_read(&p.session, mime)
                .await
                .map_err(|e| e.to_string())?
                .into();
            let file = tokio::fs::File::from_std(std::fs::File::from(fd));
            let mut bytes = Vec::new();
            tokio::time::timeout(
                Duration::from_secs(3),
                file.take(limit as u64 + 1).read_to_end(&mut bytes),
            )
            .await
            .map_err(|_| "Clipboard read timed out")?
            .map_err(|e| e.to_string())?;
            Ok::<_, String>(bytes)
        })?;
        if bytes.len() > limit {
            return Err("Clipboard exceeds the transfer limit".into());
        }
        return if mime == "text/plain" {
            Ok(json!({"text":String::from_utf8(bytes).map_err(|_| "Clipboard text is not UTF-8")?}))
        } else {
            crate::computer::clipboard_png(&bytes)?;
            Ok(json!({"data":base64::engine::general_purpose::STANDARD.encode(bytes)}))
        };
    }
    if value["direction"] != "send" {
        return Err("Invalid clipboard direction".into());
    }
    let bytes = if mime == "text/plain" {
        value["text"]
            .as_str()
            .ok_or("Missing clipboard text")?
            .as_bytes()
            .to_vec()
    } else {
        base64::engine::general_purpose::STANDARD
            .decode(
                value["data"]
                    .as_str()
                    .filter(|v| v.len() <= 12 * 1024 * 1024)
                    .ok_or("Missing or oversized PNG")?,
            )
            .map_err(|e| e.to_string())?
    };
    if bytes.len() > limit {
        return Err("Clipboard exceeds the transfer limit".into());
    }
    if mime == "image/png" {
        crate::computer::clipboard_png(&bytes)?;
    }
    let generation = value["generation"]
        .as_u64()
        .ok_or("Missing clipboard generation")?;
    if generation != crate::computer::generation() || !crate::computer::remote_enabled() {
        return Err("Control changed during clipboard exchange".into());
    }
    *p.selection.lock().map_err(|_| "Clipboard unavailable")? =
        Some((mime.into(), bytes, generation));
    block(
        clipboard.set_selection(
            &p.session,
            ashpd::desktop::clipboard::SetSelectionOptions::default().set_mime_types(&[mime]),
        ),
        Duration::from_secs(2),
    )?;
    Ok(json!({"sent":true}))
}
