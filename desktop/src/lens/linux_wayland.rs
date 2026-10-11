//! A private ScreenCast-only portal session and capture-only media child.
//! Portal coordinates/application metadata never become native identity proof.

use super::{
    bridge::{DisplayInfo, FrameGeometry},
    request::Cancellation,
    CaptureLease, Lens, Target,
};
use ashpd::{
    desktop::{
        screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType},
        PersistMode, Session,
    },
    zbus::{self, zvariant::OwnedValue},
};
use futures_util::{FutureExt, StreamExt};
use std::{
    collections::HashMap,
    future::Future,
    os::fd::{AsRawFd, OwnedFd},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout, Command},
};

const FRAME_BUDGET: Duration = Duration::from_secs(5);
const START_BUDGET: Duration = Duration::from_secs(30);
const DBUS_BUDGET: Duration = Duration::from_millis(500);
const PIXEL_CAP: usize = 32 * 1024 * 1024;
const SCORE: &str = "linux:pipewire:rgb16-tile32-v1";
const PORTAL: &str = "org.freedesktop.portal.Desktop";

pub struct Backend {
    lens: Weak<Lens>,
    media: PathBuf,
    run: Mutex<Option<Run>>,
    lifecycle: tokio::sync::Mutex<()>,
    retirement: tokio::sync::Mutex<Option<Retirement>>,
    ordinal: AtomicU64,
}
struct Run {
    control: Arc<Control>,
    worker: tokio::task::JoinHandle<Result<(), String>>,
}
enum Retirement {
    Pending(tokio::task::JoinHandle<Result<(), String>>),
    Failed,
}
struct Control {
    lens: Weak<Lens>,
    generation: AtomicU64,
    cancel: Arc<Cancellation>,
    request: Arc<Cancellation>,
}
impl Control {
    fn check(&self) -> Result<(), String> {
        if self.cancel.is_cancelled()
            || self.request.is_cancelled()
            || !crate::remote_session::active()
            || !self.lens.upgrade().is_some_and(|lens| {
                lens.request_generation() == self.generation.load(Ordering::Acquire)
            })
        {
            return Err("cancelled".into());
        }
        Ok(())
    }
    fn invalidate(&self, reason: &str) {
        if let Some(lens) = self.lens.upgrade() {
            if let Some(generation) =
                lens.invalidate_source(self.generation.load(Ordering::Acquire), reason)
            {
                self.generation.store(generation, Ordering::Release);
            }
        }
    }
    /// A deadline bounds even a stalled bus/read. Check the exact generation
    /// throughout, rather than adopting a later unrelated Lens generation.
    async fn within<T>(
        &self,
        budget: Duration,
        future: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        self.check()?;
        tokio::pin!(future);
        let deadline = tokio::time::sleep(budget);
        tokio::pin!(deadline);
        loop {
            tokio::select! { biased;
                _ = self.cancel.cancelled() => return Err("cancelled".into()),
                _ = self.request.cancelled() => return Err("cancelled".into()),
                _ = &mut deadline => return Err("wayland-timeout".into()),
                _ = tokio::time::sleep(Duration::from_millis(25)) => self.check()?,
                result = &mut future => { self.check()?; return result; }
            }
        }
    }
}
async fn wait_retirement(
    retirement: &mut Option<Retirement>,
    budget: Duration,
) -> Result<(), String> {
    let result = match retirement {
        Some(Retirement::Pending(join)) => tokio::time::timeout(budget, join).await,
        Some(Retirement::Failed) => return Err("wayland-stop-failed".into()),
        None => return Ok(()),
    };
    match result {
        Ok(Ok(Ok(()))) => {
            *retirement = None;
            Ok(())
        }
        Err(_) => Err("wayland-stop-timeout".into()),
        Ok(_) => {
            *retirement = Some(Retirement::Failed);
            Err("wayland-stop-failed".into())
        }
    }
}
impl Backend {
    /// Attachment has no portal request, native capture or permission prompt.
    pub fn attach(_app: &tauri::AppHandle, lens: &Arc<Lens>, media: &Path) -> Arc<Self> {
        Arc::new(Self {
            lens: Arc::downgrade(lens),
            media: media.to_path_buf(),
            run: Mutex::new(None),
            lifecycle: tokio::sync::Mutex::new(()),
            retirement: tokio::sync::Mutex::new(None),
            ordinal: AtomicU64::new(1),
        })
    }
    pub async fn start(
        self: &Arc<Self>,
        expected_generation: u64,
        request: Arc<Cancellation>,
    ) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().await;
        let control = Arc::new(Control {
            lens: self.lens.clone(),
            generation: AtomicU64::new(expected_generation),
            cancel: Cancellation::new(),
            request,
        });
        control.check()?;
        self.stop_inner().await?;
        control.check()?;
        if std::env::var("XDG_SESSION_TYPE").is_ok_and(|kind| kind != "wayland")
            || std::env::var_os("WAYLAND_DISPLAY").is_none()
            || !self.media.join("rimeward-media").is_file()
        {
            return Err("wayland-unavailable".into());
        }
        let ordinal = self
            .ordinal
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value
                    .checked_add(1)
                    .filter(|next| *next <= u64::from(u32::MAX))
            })
            .map_err(|_| "wayland-source-limit")? as u32;
        let (ready, result) = tokio::sync::oneshot::channel();
        let worker_control = control.clone();
        let media = self.media.clone();
        let worker = tokio::spawn(async move {
            let mut owned = Owned::default();
            let mut ready = Some(ready);
            // Keep native owners alive across an observer panic: revoke before
            // resource teardown, then retain the failure at the lifecycle root.
            let observation = std::panic::AssertUnwindSafe(observe(
                &worker_control,
                &mut owned,
                &media,
                ordinal,
                &mut ready,
            ))
            .catch_unwind()
            .await;
            let panic = observation.is_err();
            let reason = match observation {
                Ok(Err(reason)) => reason,
                Ok(Ok(())) => "stopped".into(),
                Err(_) => "wayland-worker-failed".into(),
            };
            worker_control.invalidate(&reason);
            if let Some(ready) = ready.take() {
                let _ = ready.send(Err(reason));
            }
            let cleaned = owned.cleanup().await;
            if panic {
                Err("wayland-worker-failed".into())
            } else {
                cleaned
            }
        });
        *self.run.lock().unwrap() = Some(Run {
            control: control.clone(),
            worker,
        });
        // A provider grant changes State before its OCR drain returns. Do not
        // compare the old generation while that exact mutation is in flight.
        let started = tokio::select! { biased;
            _ = control.cancel.cancelled() => Err("cancelled".into()),
            _ = control.request.cancelled() => Err("cancelled".into()),
            result = tokio::time::timeout(START_BUDGET, result) => {
                match result {
                    Ok(Ok(result)) => result.and_then(|()| control.check()),
                    _ => Err("wayland-start-timeout".into()),
                }
            }
        };
        if started.is_err() {
            control.cancel.cancel();
            self.stop_inner().await?;
        }
        started
    }
    /// State-safe cancellation: no Lens mutex, native dispatch or blocking join.
    pub fn cancel(&self) {
        if let Some(run) = self.run.lock().unwrap().as_ref() {
            run.control.cancel.cancel();
        }
    }
    pub async fn stop(&self) -> Result<(), String> {
        let control = self
            .run
            .lock()
            .unwrap()
            .as_ref()
            .map(|run| run.control.clone());
        if let Some(control) = control {
            control.invalidate("stopped");
            control.cancel.cancel();
        }
        let _lifecycle = self.lifecycle.lock().await;
        self.stop_inner().await
    }
    async fn stop_inner(&self) -> Result<(), String> {
        let mut retirement = self.retirement.lock().await;
        wait_retirement(&mut retirement, FRAME_BUDGET).await?;
        let run = self.run.lock().unwrap().take();
        if let Some(run) = run {
            run.control.invalidate("stopped");
            run.control.cancel.cancel();
            *retirement = Some(Retirement::Pending(run.worker));
            // Timeout or caller cancellation leaves the exact join stored.
            wait_retirement(&mut retirement, FRAME_BUDGET).await?;
        }
        Ok(())
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        if let Some(run) = self.run.get_mut().unwrap().take() {
            run.control.invalidate("stopped");
            run.control.cancel.cancel();
        }
    }
}

