//! Screen operations live in the signed parent process, behind a local stop switch.
use crate::input_guardian::Input;
use crate::remote_control::{Authority, Kind};
use base64::Engine;
use enigo::{Axis, Button, Coordinate, Direction, Key};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

struct Controller {
    authority: Authority,
    input: Option<Input>,
    displays: Vec<Value>,
    scroll: [f64; 2],
}
static CONTROLLER: Mutex<Controller> = Mutex::new(Controller {
    authority: Authority {
        owner: None,
        generation: 0,
        topology: 0,
    },
    input: None,
    displays: Vec::new(),
    scroll: [0.0; 2],
});
static CLIPBOARD: Mutex<Option<arboard::Clipboard>> = Mutex::new(None);
static PROFILE: OnceLock<std::path::PathBuf> = OnceLock::new();
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
impl Controller {
    fn release_inputs(&mut self) {
        #[cfg(target_os = "linux")]
        if crate::remote_wayland::is_wayland() {
            crate::remote_wayland::release();
            crate::remote_wayland::clear_clipboard();
        }
        // Dropping guarded input releases it here and in the signed watchdog.
        self.input = None;
        self.scroll = [0.0; 2];
        CONTROL.fetch_add(2, Ordering::SeqCst);
    }
    fn release(&mut self) {
        self.authority.release();
        self.release_inputs();
    }
}
pub fn initialize(profile: std::path::PathBuf) {
    crate::remote_files::initialize(&profile);
    crate::remote_session::initialize();
    let suspended = profile.join("remote-access-stopped").exists();
    #[cfg(target_os = "linux")]
    if crate::remote_wayland::is_wayland() {
        crate::remote_wayland::initialize(&profile, !suspended);
    }
    let _ = PROFILE.set(profile);
    CONTROL.store(if suspended { 0 } else { 1 }, Ordering::SeqCst);
    std::thread::spawn(|| {
        let mut last = now();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let wake = now().saturating_sub(last) > 1000 || now() < last;
            last = now();
            let available = crate::remote_session::active() && !wake;
            crate::remote_files::expire(
                now(),
                CONTROL.load(Ordering::SeqCst) & 1 == 1 && available,
            );
            crate::remote_media::tick(
                now(),
                CONTROL.load(Ordering::SeqCst) & 1 == 1 && screen_permission() && available,
            );
            if let Ok(mut c) = CONTROLLER.try_lock() {
                if c.input.as_mut().is_some_and(|input| input.pulse().is_err())
                    || c.authority.expire(now())
                    || (c.authority.owner.is_some()
                        && (!available
                            || CONTROL.load(Ordering::SeqCst) & 1 == 0
                            || !screen_permission()
                            || !input_permission()))
                {
                    c.release();
                }
            }
        }
    });
}
/// Runtime loss/quit closes access without changing the user's persisted Stop latch.
pub fn disconnect() {
    CONTROL.fetch_and(!1, Ordering::SeqCst);
    crate::remote_media::stop();
    #[cfg(target_os = "linux")]
    crate::remote_wayland::stop();
    if let Ok(mut c) = CONTROLLER.lock() {
        c.release();
    }
}
use xcap::Monitor;

// Low bit is permission; the remaining bits invalidate queued actions and stale settings.
static CONTROL: AtomicU64 = AtomicU64::new(0);

