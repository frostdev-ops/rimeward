//! Cua's private SDK channel with independent cancellation and a release-only child.
//! No request, including a stalled read, owns the Stop channel.
use cua_driver_sdk::worker::{
    ActionCompletion, ChannelRequest, ChannelResponse, WorkerInitialization,
};
use cua_driver_sdk::{
    ConfiguredDriverOptions, DriverMetadata, RuntimeAuthorizationOptions, SessionPermissionMode,
};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::{
    fd::{AsRawFd, FromRawFd},
    unix::{net::UnixStream, process::CommandExt},
};
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

// Private event layouts are accepted only on an OS build exercised with the signed host.
// No environment variable or agent argument can opt another build in.
pub fn validated_host() -> bool {
    static VALIDATED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *VALIDATED.get_or_init(|| {
        let mut build = [0u8; 128];
        let mut size = build.len();
        cfg!(target_arch = "aarch64")
            && unsafe {
                libc::sysctlbyname(
                    c"kern.osversion".as_ptr(),
                    build.as_mut_ptr().cast(),
                    &mut size,
                    std::ptr::null_mut(),
                    0,
                ) == 0
            }
            && build.get(..size) == Some(b"26A5416b\0")
    })
}

static GUARDIANS: AtomicUsize = AtomicUsize::new(0);
pub fn settled() -> bool {
    GUARDIANS.load(Ordering::SeqCst) == 0
}
pub fn stamp(pid: i32) -> Option<(u64, u64)> {
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
            || info.pbi_status == 5
        {
            return None;
        }
        Some((info.pbi_start_tvsec, info.pbi_start_tvusec))
    }
}
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Target {
    pub pid: i32,
    pub window: u32,
    pub stamp: (u64, u64),
    pub bounds: [f64; 4],
    pub space: u64,
}
impl Target {
    pub fn capture(pid: i32, window: u32) -> Result<Self, String> {
        let w = platform_macos::windows::all_windows()
            .into_iter()
            .find(|w| w.pid == pid && w.window_id == window)
            .ok_or("Target window closed")?;
        Ok(Self {
            pid,
            window,
            stamp: stamp(pid).ok_or("Target process exited")?,
            bounds: [w.bounds.x, w.bounds.y, w.bounds.width, w.bounds.height],
            space: w.current_space_id.ok_or("Window Space unavailable")?,
        })
    }
    fn background(&self) -> bool {
        stamp(self.pid) == Some(self.stamp)
            && platform_macos::input::skylight::front_process_matches(self.pid, self.window)
                == Some(false)
            && crate::remote_session::active()
            && platform_macos::windows::all_windows().iter().any(|w| {
                w.pid == self.pid
                    && w.window_id == self.window
                    && [w.bounds.x, w.bounds.y, w.bounds.width, w.bounds.height] == self.bounds
                    && w.current_space_id == Some(self.space)
                    && w.is_on_screen
                    && w.on_current_space == Some(true)
            })
    }
}
pub struct Image {
    pub mime_type: String,
    pub data_base64: String,
}
pub struct ToolResult {
    pub structured_json: Option<String>,
    pub images: Vec<Image>,
    pub is_error: bool,
    pub error_code: Option<String>,
    pub text: String,
}
struct Channel {
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next: u64,
}
pub struct Worker {
    generation: String,
    pid: u32,
    channel: Mutex<Channel>,
    stop: Mutex<Option<ChildStdin>>,
    alive: Arc<AtomicBool>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.cancel();
    }
}
impl Worker {
    pub fn spawn(
        path: &std::path::Path,
        target: Option<Target>,
        generation: String,
    ) -> Result<Arc<Self>, String> {
        if !settled() {
            return Err("Previous background input is still being released; retry shortly".into());
        }
        let (worker_pipe, guard_pipe) = UnixStream::pair().map_err(|e| e.to_string())?;
        let fd = worker_pipe.as_raw_fd();
        let mut command = Command::new(path);
        command
            .args(["__private-worker", "--generation", &generation])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("HOME", std::env::var_os("HOME").unwrap_or_default())
            .env("CUA_DRIVER_RS_TELEMETRY_ENABLED", "false")
            .env("CUA_DRIVER_EMBEDDED", "1")
            .env("CUA_DRIVER_HOST_BUNDLE_ID", "io.frostdev.rimeward")
            .env("RIMEWARD_BACKGROUND_GUARD_FD", fd.to_string());
        unsafe {
            command.pre_exec(move || {
                if libc::fcntl(fd, libc::F_SETFD, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        drop(worker_pipe);
        let pid = child.id() as i32;
        let identity = stamp(pid).ok_or("Worker exited during startup")?;
        let fd = guard_pipe.as_raw_fd();
        let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
        command
            .arg("--rimeward-background-guardian")
            .arg(pid.to_string())
            .arg(serde_json::to_string(&identity).unwrap())
            .arg(serde_json::to_string(&target).unwrap())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env("RIMEWARD_BACKGROUND_GUARD_FD", fd.to_string());
        unsafe {
            command.pre_exec(move || {
                if libc::fcntl(fd, libc::F_SETFD, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut guardian = match command.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        };
        drop(guard_pipe);
        let stop = guardian.stdin.take();
        let alive = Arc::new(AtomicBool::new(true));
        let input = child.stdin.take().ok_or("Worker stdin missing")?;
        let output = BufReader::new(child.stdout.take().ok_or("Worker stdout missing")?);
        let live = alive.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            live.store(false, Ordering::SeqCst);
        });
        GUARDIANS.fetch_add(1, Ordering::SeqCst);
        std::thread::spawn(move || {
            let _ = guardian.wait();
            GUARDIANS.fetch_sub(1, Ordering::SeqCst);
        });
        Ok(Arc::new(Self {
            generation,
            pid: pid as u32,
            channel: Mutex::new(Channel {
                input,
                output,
                next: 0,
            }),
            stop: Mutex::new(stop),
            alive,
        }))
    }
    pub fn cancel(&self) {
        self.alive.store(false, Ordering::SeqCst);
        self.stop.lock().unwrap().take();
    }
    pub fn is_available(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
    pub async fn shutdown(&self) -> Result<(), String> {
        self.cancel();
        Ok(())
    }
    async fn request(
        self: &Arc<Self>,
        operation: &str,
        name: Option<String>,
        arguments: Option<Value>,
    ) -> Result<Value, String> {
        if !self.is_available() {
            return Err("Background worker ended; never replay uncertain input".into());
        }
        let this = self.clone();
        let operation = operation.to_owned();
        let job = tokio::task::spawn_blocking(move || {
            let mut c = this.channel.lock().unwrap();
            if !this.is_available() {
                return Err("Background worker ended".to_string());
            }
            let id = c.next;
            c.next += 1;
            let req = ChannelRequest {
                protocol_version: 1,
                request_id: id,
                generation: this.generation.clone(),
                operation,
                name,
                arguments,
                session_handle: None,
            };
            serde_json::to_writer(&mut c.input, &req).map_err(|e| e.to_string())?;
            c.input
                .write_all(b"\n")
                .and_then(|_| c.input.flush())
                .map_err(|e| e.to_string())?;
            let mut line = String::new();
            // Bounded even if a compromised worker omits its newline.
            (&mut c.output)
                .take(12 * 1024 * 1024)
                .read_line(&mut line)
                .map_err(|e| e.to_string())?;
            let r: ChannelResponse = serde_json::from_str(&line).map_err(|_| "Worker channel ended or returned an invalid receipt; action may be partial, never replay it".to_string())?;
            if r.protocol_version != 1
                || r.request_id != id
                || r.generation != this.generation
                || !r.ok
                || r.completion != ActionCompletion::Completed
            {
                return Err(r
                    .error
                    .unwrap_or("Worker response identity/completion mismatch".into()));
            }
            r.result.ok_or("Worker omitted receipt".into())
        });
        let result = match tokio::time::timeout(Duration::from_secs(30), job).await {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => {
                Err("Background worker timed out; action may be partial, never replay it".into())
            }
        };
        if result.is_err() {
            self.cancel();
        }
        result
    }
    pub async fn initialize(self: &Arc<Self>) -> Result<(), String> {
        let init = WorkerInitialization {
            host_bundle_id: "io.frostdev.rimeward".into(),
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
        };
        let ready = self
            .request(
                "initialize",
                None,
                Some(serde_json::to_value(init).unwrap()),
            )
            .await?;
        if ready["ready"] != true
            || ready["host_bundle_id"] != "io.frostdev.rimeward"
            || ready["rimeward_release_guard"] != 1
            || ready["pid"] != self.pid
        {
            self.cancel();
            return Err("Worker readiness mismatch".into());
        }
        Ok(())
    }
    pub async fn metadata(self: &Arc<Self>) -> Result<DriverMetadata, String> {
        let raw = self.request("metadata", None, None).await?;
        if raw["pid"] != self.pid {
            self.cancel();
            return Err("Worker process identity mismatch".into());
        }
        serde_json::from_value(raw).map_err(|e| e.to_string())
    }
    pub async fn call_tool(
        self: &Arc<Self>,
        name: String,
        arguments: String,
    ) -> Result<ToolResult, String> {
        let action = ["click", "scroll", "type_text"].contains(&name.as_str());
        let raw = self
            .request(
                "call",
                Some(name),
                Some(serde_json::from_str(&arguments).map_err(|e| e.to_string())?),
            )
            .await?;
        if action
            && raw["isError"] != true
            && (raw["structuredContent"]["delivery"]["mode"] != "background"
                || !matches!(
                    raw["structuredContent"]["effect"].as_str(),
                    Some("confirmed" | "unverifiable" | "partial" | "refused")
                ))
        {
            self.cancel();
            return Err("Invalid background action receipt; do not replay input".into());
        }
        let content = raw["content"].as_array().ok_or("Invalid tool content")?;
        Ok(ToolResult {
            structured_json: raw.get("structuredContent").map(Value::to_string),
            text: content
                .iter()
                .filter_map(|c| c["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            is_error: raw["isError"].as_bool().unwrap_or(false),
            error_code: raw["structuredContent"]["code"].as_str().map(str::to_owned),
            images: content
                .iter()
                .filter(|c| c["type"] == "image")
                .filter_map(|c| {
                    Some(Image {
                        mime_type: c["mimeType"].as_str()?.into(),
                        data_base64: c["data"].as_str()?.into(),
                    })
                })
                .collect(),
        })
    }
}

/// Only releases recorded before a down event. This process cannot initiate input.
pub fn guardian() -> i32 {
    use objc2_core_foundation::CFData;
    use objc2_core_graphics::{CGEvent, CGEventField, CGEventType};
    let run = || -> Result<(), String> {
        let args: Vec<_> = std::env::args().collect();
        let pid: i32 = args
            .get(2)
            .ok_or("Worker pid missing")?
            .parse()
            .map_err(|_| "Invalid worker pid")?;
        let identity: (u64, u64) =
            serde_json::from_str(args.get(3).ok_or("Worker identity missing")?)
                .map_err(|e| e.to_string())?;
        let target: Option<Target> = serde_json::from_str(args.get(4).ok_or("Target missing")?)
            .map_err(|e| e.to_string())?;
        let fd: i32 = std::env::var("RIMEWARD_BACKGROUND_GUARD_FD")
            .map_err(|e| e.to_string())?
            .parse()
            .map_err(|_| "Invalid guard pipe")?;
        let mut stream = unsafe { UnixStream::from_raw_fd(fd) };
        stream
            .set_read_timeout(Some(Duration::from_millis(250)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_millis(250)))
            .map_err(|e| e.to_string())?;
        let mut held: std::collections::HashMap<i64, objc2_core_foundation::CFRetained<CGEvent>> =
            std::collections::HashMap::new();
        loop {
            let mut poll = [
                libc::pollfd {
                    fd: 0,
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd,
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            if unsafe { libc::poll(poll.as_mut_ptr(), 2, 50) } < 0
                || poll[0].revents != 0
                || stamp(pid) != Some(identity)
                || target.as_ref().is_some_and(|t| !t.background())
            {
                break;
            }
            if poll[1].revents == 0 {
                continue;
            }
            let request = (|| -> Result<Value, String> {
                let mut size = [0u8; 4];
                stream.read_exact(&mut size).map_err(|e| e.to_string())?;
                let size = u32::from_be_bytes(size) as usize;
                if size > 65536 {
                    return Err("Oversized guard message".into());
                }
                let mut bytes = vec![0; size];
                stream.read_exact(&mut bytes).map_err(|e| e.to_string())?;
                serde_json::from_slice(&bytes).map_err(|e| e.to_string())
            })();
            let Ok(message) = request else {
                break;
            };
            if message["clear"] == true {
                if let Some(t) = target.as_ref().filter(|t| stamp(t.pid) == Some(t.stamp)) {
                    for event in held.values() {
                        release_event(t.pid, event, true);
                    }
                }
                held.clear();
            } else if let Some(slot) = message["released"].as_i64() {
                if target.as_ref().is_none_or(|t| message["pid"] != t.pid) {
                    break;
                }
                held.remove(&slot);
            } else {
                let Some(t) = target.as_ref() else {
                    break;
                };
                if message["pid"] != t.pid || !t.background() {
                    break;
                }
                let Ok(bytes) = serde_json::from_value::<Vec<u8>>(message["event"].clone()) else {
                    break;
                };
                let Some(event) = CGEvent::from_data(None, Some(&CFData::from_bytes(&bytes)))
                else {
                    break;
                };
                let kind = CGEvent::r#type(Some(&event));
                if ![
                    CGEventType::KeyDown,
                    CGEventType::KeyUp,
                    CGEventType::LeftMouseDown,
                    CGEventType::LeftMouseUp,
                    CGEventType::MouseMoved,
                    CGEventType::ScrollWheel,
                ]
                .contains(&kind)
                {
                    break;
                }
                let release = if kind == CGEventType::KeyDown {
                    Some((
                        1000 + CGEvent::integer_value_field(
                            Some(&event),
                            CGEventField::KeyboardEventKeycode,
                        ),
                        CGEventType::KeyUp,
                    ))
                } else if kind == CGEventType::LeftMouseDown {
                    Some((1, CGEventType::LeftMouseUp))
                } else {
                    None
                };
                if let Some((slot, up)) = release {
                    if held.len() > 8 {
                        break;
                    }
                    let event = if up == CGEventType::KeyUp {
                        // A deserialized down can retain an obsolete authentication envelope.
                        // Build a fresh key release; mouse releases retain exact window routing.
                        let code = CGEvent::integer_value_field(
                            Some(&event),
                            CGEventField::KeyboardEventKeycode,
                        );
                        let Ok(code) = u16::try_from(code) else {
                            break;
                        };
                        let Some(release) = CGEvent::new_keyboard_event(None, code, false) else {
                            break;
                        };
                        CGEvent::set_flags(
                            Some(&release),
                            objc2_core_graphics::CGEventFlags::empty(),
                        );
                        release
                    } else {
                        CGEvent::set_type(Some(&event), up);
                        event
                    };
                    if !release_event(t.pid, &event, false) {
                        break;
                    }
                    held.insert(slot, event);
                }
            }
            if stream.write_all(&[1]).is_err() {
                break;
            }
        }
        // Stop the sender before releasing; it can no longer post after our release.
        if stamp(pid) == Some(identity) {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        for _ in 0..100 {
            if stamp(pid) != Some(identity) {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        if let Some(t) = target.filter(|t| stamp(t.pid) == Some(t.stamp)) {
            for event in held.values() {
                release_event(t.pid, event, true);
            }
        }
        Ok(())
    };
    if run().is_ok() {
        0
    } else {
        1
    }
}

// Release through the same authenticated SkyLight route as Cua's sender.
// The bridge follows the pinned Cua skylight.rs (MIT; bundled Cua notice).
pub fn release_event(pid: i32, event: &objc2_core_graphics::CGEvent, post_event: bool) -> bool {
    use objc2_core_graphics::{CGEvent, CGEventType};
    use std::ffi::{c_void, CStr};
    unsafe fn symbol<T: Copy>(name: &CStr) -> Option<T> {
        let p = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
        if p.is_null() {
            None
        } else {
            Some(unsafe { std::mem::transmute_copy(&p) })
        }
    }
    if !validated_host()
        || ![CGEventType::KeyUp, CGEventType::LeftMouseUp].contains(&CGEvent::r#type(Some(event)))
    {
        return false;
    }
    unsafe {
        libc::dlopen(
            c"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight".as_ptr(),
            libc::RTLD_LAZY | libc::RTLD_GLOBAL,
        );
        let Some(post) = symbol::<unsafe extern "C" fn(i32, *mut c_void)>(c"SLEventPostToPid")
        else {
            return false;
        };
        let event_ptr = (event as *const CGEvent).cast_mut().cast::<c_void>();
        if CGEvent::r#type(Some(event)) == CGEventType::KeyUp {
            let (Some(class), Some(selector), Some(responds), Some(send), Some(set)) = (
                symbol::<unsafe extern "C" fn(*const libc::c_char) -> *mut c_void>(
                    c"objc_getClass",
                ),
                symbol::<unsafe extern "C" fn(*const libc::c_char) -> *mut c_void>(
                    c"sel_registerName",
                ),
                symbol::<unsafe extern "C" fn(*mut c_void, *mut c_void) -> bool>(
                    c"class_respondsToSelector",
                ),
                symbol::<
                    unsafe extern "C" fn(
                        *mut c_void,
                        *mut c_void,
                        *mut c_void,
                        i32,
                        u32,
                    ) -> *mut c_void,
                >(c"objc_msgSend"),
                symbol::<unsafe extern "C" fn(*mut c_void, *mut c_void)>(
                    c"SLEventSetAuthenticationMessage",
                ),
            ) else {
                return false;
            };
            let cls = class(c"SLSEventAuthenticationMessage".as_ptr());
            let sel = selector(c"messageWithEventRecord:pid:version:".as_ptr());
            let Some(meta) =
                symbol::<unsafe extern "C" fn(*mut c_void) -> *mut c_void>(c"object_getClass")
            else {
                return false;
            };
            if cls.is_null() || sel.is_null() || !responds(meta(cls), sel) {
                return false;
            }
            let mut record = std::ptr::null_mut();
            for offset in [24usize, 32, 16] {
                record = std::ptr::read_unaligned(
                    event_ptr.cast::<u8>().add(offset).cast::<*mut c_void>(),
                );
                if !record.is_null() {
                    break;
                }
            }
            if record.is_null() {
                return false;
            }
            let message = send(cls, sel, record, pid, 0);
            if message.is_null() {
                return false;
            }
            set(event_ptr, message);
        }
        if post_event {
            post(pid, event_ptr);
        }
        true
    }
}