#[derive(Default)]
struct Owned {
    connection: Option<zbus::Connection>,
    session: Option<Session<Screencast>>,
    closed: bool,
    child: Option<Child>,
}
impl Owned {
    async fn cleanup(&mut self) -> Result<(), String> {
        // Child destruction and portal closure run concurrently. Dropping a
        // timed-out wait never counts as proof; the backend retains failure.
        let child = async {
            if let Some(child) = &mut self.child {
                if child
                    .try_wait()
                    .map_err(|_| "wayland-child-reap")?
                    .is_none()
                {
                    child.start_kill().map_err(|_| "wayland-child-kill")?;
                }
                child.wait().await.map_err(|_| "wayland-child-reap")?;
            }
            Ok::<_, &str>(())
        };
        let session = async {
            if !self.closed {
                if let Some(session) = &self.session {
                    session.close().await.map_err(|_| "wayland-session-close")?;
                }
            }
            Ok::<_, &str>(())
        };
        let (child, session) = tokio::join!(
            tokio::time::timeout(Duration::from_secs(2), child),
            tokio::time::timeout(Duration::from_secs(2), session)
        );
        // This dedicated bus is never ashpd's shared singleton. Disconnecting
        // also retires a CreateSession interrupted before its handle arrived.
        let connection = if let Some(connection) = self.connection.take() {
            tokio::time::timeout(Duration::from_secs(2), connection.close())
                .await
                .is_ok_and(|result| result.is_ok())
        } else {
            true
        };
        if child.is_ok_and(|result| result.is_ok())
            && session.is_ok_and(|result| result.is_ok())
            && connection
        {
            Ok(())
        } else {
            Err("wayland-cleanup-unproved".into())
        }
    }
}
#[derive(Debug, PartialEq)]
struct StreamIdentity {
    node: u32,
    serial: Option<u64>,
    monitor: bool,
}
fn stream_identity(
    code: u32,
    mut results: HashMap<String, OwnedValue>,
    requested: SourceType,
    version: u32,
) -> Result<StreamIdentity, String> {
    if code != 0 {
        return Err(if code == 1 {
            "wayland-permission-denied"
        } else {
            "wayland-portal-failed"
        }
        .into());
    }
    let streams: Vec<(u32, HashMap<String, OwnedValue>)> = results
        .remove("streams")
        .ok_or("wayland-stream-unproved")?
        .try_into()
        .map_err(|_| "wayland-stream-unproved")?;
    if streams.len() != 1 || streams[0].0 == 0 {
        return Err("wayland-stream-ambiguous".into());
    }
    let (node, mut properties) = streams.into_iter().next().unwrap();
    if let Some(kind) = properties.remove("source_type") {
        if u32::try_from(kind).map_err(|_| "wayland-stream-unproved")? != requested as u32 {
            return Err("wayland-stream-unproved".into());
        }
    } else if version >= 3 {
        return Err("wayland-stream-unproved".into());
    }
    let serial = properties
        .remove("pipewire-serial")
        .map(|value| u64::try_from(value).map_err(|_| "wayland-stream-unproved"))
        .transpose()?;
    if serial == Some(0) || (version >= 6 && serial.is_none()) {
        return Err("wayland-stream-unproved".into());
    }
    // Ignore title, id, mapping_id, restore_token, position and size. The
    // portal proves selected authority, not an application/native window PID.
    Ok(StreamIdentity {
        node,
        serial,
        monitor: requested == SourceType::Monitor,
    })
}
async fn raw_start(
    screen: &Screencast,
    session: &Session<Screencast>,
    requested: SourceType,
) -> Result<StreamIdentity, String> {
    // One Start on this exclusive connection. The token is a legal private
    // path element, subscribed before the call to avoid a response race.
    let token = "rimeward_lens";
    let sender = screen
        .connection()
        .unique_name()
        .ok_or("wayland-portal-unavailable")?
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    let path = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
    let request = zbus::Proxy::new(
        screen.connection(),
        PORTAL,
        path.as_str(),
        "org.freedesktop.portal.Request",
    )
    .await
    .map_err(|_| "wayland-portal-unavailable")?;
    let mut responses = request
        .receive_signal("Response")
        .await
        .map_err(|_| "wayland-portal-unavailable")?;
    let options = HashMap::from([("handle_token", zbus::zvariant::Value::from(token))]);
    let actual: zbus::zvariant::OwnedObjectPath = screen
        .call("Start", &(session, "", options))
        .await
        .map_err(|_| "wayland-portal-failed")?;
    if actual.as_str() != path {
        return Err("wayland-request-unproved".into());
    }
    let response = responses.next().await.ok_or("wayland-portal-closed")?;
    if response.body().len() > 64 * 1024 {
        return Err("wayland-stream-unproved".into());
    }
    let (code, results): (u32, HashMap<String, OwnedValue>) = response
        .body()
        .deserialize()
        .map_err(|_| "wayland-stream-unproved")?;
    stream_identity(code, results, requested, screen.version())
}

