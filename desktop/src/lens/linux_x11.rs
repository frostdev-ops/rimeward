//! X11 Lens observes the compositor's existing redirected client pixmap.
//! No root crops, redirects, input authority, or client-supplied PID authority.

use super::{
    bridge::{DisplayInfo, FrameGeometry},
    linux_overlay::Overlay,
    request::Cancellation,
    CaptureLease, Lens, Target,
};
use std::{
    fs::File,
    io::{self, IoSlice, Read},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::net::UnixStream,
    },
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tauri::AppHandle;
use x11rb::{
    connection::Connection,
    protocol::{
        composite, damage, randr, res,
        xproto::{ConnectionExt as _, *},
        Event,
    },
    reexports::x11rb_protocol::{
        parse_display::{parse_display, ConnectAddress},
        xauth::get_auth,
    },
    rust_connection::{DefaultStream, PollMode, RustConnection, Stream},
    utils::RawFdContainer,
};

const IO_BUDGET: Duration = Duration::from_millis(500);
const PIXEL_CAP: usize = 32 * 1024 * 1024;
const SCORE: &str = "linux:x11:rgb16-tile32-v1";
const AX_REASON: &str = "accessibility-window-unproved-ocr-only";

/// Created at attachment; a worker is created only by a consented start.
pub struct Backend {
    lens: Weak<Lens>,
    pub overlay: Arc<Overlay>,
    run: Mutex<Option<Run>>,
    lifecycle: tokio::sync::Mutex<()>,
    retirement: tokio::sync::Mutex<Option<Retirement>>,
    ordinal: AtomicU64,
}
struct Run {
    control: Arc<Control>,
    worker: JoinHandle<()>,
}
enum Retirement {
    Pending(tokio::task::JoinHandle<bool>),
    Failed,
}
/// The join remains stored even if this wait times out or its caller is dropped.
/// Only proved successful cleanup clears the gate for Stop or replacement Start.
async fn wait_retirement(
    retirement: &mut Option<Retirement>,
    budget: Duration,
) -> Result<(), String> {
    let result = match retirement {
        Some(Retirement::Pending(join)) => tokio::time::timeout(budget, join).await,
        Some(Retirement::Failed) => return Err("x11-stop-failed".into()),
        None => return Ok(()),
    };
    match result {
        Ok(Ok(true)) => {
            *retirement = None;
            Ok(())
        }
        Err(_) => Err("x11-stop-timeout".into()),
        Ok(_) => {
            *retirement = Some(Retirement::Failed);
            Err("x11-stop-failed".into())
        }
    }
}
pub(super) struct Control {
    pub generation: AtomicU64,
    pub cancel: Arc<Cancellation>,
    lens: Weak<Lens>,
    guarded: bool,
    source_cancel: Option<Arc<Cancellation>>,
}
impl Control {
    fn new(lens: Weak<Lens>, generation: u64) -> Arc<Self> {
        Arc::new(Self {
            generation: AtomicU64::new(generation),
            cancel: Cancellation::new(),
            lens,
            guarded: false,
            source_cancel: None,
        })
    }
    pub(super) fn check(&self) -> Result<(), String> {
        if self.cancel.is_cancelled()
            || self
                .source_cancel
                .as_ref()
                .is_some_and(|cancel| cancel.is_cancelled())
            || !crate::remote_session::active()
            || (!self.guarded
                && !self.lens.upgrade().is_some_and(|lens| {
                    lens.request_generation() == self.generation.load(Ordering::Acquire)
                }))
        {
            return Err("cancelled".into());
        }
        Ok(())
    }
    fn guarded(self: &Arc<Self>, source_cancel: Arc<Cancellation>) -> Arc<Self> {
        Arc::new(Self {
            generation: AtomicU64::new(self.generation.load(Ordering::Acquire)),
            cancel: self.cancel.clone(),
            lens: Weak::new(),
            guarded: true,
            source_cancel: Some(source_cancel),
        })
    }
}
/// x11rb's default poll is unbounded. This single-owner stream bounds handshake,
/// replies and writes, and notices Stop/session withdrawal every 25 ms.
pub(super) struct BoundedStream {
    stream: DefaultStream,
    control: Arc<Control>,
    deadline: Mutex<Instant>,
}
impl BoundedStream {
    fn check(&self) -> io::Result<()> {
        self.control.check().map_err(io::Error::other)?;
        if Instant::now() >= *self.deadline.lock().unwrap() {
            return Err(io::Error::other("x11-timeout"));
        }
        Ok(())
    }
}
impl Stream for BoundedStream {
    fn poll(&self, mode: PollMode) -> io::Result<()> {
        loop {
            self.check()?;
            let mut fd = libc::pollfd {
                fd: self.stream.as_raw_fd(),
                events: (if mode.readable() { libc::POLLIN } else { 0 })
                    | (if mode.writable() { libc::POLLOUT } else { 0 }),
                revents: 0,
            };
            // The descriptor is owned by stream for this entire synchronous call.
            let result = unsafe { libc::poll(&mut fd, 1, 25) };
            if result > 0 {
                return Ok(());
            }
            if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                return Err(io::Error::last_os_error());
            }
        }
    }
    fn read(&self, buf: &mut [u8], fds: &mut Vec<RawFdContainer>) -> io::Result<usize> {
        self.check()?;
        self.stream.read(buf, fds)
    }
    fn write(&self, buf: &[u8], fds: &mut Vec<RawFdContainer>) -> io::Result<usize> {
        self.check()?;
        self.stream.write(buf, fds)
    }
    fn write_vectored(
        &self,
        bufs: &[IoSlice<'_>],
        fds: &mut Vec<RawFdContainer>,
    ) -> io::Result<usize> {
        self.check()?;
        self.stream.write_vectored(bufs, fds)
    }
}
pub(super) struct Native {
    pub conn: RustConnection<BoundedStream>,
    pub root: u32,
    screen: usize,
    control: Arc<Control>,
    active: u32,
    title: u32,
    utf8: u32,
    probe: u32,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Geometry {
    pub x: i16,
    pub y: i16,
    pub w: u16,
    pub h: u16,
    depth: u8,
    visual: u32,
}
pub(super) struct Process {
    pid: u32,
    started: u64,
    fd: OwnedFd,
}
pub(super) struct Source {
    pub window: u32,
    pixmap: u32,
    damage: u32,
    process: Process,
    pub geometry: Geometry,
    pub lease: CaptureLease,
    pub control: Arc<Control>,
    pub cancel: Arc<Cancellation>,
    witness: Mutex<(Native, Option<EventAction>)>,
}
impl Source {
    pub(super) fn overlay_control(&self) -> Arc<Control> {
        self.control.guarded(self.cancel.clone())
    }
    /// This private connection subscribed before lease acceptance. Both capture
    /// and overlay proof drain it, so same-process XID reuse cannot escape a
    /// delayed capture worker. Its control never reenters Lens State.
    fn change(&self) -> Result<Option<EventAction>, String> {
        let mut witness = self.witness.lock().unwrap();
        let (native, action) = &mut *witness;
        native.budget();
        native.control.check()?;
        // A reply orders the server's earlier lifetime events before the drain.
        native
            .conn
            .get_input_focus()
            .map_err(native_error)?
            .reply()
            .map_err(native_error)?;
        let mut count = 0;
        while let Some(event) = native.conn.poll_for_event().map_err(native_error)? {
            count += 1;
            if count > 4096 {
                return Err("x11-event-overflow".into());
            }
            match source_event(&event, self.window, native.root, native.active) {
                EventAction::Invalidate => {
                    self.cancel.cancel();
                    return Err("x11-target-invalidated".into());
                }
                EventAction::Foreground => *action = Some(EventAction::Foreground),
                EventAction::Geometry if action.is_none() => *action = Some(EventAction::Geometry),
                _ => {}
            }
        }
        Ok(*action)
    }
}
impl Backend {
    pub fn attach(app: &AppHandle, lens: &Arc<Lens>) -> Arc<Self> {
        Arc::new(Self {
            lens: Arc::downgrade(lens),
            overlay: Overlay::attach(app, lens),
            run: Mutex::new(None),
            lifecycle: tokio::sync::Mutex::new(()),
            retirement: tokio::sync::Mutex::new(None),
            ordinal: AtomicU64::new(1),
        })
    }
    /// The integration caller must already have applied consent/demand and pass
    /// that exact lifecycle generation. No status/poll call starts observation.
    pub async fn start(
        self: &Arc<Self>,
        expected_generation: u64,
        request: Arc<Cancellation>,
    ) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().await;
        let lens = self.lens.upgrade().ok_or("cancelled")?;
        if request.is_cancelled()
            || lens.request_generation() != expected_generation
            || !crate::remote_session::active()
        {
            return Err("cancelled".into());
        }
        self.stop_inner().await?;
        if lens.request_generation() != expected_generation {
            return Err("cancelled".into());
        }
        if std::env::var("XDG_SESSION_TYPE").is_ok_and(|kind| kind != "x11")
            || std::env::var_os("WAYLAND_DISPLAY").is_some()
        {
            return Err("x11-unavailable".into());
        }
        let control = Control::new(self.lens.clone(), expected_generation);
        let (ready, result) = tokio::sync::oneshot::channel();
        let backend = Arc::downgrade(self);
        let worker_control = control.clone();
        let worker = std::thread::Builder::new()
            .name("lens-x11".into())
            .spawn(move || {
                let invalidate = |reason: &str| {
                    let generation = worker_control.generation.load(Ordering::Acquire);
                    if let Some(next) = lens.invalidate_source(generation, reason) {
                        worker_control.generation.store(next, Ordering::Release);
                    }
                    if let Some(backend) = backend.upgrade() {
                        backend.overlay.invalidate_generation(generation);
                    }
                };
                match Native::connect(worker_control.clone()) {
                    Ok(native) => {
                        // Borrowed Native remains alive across an observer panic,
                        // so revocation still precedes resource teardown. Resume
                        // the panic afterward so retirement cannot claim cleanup.
                        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            native.observe(&lens, &backend, ready)
                        })) {
                            Ok(Err(reason)) => invalidate(&reason),
                            Ok(Ok(())) => {}
                            Err(panic) => {
                                invalidate("x11-worker-failed");
                                std::panic::resume_unwind(panic);
                            }
                        }
                    }
                    Err(reason) => invalidate(&reason),
                }
                // Dropping this connection releases only our named pixmap and Damage
                // resources. The compositor's redirect and other clients are untouched.
            })
            .map_err(|_| "x11-unavailable")?;
        *self.run.lock().unwrap() = Some(Run { control, worker });
        let startup = tokio::select! { biased;
            _ = request.cancelled() => None,
            result = tokio::time::timeout(Duration::from_secs(2), result) => Some(result),
        };
        match startup {
            Some(Ok(Ok(result))) => result,
            _ => {
                self.stop_inner().await?;
                Err("x11-unavailable".into())
            }
        }
    }
    /// Invalidate before hiding/joining. Returning an error prevents a successful
    /// Stop acknowledgement when native cleanup has not actually completed.
    pub async fn stop(&self) -> Result<(), String> {
        let control = self
            .run
            .lock()
            .unwrap()
            .as_ref()
            .map(|run| run.control.clone());
        if let Some(control) = control {
            if let Some(lens) = self.lens.upgrade() {
                let _ =
                    lens.invalidate_source(control.generation.load(Ordering::Acquire), "stopped");
            }
            self.overlay
                .invalidate_generation(control.generation.load(Ordering::Acquire));
            control.cancel.cancel();
        }
        let _lifecycle = self.lifecycle.lock().await;
        self.stop_inner().await
    }
    /// Called under the shared lifecycle's serialized control guard, before it
    /// mutates Lens State. This method never acquires the Lens State mutex.
    pub fn cancel(&self) {
        if let Some(run) = self.run.lock().unwrap().as_ref() {
            run.control.cancel.cancel();
        }
        self.overlay.invalidate();
    }
    async fn stop_inner(&self) -> Result<(), String> {
        // Acquire the stored gate before moving Run. Future cancellation can
        // release this guard, but cannot discard the backend's pending join.
        let mut retirement = self.retirement.lock().await;
        wait_retirement(&mut retirement, Duration::from_secs(2)).await?;
        let run = self.run.lock().unwrap().take();
        if let Some(run) = &run {
            if let Some(lens) = self.lens.upgrade() {
                let _ = lens
                    .invalidate_source(run.control.generation.load(Ordering::Acquire), "stopped");
            }
            run.control.cancel.cancel();
        }
        self.overlay.invalidate();
        if let Some(run) = run {
            *retirement = Some(Retirement::Pending(tokio::task::spawn_blocking(
                move || run.worker.join().is_ok(),
            )));
            wait_retirement(&mut retirement, Duration::from_secs(2)).await?;
        }
        Ok(())
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        if let Some(run) = self.run.get_mut().unwrap().take() {
            if let Some(lens) = self.lens.upgrade() {
                let _ = lens
                    .invalidate_source(run.control.generation.load(Ordering::Acquire), "stopped");
            }
            run.control.cancel.cancel();
        }
        self.overlay.invalidate();
    }
}
impl Native {
    pub(super) fn connect(control: Arc<Control>) -> Result<Self, String> {
        control.check()?;
        let display = parse_display(None).map_err(|_| "x11-unavailable")?;
        // /proc PID authority is meaningful only for this local server. TCP and
        // SSH forwarding cannot prove the server's process lifetime locally.
        let mut connected = None;
        for address in display.connect_instruction() {
            let ConnectAddress::Socket(path) = address else {
                continue;
            };
            if let Ok(stream) = local_socket(&path, &control) {
                let (stream, (family, peer)) =
                    DefaultStream::from_unix_stream(stream).map_err(native_error)?;
                let (name, data) = get_auth(family, &peer, display.display)
                    .map_err(|_| "x11-unavailable")?
                    .unwrap_or_default();
                let stream = BoundedStream {
                    stream,
                    control: control.clone(),
                    deadline: Mutex::new(Instant::now() + IO_BUDGET),
                };
                connected = Some(
                    RustConnection::connect_to_stream_with_auth_info(
                        stream,
                        usize::from(display.screen),
                        name,
                        data,
                    )
                    .map_err(|_| "x11-unavailable")?,
                );
                break;
            }
        }
        let conn = connected.ok_or("x11-unavailable")?;
        let screen = usize::from(display.screen);
        let root = conn
            .setup()
            .roots
            .get(screen)
            .ok_or("x11-unavailable")?
            .root;
        if conn
            .query_extension(b"XWAYLAND")
            .map_err(native_error)?
            .reply()
            .map_err(native_error)?
            .present
        {
            return Err("x11-unavailable".into());
        }
        let version = composite::query_version(&conn, 0, 4)
            .map_err(native_error)?
            .reply()
            .map_err(native_error)?;
        if version.major_version == 0 && version.minor_version < 2 {
            return Err("x11-composite-unavailable".into());
        }
        let version = res::query_version(&conn, 1, 2)
            .map_err(native_error)?
            .reply()
            .map_err(native_error)?;
        if version.server_major < 1 || (version.server_major == 1 && version.server_minor < 2) {
            return Err("x11-process-unproved".into());
        }
        damage::query_version(&conn, 1, 1)
            .map_err(native_error)?
            .reply()
            .map_err(native_error)?;
        randr::query_version(&conn, 1, 3)
            .map_err(native_error)?
            .reply()
            .map_err(native_error)?;
        let atom = |name: &[u8]| {
            conn.intern_atom(false, name)
                .map_err(native_error)?
                .reply()
                .map(|r| r.atom)
                .map_err(native_error)
        };
        let active = atom(b"_NET_ACTIVE_WINDOW")?;
        let title = atom(b"_NET_WM_NAME")?;
        let utf8 = atom(b"UTF8_STRING")?;
        let probe = conn.generate_id().map_err(native_error)?;
        Ok(Self {
            conn,
            root,
            screen,
            control,
            active,
            title,
            utf8,
            probe,
        })
    }
    pub(super) fn budget(&self) {
        *self.conn.stream().deadline.lock().unwrap() = Instant::now() + IO_BUDGET;
    }
    fn active_window(&self) -> Result<u32, String> {
        let value = self
            .conn
            .get_property(false, self.root, self.active, AtomEnum::WINDOW, 0, 1)
            .map_err(native_error)?
            .reply()
            .map_err(native_error)?;
        if value.format != 32
            || value.type_ != u32::from(AtomEnum::WINDOW)
            || value.bytes_after != 0
            || value.value.len() != 4
        {
            return Err("x11-window-unavailable".into());
        }
        let window = value
            .value32()
            .and_then(|mut v| v.next())
            .filter(|id| *id != 0)
            .ok_or("x11-window-unavailable")?;
        // EWMH selects the client, but a writable root property alone does not
        // prove foreground. Server focus must be that client or its descendant.
        let mut focus = self
            .conn
            .get_input_focus()
            .map_err(native_error)?
            .reply()
            .map_err(native_error)?
            .focus;
        for _ in 0..64 {
            if focus == window {
                return Ok(window);
            }
            if focus <= 1 || focus == self.root {
                break;
            }
            let tree = self
                .conn
                .query_tree(focus)
                .map_err(native_error)?
                .reply()
                .map_err(native_error)?;
            if tree.root != self.root {
                break;
            }
            focus = tree.parent;
        }
        Err("x11-foreground-unproved".into())
    }
    pub(super) fn geometry(&self, window: u32) -> Result<Geometry, String> {
        let attributes = self
            .conn
            .get_window_attributes(window)
            .map_err(native_error)?
            .reply()
            .map_err(native_error)?;
        let geometry = self
            .conn
            .get_geometry(window)
            .map_err(native_error)?
            .reply()
            .map_err(native_error)?;
        let position = self
            .conn
            .translate_coordinates(window, self.root, 0, 0)
            .map_err(native_error)?
            .reply()
            .map_err(native_error)?;
        if attributes.map_state != MapState::VIEWABLE
            || attributes.class != WindowClass::INPUT_OUTPUT
            || geometry.root != self.root
            || geometry.border_width != 0
            || !position.same_screen
            || geometry.width == 0
            || geometry.height == 0
            || usize::from(geometry.width) * usize::from(geometry.height) * 4 > PIXEL_CAP
        {
            return Err("x11-geometry-unproved".into());
        }
        Ok(Geometry {
            x: position.dst_x,
            y: position.dst_y,
            w: geometry.width,
            h: geometry.height,
            depth: geometry.depth,
            visual: attributes.visual,
        })
    }
    fn pid(&self, window: u32) -> Result<u32, String> {
        let ids = res::query_client_ids(
            &self.conn,
            &[res::ClientIdSpec {
                client: window,
                mask: res::ClientIdMask::LOCAL_CLIENT_PID,
            }],
        )
        .map_err(native_error)?
        .reply()
        .map_err(native_error)?
        .ids;
        if ids.len() != 1
            || ids[0].spec.mask != res::ClientIdMask::LOCAL_CLIENT_PID
            || ids[0].value.len() != 1
        {
            return Err("x11-process-unproved".into());
        }
        ids[0]
            .value
            .first()
            .copied()
            .filter(|pid| *pid > 0 && *pid <= i32::MAX as u32)
            .ok_or_else(|| "x11-process-unproved".into())
    }
    fn display_unchanged(&self) -> Result<(), String> {
        let bounds = self
            .conn
            .get_geometry(self.root)
            .map_err(native_error)?
            .reply()
            .map_err(native_error)?;
        let screen = &self.conn.setup().roots[self.screen];
        if bounds.width != screen.width_in_pixels || bounds.height != screen.height_in_pixels {
            return Err("x11-display-invalidated".into());
        }
        Ok(())
    }
    pub(super) fn verify(&self, source: &Source) -> Result<(), String> {
        self.control.check()?;
        self.display_unchanged()?;
        if source.change()?.is_some() {
            return Err("x11-source-changed".into());
        }
        if self.root
            != self
                .conn
                .get_geometry(source.pixmap)
                .map_err(native_error)?
                .reply()
                .map_err(native_error)?
                .root
            || self.pid(source.window)? != source.process.pid
            || !source.process.alive()?
            || self.geometry(source.window)? != source.geometry
            || self.active_window()? != source.window
        {
            return Err("x11-target-invalidated".into());
        }
        self.current_pixmap(source.window, source.geometry)?;
        self.conn
            .free_pixmap(self.probe)
            .map_err(native_error)?
            .check()
            .map_err(native_error)?;
        if source.change()?.is_some() {
            return Err("x11-source-changed".into());
        }
        Ok(())
    }
    fn current_pixmap(&self, window: u32, geometry: Geometry) -> Result<u32, String> {
        // Reuse our acknowledged-freed alias ID. Fresh naming detects a
        // compositor unredirect/re-redirect without replaying an old surface.
        composite::name_window_pixmap(&self.conn, window, self.probe)
            .map_err(native_error)?
            .check()
            .map_err(|_| "x11-compositor-pixmap-unavailable")?;
        let current = self
            .conn
            .get_geometry(self.probe)
            .map_err(native_error)?
            .reply()
            .map_err(native_error)?;
        if current.root != self.root
            || current.width != geometry.w
            || current.height != geometry.h
            || current.depth != geometry.depth
        {
            return Err("x11-pixmap-geometry-unproved".into());
        }
        Ok(self.probe)
    }
    fn accept(&self, lens: &Lens, ordinal: u32, pinned: Option<&Source>) -> Result<Source, String> {
        self.display_unchanged()?;
        let window = self.active_window()?;
        self.conn
            .change_window_attributes(
                window,
                &ChangeWindowAttributesAux::new()
                    .event_mask(EventMask::STRUCTURE_NOTIFY | EventMask::PROPERTY_CHANGE),
            )
            .map_err(native_error)?
            .check()
            .map_err(native_error)?;
        let geometry = self.geometry(window)?;
        let process = Process::open(self.pid(window)?)?;
        if let Some(pinned) = pinned {
            if window != pinned.window
                || process.pid != pinned.process.pid
                || process.started != pinned.process.started
                || !pinned.process.alive()?
            {
                return Err("x11-target-invalidated".into());
            }
        }
        let cancel = Cancellation::new();
        let witness = Native::connect(self.control.guarded(cancel.clone()))?;
        witness.budget();
        witness
            .conn
            .change_window_attributes(
                window,
                &ChangeWindowAttributesAux::new().event_mask(EventMask::STRUCTURE_NOTIFY),
            )
            .map_err(native_error)?
            .check()
            .map_err(native_error)?;
        witness.watch_root()?;
        let pixmap = self.conn.generate_id().map_err(native_error)?;
        // BadMatch is a refusal: only a window already redirected by the user's
        // compositor may be named. This module never redirects any window.
        composite::name_window_pixmap(&self.conn, window, pixmap)
            .map_err(native_error)?
            .check()
            .map_err(|_| "x11-compositor-pixmap-unavailable")?;
        let surface = self
            .conn
            .get_geometry(pixmap)
            .map_err(native_error)?
            .reply()
            .map_err(native_error)?;
        if surface.width != geometry.w
            || surface.height != geometry.h
            || surface.depth != geometry.depth
            || surface.root != self.root
        {
            return Err("x11-pixmap-geometry-unproved".into());
        }
        // Prove actual pixels and packing before granting capture capability.
        // Fresh naming, rather than this retained alias, is also required for
        // every subsequent sample and every native overlay proof.
        let current = self.current_pixmap(window, geometry)?;
        let image = self
            .conn
            .get_image(
                ImageFormat::Z_PIXMAP,
                current,
                0,
                0,
                geometry.w,
                geometry.h,
                u32::MAX,
            )
            .map_err(native_error)?
            .reply()
            .map_err(native_error);
        self.conn
            .free_pixmap(current)
            .map_err(native_error)?
            .check()
            .map_err(native_error)?;
        let image = image?;
        if image.depth != geometry.depth {
            return Err("x11-pixel-format-unproved".into());
        }
        pack(
            &self.conn.setup().pixmap_formats,
            &self.conn.setup().roots[self.screen].allowed_depths,
            self.conn.setup().image_byte_order,
            geometry,
            &image.data,
            &self.control.cancel,
        )?;
        let damaged = self.conn.generate_id().map_err(native_error)?;
        damage::create(&self.conn, damaged, window, damage::ReportLevel::NON_EMPTY)
            .map_err(native_error)?
            .check()
            .map_err(native_error)?;
        let title = self
            .conn
            .get_property(false, window, self.title, self.utf8, 0, 128)
            .map_err(native_error)?
            .reply()
            .map_err(native_error)?;
        let title = if title.format == 8 && title.type_ == self.utf8 && title.bytes_after == 0 {
            String::from_utf8_lossy(&title.value).into_owned()
        } else {
            String::new()
        };
        let name = read_small(&format!("/proc/{}/comm", process.pid), 256)
            .map(|v| v.trim().to_owned())
            .unwrap_or_default();
        let bounds = [
            f64::from(geometry.x),
            f64::from(geometry.y),
            f64::from(geometry.w),
            f64::from(geometry.h),
        ];
        let size = [u32::from(geometry.w), u32::from(geometry.h)];
        let frame = FrameGeometry {
            window: bounds,
            scale: 1.0,
            content_rect: [0.0, 0.0, bounds[2], bounds[3]],
            content_scale: 1.0,
            captured: [0.0, 0.0, bounds[2], bounds[3]],
        };
        let screen = &self.conn.setup().roots[self.screen];
        let target = Target {
            pid: process.pid as i32,
            bundle: name.clone(),
            name,
            window_id: ordinal,
            title,
            bounds,
            url: None,
            display: DisplayInfo {
                id: self.screen as u32 + 1,
                w: f64::from(screen.width_in_pixels),
                h: f64::from(screen.height_in_pixels),
                scale: 1.0,
            },
        };
        // Round-trip identity/geometry again before adopting; then discard any
        // queued native lifetime event before publishing the first sample.
        if self.pid(window)? != process.pid
            || !process.alive()?
            || self.geometry(window)? != geometry
            || self.active_window()? != window
        {
            return Err("x11-target-invalidated".into());
        }
        let granted = tauri::async_runtime::block_on(async {
            tokio::select! { biased;
                _ = self.control.cancel.cancelled() => Err("cancelled".into()),
                grant = lens.backend_status(self.control.generation.load(Ordering::Acquire), true, false, SCORE, Some(AX_REASON)) => grant,
            }
        })?;
        self.control.generation.store(granted, Ordering::Release);
        self.budget();
        self.control.check()?;
        let mut events = 0;
        while let Some(event) = self.conn.poll_for_event().map_err(native_error)? {
            events += 1;
            if events > 4096
                || matches!(
                    source_event(&event, window, self.root, self.active),
                    EventAction::Invalidate | EventAction::Geometry | EventAction::Foreground
                )
            {
                return Err("x11-target-invalidated".into());
            }
        }
        if self.pid(window)? != process.pid
            || !process.alive()?
            || self.geometry(window)? != geometry
            || self.active_window()? != window
        {
            return Err("x11-target-invalidated".into());
        }
        self.display_unchanged()?;
        let lease = lens
            .accept_target(
                self.control.generation.load(Ordering::Acquire),
                target,
                frame,
                size,
                [
                    0.0,
                    0.0,
                    f64::from(screen.width_in_pixels),
                    f64::from(screen.height_in_pixels),
                ],
            )
            .ok_or("cancelled")?;
        self.control
            .generation
            .store(lease.generation, Ordering::Release);
        Ok(Source {
            window,
            pixmap,
            damage: damaged,
            process,
            geometry,
            lease,
            control: self.control.clone(),
            cancel,
            witness: Mutex::new((witness, None)),
        })
    }
    fn watch_root(&self) -> Result<(), String> {
        self.conn
            .change_window_attributes(
                self.root,
                &ChangeWindowAttributesAux::new()
                    .event_mask(EventMask::PROPERTY_CHANGE | EventMask::STRUCTURE_NOTIFY),
            )
            .map_err(native_error)?
            .check()
            .map_err(native_error)?;
        randr::select_input(
            &self.conn,
            self.root,
            randr::NotifyMask::SCREEN_CHANGE
                | randr::NotifyMask::CRTC_CHANGE
                | randr::NotifyMask::OUTPUT_CHANGE
                | randr::NotifyMask::OUTPUT_PROPERTY,
        )
        .map_err(native_error)?
        .check()
        .map_err(native_error)
    }
    fn observe(
        &self,
        lens: &Lens,
        backend: &Weak<Backend>,
        ready: tokio::sync::oneshot::Sender<Result<(), String>>,
    ) -> Result<(), String> {
        self.budget();
        self.watch_root()?;
        let mut ready = Some(ready);
        let mut pinned: Option<Arc<Source>> = None;
        loop {
            self.budget();
            self.control.check()?;
            let owner = backend.upgrade().ok_or("cancelled")?;
            let ordinal = owner
                .ordinal
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                    (value < u64::from(u32::MAX)).then_some(value + 1)
                })
                .map_err(|_| "x11-source-limit")? as u32;
            let source = Arc::new(self.accept(lens, ordinal, pinned.as_deref())?);
            let overlay = owner.overlay.source(source.clone(), self);
            lens.set_overlay_available(source.lease.generation, overlay);
            drop(owner);
            if let Some(ready) = ready.take() {
                let _ = ready.send(Ok(()));
            }
            let outcome = self.samples(lens, &source);
            let action = match outcome {
                Err(reason) if reason == "x11-source-changed" => {
                    source.change()?.ok_or("x11-target-invalidated")?
                }
                result => result?,
            };
            // A normal foreground/geometry event revokes before proof and grant.
            // Never discover a later unrelated generation to rearm an old worker.
            let generation = lens
                .invalidate_source(source.lease.generation, "warming")
                .ok_or("cancelled")?;
            source.cancel.cancel();
            if let Some(owner) = backend.upgrade() {
                owner.overlay.invalidate_generation(source.lease.generation);
            }
            self.control.generation.store(generation, Ordering::Release);
            self.budget();
            self.control.check()?;
            damage::destroy(&self.conn, source.damage)
                .map_err(native_error)?
                .check()
                .map_err(native_error)?;
            self.conn
                .free_pixmap(source.pixmap)
                .map_err(native_error)?
                .check()
                .map_err(native_error)?;
            pinned = if action == EventAction::Geometry {
                Some(source)
            } else {
                None
            };
        }
    }
    fn events(&self, source: &Source, dirty: &mut bool) -> Result<Option<EventAction>, String> {
        let mut rearm = None;
        let mut count = 0;
        while let Some(event) = self.conn.poll_for_event().map_err(native_error)? {
            count += 1;
            if count > 4096 {
                return Err("x11-event-overflow".into());
            }
            match source_event(&event, source.window, self.root, self.active) {
                EventAction::Invalidate => return Err("x11-target-invalidated".into()),
                EventAction::Foreground => rearm = Some(EventAction::Foreground),
                EventAction::Geometry if rearm.is_none() => rearm = Some(EventAction::Geometry),
                EventAction::Dirty => *dirty = true,
                _ => {}
            }
        }
        Ok(rearm)
    }
    fn samples(&self, lens: &Lens, source: &Source) -> Result<EventAction, String> {
        let mut dirty = true;
        let mut next = Instant::now();
        loop {
            self.budget();
            self.control.check()?;
            if let Some(action) = self.events(source, &mut dirty)? {
                return Ok(action);
            }
            if let Some(action) = source.change()? {
                return Ok(action);
            }
            if !source.process.alive()? {
                return Err("x11-process-exited".into());
            }
            if dirty && Instant::now() >= next {
                dirty = false;
                // Clear Damage before reading, so updates during capture remain
                // pending for the next immutable sample rather than being lost.
                damage::subtract(&self.conn, source.damage, x11rb::NONE, x11rb::NONE)
                    .map_err(native_error)?
                    .check()
                    .map_err(native_error)?;
                self.verify(source)?;
                let surface = self.current_pixmap(source.window, source.geometry)?;
                let image = self
                    .conn
                    .get_image(
                        ImageFormat::Z_PIXMAP,
                        surface,
                        0,
                        0,
                        source.geometry.w,
                        source.geometry.h,
                        u32::MAX,
                    )
                    .map_err(native_error)?
                    .reply()
                    .map_err(native_error);
                self.conn
                    .free_pixmap(surface)
                    .map_err(native_error)?
                    .check()
                    .map_err(native_error)?;
                let reply = image?;
                if reply.depth != source.geometry.depth {
                    return Err("x11-pixel-format-unproved".into());
                }
                let pixels = pack(
                    &self.conn.setup().pixmap_formats,
                    &self.conn.setup().roots[self.screen].allowed_depths,
                    self.conn.setup().image_byte_order,
                    source.geometry,
                    &reply.data,
                    &self.control.cancel,
                )?;
                // Drain lifetime changes before verification. Old named pixmaps
                // can remain readable after Unmap/Destroy/resize.
                if let Some(action) = self.events(source, &mut dirty)? {
                    return Ok(action);
                }
                self.verify(source)?;
                if let Some(action) = self.events(source, &mut dirty)? {
                    return Ok(action);
                }
                self.control.check()?;
                lens.publish_frame(
                    &source.lease,
                    pixels.into(),
                    source.lease.size,
                    source.lease.geometry,
                );
                next = Instant::now() + Duration::from_millis(100);
            }
            // Only an event-coalescing/session tick; never periodic screenshots.
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EventAction {
    Ignore,
    Dirty,
    Invalidate,
    Foreground,
    Geometry,
}
fn source_event(event: &Event, window: u32, root: u32, active: u32) -> EventAction {
    match event {
        Event::DestroyNotify(e) if e.window == window => EventAction::Invalidate,
        Event::UnmapNotify(e) if e.window == window => EventAction::Invalidate,
        Event::ConfigureNotify(e) if e.window == window => EventAction::Geometry,
        Event::ConfigureNotify(e) if e.window == root => EventAction::Invalidate,
        Event::ReparentNotify(e) if e.window == window => EventAction::Invalidate,
        Event::PropertyNotify(e) if e.window == root && e.atom == active => EventAction::Foreground,
        Event::RandrScreenChangeNotify(_) | Event::RandrNotify(_) | Event::Error(_) => {
            EventAction::Invalidate
        }
        Event::DamageNotify(_) => EventAction::Dirty,
        _ => EventAction::Ignore,
    }
}
impl Process {
    fn open(pid: u32) -> Result<Self, String> {
        let started = proc_started(&read_small(&format!("/proc/{pid}/stat"), 8192)?)?;
        // pidfd readiness survives numeric PID reuse; creation ticks are also
        // rechecked before/after opening so no replacement process is adopted.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        if fd < 0 {
            return Err("x11-process-unproved".into());
        }
        let process = Self {
            pid,
            started,
            fd: unsafe { OwnedFd::from_raw_fd(fd as i32) },
        };
        if !process.alive()? {
            return Err("x11-process-unproved".into());
        }
        Ok(process)
    }
    fn alive(&self) -> Result<bool, String> {
        let mut fd = libc::pollfd {
            fd: self.fd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut fd, 1, 0) };
        if result < 0 {
            return Err("x11-process-unproved".into());
        }
        Ok(result == 0
            && proc_started(&read_small(&format!("/proc/{}/stat", self.pid), 8192)?)?
                == self.started)
    }
}
fn read_small(path: &str, cap: usize) -> Result<String, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "x11-process-unproved")?
        .take(cap as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "x11-process-unproved")?;
    if bytes.len() > cap {
        return Err("x11-process-unproved".into());
    }
    String::from_utf8(bytes).map_err(|_| "x11-process-unproved".into())
}
fn proc_started(stat: &str) -> Result<u64, String> {
    let (_, rest) = stat.rsplit_once(')').ok_or("x11-process-unproved")?;
    let fields: Vec<_> = rest.split_ascii_whitespace().collect();
    if fields.len() < 20 || matches!(fields[0], "Z" | "X" | "x") {
        return Err("x11-process-unproved".into());
    }
    fields[19]
        .parse()
        .map_err(|_| "x11-process-unproved".into())
}
fn native_error<T: std::fmt::Display>(_: T) -> String {
    "x11-unavailable".into()
}
fn local_socket(path: &str, control: &Control) -> io::Result<UnixStream> {
    let bytes = path.as_bytes();
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.contains(&0) || bytes.len() + 1 > address.sun_path.len() {
        return Err(io::Error::other("x11-unavailable"));
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    let deadline = Instant::now() + IO_BUDGET;
    // Same local endpoint, first Linux's abstract name, then its pathname.
    // x11rb's stock connector is blocking before its Stream is created.
    for abstract_name in [true, false] {
        control.check().map_err(io::Error::other)?;
        address.sun_path.fill(0);
        let offset = usize::from(abstract_name);
        for (slot, byte) in address.sun_path[offset..].iter_mut().zip(bytes) {
            *slot = *byte as libc::c_char;
        }
        let raw = unsafe {
            libc::socket(
                libc::AF_UNIX,
                libc::SOCK_STREAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC,
                0,
            )
        };
        if raw < 0 {
            return Err(io::Error::last_os_error());
        }
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        let length = (std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1)
            as libc::socklen_t;
        let result = unsafe {
            libc::connect(
                fd.as_raw_fd(),
                (&address as *const libc::sockaddr_un).cast(),
                length,
            )
        };
        if result < 0 {
            if !matches!(
                io::Error::last_os_error().raw_os_error(),
                Some(libc::EINPROGRESS | libc::EINTR)
            ) {
                continue;
            }
            loop {
                control.check().map_err(io::Error::other)?;
                if Instant::now() >= deadline {
                    return Err(io::Error::other("x11-timeout"));
                }
                let mut poll = libc::pollfd {
                    fd: fd.as_raw_fd(),
                    events: libc::POLLOUT,
                    revents: 0,
                };
                let result = unsafe { libc::poll(&mut poll, 1, 25) };
                if result > 0 {
                    break;
                }
                if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                    return Err(io::Error::last_os_error());
                }
            }
            let mut error: libc::c_int = 0;
            let mut length = std::mem::size_of_val(&error) as libc::socklen_t;
            if unsafe {
                libc::getsockopt(
                    fd.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_ERROR,
                    (&mut error as *mut libc::c_int).cast(),
                    &mut length,
                )
            } < 0
            {
                return Err(io::Error::last_os_error());
            }
            if error != 0 {
                continue;
            }
        }
        return Ok(UnixStream::from(fd));
    }
    Err(io::Error::other("x11-unavailable"))
}
fn pack(
    formats: &[Format],
    depths: &[Depth],
    order: ImageOrder,
    geometry: Geometry,
    bytes: &[u8],
    cancel: &Cancellation,
) -> Result<Vec<u8>, String> {
    if cancel.is_cancelled() {
        return Err("cancelled".into());
    }
    let format = formats
        .iter()
        .find(|f| f.depth == geometry.depth)
        .ok_or("x11-pixel-format-unproved")?;
    let visual = depths
        .iter()
        .flat_map(|d| &d.visuals)
        .find(|v| v.visual_id == geometry.visual)
        .ok_or("x11-pixel-format-unproved")?;
    if visual.class != VisualClass::TRUE_COLOR
        || !matches!(format.bits_per_pixel, 16 | 24 | 32)
        || !matches!(format.scanline_pad, 8 | 16 | 32)
        || !matches!(order, ImageOrder::LSB_FIRST | ImageOrder::MSB_FIRST)
    {
        return Err("x11-pixel-format-unproved".into());
    }
    let masks = [visual.blue_mask, visual.green_mask, visual.red_mask];
    if masks.iter().any(|m| {
        *m == 0
            || (*m >> m.trailing_zeros()).count_ones() != (*m >> m.trailing_zeros()).trailing_ones()
    }) || masks[0] & masks[1] != 0
        || masks[0] & masks[2] != 0
        || masks[1] & masks[2] != 0
        || masks
            .iter()
            .any(|m| u64::from(*m) >= (1u64 << format.bits_per_pixel))
    {
        return Err("x11-pixel-format-unproved".into());
    }
    let bpp = usize::from(format.bits_per_pixel / 8);
    let pad = usize::from(format.scanline_pad);
    let stride =
        (usize::from(geometry.w) * usize::from(format.bits_per_pixel)).div_ceil(pad) * pad / 8;
    let packed = usize::from(geometry.w) * usize::from(geometry.h) * 4;
    if packed == 0 || packed > PIXEL_CAP || bytes.len() != stride * usize::from(geometry.h) {
        return Err("x11-pixel-format-unproved".into());
    }
    let mut output = Vec::with_capacity(packed);
    for row in bytes.chunks_exact(stride) {
        if cancel.is_cancelled() {
            return Err("cancelled".into());
        }
        for bytes in row[..usize::from(geometry.w) * bpp].chunks_exact(bpp) {
            let mut pixel = 0u32;
            for (index, byte) in bytes.iter().enumerate() {
                let shift = if order == ImageOrder::LSB_FIRST {
                    index
                } else {
                    bpp - index - 1
                } * 8;
                pixel |= u32::from(*byte) << shift;
            }
            for mask in masks {
                let max = mask >> mask.trailing_zeros();
                let value = (pixel & mask) >> mask.trailing_zeros();
                output.push(((u64::from(value) * 255 + u64::from(max) / 2) / u64::from(max)) as u8);
            }
            output.push(255);
        }
    }
    Ok(output)
}