pub fn stop() {
    let _ = CONTROL.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
        Some(n.wrapping_add(2) & !1)
    });
    crate::remote_media::stop();
    #[cfg(target_os = "linux")]
    crate::remote_wayland::stop();
    if let Ok(mut c) = CONTROLLER.try_lock() {
        c.release();
    }
    // Existence is the latch; its contents carry no credentials or screen data.
    if let Some(profile) = PROFILE.get() {
        let _ = std::fs::write(profile.join("remote-access-stopped"), b"stopped\n");
    }
}
fn supported() -> bool {
    #[cfg(target_os = "linux")]
    if crate::remote_wayland::is_wayland() {
        return true;
    }
    !cfg!(target_os = "linux")
        || (std::env::var_os("WAYLAND_DISPLAY").is_none()
            && std::env::var("XDG_SESSION_TYPE").unwrap_or_default() != "wayland"
            && std::env::var_os("DISPLAY").is_some())
}
pub fn remote_enabled() -> bool {
    CONTROL.load(Ordering::SeqCst) & 1 == 1
}
pub fn release_remote_input() {
    if let Ok(mut c) = CONTROLLER.lock() {
        c.release();
    }
}
pub fn release_remote_owner(id: &str) {
    if let Ok(mut c) = CONTROLLER.lock() {
        if c.authority
            .owner
            .as_ref()
            .is_some_and(|owner| owner.id == id)
        {
            c.release();
        }
    }
}
pub(crate) fn screen_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        objc2_core_graphics::CGPreflightScreenCaptureAccess()
    }
    #[cfg(not(target_os = "macos"))]
    {
        #[cfg(target_os = "linux")]
        if crate::remote_wayland::is_wayland() {
            return crate::remote_wayland::status()["ready"] == true;
        }
        supported()
    }
}
pub(crate) fn input_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "ApplicationServices", kind = "framework")]
        extern "C" {
            fn AXIsProcessTrusted() -> bool;
        }
        // Read-only preflight: never opens an OS permission prompt.
        unsafe { AXIsProcessTrusted() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        #[cfg(target_os = "linux")]
        if crate::remote_wayland::is_wayland() {
            return crate::remote_wayland::status()["input"] == true;
        }
        supported()
    }
}
pub(crate) fn permitted() -> Result<(), String> {
    if !crate::remote_session::active() {
        return Err("Unlock the active desktop locally before connecting".into());
    }
    if !remote_enabled() {
        return Err("Computer control is off. Enable it in Rimeward connections.".into());
    }
    if !supported() {
        return Err("Desktop screen control requires an active graphical session.".into());
    }
    Ok(())
}
fn geometry(m: &Monitor) -> Result<Value, String> {
    let err = |e: xcap::XCapError| e.to_string();
    Ok(
        json!({"display": m.id().map_err(err)?, "primary":m.is_primary().unwrap_or(false), "x": m.x().map_err(err)?, "y": m.y().map_err(err)?,
        "width": m.width().map_err(err)?, "height": m.height().map_err(err)?,
        "scale": m.scale_factor().map_err(err)?, "rotation": m.rotation().map_err(err)?}),
    )
}
// XCap reports the desktop coordinate space and already-oriented dimensions.
// Scaling a streamed/screenshot image must not apply display DPI or rotation twice.
fn display_point(geometry: &Value, x: f64, y: f64) -> Result<(i32, i32), String> {
    let axis = |position: f64, origin: &Value, extent: &Value| -> Result<i32, String> {
        if !position.is_finite() || !(0.0..1.0).contains(&position) {
            return Err("Coordinates must be inside the observed image".into());
        }
        let origin = origin.as_f64().ok_or("Invalid display origin")?;
        let extent = extent
            .as_f64()
            .filter(|n| n.is_finite() && *n > 0.0)
            .ok_or("Invalid display size")?;
        let mapped = (origin + position * extent).floor();
        if !mapped.is_finite() || mapped < f64::from(i32::MIN) || mapped > f64::from(i32::MAX) {
            return Err("Invalid desktop coordinate".into());
        }
        Ok(mapped as i32)
    };
    Ok((
        axis(x, &geometry["x"], &geometry["width"])?,
        axis(y, &geometry["y"], &geometry["height"])?,
    ))
}
fn monitors() -> Result<Vec<Monitor>, String> {
    Monitor::all().map_err(|e| format!("Displays unavailable: {e}"))
}
fn display_list() -> Result<Vec<Value>, String> {
    #[cfg(target_os = "linux")]
    if crate::remote_wayland::is_wayland() {
        let state = crate::remote_wayland::status();
        let mut displays = state["displays"].as_array().cloned().unwrap_or_default();
        for display in &mut displays {
            display["portalEpoch"] = state["epoch"].clone();
            display["inputGeneration"] = state["inputGeneration"].clone();
        }
        return Ok(displays);
    }
    monitors()?.iter().map(geometry).collect()
}
fn key(value: &str) -> Result<Key, String> {
    Ok(match value {
        "Control" => Key::Control,
        "Alt" => Key::Alt,
        "Shift" => Key::Shift,
        "Meta" => Key::Meta,
        "Enter" => Key::Return,
        "Tab" => Key::Tab,
        "Escape" => Key::Escape,
        "Backspace" => Key::Backspace,
        "Delete" => Key::Delete,
        "Space" => Key::Space,
        "ArrowUp" => Key::UpArrow,
        "ArrowDown" => Key::DownArrow,
        "ArrowLeft" => Key::LeftArrow,
        "ArrowRight" => Key::RightArrow,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "F1" => Key::F1,
        "F2" => Key::F2,
        "F3" => Key::F3,
        "F4" => Key::F4,
        "F5" => Key::F5,
        "F6" => Key::F6,
        "F7" => Key::F7,
        "F8" => Key::F8,
        "F9" => Key::F9,
        "F10" => Key::F10,
        "F11" => Key::F11,
        "F12" => Key::F12,
        s if s.chars().count() == 1 => Key::Unicode(s.chars().next().ok_or("Empty key")?),
        _ => return Err("Unknown key name".into()),
    })
}
pub(crate) fn physical_key(value: &str) -> Result<u16, String> {
    let value = match value {
        "MetaLeft" => "SuperLeft",
        "MetaRight" => "SuperRight",
        value => value,
    };
    let code: tao::keyboard::KeyCode =
        serde_json::from_value(Value::String(value.into())).map_err(|_| "Unknown physical key")?;
    // Tao 0.35.3 has two incorrect Linux forward entries (M and ]).
    // Its native event decoder is correct and covers the complete X11 key range.
    #[cfg(target_os = "linux")]
    let scan = (8..=255).find(|scan| tao::keyboard::KeyCode::from_scancode(*scan) == code);
    #[cfg(not(target_os = "linux"))]
    let scan = code.to_scancode();
    scan.and_then(|scan| u16::try_from(scan).ok())
        .ok_or("Physical key unavailable on this platform".into())
}