/// login1 proves the caller's real local session is active and unlocked. A
/// missing/unreadable property refuses capture rather than guessing from env.
struct SessionGuard {
    connection: zbus::Connection,
    path: zbus::zvariant::OwnedObjectPath,
}
impl SessionGuard {
    async fn new() -> Result<Self, String> {
        let connection = zbus::connection::Builder::system()
            .map_err(|_| "wayland-session-unproved")?
            .max_queued(16)
            .build()
            .await
            .map_err(|_| "wayland-session-unproved")?;
        let manager = zbus::Proxy::new(
            &connection,
            "org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
        )
        .await
        .map_err(|_| "wayland-session-unproved")?;
        let path = manager
            .call("GetSessionByPID", &(std::process::id(),))
            .await
            .map_err(|_| "wayland-session-unproved")?;
        drop(manager);
        Ok(Self { connection, path })
    }
    async fn check(&self) -> Result<(), String> {
        let session = zbus::proxy::Builder::<zbus::Proxy<'_>>::new(&self.connection)
            .destination("org.freedesktop.login1")
            .map_err(|_| "wayland-session-unproved")?
            .path(&self.path)
            .map_err(|_| "wayland-session-unproved")?
            .interface("org.freedesktop.login1.Session")
            .map_err(|_| "wayland-session-unproved")?
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await
            .map_err(|_| "wayland-session-unproved")?;
        let manager = zbus::proxy::Builder::<zbus::Proxy<'_>>::new(&self.connection)
            .destination("org.freedesktop.login1")
            .map_err(|_| "wayland-session-unproved")?
            .path("/org/freedesktop/login1")
            .map_err(|_| "wayland-session-unproved")?
            .interface("org.freedesktop.login1.Manager")
            .map_err(|_| "wayland-session-unproved")?
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await
            .map_err(|_| "wayland-session-unproved")?;
        let active: bool = session
            .get_property("Active")
            .await
            .map_err(|_| "wayland-session-unproved")?;
        let locked: bool = session
            .get_property("LockedHint")
            .await
            .map_err(|_| "wayland-session-unproved")?;
        let sleeping: bool = manager
            .get_property("PreparingForSleep")
            .await
            .map_err(|_| "wayland-session-unproved")?;
        let kind: String = session
            .get_property("Type")
            .await
            .map_err(|_| "wayland-session-unproved")?;
        if active && !locked && !sleeping && kind == "wayland" {
            Ok(())
        } else {
            Err("wayland-session-inactive".into())
        }
    }
    async fn security_events(&self) -> Result<impl futures_util::Stream<Item = ()>, String> {
        let session = zbus::Proxy::new(
            &self.connection,
            "org.freedesktop.login1",
            &self.path,
            "org.freedesktop.login1.Session",
        )
        .await
        .map_err(|_| "wayland-session-unproved")?;
        let manager = zbus::Proxy::new(
            &self.connection,
            "org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
        )
        .await
        .map_err(|_| "wayland-session-unproved")?;
        let properties = zbus::Proxy::new(
            &self.connection,
            "org.freedesktop.login1",
            &self.path,
            "org.freedesktop.DBus.Properties",
        )
        .await
        .map_err(|_| "wayland-session-unproved")?;
        let lock = session
            .receive_signal("Lock")
            .await
            .map_err(|_| "wayland-session-unproved")?
            .map(|_| ());
        let sleep = manager
            .receive_signal("PrepareForSleep")
            .await
            .map_err(|_| "wayland-session-unproved")?
            .map(|_| ());
        let changed = properties
            .receive_signal_with_args(
                "PropertiesChanged",
                &[(0, "org.freedesktop.login1.Session")],
            )
            .await
            .map_err(|_| "wayland-session-unproved")?
            .filter_map(|message| async move {
                let body = message
                    .body()
                    .deserialize::<(String, HashMap<String, OwnedValue>, Vec<String>)>();
                match body {
                    Ok((_, changed, invalidated))
                        if ["Active", "LockedHint", "Type"].iter().any(|key| {
                            changed.contains_key(*key) || invalidated.iter().any(|name| name == key)
                        }) =>
                    {
                        Some(())
                    }
                    Err(_) => Some(()),
                    _ => None,
                }
            });
        Ok(futures_util::stream::select(
            futures_util::stream::select(lock, sleep),
            changed,
        ))
    }
}