// shortcut: AT-SPI AccessibleId is application-specific, not a native XID.
// Until an actual per-window association API is proved, no accessibility names,
// values, descriptions or text are requested (including password nodes).

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn pending_retirement_survives_timeout_and_cancelled_wait_until_proved_exit() {
        let (send, receive) = std::sync::mpsc::channel::<()>();
        let worker = std::thread::spawn(move || receive.recv().unwrap());
        let mut retirement = Some(Retirement::Pending(tokio::task::spawn_blocking(
            move || worker.join().is_ok(),
        )));
        assert_eq!(
            wait_retirement(&mut retirement, Duration::from_millis(5)).await,
            Err("x11-stop-timeout".into())
        );
        assert!(matches!(retirement, Some(Retirement::Pending(_))));
        // Repeated Stop/new Start must still see the retained unproved join.
        assert_eq!(
            wait_retirement(&mut retirement, Duration::from_millis(5)).await,
            Err("x11-stop-timeout".into())
        );
        {
            let wait = wait_retirement(&mut retirement, Duration::from_secs(2));
            tokio::pin!(wait);
            tokio::select! {
                _ = &mut wait => panic!("owned worker is still pending"),
                _ = tokio::time::sleep(Duration::from_millis(5)) => {},
            }
        }
        assert!(
            matches!(retirement, Some(Retirement::Pending(_))),
            "dropping a wait cannot forget native cleanup"
        );
        send.send(()).unwrap();
        assert_eq!(
            wait_retirement(&mut retirement, Duration::from_secs(5)).await,
            Ok(())
        );
        assert!(retirement.is_none());
        assert_eq!(
            wait_retirement(&mut retirement, Duration::ZERO).await,
            Ok(())
        );
    }
    #[tokio::test]
    async fn panicked_retirement_keeps_stop_and_replacement_capture_refused() {
        let worker = std::thread::spawn(|| panic!("disposable worker panic"));
        let mut retirement = Some(Retirement::Pending(tokio::task::spawn_blocking(
            move || worker.join().is_ok(),
        )));
        assert_eq!(
            wait_retirement(&mut retirement, Duration::from_secs(5)).await,
            Err("x11-stop-failed".into())
        );
        assert!(matches!(retirement, Some(Retirement::Failed)));
        assert_eq!(
            wait_retirement(&mut retirement, Duration::ZERO).await,
            Err("x11-stop-failed".into())
        );
        let task = tokio::spawn(async { panic!("disposable join task panic") });
        let mut retirement = Some(Retirement::Pending(task));
        assert_eq!(
            wait_retirement(&mut retirement, Duration::from_secs(5)).await,
            Err("x11-stop-failed".into())
        );
        assert!(matches!(retirement, Some(Retirement::Failed)));
    }
    #[test]
    fn proc_creation_handles_parentheses_and_refuses_exited_processes() {
        let tail = (1..=18).map(|_| "1").collect::<Vec<_>>().join(" ");
        assert_eq!(
            proc_started(&format!("12 (odd ) process) S {tail} 42")),
            Ok(42)
        );
        assert!(proc_started(&format!("12 (same) Z {tail} 42")).is_err());
        assert!(proc_started("12 (truncated) S 1").is_err());
    }
    #[test]
    fn readable_old_pixmaps_do_not_survive_native_lifetime_events() {
        let event = Event::UnmapNotify(UnmapNotifyEvent {
            response_type: 18,
            sequence: 0,
            event: 1,
            window: 4,
            from_configure: false,
        });
        assert_eq!(source_event(&event, 4, 1, 10), EventAction::Invalidate);
        assert_eq!(source_event(&event, 5, 1, 10), EventAction::Ignore);
        let event = Event::DestroyNotify(DestroyNotifyEvent {
            response_type: 17,
            sequence: 0,
            event: 1,
            window: 4,
        });
        assert_eq!(source_event(&event, 4, 1, 10), EventAction::Invalidate);
    }
    #[test]
    fn exact_stride_endianness_and_visual_masks_determine_bgra() {
        let geometry = Geometry {
            x: -10,
            y: 4,
            w: 1,
            h: 1,
            depth: 24,
            visual: 9,
        };
        let formats = [Format {
            depth: 24,
            bits_per_pixel: 24,
            scanline_pad: 32,
        }];
        let depths = [Depth {
            depth: 24,
            visuals: vec![Visualtype {
                visual_id: 9,
                class: VisualClass::TRUE_COLOR,
                bits_per_rgb_value: 8,
                colormap_entries: 256,
                red_mask: 0xff0000,
                green_mask: 0xff00,
                blue_mask: 0xff,
            }],
        }];
        assert_eq!(
            pack(
                &formats,
                &depths,
                ImageOrder::LSB_FIRST,
                geometry,
                &[3, 2, 1, 0],
                &Cancellation::new(),
            )
            .unwrap(),
            [3, 2, 1, 255]
        );
        assert_eq!(
            pack(
                &formats,
                &depths,
                ImageOrder::MSB_FIRST,
                geometry,
                &[1, 2, 3, 0],
                &Cancellation::new(),
            )
            .unwrap(),
            [3, 2, 1, 255]
        );
        assert!(pack(
            &formats,
            &depths,
            ImageOrder::LSB_FIRST,
            geometry,
            &[3, 2, 1],
            &Cancellation::new(),
        )
        .is_err());
        let mut invalid = depths.clone();
        invalid[0].visuals[0].green_mask = 0xff;
        assert!(pack(
            &formats,
            &invalid,
            ImageOrder::LSB_FIRST,
            geometry,
            &[3, 2, 1, 0],
            &Cancellation::new(),
        )
        .is_err());
        let cancelled = Cancellation::new();
        cancelled.cancel();
        assert_eq!(
            pack(
                &formats,
                &depths,
                ImageOrder::LSB_FIRST,
                geometry,
                &[3, 2, 1, 0],
                &cancelled
            ),
            Err("cancelled".into())
        );
    }
    #[test]
    fn normal_changes_regrant_but_destroy_unmap_and_topology_refuse() {
        let event = Event::PropertyNotify(PropertyNotifyEvent {
            response_type: 28,
            sequence: 0,
            window: 1,
            atom: 10,
            time: 0,
            state: Property::NEW_VALUE,
        });
        assert_eq!(source_event(&event, 4, 1, 10), EventAction::Foreground);
        let event = Event::ConfigureNotify(ConfigureNotifyEvent {
            response_type: 22,
            sequence: 0,
            event: 1,
            window: 4,
            above_sibling: 0,
            x: 12,
            y: 10,
            width: 40,
            height: 20,
            border_width: 0,
            override_redirect: false,
        });
        assert_eq!(source_event(&event, 4, 1, 10), EventAction::Geometry);
        assert_eq!(source_event(&event, 1, 4, 10), EventAction::Invalidate);
    }
    #[test]
    fn pidfd_exit_does_not_adopt_a_process_with_a_reused_number() {
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut child = Child(
            std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .expect("disposable Linux child"),
        );
        let identity = Process::open(child.0.id()).expect("server-local Linux process identity");
        assert!(identity.alive().unwrap());
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(!identity.alive().unwrap_or(false));
    }
    /// Starts its own display and redirects only its own disposable test target.
    /// No user DISPLAY, input or compositor setting is touched. CI runs this
    /// explicitly with Xvfb installed; it is not installed desktop acceptance.
    #[test]
    #[ignore = "requires isolated Xvfb; run explicitly in Linux CI"]
    fn isolated_xvfb_pixmap_excludes_foreign_pixels_and_rejects_retained_surface() {
        struct Server(std::process::Child);
        impl Drop for Server {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut server = Server(
            std::process::Command::new("Xvfb")
                .args([
                    "-displayfd",
                    "1",
                    "-screen",
                    "0",
                    "800x600x24",
                    "-nolisten",
                    "tcp",
                ])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("Xvfb installed"),
        );
        let mut output = server.0.stdout.take().unwrap();
        let mut display = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            assert!(Instant::now() < deadline, "Xvfb startup deadline");
            let mut fd = libc::pollfd {
                fd: output.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            if unsafe { libc::poll(&mut fd, 1, 25) } > 0 {
                let mut byte = [0];
                assert_eq!(output.read(&mut byte).unwrap(), 1);
                if byte[0] == b'\n' {
                    break;
                }
                display.push(byte[0]);
                assert!(display.len() < 16);
            }
        }
        let display = format!(":{}", String::from_utf8(display).unwrap());
        let (client, screen) = x11rb::connect(Some(&display)).unwrap();
        let (compositor, _) = x11rb::connect(Some(&display)).unwrap();
        let (observer, _) = x11rb::connect(Some(&display)).unwrap();
        let root = &client.setup().roots[screen];
        let target = client.generate_id().unwrap();
        let create = |color| {
            client
                .create_window(
                    root.root_depth,
                    target,
                    root.root,
                    20,
                    20,
                    32,
                    24,
                    0,
                    WindowClass::INPUT_OUTPUT,
                    root.root_visual,
                    &CreateWindowAux::new().background_pixel(color),
                )
                .unwrap()
                .check()
                .unwrap()
        };
        create(0x112233);
        client.map_window(target).unwrap().check().unwrap();
        composite::redirect_window(&compositor, target, composite::Redirect::MANUAL)
            .unwrap()
            .check()
            .unwrap();
        observer
            .change_window_attributes(
                target,
                &ChangeWindowAttributesAux::new().event_mask(EventMask::STRUCTURE_NOTIFY),
            )
            .unwrap()
            .check()
            .unwrap();
        let ids = res::query_client_ids(
            &observer,
            &[res::ClientIdSpec {
                client: target,
                mask: res::ClientIdMask::LOCAL_CLIENT_PID,
            }],
        )
        .unwrap()
        .reply()
        .unwrap()
        .ids;
        assert_eq!(ids[0].value, [std::process::id()]);
        let _identity = Process::open(ids[0].value[0]).unwrap();
        let pixmap = observer.generate_id().unwrap();
        composite::name_window_pixmap(&observer, target, pixmap)
            .unwrap()
            .check()
            .unwrap();
        let foreign = client.generate_id().unwrap();
        client
            .create_window(
                root.root_depth,
                foreign,
                root.root,
                20,
                20,
                32,
                24,
                0,
                WindowClass::INPUT_OUTPUT,
                root.root_visual,
                &CreateWindowAux::new().background_pixel(0x00ff00),
            )
            .unwrap()
            .check()
            .unwrap();
        client.map_window(foreign).unwrap().check().unwrap();
        let geometry = Geometry {
            x: 20,
            y: 20,
            w: 32,
            h: 24,
            depth: root.root_depth,
            visual: root.root_visual,
        };
        let reply = observer
            .get_image(ImageFormat::Z_PIXMAP, pixmap, 0, 0, 32, 24, u32::MAX)
            .unwrap()
            .reply()
            .unwrap();
        let pixels = pack(
            &observer.setup().pixmap_formats,
            &observer.setup().roots[screen].allowed_depths,
            observer.setup().image_byte_order,
            geometry,
            &reply.data,
            &Cancellation::new(),
        )
        .unwrap();
        assert!(
            pixels
                .as_chunks::<4>()
                .0
                .iter()
                .all(|pixel| *pixel == [0x33, 0x22, 0x11, 255]),
            "foreign root sibling never replaces target pixels"
        );
        composite::unredirect_window(&compositor, target, composite::Redirect::MANUAL)
            .unwrap()
            .check()
            .unwrap();
        let probe = observer.generate_id().unwrap();
        assert!(
            composite::name_window_pixmap(&observer, target, probe)
                .unwrap()
                .check()
                .is_err(),
            "fresh naming refuses an unredirected target"
        );
        assert!(
            observer.get_geometry(pixmap).unwrap().reply().is_ok(),
            "retained alias alone cannot prove current compositor capture"
        );
        composite::redirect_window(&compositor, target, composite::Redirect::MANUAL)
            .unwrap()
            .check()
            .unwrap();
        client
            .change_window_attributes(
                target,
                &ChangeWindowAttributesAux::new().background_pixel(0xabcdef),
            )
            .unwrap()
            .check()
            .unwrap();
        client
            .clear_area(false, target, 0, 0, 0, 0)
            .unwrap()
            .check()
            .unwrap();
        composite::name_window_pixmap(&observer, target, probe)
            .unwrap()
            .check()
            .unwrap();
        let reply = observer
            .get_image(ImageFormat::Z_PIXMAP, probe, 0, 0, 32, 24, u32::MAX)
            .unwrap()
            .reply()
            .unwrap();
        let fresh = pack(
            &observer.setup().pixmap_formats,
            &observer.setup().roots[screen].allowed_depths,
            observer.setup().image_byte_order,
            geometry,
            &reply.data,
            &Cancellation::new(),
        )
        .unwrap();
        assert!(fresh
            .as_chunks::<4>()
            .0
            .iter()
            .all(|pixel| *pixel == [0xef, 0xcd, 0xab, 255]));
        assert_ne!(
            fresh, pixels,
            "re-redirect requires the current named surface"
        );
        observer.free_pixmap(probe).unwrap().check().unwrap();
        let active = observer
            .intern_atom(false, b"_NET_ACTIVE_WINDOW")
            .unwrap()
            .reply()
            .unwrap()
            .atom;
        observer
            .change_window_attributes(
                root.root,
                &ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE),
            )
            .unwrap()
            .check()
            .unwrap();
        observer
            .change_property(
                PropMode::REPLACE,
                root.root,
                active,
                AtomEnum::WINDOW,
                32,
                1,
                &foreign.to_ne_bytes(),
            )
            .unwrap()
            .check()
            .unwrap();
        observer.get_input_focus().unwrap().reply().unwrap();
        let mut retargeted = false;
        while let Some(event) = observer.poll_for_event().unwrap() {
            retargeted |=
                source_event(&event, target, root.root, active) == EventAction::Foreground;
        }
        assert!(
            retargeted,
            "foreground change requires a fresh generation and target proof"
        );
        client
            .configure_window(target, &ConfigureWindowAux::new().width(40))
            .unwrap()
            .check()
            .unwrap();
        assert_eq!(
            observer
                .get_geometry(pixmap)
                .unwrap()
                .reply()
                .unwrap()
                .width,
            32,
            "named old surface survives resize"
        );
        client.unmap_window(target).unwrap().check().unwrap();
        client.destroy_window(target).unwrap().check().unwrap();
        // Recreate exactly that XID in the same still-live process. Native
        // lifetime events must invalidate even when PID/starttime are identical.
        create(0xabcdef);
        client.map_window(target).unwrap().check().unwrap();
        observer.get_input_focus().unwrap().reply().unwrap();
        let mut invalidated = false;
        let mut resized = false;
        while let Some(event) = observer.poll_for_event().unwrap() {
            invalidated |= source_event(&event, target, root.root, 0) == EventAction::Invalidate;
            resized |= source_event(&event, target, root.root, 0) == EventAction::Geometry;
        }
        assert!(invalidated && resized);
        assert_eq!(
            observer
                .get_geometry(pixmap)
                .unwrap()
                .reply()
                .unwrap()
                .width,
            32,
            "retained pixmap readability is not lifetime proof"
        );
    }
}