pub fn request(op: &str, value: &Value) -> Result<Value, String> {
    if op == "computer-revoke" {
        release_remote_input();
        crate::remote_media::stop();
        crate::remote_files::expire(now(), false);
        return Ok(json!({"revoked": true}));
    }
    if op == "computer-disconnect" {
        disconnect();
        return Ok(json!({"closed": true}));
    }
    if op == "computer-configure" {
        let enable = value["enabled"]
            .as_bool()
            .ok_or("Invalid control permission")?;
        if enable {
            let expected = value["generation"]
                .as_u64()
                .ok_or("Refresh control settings before enabling")?;
            CONTROL
                .compare_exchange(
                    expected,
                    expected.wrapping_add(2) | 1,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                )
                .map_err(|_| "Control permission changed; refresh settings before enabling")?;
            if let Some(profile) = PROFILE.get() {
                let latch = profile.join("remote-access-stopped");
                if latch.exists() && std::fs::remove_file(latch).is_err() {
                    disconnect();
                    return Err(
                        "Could not resume remote access; check local profile permissions".into(),
                    );
                }
            }
            #[cfg(target_os = "linux")]
            if crate::remote_wayland::is_wayland() {
                crate::remote_wayland::start();
            }
        } else {
            stop();
        }
        return Ok(json!({"enabled": enable}));
    }
    if op == "computer-status" {
        let displays = if supported() {
            display_list()
        } else {
            Ok(Vec::<Value>::new())
        };
        let mut c = CONTROLLER.lock().map_err(|_| "Controller unavailable")?;
        if let Ok(list) = &displays {
            if c.displays != *list {
                c.displays.clone_from(list);
                c.authority.topology_changed();
                c.release_inputs();
            }
        }
        if c.authority.expire(now()) {
            c.release_inputs();
        }
        let control = CONTROL.load(Ordering::SeqCst);
        #[allow(unused_mut)]
        let mut capabilities = json!({"clipboard":supported(),"text":supported()});
        #[cfg(target_os = "linux")]
        if crate::remote_wayland::is_wayland() {
            capabilities = crate::remote_wayland::status();
        }
        return Ok(json!({"enabled": control & 1 == 1, "generation": control,
            "media": crate::remote_media::available(),
            "clipboardPermission":capabilities["clipboard"], "textPermission":capabilities["text"],
            "screenPermission": screen_permission(), "inputPermission": input_permission(),
            "controller": c.authority.owner, "ownershipGeneration": c.authority.generation, "topology": c.authority.topology,
            "locked": !crate::remote_session::active(),
            "suspended": PROFILE.get().is_some_and(|p| p.join("remote-access-stopped").exists()),
            "platform": std::env::consts::OS, "supported": supported(), "displays": displays.as_ref().ok(),
            "error": displays.err(), "permissions": if cfg!(target_os = "macos") {
                "Allow Rimeward in System Settings > Privacy & Security > Accessibility and Screen & System Audio Recording."
            } else if cfg!(target_os = "windows") {
                "Controls this signed-in desktop. Windows blocks input into elevated apps and secure desktops."
            } else { "On Wayland, save enabled access in Connections and approve the compositor's screen/input dialog. Capture and input use the same portal session." }}));
    }
    if op == "computer-files" {
        return crate::remote_files::request(value, now(), || {
            CONTROL.load(Ordering::SeqCst) & 1 == 1 && crate::remote_session::active()
        });
    }
    if op == "computer-media" {
        permitted()?;
        if !screen_permission() {
            return Err("Screen recording permission required".into());
        }
        return crate::remote_media::request(value);
    }
    permitted()?;
    if op == "computer-clipboard" {
        return clipboard_request(value);
    }
    if matches!(
        op,
        "computer-clear"
            | "computer-acquire"
            | "computer-agent-acquire"
            | "computer-release"
            | "computer-heartbeat"
            | "computer-event"
    ) {
        return controller_request(op, value);
    }
    let list = display_list()?;
    let id = if op == "computer-input" {
        &value["geometry"]["display"]
    } else {
        &value["display"]
    };
    let mut current = if id.is_null() {
        list.iter()
            .find(|m| m["primary"] == true)
            .or_else(|| list.first())
    } else {
        let id = id.as_u64().ok_or("Invalid display ID")?;
        list.iter().find(|m| m["display"] == id)
    }
    .ok_or("Display unavailable; read computer_status again")?
    .clone();
    if op == "computer-screenshot" || op == "computer-frame" {
        #[cfg(target_os = "linux")]
        if crate::remote_wayland::is_wayland() {
            let limit: f64 = if op == "computer-frame" {
                1280.0
            } else {
                1600.0
            };
            let width = current["width"].as_f64().ok_or("Invalid display width")?;
            let height = current["height"].as_f64().ok_or("Invalid display height")?;
            let scale = (limit / width.max(height)).min(1.0);
            let frame = crate::remote_media::snapshot(
                current["display"].as_u64().ok_or("Invalid display")?,
                (width * scale).max(1.0) as u64,
                (height * scale).max(1.0) as u64,
            )?;
            permitted()?;
            if !display_list()?.contains(&current) {
                return Err("Portal display changed during capture".into());
            }
            for field in ["image", "imageWidth", "imageHeight"] {
                current[field] = frame[field].clone();
            }
            return Ok(current);
        }
        #[cfg(target_os = "macos")]
        if !objc2_core_graphics::CGPreflightScreenCaptureAccess() {
            return Err("Allow Rimeward Screen & System Audio Recording in System Settings before capturing.".into());
        }
        let monitors = monitors()?;
        let monitor = monitors
            .iter()
            .find(|m| m.id().is_ok_and(|id| current["display"] == id))
            .ok_or("Display disconnected")?;
        let capture = monitor
            .capture_image()
            .map_err(|e| format!("Screen capture failed: {e}"))?;
        if u64::from(capture.width()) * u64::from(capture.height()) > 64 * 1024 * 1024 {
            return Err("Display exceeds the 64 megapixel capture limit".into());
        }
        let limit = if op == "computer-frame" { 1280 } else { 1600 };
        let image = image::DynamicImage::ImageRgba8(capture)
            .thumbnail(limit, limit)
            .to_rgb8();
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 80)
            .encode_image(&image)
            .map_err(|e| e.to_string())?;
        permitted()?;
        current["imageWidth"] = image.width().into();
        current["imageHeight"] = image.height().into();
        current["image"] = base64::engine::general_purpose::STANDARD
            .encode(bytes)
            .into();
        return Ok(current);
    }
    if op != "computer-input" {
        return Err("Unknown computer operation".into());
    }
    // Hold the common authority for the full atomic agent gesture. Human takeover
    // invalidates its next call; Stop remains atomic and is checked during gestures.
    let mut controller = CONTROLLER.lock().map_err(|_| "Controller unavailable")?;
    controller.authority.check(
        value["owner"].as_str().ok_or("Missing controller")?,
        value["ownership"]
            .as_u64()
            .ok_or("Missing ownership generation")?,
        value["topology"].as_u64().ok_or("Missing topology")?,
        now(),
    )?;
    if value["generation"].as_u64() != Some(CONTROL.load(Ordering::SeqCst)) {
        return Err("Control permission changed; take another screenshot".into());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Clock unavailable")?
        .as_millis();
    if value["expires"]
        .as_u64()
        .is_none_or(|expires| u128::from(expires) <= now)
    {
        return Err("Screenshot expired; take another screenshot".into());
    }
    let old = &value["geometry"];
    // The JavaScript bridge serializes integral floats (1.0) as integers (1).
    for field in ["display", "x", "y", "width", "height", "scale", "rotation"] {
        if old[field]
            .as_f64()
            .is_none_or(|number| Some(number) != current[field].as_f64())
        {
            return Err("Display geometry changed; take another screenshot".into());
        }
    }
    #[cfg(target_os = "linux")]
    if crate::remote_wayland::is_wayland() {
        let result = crate::remote_wayland::agent_input(value, &current);
        crate::remote_wayland::release();
        result?;
        return Ok(json!({"sent":true,"note":"Take another screenshot to verify the result."}));
    }
    let point = |x: &Value, y: &Value| -> Result<(i32, i32), String> {
        let x = x.as_f64().ok_or("Missing x coordinate")?;
        let y = y.as_f64().ok_or("Missing y coordinate")?;
        let w = old["imageWidth"]
            .as_f64()
            .filter(|n| *n > 0.0)
            .ok_or("Missing image width")?;
        let h = old["imageHeight"]
            .as_f64()
            .filter(|n| *n > 0.0)
            .ok_or("Missing image height")?;
        display_point(&current, x / w, y / h)
    };
    let mut input = Input::new()
        .map_err(|e| format!("Input unavailable; check OS Accessibility permissions: {e}"))?;
    let err = |e: enigo::InputError| {
        format!("Input may be partial: {e}. Take another screenshot before continuing.")
    };
    match value["action"].as_str() {
        Some("click" | "move" | "drag") => {
            let (x, y) = point(&value["x"], &value["y"])?;
            let destination = if value["action"] == "drag" {
                Some(point(&value["toX"], &value["toY"])?)
            } else {
                None
            };
            let button = match value["button"].as_str().unwrap_or("left") {
                "left" => Button::Left,
                "right" => Button::Right,
                "middle" => Button::Middle,
                _ => return Err("Invalid mouse button".into()),
            };
            let clicks = if value["clicks"].is_null() {
                1
            } else {
                value["clicks"]
                    .as_u64()
                    .filter(|v| (1..=2).contains(v))
                    .ok_or("Use one or two clicks")?
            };
            permitted()?;
            input.move_mouse(x, y, Coordinate::Abs).map_err(err)?;
            if let Some((x, y)) = destination {
                input.button(button, Direction::Press).map_err(err)?;
                let start = point(&value["x"], &value["y"])?;
                let moved = (1..=20).try_for_each(|step| {
                    permitted()?;
                    std::thread::sleep(std::time::Duration::from_millis(15));
                    input
                        .move_mouse(
                            start.0 + (x - start.0) * step / 20,
                            start.1 + (y - start.1) * step / 20,
                            Coordinate::Abs,
                        )
                        .map_err(err)
                });
                let released = input.button(button, Direction::Release);
                moved?;
                released.map_err(err)?;
            } else if value["action"] == "click" {
                for _ in 0..clicks {
                    permitted()?;
                    input.button(button, Direction::Click).map_err(err)?;
                    if clicks == 2 {
                        std::thread::sleep(std::time::Duration::from_millis(80));
                    }
                }
            }
        }
        Some("text") => {
            let text = value["text"]
                .as_str()
                .filter(|s| !s.is_empty() && s.chars().count() <= 4000)
                .ok_or("Use 1–4000 text characters")?;
            permitted()?;
            input.text(text).map_err(err)?;
        }
        Some("key") => {
            let keys = value["keys"]
                .as_array()
                .filter(|v| !v.is_empty() && v.len() <= 5)
                .ok_or("Use 1–5 keys")?;
            let keys: Vec<Key> = keys
                .iter()
                .map(|v| key(v.as_str().unwrap_or("")))
                .collect::<Result<_, _>>()?;
            for k in &keys {
                permitted()?;
                input.key(*k, Direction::Press).map_err(err)?;
            }
            for k in keys.iter().rev() {
                input.key(*k, Direction::Release).map_err(err)?;
            }
        }
        Some("scroll") => {
            let (x, y) = point(&value["x"], &value["y"])?;
            let amount = value["amount"]
                .as_i64()
                .filter(|n| (1..=20).contains(n))
                .ok_or("Scroll amount must be 1–20")? as i32;
            let (axis, sign) = match value["direction"].as_str() {
                Some("up") => (Axis::Vertical, -1),
                Some("down") => (Axis::Vertical, 1),
                Some("left") => (Axis::Horizontal, -1),
                Some("right") => (Axis::Horizontal, 1),
                _ => return Err("Invalid scroll direction".into()),
            };
            permitted()?;
            input.move_mouse(x, y, Coordinate::Abs).map_err(err)?;
            input.scroll(amount * sign, axis).map_err(err)?;
        }
        _ => return Err("Unknown input action".into()),
    }
    Ok(json!({"sent": true, "note": "Take another screenshot to verify the result."}))
}