async fn observe(
    control: &Control,
    owned: &mut Owned,
    media: &Path,
    ordinal: u32,
    ready: &mut Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
) -> Result<(), String> {
    let guard = control.within(DBUS_BUDGET, SessionGuard::new()).await?;
    let events = control.within(DBUS_BUDGET, guard.security_events()).await?;
    tokio::pin!(events);
    control.within(DBUS_BUDGET, guard.check()).await?;
    let connection = control
        .within(DBUS_BUDGET, async {
            zbus::connection::Builder::session()
                .map_err(|_| "wayland-portal-unavailable")?
                .max_queued(16)
                .build()
                .await
                .map_err(|_| "wayland-portal-unavailable".into())
        })
        .await?;
    owned.connection = Some(connection.clone());
    let screen = control
        .within(DBUS_BUDGET, async {
            Screencast::with_connection(connection)
                .await
                .map_err(|_| "wayland-portal-unavailable".into())
        })
        .await?;
    let types = control
        .within(DBUS_BUDGET, async {
            screen
                .available_source_types()
                .await
                .map_err(|_| "wayland-portal-unavailable".into())
        })
        .await?;
    let requested = if types.contains(SourceType::Window) {
        SourceType::Window
    } else if types.contains(SourceType::Monitor) {
        SourceType::Monitor
    } else {
        return Err("wayland-source-unavailable".into());
    };
    // Require v2 cursor negotiation; metadata-only cursors have no implementation.
    let cursors = control
        .within(DBUS_BUDGET, async {
            screen
                .available_cursor_modes()
                .await
                .map_err(|_| "wayland-cursor-unavailable".into())
        })
        .await?;
    let cursor = if cursors.contains(CursorMode::Hidden) {
        CursorMode::Hidden
    } else if cursors.contains(CursorMode::Embedded) {
        CursorMode::Embedded
    } else {
        return Err("wayland-cursor-unavailable".into());
    };
    owned.session = Some(
        control
            .within(FRAME_BUDGET, async {
                screen
                    .create_session(Default::default())
                    .await
                    .map_err(|_| "wayland-session-denied".into())
            })
            .await?,
    );
    let session = owned.session.as_ref().unwrap();
    let closed = control
        .within(DBUS_BUDGET, async {
            session
                .receive_closed()
                .await
                .map_err(|_| "wayland-portal-unavailable".into())
        })
        .await?;
    tokio::pin!(closed);
    // The Closed subscription covers selection, Start, descriptor setup and
    // every read/publication. No reconnect or automatic chooser after closure.
    let body = async {
        control
            .within(FRAME_BUDGET, async {
                screen
                    .select_sources(
                        session,
                        SelectSourcesOptions::default()
                            .set_sources(Some(requested.into()))
                            .set_multiple(false)
                            .set_cursor_mode(cursor)
                            .set_persist_mode(PersistMode::DoNot),
                    )
                    .await
                    .map_err(|_| "wayland-source-denied")?
                    .response()
                    .map_err(|_| "wayland-source-denied".into())
            })
            .await?;
        let identity = control
            .within(START_BUDGET, raw_start(&screen, session, requested))
            .await?;
        control.within(DBUS_BUDGET, guard.check()).await?;
        let fd = control
            .within(DBUS_BUDGET, async {
                screen
                    .open_pipe_wire_remote(session, Default::default())
                    .await
                    .map_err(|_| "wayland-stream-denied".into())
            })
            .await?;
        let owner = control.generation.load(Ordering::Acquire);
        owned.child = Some(launch(media, &fd)?);
        let child = owned.child.as_mut().unwrap();
        let input = child.stdin.take().ok_or("wayland-child-unavailable")?;
        let output = child.stdout.take().ok_or("wayland-child-unavailable")?;
        drop(fd);
        let mut pipe = Frames {
            input,
            output,
            owner,
            request: 0,
            sequence: 0,
            size: None,
        };
        control.within(FRAME_BUDGET, pipe.bind(&identity)).await?;
        let first = loop {
            if let Some(frame) = control.within(FRAME_BUDGET, pipe.next()).await? {
                break frame;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            control.check()?;
        };
        control.within(DBUS_BUDGET, guard.check()).await?;
        let lens = control.lens.upgrade().ok_or("cancelled")?;
        // Complete this exact mutation even if cancelled during its OCR drain;
        // its returned generation is needed to revoke the grant before cleanup.
        let reason = if identity.monitor {
            "wayland-selected-display-frame-local-application-unknown-ocr-only"
        } else {
            "wayland-selected-window-frame-local-application-unknown-ocr-only"
        };
        let generation = lens
            .backend_status(owner, true, false, SCORE, Some(reason))
            .await?;
        control.generation.store(generation, Ordering::Release);
        control.check()?;
        let (target, geometry) = target(ordinal, identity.monitor, first.size);
        let lease = lens
            .accept_target(generation, target, geometry, first.size, geometry.window)
            .ok_or("cancelled")?;
        control
            .generation
            .store(lease.generation, Ordering::Release);
        lens.set_overlay_available(lease.generation, false);
        publish(control, &lens, &lease, first)?;
        ready
            .take()
            .ok_or("cancelled")?
            .send(Ok(()))
            .map_err(|_| "cancelled")?;
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            control.within(DBUS_BUDGET, guard.check()).await?;
            if let Some(frame) = control.within(FRAME_BUDGET, pipe.next()).await? {
                control.within(DBUS_BUDGET, guard.check()).await?;
                publish(control, &lens, &lease, frame)?;
            }
        }
    };
    tokio::pin!(body);
    tokio::select! { biased;
        signal = closed.next() => {
            control.cancel.cancel();
            // Finish any grant already mutating State so its returned
            // generation is carried into revocation before teardown.
            let _ = body.await;
            owned.closed = signal.is_some();
            Err("wayland-source-closed".into())
        }
        _ = events.next() => {
            control.cancel.cancel();
            let _ = body.await;
            Err("wayland-session-invalidated".into())
        }
        result = &mut body => result,
    }
}
struct Frame {
    size: [u32; 2],
    pixels: Arc<[u8]>,
}
fn target(ordinal: u32, monitor: bool, size: [u32; 2]) -> (Target, FrameGeometry) {
    let bounds = [0.0, 0.0, f64::from(size[0]), f64::from(size[1])];
    (
        Target {
            pid: 0,
            bundle: String::new(),
            name: "Unknown application".into(),
            window_id: ordinal,
            title: if monitor {
                "Selected Wayland display (frame-local pixels)"
            } else {
                "Selected Wayland window (frame-local pixels)"
            }
            .into(),
            bounds,
            url: None,
            display: DisplayInfo {
                id: ordinal,
                w: bounds[2],
                h: bounds[3],
                scale: 1.0,
            },
        },
        FrameGeometry {
            window: bounds,
            scale: 1.0,
            content_rect: bounds,
            content_scale: 1.0,
            captured: bounds,
        },
    )
}
fn publish(
    control: &Control,
    lens: &Lens,
    lease: &CaptureLease,
    frame: Frame,
) -> Result<(), String> {
    control.check()?;
    if frame.size != lease.size {
        return Err("wayland-source-invalidated".into());
    }
    // None also means an unchanged frame; the immutable lease is rechecked by
    // shared publication. A concurrent invalidation is caught again here.
    let _ = lens.publish_frame(lease, frame.pixels, frame.size, lease.geometry);
    control.check()
}
struct Frames {
    input: ChildStdin,
    output: ChildStdout,
    owner: u64,
    request: u64,
    sequence: u64,
    size: Option<[u32; 2]>,
}
impl Frames {
    async fn bind(&mut self, identity: &StreamIdentity) -> Result<(), String> {
        self.command(serde_json::json!({"command":"bind","owner":self.owner,"node":identity.node,"serial":identity.serial})).await
    }
    async fn command(&mut self, command: serde_json::Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&command).map_err(|_| "wayland-protocol")?;
        if bytes.len() > 4095 {
            return Err("wayland-protocol".into());
        }
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|_| "wayland-child-closed")?;
        self.input
            .flush()
            .await
            .map_err(|_| "wayland-child-closed".into())
    }
    async fn next(&mut self) -> Result<Option<Frame>, String> {
        self.request = self.request.checked_add(1).ok_or("wayland-protocol")?;
        self.command(serde_json::json!({"command":"frame","owner":self.owner,"request":self.request,"after":self.sequence})).await?;
        let mut header = [0; 40];
        self.output
            .read_exact(&mut header)
            .await
            .map_err(|_| "wayland-child-closed")?;
        let Some((sequence, size, length)) =
            frame_header(&header, self.owner, self.request, self.sequence, self.size)?
        else {
            return Ok(None);
        };
        let mut pixels = vec![0; length];
        self.output
            .read_exact(&mut pixels)
            .await
            .map_err(|_| "wayland-child-closed")?;
        self.sequence = sequence;
        self.size = Some(size);
        // Reprove source liveness after transferring the potentially large
        // frame. This catches EOS/format loss while pixels were in the pipe.
        self.request = self.request.checked_add(1).ok_or("wayland-protocol")?;
        self.command(serde_json::json!({"command":"verify","owner":self.owner,"request":self.request,"after":self.sequence})).await?;
        self.output
            .read_exact(&mut header)
            .await
            .map_err(|_| "wayland-child-closed")?;
        if frame_header(&header, self.owner, self.request, self.sequence, self.size)?.is_some() {
            return Err("wayland-protocol".into());
        }
        Ok(Some(Frame {
            size,
            pixels: pixels.into(),
        }))
    }
}
fn frame_header(
    header: &[u8; 40],
    owner: u64,
    request: u64,
    previous: u64,
    size: Option<[u32; 2]>,
) -> Result<Option<(u64, [u32; 2], usize)>, String> {
    let number = |start| u64::from_be_bytes(header[start..start + 8].try_into().unwrap());
    let next = number(24);
    let actual = [
        u32::from_be_bytes(header[32..36].try_into().unwrap()),
        u32::from_be_bytes(header[36..40].try_into().unwrap()),
    ];
    if &header[..4] != b"RLN1"
        || header[5..8] != [0; 3]
        || number(8) != owner
        || number(16) != request
        || next < previous
    {
        return Err("wayland-protocol".into());
    }
    match header[4] {
        0 if actual == [0, 0] && next == previous => Ok(None),
        1 if next > previous && size.is_none_or(|old| old == actual) => {
            let length = (actual[0] as usize)
                .checked_mul(actual[1] as usize)
                .and_then(|v| v.checked_mul(4))
                .filter(|length| *length > 0 && *length <= PIXEL_CAP)
                .ok_or("wayland-frame-bounds")?;
            if actual.iter().any(|v| *v == 0 || *v > 8192) {
                return Err("wayland-frame-bounds".into());
            }
            Ok(Some((next, actual, length)))
        }
        2 if actual == [0, 0] => Err("wayland-source-closed".into()),
        _ => Err("wayland-source-invalidated".into()),
    }
}
fn launch(media: &Path, fd: &OwnedFd) -> Result<Child, String> {
    let mut command = Command::new(media.join("rimeward-media"));
    command.arg("--lens-pipewire").env_clear();
    for key in ["HOME", "TMPDIR", "XDG_RUNTIME_DIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command.env(
        "PATH",
        std::env::join_paths([media.to_path_buf(), media.join("bin")])
            .map_err(|_| "wayland-helper-path")?,
    );
    command.env("RIMEWARD_LENS_PIPEWIRE_FD", "3");
    command.env("RIMEWARD_MEDIA_PLUGIN_DIR", media.join("lib/gstreamer-1.0"));
    command.env(
        "GST_PLUGIN_SCANNER_1_0",
        media.join("libexec/gstreamer-1.0/gst-plugin-scanner"),
    );
    command.env(
        "GST_REGISTRY_1_0",
        std::env::temp_dir().join(format!("rimeward-lens-gst-{}.bin", std::process::id())),
    );
    command.env("LD_LIBRARY_PATH", media.join("lib"));
    command.env("SPA_PLUGIN_DIR", media.join("lib/spa-0.2"));
    command.env("PIPEWIRE_MODULE_DIR", media.join("lib/pipewire-0.3"));
    command.env("PIPEWIRE_CONFIG_DIR", media.join("share/pipewire"));
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let original = fd.as_raw_fd();
    // Only async-signal-safe descriptor operations in the post-fork child.
    // The original stays CLOEXEC; only the private child FD 3 is inherited.
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(original, 3) == -1 || libc::fcntl(3, libc::F_SETFD, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command
        .spawn()
        .map_err(|_| "wayland-child-unavailable".into())
}

// shortcut: ScreenCast proves selected stream authority but exposes no reliable
// native application/window association or exact overlay placement/exclusion.
// AX and overlays remain false; all transforms are explicitly frame-local.

#[cfg(test)]
mod tests {
    use super::*;
    fn streams(node: u32, serial: Option<u64>) -> HashMap<String, OwnedValue> {
        let mut properties = HashMap::from([("source_type".to_string(), OwnedValue::from(2u32))]);
        if let Some(serial) = serial {
            properties.insert("pipewire-serial".into(), OwnedValue::from(serial));
        }
        let value = zbus::zvariant::Value::from(vec![(node, properties)]);
        HashMap::from([("streams".into(), OwnedValue::try_from(value).unwrap())])
    }
    #[test]
    fn portal_denial_ambiguity_and_serial_reuse_are_not_new_authority() {
        assert_eq!(
            stream_identity(1, streams(7, Some(100)), SourceType::Window, 6),
            Err("wayland-permission-denied".into())
        );
        assert!(stream_identity(0, streams(0, Some(100)), SourceType::Window, 6).is_err());
        assert!(stream_identity(0, streams(7, None), SourceType::Window, 6).is_err());
        assert!(stream_identity(0, streams(7, Some(0)), SourceType::Window, 6).is_err());
        assert!(stream_identity(0, streams(7, Some(100)), SourceType::Monitor, 6).is_err());
        let first = stream_identity(0, streams(7, Some(100)), SourceType::Window, 6).unwrap();
        let reused = stream_identity(0, streams(7, Some(101)), SourceType::Window, 6).unwrap();
        assert_ne!(
            first, reused,
            "a reused node does not preserve its stream identity"
        );
        let legacy = stream_identity(0, streams(7, None), SourceType::Window, 5).unwrap();
        assert_eq!(legacy.serial, None);
        let empty = zbus::zvariant::Value::from(Vec::<(u32, HashMap<String, OwnedValue>)>::new());
        assert!(stream_identity(
            0,
            HashMap::from([("streams".into(), OwnedValue::try_from(empty).unwrap())]),
            SourceType::Window,
            6
        )
        .is_err());
    }
    fn header(status: u8, owner: u64, request: u64, sequence: u64, size: [u32; 2]) -> [u8; 40] {
        let mut header = [0; 40];
        header[..4].copy_from_slice(b"RLN1");
        header[4] = status;
        header[8..16].copy_from_slice(&owner.to_be_bytes());
        header[16..24].copy_from_slice(&request.to_be_bytes());
        header[24..32].copy_from_slice(&sequence.to_be_bytes());
        header[32..36].copy_from_slice(&size[0].to_be_bytes());
        header[36..40].copy_from_slice(&size[1].to_be_bytes());
        header
    }
    #[test]
    fn frame_protocol_refuses_stale_owner_callback_replay_resize_and_unbounded_pixels() {
        let bytes = header(1, 4, 3, 9, [2, 3]);
        assert_eq!(
            frame_header(&bytes, 4, 3, 8, Some([2, 3])),
            Ok(Some((9, [2, 3], 24)))
        );
        assert!(frame_header(&bytes, 5, 3, 8, None).is_err());
        assert!(frame_header(&bytes, 4, 4, 8, None).is_err());
        assert!(frame_header(&bytes, 4, 3, 9, None).is_err());
        assert!(frame_header(&bytes, 4, 3, 8, Some([3, 2])).is_err());
        assert!(frame_header(&header(1, 4, 3, 9, [8192, 8192]), 4, 3, 8, None).is_err());
        assert!(frame_header(&header(1, 4, 3, 9, [0, 2]), 4, 3, 8, None).is_err());
        assert!(frame_header(&header(2, 4, 3, 8, [0, 0]), 4, 3, 8, None).is_err());
        assert_eq!(
            frame_header(&header(0, 4, 3, 8, [0, 0]), 4, 3, 8, None),
            Ok(None)
        );
    }
    #[test]
    fn selected_stream_has_unknown_application_and_frozen_frame_local_transform() {
        let (window, geometry) = target(3, false, [200, 100]);
        assert_eq!(window.pid, 0);
        assert!(window.bundle.is_empty());
        assert_eq!(window.name, "Unknown application");
        assert_eq!(window.window_id, 3);
        assert_eq!(window.bounds, [0.0, 0.0, 200.0, 100.0]);
        assert_eq!(geometry.window, geometry.content_rect);
        assert_eq!(geometry.captured, geometry.window);
        assert_eq!(geometry.scale, 1.0);
        assert_eq!(geometry.content_scale, 1.0);
        assert!(window.url.is_none());
        assert_eq!(
            (
                window.display.id,
                window.display.w,
                window.display.h,
                window.display.scale
            ),
            (3, 200.0, 100.0, 1.0)
        );
        assert!(window.title.contains("frame-local pixels"));
        assert!(target(4, true, [200, 100]).0.title.contains("display"));
    }
    #[tokio::test]
    async fn retirement_retains_pending_and_failed_cleanup_across_stop_or_start() {
        let (send, receive) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(async {
            receive.await.unwrap();
            Ok(())
        });
        let mut retirement = Some(Retirement::Pending(task));
        for _ in 0..2 {
            assert_eq!(
                wait_retirement(&mut retirement, Duration::from_millis(2)).await,
                Err("wayland-stop-timeout".into())
            );
        }
        {
            let wait = wait_retirement(&mut retirement, FRAME_BUDGET);
            tokio::pin!(wait);
            tokio::select! {
                _ = &mut wait => panic!("owned worker is pending"),
                _ = tokio::time::sleep(Duration::from_millis(2)) => {},
            }
        }
        assert!(matches!(retirement, Some(Retirement::Pending(_))));
        send.send(()).unwrap();
        assert_eq!(wait_retirement(&mut retirement, FRAME_BUDGET).await, Ok(()));
        assert!(retirement.is_none());
        let mut retirement = Some(Retirement::Pending(tokio::spawn(async {
            Err("cleanup".into())
        })));
        assert_eq!(
            wait_retirement(&mut retirement, FRAME_BUDGET).await,
            Err("wayland-stop-failed".into())
        );
        assert_eq!(
            wait_retirement(&mut retirement, Duration::ZERO).await,
            Err("wayland-stop-failed".into())
        );
        let mut retirement = Some(Retirement::Pending(tokio::spawn(async {
            panic!("owned worker panic")
        })));
        assert_eq!(
            wait_retirement(&mut retirement, FRAME_BUDGET).await,
            Err("wayland-stop-failed".into())
        );
        assert!(matches!(retirement, Some(Retirement::Failed)));
    }
    #[tokio::test]
    async fn cleanup_reaps_its_owned_child_and_no_portal_authority_is_needed() {
        // Disposable non-capture child; no user portal/session or FD is opened.
        let child = Command::new("/bin/sleep")
            .arg("30")
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut owned = Owned {
            child: Some(child),
            ..Default::default()
        };
        assert_eq!(owned.cleanup().await, Ok(()));
        assert!(owned.child.as_mut().unwrap().try_wait().unwrap().is_some());
    }
    #[tokio::test]
    async fn child_receives_only_private_descriptor_contract_and_is_reaped() {
        use std::{
            io::Write,
            os::unix::{fs::PermissionsExt, net::UnixStream},
        };
        // Disposable fake helper validates actual launch/FD ownership only.
        // It cannot create a portal, capture pixels or grant a Lens lease.
        let directory = std::env::temp_dir().join(format!(
            "rime52-fd-fixture-{}-{}",
            std::process::id(),
            super::super::bridge::now_ms()
        ));
        std::fs::create_dir(&directory).unwrap();
        let binary = directory.join("rimeward-media");
        std::fs::write(
            &binary,
            b"#!/bin/sh\n[ \"$1\" = --lens-pipewire ] || exit 2\n[ \"$RIMEWARD_LENS_PIPEWIRE_FD\" = 3 ] || exit 3\n[ -z \"${RIMEWARD_PIPEWIRE_FD-}\" ] || exit 4\nIFS= read -r line <&3 || exit 5\nprintf '%s' \"$line\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let (read, mut write) = UnixStream::pair().unwrap();
        let fd: OwnedFd = read.into();
        let mut child = launch(&directory, &fd).unwrap();
        write.write_all(b"owned-fd\n").unwrap();
        let mut output = [0; 8];
        tokio::time::timeout(
            FRAME_BUDGET,
            child.stdout.as_mut().unwrap().read_exact(&mut output),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(&output, b"owned-fd");
        let mut owned = Owned {
            child: Some(child),
            ..Default::default()
        };
        assert_eq!(owned.cleanup().await, Ok(()));
        assert!(owned.child.as_mut().unwrap().try_wait().unwrap().is_some());
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[tokio::test]
    async fn actual_private_reader_rechecks_loss_after_pixels_and_refuses_stale_or_large_frames() {
        use std::{
            io::Write,
            os::unix::{fs::PermissionsExt, net::UnixStream},
        };
        for mode in ["lost", "stale", "bounds", "ok"] {
            let directory = std::env::temp_dir().join(format!(
                "rime52-protocol-fixture-{}-{mode}",
                std::process::id()
            ));
            std::fs::create_dir(&directory).unwrap();
            let binary = directory.join("rimeward-media");
            // This isolated child supplies private binary protocol fixtures,
            // not PipeWire/portal authority or a production-session bypass.
            std::fs::write(&binary, br#"#!/usr/bin/python3
import json, os, struct, sys
assert sys.argv[1] == '--lens-pipewire'
assert os.environ['RIMEWARD_LENS_PIPEWIRE_FD'] == '3'
mode = os.read(3, 64).decode().strip()
bind = json.loads(sys.stdin.buffer.readline())
assert bind['command'] == 'bind'
owner = bind['owner']
for line in sys.stdin.buffer:
    command = json.loads(line)
    assert command['owner'] == owner
    status, width, height = 1, 2, 1
    if command['command'] == 'verify':
        status, width, height = (2 if mode == 'lost' else 0), 0, 0
    elif mode == 'bounds':
        width, height = 8192, 8192
    actual_owner = owner + (1 if mode == 'stale' else 0)
    sys.stdout.buffer.write(struct.pack('>4sB3xQQQII', b'RLN1', status, actual_owner, command['request'], 1, width, height))
    if status == 1 and mode != 'bounds':
        sys.stdout.buffer.write(bytes(range(8)))
    sys.stdout.buffer.flush()
"#).unwrap();
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
            let (read, mut write) = UnixStream::pair().unwrap();
            let fd: OwnedFd = read.into();
            let mut child = launch(&directory, &fd).unwrap();
            write.write_all(format!("{mode}\n").as_bytes()).unwrap();
            let mut frames = Frames {
                input: child.stdin.take().unwrap(),
                output: child.stdout.take().unwrap(),
                owner: 41,
                request: 0,
                sequence: 0,
                size: None,
            };
            let identity = StreamIdentity {
                node: 1,
                serial: Some(2),
                monitor: false,
            };
            let result = tokio::time::timeout(FRAME_BUDGET, async {
                frames.bind(&identity).await?;
                frames.next().await
            })
            .await
            .unwrap();
            match mode {
                "lost" => assert_eq!(result.err().unwrap(), "wayland-source-closed"),
                "stale" => assert_eq!(result.err().unwrap(), "wayland-protocol"),
                "bounds" => assert_eq!(result.err().unwrap(), "wayland-frame-bounds"),
                _ => {
                    let frame = result.unwrap().unwrap();
                    assert_eq!(frame.size, [2, 1]);
                    assert_eq!(&*frame.pixels, &[0, 1, 2, 3, 4, 5, 6, 7]);
                    assert_eq!(
                        frames.request, 2,
                        "production reader performed its post-transfer proof"
                    );
                }
            }
            drop(frames);
            let mut owned = Owned {
                child: Some(child),
                ..Default::default()
            };
            assert_eq!(owned.cleanup().await, Ok(()));
            assert!(owned.child.as_mut().unwrap().try_wait().unwrap().is_some());
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
}
