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
    #[cfg(target_os = "macos")]
    let supported = crate::background_worker::validated_host();
    #[cfg(not(target_os = "macos"))]
    let supported = false;
    json!({"supported": supported, "backend": "cua-driver", "version": "0.25.0",
        "revision": REVISION, "preview": "observations", "webViewText": false, "reason":
        if supported { "Native app background control available. Web-view text requires browser tools or an explicit physical handoff." }
        else { "Background app control has not been validated on this OS build." }})
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
    return macos::request(op, args)
        .await
        .or_else(|error| macos::failure(args, error));
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
    use crate::background_worker::{ToolResult, Worker as CuaDriver};
    use sha2::{Digest, Sha256};
    use std::sync::atomic::Ordering;
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
        image_hash: String,
    }
    struct Session {
        id: String,
        owner: String,
        target: Target,
        driver: Arc<CuaDriver>,
        observation: Option<Observation>,
        preview: Value,
        paused: bool,
        needs_worker: bool,
        heartbeat: u64,
        read_args: Value,
    }
    static SESSION: Mutex<Option<Session>> = Mutex::new(None);
    static BUSY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    static EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    fn integer(
        args: &Value,
        name: &str,
        default: usize,
        min: usize,
        max: usize,
    ) -> Result<usize, String> {
        match args.get(name) {
            None => Ok(default),
            Some(value) => value
                .as_u64()
                .and_then(|v| usize::try_from(v).ok())
                .filter(|v| (min..=max).contains(v))
                .ok_or_else(|| format!("Invalid {name}: expected {min}–{max}")),
        }
    }
    fn query(args: &Value) -> Result<String, String> {
        match args.get("query") {
            None => Ok(String::new()),
            Some(value) => value
                .as_str()
                .filter(|s| s.chars().count() <= 256)
                .map(str::to_lowercase)
                .ok_or_else(|| "Query must contain at most 256 characters".into()),
        }
    }
    fn matches_query(value: &Value, query: &str) -> bool {
        match value {
            Value::String(s) => s.to_lowercase().contains(query),
            Value::Array(a) => a.iter().any(|v| matches_query(v, query)),
            Value::Object(o) => o.values().any(|v| matches_query(v, query)),
            _ => false,
        }
    }
    fn bound_text(value: &mut Value) -> bool {
        match value {
            Value::String(s) if s.chars().count() > 256 => {
                *s = s.chars().take(256).collect::<String>() + "…[truncated]";
                true
            }
            Value::Array(a) => a.iter_mut().fold(false, |cut, v| bound_text(v) | cut),
            Value::Object(o) => o.values_mut().fold(false, |cut, v| bound_text(v) | cut),
            _ => false,
        }
    }
    // Keep images out of the text budget; attachments are stored by the calling runtime.
    fn page(
        mut receipt: Value,
        key: &str,
        rows: Vec<Value>,
        args: &Value,
        limit: usize,
    ) -> Result<Value, String> {
        let cursor = integer(args, "cursor", 0, 0, 100000)?;
        let query = query(args)?;
        let rows: Vec<_> = rows
            .into_iter()
            .filter(|v| query.is_empty() || matches_query(v, &query))
            .collect();
        let cut = bound_text(&mut receipt);
        receipt["text_truncated"] = json!(cut);
        receipt["page"] = json!({"cursor":cursor,"total":rows.len(),"returned":0});
        receipt[key] = json!([]);
        // Leave room for attachment IDs and action receipts below the agent's 12 KB cap.
        let mut remaining = 9000usize.saturating_sub(receipt.to_string().len() + 100);
        let mut output = Vec::new();
        for mut row in rows.iter().skip(cursor).take(limit).cloned() {
            if bound_text(&mut row) {
                row["text_truncated"] = json!(true);
            }
            let size = row.to_string().len() + 1;
            if size > remaining {
                break;
            }
            remaining -= size;
            output.push(row);
        }
        let returned = output.len();
        receipt["page"]["returned"] = json!(returned);
        if cursor.saturating_add(returned) < rows.len() {
            if returned == 0 {
                receipt["row_omitted"] = json!({"cursor":cursor,"error":"Row exceeds the response budget. Inspect the screenshot or narrow the query."});
                receipt["next"] = json!(cursor + 1);
            } else {
                receipt["next"] = json!(cursor + returned);
            }
        }
        receipt[key] = json!(output);
        if key == "elements" {
            receipt["returned_element_count"] = json!(returned);
        }
        Ok(receipt)
    }
    pub fn failure(args: &Value, error: String) -> Result<Value, String> {
        let guard = SESSION.lock().unwrap();
        let Some(session) = guard.as_ref().filter(|s| args["owner"] == s.owner) else {
            return Err(error);
        };
        Ok(
            json!({"error":error.chars().take(1500).collect::<String>(),"session":session.id,
            "pid":session.target.pid,"window_id":session.target.window,"paused":session.paused,
            "requires_local_resume":session.paused,"requires_fresh_observation":true,"replay_allowed":false}),
        )
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
        crate::background_worker::stamp(pid)
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
        if platform_macos::input::skylight::front_process_matches(target.pid, target.window)
            != Some(false)
        {
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
    async fn call(driver: &Arc<CuaDriver>, name: &str, args: Value) -> Result<ToolResult, String> {
        let result = driver
            .call_tool(name.into(), args.to_string())
            .await
            .map_err(|e| e.to_string())?;
        if result.is_error {
            return Err(format!(
                "{}: {}. Do not replay this input; inspect the app and explicitly Resume locally.",
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
    async fn worker(target: Option<&Target>) -> Result<Arc<CuaDriver>, String> {
        let app = APP.get().ok_or("Native host unavailable")?;
        let path = crate::runtime::resources(app)
            .map_err(|e| e.to_string())?
            .join("cua/cua-driver");
        let target = target
            .map(|t| crate::background_worker::Target::capture(t.pid, t.window))
            .transpose()?;
        let generation = token()?;
        let driver =
            tokio::task::spawn_blocking(move || CuaDriver::spawn(&path, target, generation))
                .await
                .map_err(|e| e.to_string())??;
        driver.initialize().await?;
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
            s.driver.cancel();
        }
        let _ = reason;
    }
    fn pause(reason: &str) {
        EPOCH.fetch_add(1, Ordering::SeqCst);
        if let Some(s) = SESSION.lock().unwrap().as_mut() {
            s.driver.cancel();
            s.paused = true;
            s.needs_worker = true;
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
            s.driver.cancel();
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
                if BUSY.try_lock().is_err() {
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
        if !available || now().saturating_sub(s.heartbeat) > 60000 {
            drop(session);
            stop("Background session expired or unavailable");
            return;
        }
        if !s.paused && geometry(&s.target).is_err() {
            drop(session);
            pause("Target became foreground or unavailable. Explicit Resume required.");
            return;
        }
        if !s.paused && !s.needs_worker && !s.driver.is_available() {
            drop(session);
            pause("Background worker ended. Inspect the app before resuming.");
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
        let epoch = EPOCH.load(Ordering::SeqCst);
        // One FIFO per host. Stop/Release bypass it; their epoch cancels queued work.
        let _operation = tokio::time::timeout(std::time::Duration::from_secs(25), BUSY.lock())
            .await
            .map_err(|_| "Background operation queue timed out; nothing was dispatched")?;
        check_epoch(epoch)?;
        if op == "computer-apps" {
            let kind = match args.get("kind") {
                None => "windows",
                Some(value) => value.as_str().ok_or("Invalid app list kind")?,
            };
            if !["apps", "windows"].contains(&kind) {
                return Err("Invalid app list kind".into());
            }
            let limit = integer(args, "limit", 20, 1, 50)?;
            let pid = integer(args, "pid", 0, 1, i32::MAX as usize)?;
            integer(args, "cursor", 0, 0, 100000)?;
            query(args)?;
            let existing = SESSION
                .lock()
                .unwrap()
                .as_ref()
                .filter(|s| s.driver.is_available())
                .map(|s| s.driver.clone());
            let temporary = existing.is_none();
            let driver = match existing {
                Some(driver) => driver,
                None => worker(None).await?,
            };
            let result = async {
                let result = structured(
                    &call(
                        &driver,
                        if kind == "apps" {
                            "list_apps"
                        } else {
                            "list_windows"
                        },
                        json!({}),
                    )
                    .await?,
                )?;
                let mut rows = result[kind].as_array().ok_or("Missing app list")?.clone();
                rows.retain(|v| pid == 0 || v["pid"] == pid);
                // Stable ordering makes cursors useful while the app/window set is unchanged.
                rows.sort_by_key(|v| {
                    (
                        v["pid"].as_u64().unwrap_or(0),
                        v["window_id"].as_u64().unwrap_or(0),
                        v["name"].as_str().unwrap_or("").to_owned(),
                    )
                });
                check_epoch(epoch)?;
                page(
                    json!({"kind":kind,"current_space_id":result["current_space_id"]}),
                    kind,
                    rows,
                    args,
                    limit,
                )
            }
            .await;
            if temporary {
                let _ = driver.shutdown().await;
            }
            return result;
        }
        if op == "computer-app-state" {
            let read_args = json!({"max_elements":integer(args,"max_elements",300,1,300)?,
                "max_depth":integer(args,"max_depth",15,1,25)?,"cursor":integer(args,"cursor",0,0,100000)?,"query":query(args)?});
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
                    Some(s) => s.driver.is_available().then(|| s.driver.clone()), None => None,
                }
            };
            let driver = match existing {
                Some(d) => d,
                None => worker(Some(&target)).await?,
            };
            if let Err(error) = check_epoch(epoch) {
                let _ = driver.shutdown().await;
                return Err(error);
            }
            {
                let mut guard = SESSION.lock().unwrap();
                if let Some(s) = guard.as_mut() {
                    s.driver = driver.clone();
                    s.needs_worker = false;
                    s.read_args = read_args.clone();
                }
                if guard.is_none() {
                    *guard = Some(Session {
                        id: token()?,
                        owner: owner.into(),
                        target,
                        driver: driver.clone(),
                        observation: None,
                        preview: json!({"active":true}),
                        paused: false,
                        needs_worker: false,
                        heartbeat: now(),
                        read_args,
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
        if element.is_some() {
            input["snapshot_id"] = observation.state["snapshot_id"].clone();
        }
        let tool = match args["action"].as_str() {
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
                // A reduced AX walk cannot establish that an unobserved pixel target is native.
                if (observation.state["read_max_elements"] != 300
                    || observation.state["read_max_depth"] != 15)
                    && !observation.state["elements"]
                        .as_array()
                        .is_some_and(|elements| {
                            elements.iter().any(|e| {
                                e["element_token"].as_str() == element
                                    && e["in_web_content"] != true
                                    && matches!(
                                        e["role"].as_str(),
                                        Some("AXTextArea" | "AXTextField" | "AXSearchField")
                                    )
                            })
                        })
                {
                    return Err(
                        "Text with reduced AX limits requires an observed native text element"
                            .into(),
                    );
                }
                if observation.state["elements"]
                    .as_array()
                    .is_some_and(|elements| {
                        elements
                            .iter()
                            .any(|e| e["in_web_content"] == true || e["role"] == "AXWebArea")
                    })
                {
                    return Err("Background text in web views is unavailable on this host. Use browser tools or explicitly hand off to physical control.".into());
                }
                let text = args["text"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.chars().count() <= 4000)
                    .ok_or("Text must contain 1–4000 characters")?;
                input["text"] = json!(text);
                input["delay_ms"] = json!(0);
                "type_text"
            }
            _ => {
                return Err(
                    "Unsupported background action. Physical input requires an explicit handoff"
                        .into(),
                )
            }
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
                let mut receipt = structured(&action)?;
                if let Some(object) = receipt.as_object_mut() {
                    object.remove("escalation");
                }
                if bound_text(&mut receipt) {
                    receipt["text_truncated"] = json!(true);
                }
                let uncertain = !matches!(
                    receipt["effect"].as_str(),
                    Some("confirmed" | "unverifiable")
                ) || tool == "type_text" && receipt["effect"] != "confirmed";
                match observe(driver, epoch).await {
                    Ok(mut state) => {
                        state["action"] = receipt;
                        state["verification"] = json!({"screenshot_changed":state["screenshot_hash"] != observation.image_hash,
                            "requires_inspection":true,"note":"Inspect the returned screenshot/elements for the intended change. Image changes and delivery receipts alone do not prove success; never replay uncertain input."});
                        if uncertain {
                            pause("Delivery could not be confirmed. Inspect the app before resuming; do not replay input.");
                            state["paused"] = json!(true);
                            state["requires_local_resume"] = json!(true);
                        }
                        let image = state.as_object_mut().unwrap().remove("image");
                        while state.to_string().len() > 11000
                            && state["elements"].as_array().is_some_and(|v| !v.is_empty())
                        {
                            state["elements"].as_array_mut().unwrap().pop();
                            let count = state["elements"].as_array().unwrap().len();
                            state["returned_element_count"] = json!(count);
                            state["page"]["returned"] = json!(count);
                            state["next"] =
                                json!(state["page"]["cursor"].as_u64().unwrap_or(0) + count as u64);
                        }
                        if let Some(image) = image {
                            state["image"] = image;
                        }
                        Ok(state)
                    }
                    Err(error) => {
                        if uncertain {
                            pause("Delivery could not be confirmed. Inspect the app before resuming; do not replay input.");
                        }
                        Ok(
                            json!({"session":args["session"],"pid":target.pid,"window_id":target.window,
                            "consumed_observation":observation.id,"action":receipt,"observation_error":error,
                            "requires_fresh_observation":true,"requires_local_resume":uncertain}),
                        )
                    }
                }
            }
            Err(error) => {
                pause("Action failed or its result is uncertain. Inspect the app before resuming.");
                Ok(
                    json!({"session":args["session"],"pid":target.pid,"window_id":target.window,
                    "consumed_observation":observation.id,"error":error.chars().take(1500).collect::<String>(),"requires_local_resume":true,
                    "requires_fresh_observation":true,"replay_allowed":false}),
                )
            }
        }
    }
    async fn observe(driver: Arc<CuaDriver>, epoch: u64) -> Result<Value, String> {
        let (target, read_args) = {
            let guard = SESSION.lock().unwrap();
            let session = guard.as_ref().ok_or("Background session ended")?;
            (session.target.clone(), session.read_args.clone())
        };
        let before = geometry(&target)?;
        let result = call(&driver,"get_window_state",json!({"pid":target.pid,"window_id":target.window,
            "max_elements":read_args["max_elements"],"max_depth":read_args["max_depth"],"max_dimension":1280})).await?;
        check_epoch(epoch)?;
        if geometry(&target)? != before {
            return Err("Window changed during capture; take a fresh observation".into());
        }
        let mut state = structured(&result)?;
        // Cua includes the application menu bar in window snapshots. Keep only
        // descendants of this window; menu actions are not window authority.
        if let Some(elements) = state["elements"].as_array_mut() {
            let mut indices = std::collections::HashSet::new();
            elements.retain(|element| {
                let inside = element["role"] == "AXWindow" && element["depth"] == 0
                    || element["parent_index"]
                        .as_u64()
                        .is_some_and(|parent| indices.contains(&parent));
                if inside {
                    if let Some(index) = element["element_index"].as_u64() {
                        indices.insert(index);
                    }
                }
                inside
            });
        }
        let count = state["elements"].as_array().map_or(0, Vec::len);
        for field in [
            "element_count",
            "returned_element_count",
            "total_element_count",
        ] {
            state[field] = json!(count);
        }
        state
            .as_object_mut()
            .ok_or("Invalid window receipt")?
            .remove("tree_markdown");
        if state["pid"] != target.pid
            || state["window_id"] != target.window
            || !state["snapshot_id"].as_str().is_some_and(|s| !s.is_empty())
        {
            return Err("Window observation identity mismatch".into());
        }
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
        state["read_max_elements"] = read_args["max_elements"].clone();
        state["read_max_depth"] = read_args["max_depth"].clone();
        let image_hash = format!("{:x}", Sha256::digest(image.data_base64.as_bytes()));
        s.observation = Some(Observation {
            id: id.clone(),
            at,
            geometry: before,
            state: state.clone(),
            image_hash: image_hash.clone(),
        });
        state["observation"] = json!(id);
        state["session"] = json!(s.id);
        state["observedAt"] = json!(at);
        state["screenshot_hash"] = json!(image_hash);
        s.heartbeat = at;
        s.preview = json!({"active":true,"paused":false,"session":s.id,"app":state["app_name"],"observedAt":at,
            "image":image.data_base64,"imageMime":image.mime_type,"width":state["screenshot_width"],"height":state["screenshot_height"],"cursor":s.preview["cursor"]});
        drop(guard);
        show_preview();
        let rows = state["elements"].as_array().cloned().unwrap_or_default();
        // Keep control identity, geometry, and failure metadata ahead of optional tree detail.
        state.as_object_mut().unwrap().retain(|key, _| {
            [
                "pid",
                "window_id",
                "app_name",
                "window_title",
                "session",
                "observation",
                "observedAt",
                "snapshot_id",
                "screenshot_hash",
                "screenshot_width",
                "screenshot_height",
                "window_bounds",
                "screenshot_scale",
                "screenshot_frame_valid",
                "screenshot_error",
                "degraded",
                "degraded_reason",
                "element_count",
                "total_element_count",
                "returned_element_count",
                "elements_complete",
            ]
            .contains(&key.as_str())
        });
        state["read_limits"] =
            json!({"max_elements":read_args["max_elements"],"max_depth":read_args["max_depth"]});
        state = page(state, "elements", rows, &read_args, 300)?;
        state["image"] = json!(image.data_base64);
        state["imageMime"] = json!(image.mime_type);
        Ok(state)
    }
}

pub fn tick(available: bool) {
    #[cfg(target_os = "macos")]
    macos::tick(available);
    #[cfg(not(target_os = "macos"))]
    let _ = available;
}