pub(crate) fn clipboard_png(bytes: &[u8]) -> Result<image::RgbaImage, String> {
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Clipboard PNG exceeds 8 MiB".into());
    }
    let mut reader =
        image::ImageReader::with_format(std::io::Cursor::new(bytes), image::ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    Ok(reader
        .decode()
        .map_err(|_| "Invalid or oversized PNG")?
        .into_rgba8())
}
#[cfg(target_os = "linux")]
pub(crate) fn generation() -> u64 {
    CONTROL.load(Ordering::SeqCst)
}

fn clipboard_request(value: &Value) -> Result<Value, String> {
    let mut clipboard = CLIPBOARD.lock().map_err(|_| "Clipboard unavailable")?;
    let permitted_exchange = || {
        permitted()?;
        if value["generation"].as_u64() != Some(CONTROL.load(Ordering::SeqCst))
            || value["ownershipGeneration"].as_u64()
                != Some(
                    CONTROLLER
                        .lock()
                        .map_err(|_| "Controller unavailable")?
                        .authority
                        .generation,
                )
        {
            return Err("Control changed; retry the clipboard exchange explicitly".into());
        }
        Ok::<(), String>(())
    };
    permitted_exchange()?;
    #[cfg(target_os = "linux")]
    if crate::remote_wayland::is_wayland() {
        let result = crate::remote_wayland::clipboard(value)?;
        permitted_exchange()?;
        return Ok(result);
    }
    if clipboard.is_none() {
        *clipboard =
            Some(arboard::Clipboard::new().map_err(|e| format!("Clipboard unavailable: {e}"))?);
    }
    let clipboard = clipboard.as_mut().ok_or("Clipboard unavailable")?;
    let send = match value["direction"].as_str() {
        Some("send") => true,
        Some("receive") => false,
        _ => return Err("Invalid clipboard direction".into()),
    };
    match value["mime"].as_str() {
        Some("text/plain") => {
            if send {
                let text = value["text"]
                    .as_str()
                    .filter(|v| v.len() <= 1024 * 1024)
                    .ok_or("Clipboard text exceeds 1 MiB")?;
                permitted_exchange()?;
                clipboard.set_text(text).map_err(|e| e.to_string())?;
                Ok(json!({"sent": true}))
            } else {
                let text = clipboard.get_text().map_err(|e| e.to_string())?;
                if text.len() > 1024 * 1024 {
                    return Err("Clipboard text exceeds 1 MiB".into());
                }
                permitted_exchange()?;
                Ok(json!({"mime": "text/plain", "text": text}))
            }
        }
        Some("image/png") => {
            if send {
                let raw = value["data"]
                    .as_str()
                    .filter(|v| v.len() <= 12 * 1024 * 1024)
                    .ok_or("Clipboard PNG exceeds 8 MiB")?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(raw)
                    .map_err(|_| "Invalid PNG encoding")?;
                if bytes.len() > 8 * 1024 * 1024 {
                    return Err("Clipboard PNG exceeds 8 MiB".into());
                }
                let image = clipboard_png(&bytes)?;
                permitted_exchange()?;
                clipboard
                    .set_image(arboard::ImageData {
                        width: image.width() as usize,
                        height: image.height() as usize,
                        bytes: std::borrow::Cow::Owned(image.into_raw()),
                    })
                    .map_err(|e| e.to_string())?;
                Ok(json!({"sent": true}))
            } else {
                let image = clipboard.get_image().map_err(|e| e.to_string())?;
                if image.width > 16384
                    || image.height > 16384
                    || image.bytes.len() > 64 * 1024 * 1024
                {
                    return Err("Clipboard image exceeds size limit".into());
                }
                let image = image::RgbaImage::from_raw(
                    image.width as u32,
                    image.height as u32,
                    image.bytes.into_owned(),
                )
                .ok_or("Invalid clipboard image")?;
                let mut bytes = std::io::Cursor::new(Vec::new());
                image::DynamicImage::ImageRgba8(image)
                    .write_to(&mut bytes, image::ImageFormat::Png)
                    .map_err(|e| e.to_string())?;
                if bytes.get_ref().len() > 8 * 1024 * 1024 {
                    return Err("Clipboard PNG exceeds 8 MiB".into());
                }
                permitted_exchange()?;
                Ok(
                    json!({"mime": "image/png", "data": base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())}),
                )
            }
        }
        _ => Err("Only text and PNG clipboard exchange is supported".into()),
    }
}

