//! Window-only computer control. The native host owns authorization and lifecycle.
use serde_json::{json, Value};
#[cfg(target_os = "macos")]
use tauri::Manager;

pub const REVISION: &str = "6c0348b059595e63d1df96e6df2047ca7dbbbf1c";
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

pub fn initialize(app: tauri::AppHandle) {
    let _ = APP.set(app);
}
pub fn capability() -> Value {
    // Empty until the signed host passes the compatibility and cancellation matrix.
    // A release must add verified OS builds here; an agent cannot opt a host in.
    json!({"supported": false, "backend": "cua-driver", "version": "0.25.0",
        "revision": REVISION, "preview": "observations", "reason":
        "Background app control is awaiting signed-host compatibility and cancellation validation."})
}
pub fn stop(reason: &str) {
    #[cfg(target_os = "macos")]
    macos::stop(reason);
    #[cfg(not(target_os = "macos"))]
    let _ = reason;
}
pub async fn request(op: &str, args: &Value) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    if op == "computer-app-release" {
        return macos::release(args);
    }
    if capability()["supported"] != true {
        return Err(capability()["reason"]
            .as_str()
            .unwrap_or("macOS background control unavailable")
            .into());
    }
    #[cfg(target_os = "macos")]
    return macos::request(op, args).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (op, args);
        Err("Background app control requires a validated macOS host".into())
    }
}