fn controller_request(op: &str, value: &Value) -> Result<Value, String> {
    let current = if matches!(
        op,
        "computer-event" | "computer-acquire" | "computer-agent-acquire"
    ) {
        Some(display_list()?)
    } else {
        None
    };
    let mut c = CONTROLLER.lock().map_err(|_| "Controller unavailable")?;
    if let Some(current) = current {
        if c.displays != current {
            c.displays = current;
            c.authority.topology_changed();
            c.release_inputs();
        }
    }
    if c.authority.expire(now()) {
        c.release_inputs();
    }
    let id = value["owner"].as_str().ok_or("Missing controller")?;
    let generation = value["ownership"].as_u64().unwrap_or(0);
    let topology = value["topology"].as_u64().unwrap_or(0);
    if op == "computer-acquire" || op == "computer-agent-acquire" {
        let old = c.authority.generation;
        let kind = if op == "computer-acquire" {
            Kind::Human
        } else {
            Kind::Rime
        };
        let generation =
            c.authority
                .acquire(id, kind, value["takeover"].as_bool() == Some(true), now())?;
        if old != generation {
            c.release_inputs();
        }
        return Ok(
            json!({"ownership": generation, "topology": c.authority.topology,
            "generation": CONTROL.load(Ordering::SeqCst), "controller": c.authority.owner}),
        );
    }
    c.authority.check(id, generation, topology, now())?;
    if op == "computer-clear" {
        c.authority.input(
            id,
            generation,
            topology,
            value["sequence"].as_u64().ok_or("Missing input sequence")?,
            now(),
        )?;
        c.release_inputs();
        return Ok(json!({"cleared": true}));
    }
    match op {
        "computer-release" => {
            c.release();
            return Ok(json!({"released": true}));
        }
        "computer-heartbeat" => {
            c.authority.heartbeat(id, generation, now())?;
            return Ok(json!({"alive": true}));
        }
        "computer-event" => {}
        _ => return Err("Unknown controller operation".into()),
    }
    c.authority.input(
        id,
        generation,
        topology,
        value["sequence"].as_u64().ok_or("Missing input sequence")?,
        now(),
    )?;
    let events = value["events"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .ok_or("Use 1–128 input events")?;
    #[cfg(target_os = "linux")]
    if crate::remote_wayland::is_wayland() {
        let result = crate::remote_wayland::events(
            value["display"].as_u64().ok_or("Missing display")?,
            events,
        );
        if result.is_err() {
            c.release();
        }
        result?;
        return Ok(json!({"sent":true}));
    }
    if c.input.is_none() {
        c.input = Some(
            Input::new()
                .map_err(|e| format!("Input unavailable; check Accessibility permission: {e}"))?,
        );
    }
    let result = (|| -> Result<(), String> {
        let Controller {
            input,
            displays,
            scroll,
            ..
        } = &mut *c;
        let input = input.as_mut().ok_or("Input released")?;
        for event in events {
            permitted()?;
            let result = match event["type"].as_str() {
                Some("key") => {
                    let direction = match event["down"].as_bool() {
                        Some(true) => Direction::Press,
                        Some(false) => Direction::Release,
                        None => return Err("Missing key state".into()),
                    };
                    if let Some(code) = event["code"]
                        .as_str()
                        .filter(|code| !code.is_empty() && *code != "Unidentified")
                    {
                        let scan = physical_key(code)?;
                        if direction == Direction::Press && input.has_raw(scan) {
                            if code.starts_with("Shift")
                                || code.starts_with("Control")
                                || code.starts_with("Alt")
                                || code.starts_with("Meta")
                                || code.starts_with("Super")
                            {
                                continue;
                            }
                            input
                                .raw(scan, Direction::Release)
                                .map_err(|e| e.to_string())?;
                        }
                        input.raw(scan, direction)
                    } else {
                        let key = key(event["key"].as_str().ok_or("Missing key")?)?;
                        if direction == Direction::Press && input.has_key(key) {
                            if matches!(key, Key::Shift | Key::Control | Key::Alt | Key::Meta) {
                                continue;
                            }
                            input
                                .key(key, Direction::Release)
                                .map_err(|e| e.to_string())?;
                        }
                        input.key(key, direction)
                    }
                }
                Some("text") => input.text(
                    event["text"]
                        .as_str()
                        .filter(|s| s.chars().count() <= 4000)
                        .ok_or("Text too large")?,
                ),
                Some("button") => {
                    let b = match event["button"].as_u64() {
                        Some(0) => Button::Left,
                        Some(1) => Button::Middle,
                        Some(2) => Button::Right,
                        _ => return Err("Invalid button".into()),
                    };
                    let down = event["down"].as_bool().ok_or("Missing button state")?;
                    input.button(
                        b,
                        if down {
                            Direction::Press
                        } else {
                            Direction::Release
                        },
                    )
                }
                Some("move") => {
                    let display = value["display"].as_u64().ok_or("Missing display")?;
                    let list = monitors()?;
                    let m = list
                        .iter()
                        .find(|m| m.id().is_ok_and(|id| u64::from(id) == display))
                        .ok_or("Display unavailable")?;
                    let geometry = geometry(m)?;
                    if !displays.contains(&geometry) {
                        return Err("Display changed; reconnect control".into());
                    }
                    let x = event["x"]
                        .as_f64()
                        .filter(|n| n.is_finite() && *n >= 0.0 && *n < 1.0)
                        .ok_or("Invalid pointer x")?;
                    let y = event["y"]
                        .as_f64()
                        .filter(|n| n.is_finite() && *n >= 0.0 && *n < 1.0)
                        .ok_or("Invalid pointer y")?;
                    let (x, y) = display_point(&geometry, x, y)?;
                    input.move_mouse(x, y, Coordinate::Abs)
                }
                Some("scroll") => {
                    let amount = event["amount"]
                        .as_f64()
                        .filter(|n| n.is_finite() && n.abs() <= 100.0)
                        .ok_or("Invalid scroll")?;
                    let axis = match event["axis"].as_str() {
                        Some("x") => Axis::Horizontal,
                        Some("y") => Axis::Vertical,
                        _ => return Err("Invalid scroll axis".into()),
                    };
                    smooth_scroll(input, amount, axis, scroll)
                }
                _ => return Err("Unknown input event".into()),
            };
            result.map_err(|e| format!("Input may be partial: {e}; acquire control again"))?;
        }
        Ok(())
    })();
    if result.is_err() {
        c.release();
    }
    result?;
    Ok(json!({"sent": true}))
}

fn smooth_scroll(
    input: &mut Input,
    amount: f64,
    axis: Axis,
    pending: &mut [f64; 2],
) -> enigo::InputResult<()> {
    let index = usize::from(axis == Axis::Horizontal);
    let units = if cfg!(target_os = "macos") {
        40.0
    } else if cfg!(target_os = "windows") {
        120.0
    } else {
        1.0
    };
    pending[index] += amount * units;
    let delta = pending[index].trunc() as i32;
    if delta == 0 {
        return Ok(());
    }
    pending[index] -= f64::from(delta);
    #[cfg(target_os = "macos")]
    {
        use objc2_core_graphics::{CGEvent, CGEventTapLocation, CGScrollEventUnit};
        let _ = input;
        let event = CGEvent::new_scroll_wheel_event2(
            None,
            CGScrollEventUnit::Pixel,
            2,
            if index == 0 { -delta } else { 0 },
            if index == 1 { -delta } else { 0 },
            0,
        )
        .ok_or(enigo::InputError::Simulate("Could not create scroll event"))?;
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_WHEEL,
            MOUSEINPUT,
        };
        let event = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    mouseData: if index == 0 { -delta } else { delta } as u32,
                    dwFlags: if index == 0 {
                        MOUSEEVENTF_WHEEL
                    } else {
                        MOUSEEVENTF_HWHEEL
                    },
                    dwExtraInfo: input.get_marker_value(),
                    ..Default::default()
                },
            },
        };
        if unsafe { SendInput(&[event], std::mem::size_of::<INPUT>() as i32) } != 1 {
            return Err(enigo::InputError::Simulate(
                "Windows refused the scroll event",
            ));
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    input.scroll(delta, axis)
}