#[tauri::command]
pub fn background_preview(
    window: tauri::WebviewWindow,
    action: String,
    session: Option<String>,
) -> Result<Value, String> {
    if window.label() != "background-preview" {
        return Err("Local preview required".into());
    }
    #[cfg(target_os = "macos")]
    return macos::preview(&action, session.as_deref());
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (action, session);
        Err("Background app control requires macOS".into())
    }
}
#[cfg(target_os = "macos")]
fn show_preview() {
    let Some(app) = APP.get() else {
        return;
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if handle.get_webview_window("background-preview").is_none() {
            let _ = tauri::WebviewWindowBuilder::new(
                &handle,
                "background-preview",
                tauri::WebviewUrl::App("background-preview.html".into()),
            )
            .title("Rime · Background app")
            .inner_size(360.0, 310.0)
            .min_inner_size(280.0, 240.0)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .build();
        }
    });
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use cua_driver_sdk::{
        ConfiguredDriverOptions, CuaDriver, EmbeddedEnvironmentVariable, PrivateWorkerOptions,
        RuntimeAuthorizationOptions, SessionPermissionMode, ToolResult,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct Target {
        pid: i32,
        window: u32,
        stamp: (u64, u64),
    }
    struct Observation {
        id: String,
        at: u64,
        geometry: Value,
        state: Value,
    }
    struct Session {
        id: String,
        owner: String,
        target: Target,
        driver: Arc<CuaDriver>,
        observation: Option<Observation>,
        preview: Value,
        paused: bool,
        heartbeat: u64,
    }
    static SESSION: Mutex<Option<Session>> = Mutex::new(None);
    static BUSY: AtomicBool = AtomicBool::new(false);
    static EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    struct Operation;
    impl Drop for Operation {
        fn drop(&mut self) {
            BUSY.store(false, Ordering::SeqCst);
        }
    }
    fn exclusive() -> Result<Operation, String> {
        BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "Another background operation is running")?;
        Ok(Operation)
    }
    fn now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
    fn token() -> Result<String, String> {
        let mut bytes = [0u8; 24];
        getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
        Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
    }
    fn stamp(pid: i32) -> Option<(u64, u64)> {
        // Kernel start time prevents a recycled pid from inheriting an observation.
        unsafe {
            let mut info: libc::proc_bsdinfo = std::mem::zeroed();
            let size = std::mem::size_of_val(&info) as i32;
            if libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                &mut info as *mut _ as *mut _,
                size,
            ) != size
            {
                return None;
            }
            Some((info.pbi_start_tvsec, info.pbi_start_tvusec))
        }
    }
    fn permitted() -> Result<(), String> {
        crate::computer::permitted()?;
        if !crate::computer::screen_permission() || !crate::computer::input_permission() {
            return Err("Rimeward needs Screen Recording and Accessibility permissions".into());
        }
        if crate::computer::has_controller() {
            return Err("Release physical desktop control before background app control".into());
        }
        Ok(())
    }
    fn geometry(target: &Target) -> Result<Value, String> {
        if stamp(target.pid) != Some(target.stamp) {
            return Err("Target app exited or restarted".into());
        }
        if platform_macos::apps::frontmost_pid().is_none_or(|pid| pid == target.pid) {
            return Err(
                "Target app is foreground; move to another app and explicitly Resume".into(),
            );
        }
        let windows = platform_macos::windows::all_windows();
        let w = windows
            .iter()
            .find(|w| w.pid == target.pid && w.window_id == target.window)
            .ok_or("Target window closed")?;
        if !w.is_on_screen || w.on_current_space != Some(true) {
            return Err("Target window is minimized, hidden, or on another Space".into());
        }
        Ok(
            json!({"x":w.bounds.x,"y":w.bounds.y,"width":w.bounds.width,"height":w.bounds.height,"space":w.current_space_id}),
        )
    }
    fn check_epoch(epoch: u64) -> Result<(), String> {
        if EPOCH.load(Ordering::SeqCst) != epoch {
            return Err("Background session changed; input was not replayed".into());
        }
        permitted()
    }
    async fn call(driver: &CuaDriver, name: &str, args: Value) -> Result<ToolResult, String> {
        let result = driver
            .call_tool(name.into(), args.to_string())
            .await
            .map_err(|e| e.to_string())?;
        if result.is_error {
            return Err(format!(
                "{}: {}",
                result
                    .error_code
                    .as_deref()
                    .unwrap_or("background_unavailable"),
                result.text
            ));
        }
        Ok(result)
    }
    fn structured(result: &ToolResult) -> Result<Value, String> {
        serde_json::from_str(
            result
                .structured_json
                .as_deref()
                .ok_or("Missing driver receipt")?,
        )
        .map_err(|e| e.to_string())
    }
    async fn worker() -> Result<Arc<CuaDriver>, String> {
        let app = APP.get().ok_or("Native host unavailable")?;
        let path = crate::runtime::resources(app)
            .map_err(|e| e.to_string())?
            .join("cua/cua-driver");
        let driver = tokio::task::spawn_blocking(move || {
            CuaDriver::create_private_worker(PrivateWorkerOptions {
                binary_path: path.to_string_lossy().into_owned(),
                host_bundle_id: "io.frostdev.rimeward".into(),
                startup_timeout_ms: Some(10000),
                shutdown_timeout_ms: Some(2000),
                environment: vec![EmbeddedEnvironmentVariable {
                    name: "CUA_DRIVER_RS_TELEMETRY_ENABLED".into(),
                    value: "false".into(),
                }],
                inherit_stderr: false,
                configured_driver: ConfiguredDriverOptions {
                    claude_code_compatibility: false,
                    authorization: RuntimeAuthorizationOptions {
                        allowed_modes: vec![SessionPermissionMode::Standard],
                        compatibility_mode: SessionPermissionMode::Standard,
                        compatibility_capability_manifest_path: None,
                        compatibility_bounded_manifest_path: None,
                        unrestricted_acknowledged: false,
                        max_session_ttl_seconds: 3600,
                        max_idle_ttl_seconds: 60,
                    },
                },
            })
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        let verified = async {
            let metadata = driver.metadata().await.map_err(|e| e.to_string())?;
            if metadata.driver_version != "0.25.0" || !metadata.embedded {
                return Err("Bundled background driver version or mode mismatch".into());
            }
            let permissions = structured(&call(&driver, "check_permissions", json!({})).await?)?;
            if permissions["source"]["attribution"] != "host"
                || permissions["source"]["host_bundle_id"] != "io.frostdev.rimeward"
                || permissions["accessibility"] != true
                || permissions["screen_recording"] != true
            {
                return Err("Background worker permission attribution failed".into());
            }
            let health = structured(
                &call(
                    &driver,
                    "health_report",
                    json!({"include":["bundle_identity"]}),
                )
                .await?,
            )?;
            if !health["checks"].as_array().is_some_and(|checks| {
                checks.iter().any(|check| {
                    check["name"] == "bundle_identity"
                        && check["status"] == "pass"
                        && check["data"]["identity_source"] == "parent_application"
                        && check["data"]["parent_process_id"] == std::process::id()
                        && check["data"]["bundle_identifier"] == "io.frostdev.rimeward"
                })
            }) {
                return Err("Background worker is not owned by this signed app".into());
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = verified {
            let _ = driver.shutdown().await;
            return Err(error);
        }
        Ok(driver)
    }
    pub fn stop(reason: &str) {
        EPOCH.fetch_add(1, Ordering::SeqCst);
        if let Some(mut s) = SESSION.lock().unwrap().take() {
            s.observation = None;
            // The pinned SDK serializes shutdown behind in-flight input. Capability
            // stays disabled until immediate cancellation and held-input recovery
            // are certified; never advertise the 120s SDK timeout as a Stop control.
            tauri::async_runtime::spawn(async move {
                let _ = s.driver.shutdown().await;
            });
        }
        let _ = reason;
    }
    fn pause(reason: &str) {
        EPOCH.fetch_add(1, Ordering::SeqCst);
        if let Some(s) = SESSION.lock().unwrap().as_mut() {
            s.paused = true;
            s.observation = None;
            s.preview["paused"] = json!(true);
            s.preview["reason"] = json!(reason);
        }
    }
    pub fn release(args: &Value) -> Result<Value, String> {
        let owner = args["owner"].as_str().ok_or("Missing agent owner")?;
        let mut session = SESSION.lock().unwrap();
        if let Some(s) = session.as_ref() {
            if s.owner != owner {
                return Err("Background session belongs to another agent".into());
            }
            if args["session"].as_str() != Some(&s.id) {
                return Err("Background session changed".into());
            }
        }
        let old = session.take();
        EPOCH.fetch_add(1, Ordering::SeqCst);
        drop(session);
        if let Some(s) = old {
            tauri::async_runtime::spawn(async move {
                let _ = s.driver.shutdown().await;
            });
        }
        Ok(json!({"released":true}))
    }
    pub fn preview(action: &str, id: Option<&str>) -> Result<Value, String> {
        if action == "state" {
            return Ok(SESSION
                .lock()
                .unwrap()
                .as_ref()
                .map(|s| s.preview.clone())
                .unwrap_or(json!({"active":false})));
        }
        let mut session = SESSION.lock().unwrap();
        let s = session.as_mut().ok_or("Background session ended")?;
        if id != Some(&s.id) {
            return Err("Background session changed".into());
        }
        match action {
            "pause" | "takeover" => {
                drop(session);
                pause("Paused by you. Resume requires a fresh observation.");
            }
            "resume" => {
                permitted()?;
                geometry(&s.target)?;
                if BUSY.load(Ordering::SeqCst) {
                    return Err("Wait for the current operation to settle before resuming".into());
                }
                s.paused = false;
                s.observation = None;
                s.heartbeat = now();
                s.preview["paused"] = json!(false);
                s.preview["reason"] = json!("Resumed; waiting for a fresh observation");
            }
            "stop" => {
                drop(session);
                stop("Stopped locally");
            }
            _ => return Err("Unknown preview action".into()),
        }
        Ok(json!({"ok":true}))
    }
    pub fn tick(available: bool) {
        let mut session = SESSION.lock().unwrap();
        let Some(s) = session.as_mut() else {
            return;
        };
        if !available || now().saturating_sub(s.heartbeat) > 60000 || !s.driver.is_available() {
            drop(session);
            stop("Background session expired or unavailable");
            return;
        }
        if !s.paused && geometry(&s.target).is_err() {
            drop(session);
            pause("Target became foreground or unavailable. Explicit Resume required.");
        }
    }
    pub async fn request(op: &str, args: &Value) -> Result<Value, String> {
        permitted()?;
        let owner = args["owner"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .ok_or("Missing agent owner")?;
        if op == "computer-app-heartbeat" {
            let mut guard = SESSION.lock().unwrap();
            let s = guard.as_mut().ok_or("Background session ended")?;
            if s.owner != owner || args["session"] != s.id {
                return Err("Background session changed".into());
            }
            s.heartbeat = now();
            return Ok(json!({"paused":s.paused}));
        }
        let _operation = exclusive()?;
        let epoch = EPOCH.load(Ordering::SeqCst);
        if op == "computer-apps" {
            let driver = worker().await?;
            let result = async {
                let apps = structured(&call(&driver, "list_apps", json!({})).await?)?;
                let windows = structured(&call(&driver, "list_windows", json!({})).await?)?;
                check_epoch(epoch)?;
                Ok(json!({"apps":apps["apps"],"windows":windows["windows"]}))
            }
            .await;
            let _ = driver.shutdown().await;
            return result;
        }
        if op == "computer-app-state" {
            let pid = args["pid"]
                .as_i64()
                .and_then(|n| i32::try_from(n).ok())
                .filter(|n| *n > 0)
                .ok_or("Invalid app pid")?;
            let window = args["window"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .filter(|n| *n > 0)
                .ok_or("Invalid window ID")?;
            let target = Target {
                pid,
                window,
                stamp: stamp(pid).ok_or("App process unavailable")?,
            };
            geometry(&target)?;
            let existing = {
                let guard = SESSION.lock().unwrap();
                match guard.as_ref() {
                    Some(s) if s.owner != owner || s.target.pid != pid || s.target.window != window || s.target.stamp != target.stamp => return Err("Release the current background session before selecting another app or window".into()),
                    Some(s) if s.paused => return Err("Background app session is paused. Only the local preview can Resume".into()),
                    Some(s) => Some(s.driver.clone()), None => None,
                }
            };
            let driver = match existing {
                Some(d) => d,
                None => worker().await?,
            };
            if let Err(error) = check_epoch(epoch) {
                let _ = driver.shutdown().await;
                return Err(error);
            }
            {
                let mut guard = SESSION.lock().unwrap();
                if guard.is_none() {
                    *guard = Some(Session {
                        id: token()?,
                        owner: owner.into(),
                        target,
                        driver: driver.clone(),
                        observation: None,
                        preview: json!({"active":true}),
                        paused: false,
                        heartbeat: now(),
                    });
                }
            }
            return observe(driver, epoch).await;
        }
        if op != "computer-app-input" {
            return Err("Unsupported background app operation".into());
        }
        let (driver, target, observation) = {
            let mut guard = SESSION.lock().unwrap();
            let s = guard.as_mut().ok_or("Take a fresh app observation")?;
            if s.owner != owner || s.paused || args["session"] != s.id {
                return Err("Background session changed or paused".into());
            }
            let o = s
                .observation
                .as_ref()
                .ok_or("Take a fresh app observation")?;
            if args["observation"] != o.id || now().saturating_sub(o.at) >= 60000 {
                return Err("Take a fresh app observation".into());
            }
            // Consume before dispatch, including invalid input. No uncertain replay.
            (
                s.driver.clone(),
                s.target.clone(),
                s.observation.take().unwrap(),
            )
        };
        if geometry(&target)? != observation.geometry {
            return Err("Window geometry or Space changed; take a fresh observation".into());
        }
        let mut input = json!({"pid":target.pid,"window_id":target.window,"delivery_mode":"background","scope":"window"});
        let element = args["element"].as_str();
        if let Some(element) = element {
            if !observation.state["elements"]
                .as_array()
                .is_some_and(|elements| elements.iter().any(|e| e["element_token"] == element))
            {
                return Err("Element is not in this observation".into());
            }
            input["element_token"] = json!(element);
        } else {
            for (axis, dimension) in [("x", "screenshot_width"), ("y", "screenshot_height")] {
                let coordinate = args[axis]
                    .as_f64()
                    .filter(|v| {
                        v.is_finite()
                            && *v >= 0.0
                            && *v < observation.state[dimension].as_f64().unwrap_or(0.0)
                    })
                    .ok_or("Use an observed element or coordinates inside the window screenshot")?;
                input[axis] = json!(coordinate);
            }
        }
        input["snapshot_id"] = observation.state["snapshot_id"].clone();
        let tool =
            match args["action"].as_str() {
                Some("click") => {
                    input["button"] = json!("left");
                    input["count"] = json!(1);
                    "click"
                }
                Some("scroll") => {
                    let direction = args["direction"]
                        .as_str()
                        .filter(|s| ["up", "down", "left", "right"].contains(s))
                        .ok_or("Invalid scroll direction")?;
                    let amount = args["amount"]
                        .as_u64()
                        .filter(|v| (1..=20).contains(v))
                        .ok_or("Scroll amount must be 1–20")?;
                    input["direction"] = json!(direction);
                    input["amount"] = json!(amount);
                    "scroll"
                }
                Some("text") => {
                    let text = args["text"]
                        .as_str()
                        .filter(|s| !s.is_empty() && s.chars().count() <= 4000)
                        .ok_or("Text must contain 1–4000 characters")?;
                    input["text"] = json!(text);
                    input["delay_ms"] = json!(0);
                    "type_text"
                }
                _ => return Err(
                    "Unsupported background action. Physical input requires an explicit handoff"
                        .into(),
                ),
            };
        check_epoch(epoch)?;
        geometry(&target)?;
        {
            let mut guard = SESSION.lock().unwrap();
            let s = guard.as_mut().ok_or("Background session ended")?;
            s.preview["cursor"] = if let Some(element) = element {
                observation.state["elements"]
                    .as_array()
                    .and_then(|elements| {
                        let frame =
                            &elements.iter().find(|e| e["element_token"] == element)?["frame"];
                        let bounds = &observation.state["window_bounds"];
                        let x = (frame["x"].as_f64()? + frame["w"].as_f64()? / 2.0
                            - bounds["x"].as_f64()?)
                            / bounds["width"].as_f64()?
                            * observation.state["screenshot_width"].as_f64()?;
                        let y = (frame["y"].as_f64()? + frame["h"].as_f64()? / 2.0
                            - bounds["y"].as_f64()?)
                            / bounds["height"].as_f64()?
                            * observation.state["screenshot_height"].as_f64()?;
                        (x.is_finite() && y.is_finite()).then(|| json!({"x":x,"y":y}))
                    })
                    .unwrap_or(Value::Null)
            } else {
                json!({"x":input["x"],"y":input["y"]})
            };
        }
        let result = call(&driver, tool, input).await;
        if let Err(error) = check_epoch(epoch) {
            return Err(format!(
                "{error}. The action may have completed; never replay it."
            ));
        }
        match result {
            Ok(action) => {
                let receipt = structured(&action)?;
                match observe(driver, epoch).await {
                    Ok(mut state) => {
                        state["action"] = receipt;
                        Ok(state)
                    }
                    Err(error) => Ok(
                        json!({"action":receipt,"observation_error":error,"requires_fresh_observation":true}),
                    ),
                }
            }
            Err(error) => {
                pause("Action failed or its result is uncertain. Inspect the app before resuming.");
                Err(error)
            }
        }
    }
    async fn observe(driver: Arc<CuaDriver>, epoch: u64) -> Result<Value, String> {
        let target = SESSION
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("Background session ended")?
            .target
            .clone();
        let before = geometry(&target)?;
        let result = call(&driver,"get_window_state",json!({"pid":target.pid,"window_id":target.window,"max_elements":300,"max_depth":15,"max_dimension":1280})).await?;
        check_epoch(epoch)?;
        if geometry(&target)? != before {
            return Err("Window changed during capture; take a fresh observation".into());
        }
        let mut state = structured(&result)?;
        if state["screenshot_frame_valid"] != true {
            return Err("Driver could not prove the window screenshot geometry".into());
        }
        let image = result
            .images
            .first()
            .filter(|i| i.mime_type == "image/png" || i.mime_type == "image/jpeg")
            .ok_or("No window screenshot returned")?;
        if image.data_base64.len() > 7 * 1024 * 1024 {
            return Err("Window image exceeds transport limit".into());
        }
        let mut guard = SESSION.lock().unwrap();
        let s = guard.as_mut().ok_or("Background session ended")?;
        if s.paused || EPOCH.load(Ordering::SeqCst) != epoch {
            return Err("Background session paused during capture".into());
        }
        let at = now();
        let id = token()?;
        s.observation = Some(Observation {
            id: id.clone(),
            at,
            geometry: before,
            state: state.clone(),
        });
        state["observation"] = json!(id);
        state["session"] = json!(s.id);
        state["observedAt"] = json!(at);
        state["image"] = json!(image.data_base64);
        state["imageMime"] = json!(image.mime_type);
        s.heartbeat = at;
        s.preview = json!({"active":true,"paused":false,"session":s.id,"app":state["app_name"],"observedAt":at,
            "image":image.data_base64,"imageMime":image.mime_type,"width":state["screenshot_width"],"height":state["screenshot_height"],"cursor":s.preview["cursor"]});
        drop(guard);
        show_preview();
        Ok(state)
    }
}

pub fn tick(available: bool) {
    #[cfg(target_os = "macos")]
    macos::tick(available);
    #[cfg(not(target_os = "macos"))]
    let _ = available;
}