#[cfg(test)]
mod input_tests {
    #[test]
    fn display_coordinates_preserve_negative_origins_dpi_and_rotated_geometry() {
        let landscape = serde_json::json!({"x":-1920,"y":-300,"width":1920,"height":1080,"scale":2,"rotation":0});
        assert_eq!(
            super::display_point(&landscape, 0.5, 0.5).unwrap(),
            (-960, 240)
        );
        assert_eq!(
            super::display_point(&landscape, 0.0, 0.0).unwrap(),
            (-1920, -300)
        );
        let portrait = serde_json::json!({"x":1920,"y":0,"width":1080,"height":1920,"scale":1.25,"rotation":90});
        assert_eq!(
            super::display_point(&portrait, 0.5, 0.25).unwrap(),
            (2460, 480)
        );
        for x in [-0.1, 1.0, f64::NAN, f64::INFINITY] {
            assert!(super::display_point(&landscape, x, 0.5).is_err());
        }
        assert!(super::display_point(&serde_json::json!({}), 0.0, 0.0).is_err());
    }
    #[test]
    fn browser_physical_codes_round_trip_without_opening_input_devices() {
        for name in [
            "KeyA",
            "KeyM",
            "KeyR",
            "BracketRight",
            "ShiftLeft",
            "ShiftRight",
            "ControlLeft",
            "Enter",
            "NumpadEnter",
            "ArrowLeft",
        ] {
            let scan = super::physical_key(name).unwrap();
            let code: tao::keyboard::KeyCode =
                serde_json::from_value(serde_json::json!(name)).unwrap();
            assert_eq!(tao::keyboard::KeyCode::from_scancode(u32::from(scan)), code);
        }
        assert_eq!(
            super::physical_key("MetaLeft"),
            super::physical_key("SuperLeft")
        );
        assert_eq!(
            super::physical_key("MetaRight"),
            super::physical_key("SuperRight")
        );
        assert!(super::physical_key("not-a-key").is_err());
    }
}
