//! Shared Windows/Linux Lens lifecycle. Concrete capture providers own native
//! handles and prove their identity before accepting or publishing a source.
#[cfg(not(target_os = "macos"))]
#[path = "bridge.rs"]
pub mod bridge;
#[cfg(not(target_os = "macos"))]
#[path = "geometry.rs"]
pub mod geometry;
#[cfg(target_os = "linux")]
pub mod linux_overlay;
#[cfg(target_os = "linux")]
pub mod linux_wayland;
#[cfg(target_os = "linux")]
pub mod linux_x11;
#[path = "portable_ocr.rs"]
pub mod ocr;
#[cfg(not(target_os = "macos"))]
#[path = "overlay.rs"]
pub mod overlay;
#[cfg(not(target_os = "macos"))]
#[path = "request.rs"]
pub mod request;
#[cfg(not(target_os = "macos"))]
#[path = "ring.rs"]
pub mod ring;
#[cfg(target_os = "windows")]
pub mod windows;
#[cfg(target_os = "macos")]
pub use super::{bridge, geometry, overlay, request, ring};
#[cfg(test)]
#[allow(dead_code)]
#[path = "unsupported.rs"]
mod unsupported_tests;

use bridge::{Bridge, DisplayInfo, FrameGeometry, Kind, Line, Rect};
use image::codecs::jpeg::JpegEncoder;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, Notify};

pub const FRAME_CAP: usize = 2 * 1024 * 1024;
pub const DEFAULT_MAX_PX: u32 = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CaptureBackend {
    Windows,
    X11,
    Wayland,
}
impl CaptureBackend {
    fn selected() -> Self {
        #[cfg(target_os = "linux")]
        let wayland = crate::remote_wayland::is_wayland();
        #[cfg(not(target_os = "linux"))]
        let wayland = false;
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::linux(wayland)
        }
    }
    fn linux(wayland: bool) -> Self {
        if wayland {
            Self::Wayland
        } else {
            Self::X11
        }
    }
    fn score_id(self) -> &'static str {
        match self {
            Self::Windows => "windows:wgc:rgb16-tile32-v1",
            Self::X11 => "linux:x11:rgb16-tile32-v1",
            Self::Wayland => "linux:pipewire:rgb16-tile32-v1",
        }
    }
    fn native_overlays(self) -> bool {
        self != Self::Wayland
    }
}

#[cfg(target_os = "linux")]
enum LinuxBackend {
    X11(Arc<linux_x11::Backend>),
    Wayland(Arc<linux_wayland::Backend>),
}
#[cfg(target_os = "linux")]
impl LinuxBackend {
    fn cancel(&self) {
        match self {
            Self::X11(backend) => backend.cancel(),
            Self::Wayland(backend) => backend.cancel(),
        }
    }
    async fn stop(&self) -> Result<(), String> {
        match self {
            Self::X11(backend) => backend.stop().await,
            Self::Wayland(backend) => backend.stop().await,
        }
    }
    async fn start(
        &self,
        generation: u64,
        cancellation: Arc<request::Cancellation>,
    ) -> Result<(), String> {
        match self {
            Self::X11(backend) => backend.start(generation, cancellation).await,
            Self::Wayland(backend) => backend.start(generation, cancellation).await,
        }
    }
    fn overlay(&self) -> Option<Arc<linux_overlay::Overlay>> {
        match self {
            Self::X11(backend) => Some(backend.overlay.clone()),
            Self::Wayland(_) => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub pid: i32,
    pub bundle: String,
    pub name: String,
    pub window_id: u32,
    pub title: String,
    pub bounds: Rect,
    pub url: Option<String>,
    pub display: DisplayInfo,
}

/// A backend obtains this only after validating its native source's lifetime,
/// exact window scope and capture geometry. Never serialize native handles.
#[derive(Clone)]
pub struct CaptureLease {
    pub epoch: u64,
    pub generation: u64,
    pub target: Target,
    pub geometry: FrameGeometry,
    pub size: [u32; 2],
    /// Private capture-time display rectangle in the provider's screen units.
    pub display_bounds: Rect,
}

struct State {
    generation: u64,
    consented: bool,
    active: bool,
    paused: bool,
    reason: Option<String>,
    capture: bool,
    ax: bool,
    target: Option<Target>,
    session: Arc<request::Cancellation>,
    known_ax: Vec<Line>,
    known_ocr: Vec<Line>,
    previous: Option<([u32; 2], Arc<[u8]>)>,
    score_id: String,
    control_generation: u64,
    control: Arc<request::Cancellation>,
    placement: Option<(FrameGeometry, [u32; 2], Rect)>,
    overlay: bool,
}

pub struct Lens {
    pub bridge: Arc<Bridge>,
    pub ring: ring::Ring,
    state: Mutex<State>,
    ocr: ocr::Ocr,
    pending: Mutex<Option<(String, Rect)>>,
    wake: Notify,
    lifecycle: Arc<tokio::sync::Mutex<()>>,
    capture_backend: CaptureBackend,
    #[cfg(target_os = "windows")]
    backend: std::sync::OnceLock<Arc<windows::Backend>>,
    #[cfg(target_os = "linux")]
    backend: std::sync::OnceLock<LinuxBackend>,
    #[cfg(not(target_os = "macos"))]
    overlay: std::sync::OnceLock<Arc<overlay::Overlay>>,
}
impl Lens {
    pub fn init(writer: mpsc::UnboundedSender<String>, directory: &Path) -> Arc<Self> {
        Self::new(writer, ocr::Ocr::new(directory))
    }
    fn new(writer: mpsc::UnboundedSender<String>, ocr: ocr::Ocr) -> Arc<Self> {
        Self::new_for_backend(writer, ocr, CaptureBackend::selected())
    }
    fn new_for_backend(
        writer: mpsc::UnboundedSender<String>,
        ocr: ocr::Ocr,
        capture_backend: CaptureBackend,
    ) -> Arc<Self> {
        let lens = Arc::new(Self {
            bridge: Bridge::new(writer),
            ring: ring::Ring::new(),
            ocr,
            pending: Mutex::new(None),
            wake: Notify::new(),
            lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            capture_backend,
            #[cfg(not(target_os = "macos"))]
            backend: std::sync::OnceLock::new(),
            #[cfg(not(target_os = "macos"))]
            overlay: std::sync::OnceLock::new(),
            state: Mutex::new(State {
                generation: 1,
                consented: false,
                active: false,
                paused: false,
                reason: Some("not-consented".into()),
                capture: false,
                ax: false,
                target: None,
                session: request::Cancellation::new(),
                known_ax: vec![],
                known_ocr: vec![],
                previous: None,
                score_id: capture_backend.score_id().into(),
                control_generation: 1,
                control: request::Cancellation::new(),
                placement: None,
                overlay: false,
            }),
        });
        let worker = lens.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                worker.wake.notified().await;
                loop {
                    let pending = worker.pending.lock().unwrap().take();
                    let Some((frame_ref, rect)) = pending else {
                        break;
                    };
                    let _ = worker
                        .recognize(&frame_ref, rect, false, None, request::Cancellation::new())
                        .await;
                }
            }
        });
        lens
    }
    pub fn request_generation(&self) -> u64 {
        self.state.lock().unwrap().generation
    }
    /// Setup is dormant. Only a consented, active control starts a provider.
    #[cfg(not(target_os = "macos"))]
    pub fn attach(self: &Arc<Self>, app: &tauri::AppHandle, media_directory: &Path) {
        #[cfg(target_os = "windows")]
        let backend = {
            let _ = media_directory;
            windows::Backend::attach(app, Arc::downgrade(self))
        };
        #[cfg(target_os = "linux")]
        let backend = match self.capture_backend {
            CaptureBackend::Wayland => {
                LinuxBackend::Wayland(linux_wayland::Backend::attach(app, self, media_directory))
            }
            CaptureBackend::X11 => LinuxBackend::X11(linux_x11::Backend::attach(app, self)),
            CaptureBackend::Windows => unreachable!("Windows backend on Linux"),
        };
        let _ = self.backend.set(backend);
        if !self.capture_backend.native_overlays() {
            return;
        }
        if let Err(error) = app.plugin(tauri_plugin_global_shortcut::Builder::new().build()) {
            eprintln!("overlay: shortcut service unavailable: {error}");
            return;
        }
        match overlay::Overlay::build(app, self) {
            Ok(overlay) => {
                let _ = self.overlay.set(overlay.clone());
                use tauri::Manager;
                app.manage(overlay);
            }
            Err(error) => eprintln!("overlay: pool unavailable: {error}"),
        }
    }
    #[cfg(target_os = "linux")]
    pub(super) fn register_overlay_windows(&self, windows: Vec<tauri::WebviewWindow>) {
        if let Some(overlay) = self.native_overlay() {
            let _ = overlay.register_windows(windows);
        }
    }
    #[cfg(target_os = "linux")]
    fn native_overlay(&self) -> Option<Arc<linux_overlay::Overlay>> {
        self.backend.get().and_then(LinuxBackend::overlay)
    }
    #[cfg(not(target_os = "macos"))]
    fn overlay(&self) -> Option<Arc<overlay::Overlay>> {
        self.overlay.get().cloned()
    }
    pub fn request_session(&self) -> Option<Arc<request::Cancellation>> {
        Some(self.state.lock().unwrap().session.clone())
    }
    fn platform() -> &'static str {
        if cfg!(windows) {
            "windows"
        } else {
            "linux"
        }
    }
    #[cfg(test)]
    fn score_id() -> &'static str {
        CaptureBackend::selected().score_id()
    }
    fn capabilities(&self, state: &State) -> Value {
        json!({"capture":state.capture,"ax":state.ax,"ocr":self.ocr.available(),"embed":false,"triage":false,"describe":false,"translate":false,"overlay":state.overlay && self.capture_backend.native_overlays()})
    }
    fn run(state: &State) -> &'static str {
        if state.paused {
            "paused"
        } else if state.active && state.consented && state.capture {
            "running"
        } else {
            "stopped"
        }
    }
    fn invalidate(&self, state: &mut State) {
        state.session.cancel();
        state.session = request::Cancellation::new();
        state.generation += 1;
        self.bridge.bump_epoch();
        self.ring.clear();
        state.target = None;
        state.placement = None;
        state.overlay = false;
        state.known_ax.clear();
        state.known_ocr.clear();
        state.previous = None;
        *self.pending.lock().unwrap() = None;
    }
    fn announce(&self, state: &State) {
        self.bridge.emit(Kind::Capabilities {
            platform: Self::platform().into(),
            capabilities: self.capabilities(state),
            visual: json!({"scoreId":state.score_id}),
        });
        self.bridge.emit(Kind::Status {
            state: Self::run(state).into(),
            reason: state.reason.clone(),
            screen: state.capture,
            ax: state.ax,
        });
    }
    fn cancel_native(&self) {
        #[cfg(not(target_os = "macos"))]
        if let Some(backend) = self.backend.get() {
            backend.cancel();
        }
    }
    /// Drop State before dispatching. Source-scoped retirement cannot hide a
    /// replacement that reused the same pool window while this callback waited.
    fn clear_source_overlays(&self, generation: u64) {
        #[cfg(not(target_os = "macos"))]
        if let Some(overlay) = self.overlay() {
            if let Err(reason) = overlay.clear_source(generation) {
                eprintln!("overlay: source cleanup failed: {reason}");
            }
        }
        #[cfg(target_os = "macos")]
        let _ = generation;
    }
    fn cleanup_failure(&self, generation: u64, reason: &str) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.control_generation != generation {
            return false;
        }
        state.capture = false;
        state.ax = false;
        state.reason = Some(reason.into());
        self.announce(&state);
        true
    }
    fn revoke_overlay(
        &self,
        expected_generation: u64,
        cancellation: Option<&request::Cancellation>,
    ) -> bool {
        {
            let mut state = self.state.lock().unwrap();
            if state.generation != expected_generation
                || state.control.is_cancelled()
                || cancellation.is_some_and(request::Cancellation::is_cancelled)
                || Self::run(&state) != "running"
            {
                return false;
            }
            state.overlay = false;
            self.announce(&state);
        }
        self.clear_source_overlays(expected_generation);
        true
    }
    /// Controls invalidate synchronously before this gate. A superseded control
    /// must not close a newer worker after waiting for an earlier start/drain.
    async fn finish_control(&self, generation: u64, start: bool) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().await;
        let expected = {
            let state = self.state.lock().unwrap();
            if state.control_generation != generation {
                return Err("cancelled".into());
            }
            (state.generation, state.control.clone())
        };
        #[cfg(not(target_os = "macos"))]
        let stopped = if let Some(backend) = self.backend.get() {
            backend.stop().await
        } else {
            Ok(())
        };
        #[cfg(target_os = "macos")]
        let stopped: Result<(), String> = Ok(());
        #[cfg(not(target_os = "macos"))]
        let hidden = if let Some(overlay) = self.overlay() {
            tokio::task::spawn_blocking(move || overlay.clear_checked(None))
                .await
                .unwrap_or_else(|_| Err("overlay-window-gone".to_owned()))
        } else {
            Ok(())
        };
        #[cfg(target_os = "macos")]
        let hidden: Result<(), String> = Ok(());
        self.ocr.drained().await;
        if let Err(reason) = stopped.and(hidden) {
            self.cleanup_failure(generation, &reason);
            return Err(reason);
        }
        {
            let state = self.state.lock().unwrap();
            if state.control_generation != generation || expected.1.is_cancelled() {
                return Err("cancelled".into());
            }
        }
        if start {
            #[cfg(not(target_os = "macos"))]
            if let Some(backend) = self.backend.get() {
                let result = backend.start(expected.0, expected.1.clone()).await;
                let cancelled = {
                    let state = self.state.lock().unwrap();
                    state.control_generation != generation || expected.1.is_cancelled()
                };
                if cancelled {
                    backend.cancel();
                    let stopped = backend.stop().await;
                    self.ocr.drained().await;
                    if let Err(reason) = stopped {
                        self.cleanup_failure(generation, &reason);
                        return Err(reason);
                    }
                    return Err("cancelled".into());
                }
                if let Err(reason) = result {
                    let mut state = self.state.lock().unwrap();
                    if state.control_generation != generation || expected.1.is_cancelled() {
                        return Err("cancelled".into());
                    }
                    self.invalidate(&mut state);
                    state.capture = false;
                    state.ax = false;
                    state.reason = Some(reason.clone());
                    self.announce(&state);
                    return Err(reason);
                }
            }
        }
        Ok(())
    }
    /// A concrete source proves the hidden native pool's exclusion/readback.
    /// Old bootstrap completions cannot grant overlays into a new source.
    #[cfg(target_os = "linux")]
    pub fn set_overlay_available(&self, expected_generation: u64, available: bool) -> bool {
        if available && !self.capture_backend.native_overlays() {
            return false;
        }
        if !available {
            return self.revoke_overlay(expected_generation, None);
        }
        let granted = {
            let mut state = self.state.lock().unwrap();
            if state.generation != expected_generation
                || state.control.is_cancelled()
                || Self::run(&state) != "running"
            {
                return false;
            }
            state.overlay = available && state.target.is_some() && self.overlay.get().is_some();
            self.announce(&state);
            state.overlay
        };
        if granted {
            if let Some(overlay) = self.overlay() {
                std::thread::spawn(move || overlay.enable_hotkey());
            }
        } else {
            self.clear_source_overlays(expected_generation);
        }
        true
    }
    #[cfg(target_os = "linux")]
    pub(super) fn overlay_available(&self) -> bool {
        self.state.lock().unwrap().overlay
    }
    /// Backend grants are actual provider answers. RIME-49 leaves capture/AX
    /// false; installing OCR alone cannot grant capture or native overlays.
    /// Compare under the lifecycle lock and return this mutation's generation;
    /// a superseded drain cannot announce grants into a replacement session.
    pub async fn backend_status(
        &self,
        expected_generation: u64,
        capture: bool,
        ax: bool,
        score_id: &str,
        reason: Option<&str>,
    ) -> Result<u64, String> {
        if score_id != self.capture_backend.score_id()
            || (ax && self.capture_backend == CaptureBackend::Wayland)
        {
            return Err("unavailable".into());
        }
        let generation = {
            let mut state = self.state.lock().unwrap();
            if state.generation != expected_generation || state.control.is_cancelled() {
                return Err("cancelled".into());
            }
            self.invalidate(&mut state);
            state.capture = capture;
            state.ax = ax;
            state.score_id = score_id.into();
            state.reason = reason.map(str::to_owned);
            state.generation
        };
        #[cfg(not(target_os = "macos"))]
        if let Some(overlay) = self.overlay() {
            match tokio::task::spawn_blocking(move || overlay.clear_source(expected_generation))
                .await
            {
                Ok(Ok(())) => {}
                Ok(Err(reason)) => eprintln!("overlay: source cleanup failed: {reason}"),
                Err(_) => eprintln!("overlay: source cleanup failed: overlay-window-gone"),
            }
        }
        self.ocr.drained().await;
        let state = self.state.lock().unwrap();
        if state.generation != generation || state.control.is_cancelled() {
            return Err("cancelled".into());
        }
        self.announce(&state);
        Ok(generation)
    }
    pub async fn stop(&self, reason: Option<&str>) -> Result<(), String> {
        self.stop_control(reason, false).await
    }
    async fn stop_control(&self, reason: Option<&str>, pause: bool) -> Result<(), String> {
        let generation = {
            let mut state = self.state.lock().unwrap();
            state.control.cancel();
            self.invalidate(&mut state);
            self.cancel_native();
            state.control_generation = state.generation;
            state.control = request::Cancellation::new();
            if pause {
                state.paused = true;
            }
            state.active = false;
            state.reason = reason.map(str::to_owned);
            self.announce(&state);
            state.control_generation
        };
        self.finish_control(generation, false).await
    }
    /// A provider must invalidate its accepted generation on native destroy,
    /// unmap, resize, monitor/session change or permission withdrawal, even if
    /// an old capture surface remains readable. Old callbacks cannot publish.
    /// A delayed callback cannot invalidate a newer provider's generation.
    pub fn invalidate_source(&self, expected_generation: u64, reason: &str) -> Option<u64> {
        let generation = {
            let mut state = self.state.lock().unwrap();
            if state.generation != expected_generation {
                return None;
            }
            self.invalidate(&mut state);
            state.capture = false;
            state.ax = false;
            state.reason = Some(reason.into());
            self.announce(&state);
            state.generation
        };
        self.clear_source_overlays(expected_generation);
        Some(generation)
    }
    pub fn accept_target(
        &self,
        expected_generation: u64,
        target: Target,
        geometry: FrameGeometry,
        size: [u32; 2],
        display_bounds: Rect,
    ) -> Option<CaptureLease> {
        if !valid_rect(target.bounds)
            || !valid_rect(display_bounds)
            || target.window_id == 0
            || target.pid < 0
            || !geometry_valid(geometry, size)
            || geometry.window != target.bounds
        {
            return None;
        }
        let mut state = self.state.lock().unwrap();
        if state.generation != expected_generation
            || state.control.is_cancelled()
            || Self::run(&state) != "running"
        {
            return None;
        }
        self.invalidate(&mut state);
        state.target = Some(target.clone());
        state.placement = Some((geometry, size, display_bounds));
        self.bridge.emit(Kind::App {
            bundle: target.bundle.clone(),
            name: target.name.clone(),
            pid: target.pid,
        });
        self.bridge.emit(Kind::Window {
            id: target.window_id,
            title: target.title.clone(),
            bounds: target.bounds,
            url: target.url.clone(),
            display: target.display,
        });
        let lease = CaptureLease {
            epoch: self.bridge.epoch(),
            generation: state.generation,
            target,
            geometry,
            size,
            display_bounds,
        };
        drop(state);
        self.clear_source_overlays(expected_generation);
        Some(lease)
    }
    fn current(&self, state: &State, lease: &CaptureLease) -> bool {
        Self::run(state) == "running"
            && !state.control.is_cancelled()
            && self.bridge.epoch() == lease.epoch
            && state.generation == lease.generation
            && state.target.as_ref() == Some(&lease.target)
    }
    #[cfg_attr(
        all(target_os = "linux", not(test)),
        expect(
            dead_code,
            reason = "RIME-51 AX association remains unproved; remove when exact AT-SPI association attaches"
        )
    )]
    pub fn publish_ax(&self, lease: &CaptureLease, lines: Vec<Line>) -> bool {
        let mut state = self.state.lock().unwrap();
        if !state.ax
            || !self.current(&state, lease)
            || lines.len() > 4096
            || lines.iter().any(|l| !valid_rect(l.bbox))
            || lines.iter().map(|l| l.text.len()).sum::<usize>() > 128 * 1024
        {
            return false;
        }
        state.known_ax = lines.clone();
        self.bridge.emit(Kind::AxText {
            rect: [0.0, 0.0, lease.target.bounds[2], lease.target.bounds[3]],
            lines,
        });
        true
    }
    /// Immutable packed BGRA, after the provider proves identity AND geometry
    /// again for this sample. The frame's transform is never reconstructed from
    /// a later window position. The single pending recognition is latest wins.
    pub fn publish_frame(
        &self,
        lease: &CaptureLease,
        bgra: Arc<[u8]>,
        size: [u32; 2],
        geometry: FrameGeometry,
    ) -> Option<String> {
        let [w, h] = size;
        if w == 0
            || h == 0
            || u64::from(w) * u64::from(h) * 4 != bgra.len() as u64
            || bgra.len() > ocr::PIXEL_CAP
            || !geometry_valid(geometry, size)
            || geometry.window != lease.target.bounds
            || geometry != lease.geometry
            || size != lease.size
        {
            return None;
        }
        let previous = {
            let state = self.state.lock().unwrap();
            if !self.current(&state, lease) {
                return None;
            }
            state.previous.clone()
        };
        let dirty = score(previous.as_ref(), &bgra, size, &geometry);
        let mut rgb = Vec::with_capacity(w as usize * h as usize * 3);
        for pixel in bgra.as_chunks::<4>().0 {
            rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
        }
        let mut jpeg = Vec::new();
        if !dirty.is_empty() {
            JpegEncoder::new_with_quality(&mut jpeg, ring::QUALITY)
                .encode(&rgb, w, h, image::ExtendedColorType::Rgb8)
                .ok()?;
        }
        // RGB comparison/JPEG encoding never hold the lifecycle lock. Recheck
        // both the immutable lease and predecessor before publishing a callback.
        let mut state = self.state.lock().unwrap();
        let predecessor = match (&state.previous, &previous) {
            (None, None) => true,
            (Some((_, a)), Some((_, b))) => Arc::ptr_eq(a, b),
            _ => false,
        };
        if !self.current(&state, lease) || !predecessor {
            return None;
        }
        state.previous = Some((size, bgra.clone()));
        if dirty.is_empty() {
            return None;
        }
        let stamp = self.bridge.stamp_in(lease.epoch)?;
        let frame_ref = stamp.frame_ref();
        self.ring.push(ring::Frame {
            frame_ref: frame_ref.clone(),
            epoch: stamp.epoch,
            seq: stamp.seq,
            at: bridge::now_ms(),
            w,
            h,
            geometry,
            jpeg: jpeg.into(),
            pixels: Some(bgra),
        });
        let ratio = dirty.iter().map(|d| d.bbox[2] * d.bbox[3]).sum::<f64>()
            / (geometry.captured[2] * geometry.captured[3]);
        self.bridge.emit_stamped(
            stamp,
            Kind::Frame {
                frame_ref: frame_ref.clone(),
                w,
                h,
                ratio: ratio.min(1.0) as f32,
                dirty,
                geometry,
            },
        );
        *self.pending.lock().unwrap() = Some((frame_ref.clone(), geometry.captured));
        self.wake.notify_one();
        Some(frame_ref)
    }
    pub async fn recognize(
        &self,
        frame_ref: &str,
        rect: Rect,
        explicit: bool,
        deadline: Option<i64>,
        request: Arc<request::Cancellation>,
    ) -> Result<Value, String> {
        let (frame, session, roi) = {
            let state = self.state.lock().unwrap();
            let frame = self
                .ring
                .latest()
                .filter(|f| f.frame_ref == frame_ref && f.epoch == self.bridge.epoch())
                .ok_or("frame-evicted")?;
            if Self::run(&state) != "running" {
                return Err("offline".into());
            }
            let full = frame.geometry.captured;
            if !valid_rect(rect) || geometry::intersect(rect, full) != Some(rect) {
                return Err("bad-rect".into());
            }
            let known: Vec<Rect> = state
                .known_ax
                .iter()
                .chain(&state.known_ocr)
                .map(|l| l.bbox)
                .collect();
            let roi = ocr::expand_roi(rect, &known, full);
            (frame, state.session.clone(), roi)
        };
        let transform = ocr::Transform::new(&frame.geometry);
        let started = bridge::now_ms();
        let raw = self
            .ocr
            .read(
                &frame,
                transform.window_to_pixels(ocr::read_roi(roi, frame.geometry.captured)),
                deadline.unwrap_or(started + 30_000),
                explicit,
                request.clone(),
                session.clone(),
            )
            .await?;
        let lines: Vec<Line> = raw
            .into_iter()
            .filter(|l| ocr::claims(l.bbox, roi))
            .collect();
        let mut state = self.state.lock().unwrap();
        if request.is_cancelled()
            || session.is_cancelled()
            || self.bridge.epoch() != frame.epoch
            || !self.ring.latest().is_some_and(|f| f.frame_ref == frame_ref)
        {
            return Err("cancelled".into());
        }
        state.known_ocr.retain(|line| !ocr::claims(line.bbox, roi));
        state.known_ocr.extend(lines.clone());
        let ms = (bridge::now_ms() - started).max(0).min(i64::from(u32::MAX)) as u32;
        let ax_covered = ocr::ax_covers(roi, &ocr::ax_coverage(&state.known_ax));
        self.bridge.emit(Kind::Ocr {
            frame_ref: frame_ref.into(),
            rect: roi,
            lines: lines.clone(),
            ms,
            ax_covered,
        });
        Ok(
            json!({"ref":frame_ref,"epoch":frame.epoch,"seq":frame.seq,"at":frame.at,"rect":roi,"lines":lines,"ms":ms,"axCovered":ax_covered}),
        )
    }
    pub fn status(&self) -> Value {
        let state = self.state.lock().unwrap();
        let stats = self.ring.stats();
        #[cfg(not(target_os = "macos"))]
        let overlay = self
            .overlay()
            .map(|o| o.status())
            .unwrap_or(json!({"shown":0,"interactive":false}));
        #[cfg(target_os = "macos")]
        let overlay = json!({"shown":0,"interactive":false});
        json!({"platform":Self::platform(),"state":Self::run(&state),"reason":state.reason,"epoch":self.bridge.epoch(),"seq":self.bridge.last_seq(),"target":state.target,
            "ring":{"n":stats.n,"bytes":stats.bytes,"oldestAt":stats.oldest_at},"covered":false,"permissions":{"screen":state.capture,"ax":state.ax},
            "capabilities":self.capabilities(&state),"visual":{"scoreId":state.score_id},"overlay":overlay,"helper":{"state":"down","outstanding":0},"filter":"window","consented":state.consented})
    }
    fn snapshot(&self) -> Value {
        let state = self.state.lock().unwrap();
        let boundary = self.bridge.boundary();
        json!({"platform":Self::platform(),"capabilities":self.capabilities(&state),"visual":{"scoreId":state.score_id},"epoch":boundary.epoch,"seq":boundary.seq,
            "app":state.target.as_ref().map(|t|json!({"bundle":t.bundle,"name":t.name,"pid":t.pid})),"window":state.target.as_ref().map(|t|json!({"id":t.window_id,"title":t.title,"bounds":t.bounds,"url":t.url,"display":t.display})),
            "axText":state.known_ax,"ocr":state.known_ocr,"focus":null,"sheet":null,"covered":null,"live":false,
            "latest":self.ring.latest().map(|f|json!({"ref":f.frame_ref,"geometry":f.geometry}))})
    }
    async fn dispatch(
        self: &Arc<Self>,
        op: &str,
        value: &Value,
        deadline: Option<i64>,
        cancellation: Arc<request::Cancellation>,
    ) -> Result<Value, String> {
        if cancellation.is_cancelled() {
            return Err("cancelled".into());
        }
        match op {
            "lens-status" => Ok(self.status()),
            "lens-snapshot" => Ok(self.snapshot()),
            "lens-start" => {
                let (generation, start) = {
                    let mut state = self.state.lock().unwrap();
                    state.control.cancel();
                    self.invalidate(&mut state);
                    self.cancel_native();
                    state.control_generation = state.generation;
                    state.control = cancellation;
                    state.consented = value["consented"] == true;
                    state.active = value["active"] != false;
                    state.paused = value["paused"] == true;
                    state.reason = Some(
                        if !state.consented {
                            "not-consented"
                        } else if state.paused {
                            "paused"
                        } else if !state.active {
                            "idle"
                        } else if !state.capture {
                            "unsupported"
                        } else {
                            "warming"
                        }
                        .into(),
                    );
                    self.announce(&state);
                    (
                        state.control_generation,
                        state.consented && state.active && !state.paused,
                    )
                };
                self.finish_control(generation, start).await?;
                Ok(self.status())
            }
            "lens-stop" => {
                self.stop(value["reason"].as_str()).await?;
                Ok(self.status())
            }
            "lens-pause" => {
                self.stop_control(Some("paused"), true).await?;
                Ok(self.status())
            }
            "lens-resume" => {
                let generation = {
                    let mut state = self.state.lock().unwrap();
                    if !state.consented {
                        return Err("not-consented".into());
                    }
                    state.control.cancel();
                    self.invalidate(&mut state);
                    self.cancel_native();
                    state.control_generation = state.generation;
                    state.control = cancellation;
                    state.paused = false;
                    state.active = true;
                    state.reason = Some("warming".into());
                    self.announce(&state);
                    state.control_generation
                };
                self.finish_control(generation, true).await?;
                Ok(Value::Bool(true))
            }
            "lens-ocr" => {
                self.recognize(
                    value["ref"].as_str().ok_or("frame-evicted")?,
                    rect(&value["rect"]).ok_or("bad-rect")?,
                    true,
                    deadline,
                    cancellation,
                )
                .await
            }
            "lens-frame" => {
                use base64::Engine as _;
                let out = self.ring.crop(
                    value["ref"].as_str().ok_or("frame-evicted")?,
                    if value["rect"].is_null() {
                        None
                    } else {
                        Some(rect(&value["rect"]).ok_or("bad-rect")?)
                    },
                    value["maxPx"]
                        .as_u64()
                        .unwrap_or(u64::from(DEFAULT_MAX_PX))
                        .clamp(1, u64::from(u32::MAX)) as u32,
                )?;
                let jpeg = base64::engine::general_purpose::STANDARD.encode(out.jpeg);
                if jpeg.len() > FRAME_CAP {
                    return Err("too-large".into());
                }
                Ok(
                    json!({"ref":out.frame.frame_ref,"epoch":out.frame.epoch,"seq":out.frame.seq,"at":out.frame.at,"w":out.w,"h":out.h,"geometry":out.frame.geometry,"jpeg":jpeg}),
                )
            }
            "overlay-clear" => {
                #[cfg(not(target_os = "macos"))]
                if let Some(overlay) = self.overlay() {
                    let id = value["id"].as_str().map(str::to_owned);
                    let lifecycle = self.lifecycle.clone().lock_owned().await;
                    tokio::task::spawn_blocking(move || {
                        let _lifecycle = lifecycle;
                        overlay.clear_checked(id.as_deref())
                    })
                    .await
                    .map_err(|_| "overlay-window-gone")??;
                }
                Ok(Value::Bool(true))
            }
            #[cfg(not(target_os = "macos"))]
            "overlay-show" => self.overlay_show(value, cancellation).await,
            #[cfg(not(target_os = "macos"))]
            "overlay-interactive" => {
                if value["on"] != true {
                    return self.disable_interaction().await;
                }
                let source = self.overlay_source(self.bridge.epoch(), cancellation)?;
                self.interactive(source, true).await
            }
            _ => Err("unavailable".into()),
        }
    }
    fn overlay_source(
        self: &Arc<Self>,
        epoch: u64,
        cancellation: Arc<request::Cancellation>,
    ) -> Result<OverlaySource, String> {
        let state = self.state.lock().unwrap();
        if !state.consented {
            return Err("not-consented".into());
        }
        if !state.overlay || Self::run(&state) != "running" {
            return Err("unavailable".into());
        }
        if cancellation.is_cancelled() || state.control.is_cancelled() {
            return Err("cancelled".into());
        }
        if epoch != self.bridge.epoch() {
            return Err("stale-epoch".into());
        }
        let target = state.target.clone().ok_or("no-target")?;
        let (geometry, size, display_bounds) = state.placement.ok_or("no-target")?;
        Ok(OverlaySource {
            lens: self.clone(),
            lease: CaptureLease {
                epoch,
                generation: state.generation,
                target,
                geometry,
                size,
                display_bounds,
            },
            session: state.session.clone(),
            cancellation,
            #[cfg(target_os = "linux")]
            native: None,
        })
    }
    #[cfg(not(target_os = "macos"))]
    async fn interactive(
        self: &Arc<Self>,
        source: OverlaySource,
        on: bool,
    ) -> Result<Value, String> {
        let overlay = self.overlay().ok_or("unavailable")?;
        source
            .interactive(move || {
                overlay.set_interactive(on)?;
                Ok(Value::Bool(true))
            })
            .await
    }
    /// Freeze before scheduling a hotkey/escape callback. It cannot act on a
    /// different source after waiting behind Stop or source replacement.
    #[cfg(not(target_os = "macos"))]
    pub(super) fn queue_interactive(self: &Arc<Self>, on: bool) {
        if !on {
            let lens = self.clone();
            tauri::async_runtime::spawn(async move {
                let _ = lens.disable_interaction().await;
            });
            return;
        }
        let Ok(source) = self.overlay_source(self.bridge.epoch(), request::Cancellation::new())
        else {
            return;
        };
        let lens = self.clone();
        tauri::async_runtime::spawn(async move {
            let _ = lens.interactive(source, on).await;
        });
    }
    #[cfg(not(target_os = "macos"))]
    async fn disable_interaction(self: &Arc<Self>) -> Result<Value, String> {
        let overlay = self.overlay().ok_or("unavailable")?;
        self.interaction_off(move || {
            overlay.set_interactive(false)?;
            Ok(Value::Bool(true))
        })
        .await
    }
    /// Turning off the pool's owned interaction needs no live capture grant.
    /// It still serializes with enable and teardown, including dropped waiters.
    async fn interaction_off<T: Send + 'static>(
        self: &Arc<Self>,
        mutation: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let lifecycle = self.lifecycle.clone().lock_owned().await;
        tokio::task::spawn_blocking(move || {
            let _lifecycle = lifecycle;
            mutation()
        })
        .await
        .map_err(|_| "overlay-window-gone".to_owned())?
    }
    #[cfg(not(target_os = "macos"))]
    async fn overlay_show(
        self: &Arc<Self>,
        value: &Value,
        cancellation: Arc<request::Cancellation>,
    ) -> Result<Value, String> {
        let overlay = self.overlay().ok_or("unavailable")?;
        let req = overlay::ShowReq::parse(value)?;
        let source = self.overlay_source(req.epoch, cancellation)?;
        if let overlay::Anchor::Rect { frame_ref, rect } = &req.anchor {
            let frame = self.ring.get(frame_ref).ok_or("frame-evicted")?;
            if frame.epoch != source.lease.epoch || frame.geometry != source.lease.geometry {
                return Err("stale-epoch".into());
            }
            if geometry::intersect(*rect, frame.geometry.captured) != Some(*rect) {
                return Err("bad-rect".into());
            }
        }
        let place = overlay::Place {
            window: source.lease.geometry.window,
            display: source.lease.display_bounds,
        };
        overlay::native_frame(&req, place).map_err(overlay::Failure::reason)?;
        #[cfg(target_os = "linux")]
        let source = {
            let overlay = self.native_overlay().ok_or("unavailable")?;
            let mut source = source;
            let generation = source.lease.generation;
            let epoch = source.lease.epoch;
            let cancellation = source.cancellation.clone();
            let prepared = tokio::task::spawn_blocking(move || {
                overlay.prepare(generation, epoch, cancellation)
            })
            .await
            .unwrap_or_else(|_| Err("unavailable".into()));
            source.native = Some(match prepared {
                Ok(native) => native,
                Err(reason) => {
                    let failed: Result<(), overlay::Failure> =
                        source.publish(|| Err(overlay::Failure::Native(reason)));
                    source.failed(&failed);
                    return Err(failed.unwrap_err().reason());
                }
            });
            source
        };
        tokio::task::spawn_blocking(move || overlay.show(req, place, source))
            .await
            .map_err(|_| "overlay-window-gone")?
    }
}

#[derive(Clone)]
struct OverlaySource {
    lens: Arc<Lens>,
    lease: CaptureLease,
    session: Arc<request::Cancellation>,
    cancellation: Arc<request::Cancellation>,
    #[cfg(target_os = "linux")]
    native: Option<Arc<linux_overlay::Token>>,
}
impl OverlaySource {
    /// Freeze under State, then recheck while doing the actual UI mutation.
    /// No State/native lock crosses main-thread dispatch or an async wait.
    fn publish<T>(
        &self,
        publish: impl FnOnce() -> Result<T, overlay::Failure>,
    ) -> Result<T, overlay::Failure> {
        let state = self.lens.state.lock().unwrap();
        if self.cancellation.is_cancelled()
            || self.session.is_cancelled()
            || state.control.is_cancelled()
        {
            return Err("cancelled".into());
        }
        if !state.consented {
            return Err("not-consented".into());
        }
        if !state.overlay
            || !self.lens.current(&state, &self.lease)
            || state.placement
                != Some((
                    self.lease.geometry,
                    self.lease.size,
                    self.lease.display_bounds,
                ))
            || !Arc::ptr_eq(&self.session, &state.session)
        {
            return Err("stale-epoch".into());
        }
        let result = publish();
        if self.cancellation.is_cancelled()
            || self.session.is_cancelled()
            || state.control.is_cancelled()
        {
            return Err("cancelled".into());
        }
        result
    }
    fn failed<T>(&self, result: &Result<T, overlay::Failure>) -> bool {
        matches!(result, Err(overlay::Failure::Native(_)))
            && !self.cancellation.is_cancelled()
            && !self.session.is_cancelled()
            && self
                .lens
                .revoke_overlay(self.lease.generation, Some(&self.cancellation))
    }
    async fn interactive<T: Send + 'static>(
        self,
        mutation: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let lifecycle = tokio::select! { biased;
            _ = self.cancellation.cancelled() => return Err("cancelled".into()),
            _ = self.session.cancelled() => return Err("cancelled".into()),
            lifecycle = self.lens.lifecycle.clone().lock_owned() => lifecycle,
        };
        tokio::task::spawn_blocking(move || {
            // The blocking mutation owns the gate even if its async waiter is
            // dropped. Stop cannot acknowledge ahead of a late Escape binding.
            let _lifecycle = lifecycle;
            self.publish(|| Ok(())).map_err(overlay::Failure::reason)?;
            let result = mutation();
            self.publish(|| Ok(())).map_err(overlay::Failure::reason)?;
            result
        })
        .await
        .map_err(|_| "overlay-window-gone".to_owned())?
    }
    #[cfg(target_os = "linux")]
    fn place(
        &self,
        window: &tauri::WebviewWindow,
        rect: Rect,
    ) -> Result<linux_overlay::Placement, overlay::Failure> {
        overlay::validate_native_frame(rect)?;
        self.lens
            .native_overlay()
            .ok_or_else(|| overlay::Failure::Native("unavailable".into()))?
            .place(window, rect, self.native.as_ref().ok_or("unavailable")?)
            .map_err(overlay::Failure::Native)
    }
    #[cfg(target_os = "windows")]
    fn place(&self, window: &tauri::WebviewWindow, rect: Rect) -> Result<Rect, overlay::Failure> {
        overlay::validate_native_frame(rect)?;
        // shortcut: no native overlay grant without capture-time geometry proof.
        window
            .hide()
            .map_err(|_| overlay::Failure::Native("overlay-window-gone".into()))?;
        windows::place_overlay(
            ::windows::Win32::Foundation::HWND(
                window
                    .hwnd()
                    .map_err(|_| overlay::Failure::Native("overlay-window-gone".into()))?
                    .0,
            ),
            rect,
        )
        .map_err(overlay::Failure::Native)?;
        Ok(rect)
    }
    #[cfg(target_os = "linux")]
    fn reveal(
        &self,
        window: &tauri::WebviewWindow,
        proof: &linux_overlay::Placement,
    ) -> Result<(), String> {
        self.lens
            .native_overlay()
            .ok_or("unavailable")?
            .reveal(window, proof)
    }
    #[cfg(target_os = "windows")]
    fn reveal(&self, window: &tauri::WebviewWindow, proof: &Rect) -> Result<(), String> {
        let hwnd =
            ::windows::Win32::Foundation::HWND(window.hwnd().map_err(|_| "overlay-window-gone")?.0);
        windows::place_overlay(hwnd, *proof)?;
        windows::show_overlay(hwnd)
    }
}

pub async fn desktop_request_cancel(
    app: &tauri::AppHandle,
    op: &str,
    value: &Value,
    deadline: Option<i64>,
    cancellation: Arc<request::Cancellation>,
) -> Result<Value, String> {
    use tauri::Manager;
    let lens = app
        .try_state::<Arc<Lens>>()
        .map(|l| Arc::clone(&l))
        .ok_or("unavailable")?;
    if cancellation.is_cancelled() {
        return Err("cancelled".into());
    }
    lens.dispatch(op, value, deadline, cancellation).await
}
#[cfg(not(target_os = "macos"))]
pub(super) fn hide_overlay(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    use tauri::Manager;
    let lens = app.try_state::<Arc<Lens>>().ok_or("unavailable")?;
    #[cfg(target_os = "linux")]
    return lens.native_overlay().ok_or("unavailable")?.hide(window);
    #[cfg(target_os = "windows")]
    {
        let _ = lens;
        windows::hide_overlay(::windows::Win32::Foundation::HWND(
            window.hwnd().map_err(|_| "overlay-window-gone")?.0,
        ))?;
        window.hide().map_err(|_| "overlay-window-gone".into())
    }
}
fn rect(value: &Value) -> Option<Rect> {
    let a = value.as_array()?;
    if a.len() != 4 {
        return None;
    }
    let r = [
        a[0].as_f64()?,
        a[1].as_f64()?,
        a[2].as_f64()?,
        a[3].as_f64()?,
    ];
    valid_rect(r).then_some(r)
}
fn valid_rect(r: Rect) -> bool {
    r.iter().all(|n| n.is_finite()) && r[2] > 0.0 && r[3] > 0.0
}
fn geometry_valid(g: FrameGeometry, [w, h]: [u32; 2]) -> bool {
    valid_rect(g.window)
        && valid_rect(g.captured)
        && valid_rect(g.content_rect)
        && g.scale.is_finite()
        && g.scale > 0.0
        && g.content_scale.is_finite()
        && g.content_scale > 0.0
        && g.content_rect[0] >= 0.0
        && g.content_rect[1] >= 0.0
        && g.content_rect[0] + g.content_rect[2] <= f64::from(w)
        && g.content_rect[1] + g.content_rect[3] <= f64::from(h)
        && ((g.content_rect[2] / g.captured[2]) - (g.content_rect[3] / g.captured[3])).abs()
            < 0.0001
}

/// RGB max-channel delta >= 16/255, in 32x32 tiles. Scores are changed-pixel
/// fractions. Merge adjacent tiles into connected regions, then use bounded
/// minimum-waste unions; every merged score keeps its maximum constituent.
fn score(
    previous: Option<&([u32; 2], Arc<[u8]>)>,
    bgra: &[u8],
    [w, h]: [u32; 2],
    geometry: &FrameGeometry,
) -> Vec<bridge::Dirty> {
    let transform = geometry::Transform::new(geometry);
    let Some((size, old)) =
        previous.filter(|(size, old)| *size == [w, h] && old.len() == bgra.len())
    else {
        return vec![bridge::Dirty {
            bbox: geometry.captured,
            d: 1.0,
        }];
    };
    let _ = size;
    let cols = w.div_ceil(32) as usize;
    let rows = h.div_ceil(32) as usize;
    let mut tiles = vec![0.0f32; cols * rows];
    for ty in 0..rows {
        for tx in 0..cols {
            let mut n = 0;
            let mut total = 0;
            for y in ty * 32..((ty + 1) * 32).min(h as usize) {
                for x in tx * 32..((tx + 1) * 32).min(w as usize) {
                    let i = (y * w as usize + x) * 4;
                    total += 1;
                    if (0..3).any(|c| bgra[i + c].abs_diff(old[i + c]) >= 16) {
                        n += 1;
                    }
                }
            }
            tiles[ty * cols + tx] = n as f32 / total as f32;
        }
    }
    let mut regions: Vec<bridge::Dirty> = vec![];
    for index in 0..tiles.len() {
        if tiles[index] == 0.0 {
            continue;
        }
        let mut queue = vec![index];
        let mut cursor = 0;
        let mut d = 0.0f32;
        let (mut left, mut top, mut right, mut bottom) = (cols, rows, 0, 0);
        while cursor < queue.len() {
            let i = queue[cursor];
            cursor += 1;
            if tiles[i] == 0.0 {
                continue;
            }
            d = d.max(tiles[i]);
            tiles[i] = 0.0;
            let (x, y) = (i % cols, i / cols);
            left = left.min(x);
            top = top.min(y);
            right = right.max(x + 1);
            bottom = bottom.max(y + 1);
            for dy in -1isize..=1 {
                for dx in -1isize..=1 {
                    let (nx, ny) = (x as isize + dx, y as isize + dy);
                    if nx >= 0
                        && ny >= 0
                        && (nx as usize) < cols
                        && (ny as usize) < rows
                        && tiles[ny as usize * cols + nx as usize] > 0.0
                    {
                        queue.push(ny as usize * cols + nx as usize);
                    }
                }
            }
        }
        regions.push(bridge::Dirty {
            bbox: [
                (left * 32) as f64,
                (top * 32) as f64,
                ((right * 32).min(w as usize) - left * 32) as f64,
                ((bottom * 32).min(h as usize) - top * 32) as f64,
            ],
            d,
        });
        // shortcut: fold at nine regions, keeping merge work bounded even for
        // checkerboard changes on a maximum-size frame.
        if regions.len() > geometry::MAX_DIRTY {
            merge_scores(&mut regions);
        }
    }
    for region in &mut regions {
        region.bbox = transform.pixels_to_window(region.bbox);
    }
    regions
        .into_iter()
        .filter_map(|mut region| {
            region.bbox = geometry::intersect(region.bbox, geometry.captured)?;
            Some(region)
        })
        .collect()
}
fn merge_scores(regions: &mut Vec<bridge::Dirty>) {
    let rects: Vec<Rect> = regions.iter().map(|region| region.bbox).collect();
    let (i, j) = geometry::cheapest_pair(&rects);
    regions[i].bbox = geometry::union(regions[i].bbox, regions[j].bbox);
    regions[i].d = regions[i].d.max(regions[j].d);
    regions.remove(j);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn selected_backend_freezes_scoring_and_wayland_never_grants_ax_or_native_overlays() {
        assert_eq!(CaptureBackend::linux(false), CaptureBackend::X11);
        assert_eq!(CaptureBackend::linux(true), CaptureBackend::Wayland);
        assert!(CaptureBackend::X11.native_overlays());
        assert!(CaptureBackend::Windows.native_overlays());
        assert!(!CaptureBackend::Wayland.native_overlays());
        let (tx, _) = mpsc::unbounded_channel();
        let lens = Lens::new_for_backend(
            tx,
            ocr::Ocr::new(Path::new("/missing-rimeward-ocr")),
            CaptureBackend::Wayland,
        );
        let pipe = CaptureBackend::Wayland.score_id();
        assert_eq!(lens.status()["visual"]["scoreId"], pipe);
        assert_eq!(lens.status()["capabilities"]["capture"], false);
        assert_eq!(lens.status()["capabilities"]["ax"], false);
        assert_eq!(lens.status()["capabilities"]["overlay"], false);
        lens.dispatch(
            "lens-start",
            &json!({"consented":true,"active":true}),
            None,
            request::Cancellation::new(),
        )
        .await
        .unwrap();
        let generation = lens.request_generation();
        assert_eq!(
            lens.backend_status(
                generation,
                true,
                false,
                CaptureBackend::X11.score_id(),
                None
            )
            .await,
            Err("unavailable".into())
        );
        assert_eq!(
            lens.backend_status(generation, true, true, pipe, None)
                .await,
            Err("unavailable".into())
        );
        assert_eq!(lens.request_generation(), generation);
        let grant = lens
            .backend_status(
                generation,
                true,
                false,
                pipe,
                Some("wayland-selected-window-frame-local-application-unknown-ocr-only"),
            )
            .await
            .unwrap();
        #[cfg(target_os = "linux")]
        assert!(!lens.set_overlay_available(grant, true));
        #[cfg(not(target_os = "linux"))]
        let _ = grant;
        assert_eq!(lens.status()["visual"]["scoreId"], pipe);
        assert_eq!(lens.status()["capabilities"]["ax"], false);
        assert_eq!(lens.status()["capabilities"]["overlay"], false);
        lens.stop(Some("idle")).await.unwrap();
        assert_eq!(lens.status()["visual"]["scoreId"], pipe);
        assert_eq!(
            lens.capture_backend,
            CaptureBackend::Wayland,
            "refusal/Stop cannot select X11"
        );
    }

    #[tokio::test]
    async fn wayland_zero_reader_control_invalidates_before_cleanup_and_rejects_old_frames() {
        let (tx, _) = mpsc::unbounded_channel();
        let lens = Lens::new_for_backend(
            tx,
            ocr::Ocr::new(Path::new("/missing-rimeward-ocr")),
            CaptureBackend::Wayland,
        );
        let control = request::Cancellation::new();
        lens.dispatch(
            "lens-start",
            &json!({"consented":true,"active":true}),
            None,
            control.clone(),
        )
        .await
        .unwrap();
        let grant = lens
            .backend_status(
                lens.request_generation(),
                true,
                false,
                CaptureBackend::Wayland.score_id(),
                None,
            )
            .await
            .unwrap();
        let geometry = FrameGeometry {
            window: [0.0, 0.0, 2.0, 2.0],
            scale: 1.0,
            content_rect: [0.0, 0.0, 2.0, 2.0],
            content_scale: 1.0,
            captured: [0.0, 0.0, 2.0, 2.0],
        };
        let lease = lens
            .accept_target(
                grant,
                Target {
                    pid: 0,
                    bundle: String::new(),
                    name: "Unknown application".into(),
                    window_id: 1,
                    title: "Selected Wayland window (frame-local pixels)".into(),
                    bounds: geometry.window,
                    url: None,
                    display: DisplayInfo {
                        id: 1,
                        w: 2.0,
                        h: 2.0,
                        scale: 1.0,
                    },
                },
                geometry,
                [2, 2],
                geometry.window,
            )
            .unwrap();
        let pixels: Arc<[u8]> = vec![0; 16].into();
        assert!(lens
            .publish_frame(&lease, pixels.clone(), [2, 2], geometry)
            .is_some());
        let session = lens.request_session().unwrap();
        let gate = lens.lifecycle.lock().await;
        // The real Node syncCapture zero-reader value, while cleanup is queued.
        let no_readers = json!({"consented":true,"active":false});
        let idle = lens.dispatch(
            "lens-start",
            &no_readers,
            None,
            request::Cancellation::new(),
        );
        tokio::pin!(idle);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), &mut idle)
                .await
                .is_err()
        );
        assert!(control.is_cancelled() && session.is_cancelled());
        assert!(lens.ring.latest().is_none());
        assert!(lens.pending.lock().unwrap().is_none());
        assert!(!lens.state.lock().unwrap().active);
        assert!(lens
            .publish_frame(&lease, pixels, [2, 2], geometry)
            .is_none());
        assert!(!lens.publish_ax(&lease, vec![]));
        drop(gate);
        let stopped = idle.await.unwrap();
        assert_eq!(stopped["state"], "stopped");
        assert_eq!(
            stopped["visual"]["scoreId"],
            CaptureBackend::Wayland.score_id()
        );
        assert_eq!(stopped["capabilities"]["overlay"], false);
    }

    async fn overlay_fixture() -> (Arc<Lens>, OverlaySource) {
        let (tx, _) = mpsc::unbounded_channel();
        let lens = Lens::init(tx, Path::new("/missing-rimeward-ocr"));
        lens.dispatch(
            "lens-start",
            &json!({"consented":true}),
            None,
            request::Cancellation::new(),
        )
        .await
        .unwrap();
        let geometry = FrameGeometry {
            window: [5.0, 5.0, 8.0, 8.0],
            scale: 1.0,
            content_rect: [0.0, 0.0, 8.0, 8.0],
            content_scale: 1.0,
            captured: [0.0, 0.0, 8.0, 8.0],
        };
        let grant = lens
            .backend_status(
                lens.request_generation(),
                true,
                false,
                Lens::score_id(),
                None,
            )
            .await
            .unwrap();
        let lease = lens
            .accept_target(
                grant,
                Target {
                    pid: 42,
                    bundle: "disposable.test".into(),
                    name: "Disposable".into(),
                    window_id: 1,
                    title: "Fixture".into(),
                    bounds: geometry.window,
                    url: None,
                    display: DisplayInfo {
                        id: 1,
                        w: 100.0,
                        h: 100.0,
                        scale: 1.0,
                    },
                },
                geometry,
                [8, 8],
                [0.0, 0.0, 100.0, 100.0],
            )
            .unwrap();
        // Only native hidden-pool proof is stood in; guards and slot state below
        // are the actual shared production types and transitions, without GUI.
        lens.state.lock().unwrap().overlay = true;
        let source = lens
            .overlay_source(lease.epoch, request::Cancellation::new())
            .unwrap();
        (lens, source)
    }

    #[tokio::test]
    async fn cancelled_overlay_request_preserves_replacement_slot_and_native_failure_revokes() {
        let (lens, b) = overlay_fixture().await;
        let cancel = request::Cancellation::new();
        let a = lens.overlay_source(b.lease.epoch, cancel.clone()).unwrap();
        a.publish(|| Ok(())).unwrap(); // A is admitted before queueing, then stalls.
        cancel.cancel();
        let mut slots = vec![];
        b.publish(|| {
            slots.push(overlay::Slot::live_for_test(
                "caption-b",
                2,
                b.lease.generation,
            ));
            Ok(())
        })
        .unwrap();
        let refused = a.publish(|| {
            slots[0] = overlay::Slot::live_for_test("caption-a", 1, a.lease.generation);
            Err::<(), _>(overlay::Failure::Native(
                "native operation must not run".into(),
            ))
        });
        assert_eq!(refused, Err("cancelled".into()));
        assert!(!a.failed(&refused));
        assert_eq!(lens.status()["capabilities"]["overlay"], true);
        assert!(slots[0].can_reveal("caption-b", 2, std::time::Instant::now()));

        // Cancellation during an admitted native call also remains a refusal.
        let during = lens
            .overlay_source(b.lease.epoch, request::Cancellation::new())
            .unwrap();
        let refused = during.publish(|| {
            during.cancellation.cancel();
            Err::<(), _>(overlay::Failure::Native("cancelled".into()))
        });
        assert_eq!(refused, Err("cancelled".into()));
        assert!(!during.failed(&refused));
        assert_eq!(lens.status()["capabilities"]["overlay"], true);
        assert!(slots[0].can_reveal("caption-b", 2, std::time::Instant::now()));
        let obsolete =
            b.publish(|| Err::<(), _>(overlay::Failure::Refused("obsolete-slot".into())));
        assert!(!b.failed(&obsolete));

        let native = b.publish(|| {
            Err::<(), _>(overlay::Failure::Native(
                "overlay-position-exclusion-unproved".into(),
            ))
        });
        assert!(b.failed(&native));
        assert_eq!(
            native.unwrap_err().reason(),
            "overlay-position-exclusion-unproved"
        );
        assert_eq!(lens.status()["capabilities"]["overlay"], false);
        // The real pool's retirement helper then hides the source's own slots.
        assert_eq!(
            overlay::revoke_source_slots(&mut slots, b.lease.generation),
            vec!["ov-0"]
        );
        assert!(!slots[0].can_reveal("caption-b", 2, std::time::Instant::now()));
    }

    #[tokio::test]
    async fn measured_caption_uses_integral_outer_pixels_and_bad_input_preserves_existing_slots() {
        let (lens, source) = overlay_fixture().await;
        let req = overlay::ShowReq::parse(&json!({
            "id":"hello", "kind":"caption", "text":"hello",
            "anchor":{"corner":"tl"}, "epoch":source.lease.epoch
        }))
        .unwrap();
        let frame = overlay::native_frame(
            &req,
            overlay::Place {
                window: source.lease.geometry.window,
                display: source.lease.display_bounds,
            },
        )
        .unwrap();
        assert_eq!(frame, [21.0, 21.0, 49.0, 34.0]);
        #[cfg(target_os = "linux")]
        assert_eq!(linux_overlay::physical(frame).unwrap(), [21, 21, 49, 34]);
        let slot = overlay::Slot::live_for_test("prior", 1, source.lease.generation);
        let refused =
            source.publish(|| overlay::validate_native_frame([4_000_000_000.0, 0.0, 49.0, 34.0]));
        assert_eq!(refused, Err(overlay::Failure::Refused("bad-rect".into())));
        assert!(!source.failed(&refused));
        #[cfg(target_os = "linux")]
        {
            // The existing native X11 boundary, before any slot/native mutation.
            let refused =
                source.publish(|| overlay::validate_native_frame([32768.0, 0.0, 49.0, 34.0]));
            assert_eq!(refused, Err(overlay::Failure::Refused("bad-rect".into())));
            assert!(!source.failed(&refused));
        }
        assert_eq!(lens.status()["capabilities"]["overlay"], true);
        assert!(slot.can_reveal("prior", 1, std::time::Instant::now()));
        let failed: Result<(), _> = source.publish(|| {
            Err(overlay::Failure::Native(
                "overlay-position-exclusion-unproved".into(),
            ))
        });
        assert!(source.failed(&failed));
        assert_eq!(lens.status()["capabilities"]["overlay"], false);
    }

    #[tokio::test]
    async fn interaction_off_survives_native_revocation_source_close_and_consent_withdrawal() {
        for loss in ["native-proof", "source-closed", "withdrawn"] {
            let (lens, source) = overlay_fixture().await;
            let effects = Arc::new(Mutex::new((false, false)));
            let effect = effects.clone();
            source
                .clone()
                .interactive(move || {
                    *effect.lock().unwrap() = (true, true);
                    Ok(())
                })
                .await
                .unwrap();
            match loss {
                "native-proof" => {
                    let failed: Result<(), _> = source
                        .publish(|| Err(overlay::Failure::Native("overlay-exclusion".into())));
                    assert!(source.failed(&failed));
                }
                "source-closed" => {
                    lens.invalidate_source(source.lease.generation, loss)
                        .unwrap();
                }
                _ => {
                    lens.dispatch(
                        "lens-start",
                        &json!({"consented":false}),
                        None,
                        request::Cancellation::new(),
                    )
                    .await
                    .unwrap();
                }
            }
            assert!(lens
                .overlay_source(lens.bridge.epoch(), request::Cancellation::new())
                .is_err());
            // A failed native off is returned and can be retried without a grant.
            assert_eq!(
                lens.interaction_off(|| Err::<(), _>("overlay-interactive".into()))
                    .await,
                Err("overlay-interactive".into())
            );
            assert_eq!(*effects.lock().unwrap(), (true, true));
            let effect = effects.clone();
            lens.interaction_off(move || {
                *effect.lock().unwrap() = (false, false);
                Ok(())
            })
            .await
            .unwrap();
            assert_eq!(*effects.lock().unwrap(), (false, false), "{loss}");
            assert_eq!(lens.status()["capabilities"]["overlay"], false);
        }
    }

    #[tokio::test]
    async fn interactive_callbacks_recheck_the_frozen_source_after_stop_and_hold_the_teardown_gate()
    {
        let (lens, delayed) = overlay_fixture().await;
        delayed.publish(|| Ok(())).unwrap(); // Previous callback's early check.
        let effects = Arc::new(Mutex::new((false, false))); // Native cursor/Escape effects.
        lens.stop(Some("idle")).await.unwrap();
        let effect = effects.clone();
        assert_eq!(
            delayed
                .interactive(move || {
                    *effect.lock().unwrap() = (true, true);
                    Ok(())
                })
                .await,
            Err("cancelled".into())
        );
        assert_eq!(*effects.lock().unwrap(), (false, false));

        let (lens, current) = overlay_fixture().await;
        let (entered, entry) = tokio::sync::oneshot::channel();
        let (release, waiting) = std::sync::mpsc::sync_channel(1);
        let mut mutation = tokio::spawn(current.interactive(move || {
            let _ = entered.send(());
            waiting.recv().unwrap();
            Ok(())
        }));
        entry.await.unwrap();
        mutation.abort(); // The async requester disappears during a native call.
        let stop = lens.stop(Some("idle"));
        tokio::pin!(stop);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), &mut stop)
                .await
                .is_err(),
            "Stop cannot acknowledge while the blocking mutation owns the gate"
        );
        release.send(()).unwrap();
        stop.await.unwrap();
        let _ = (&mut mutation).await;
        assert_eq!(lens.status()["state"], "stopped");
    }
    #[tokio::test]
    async fn cleanup_failure_revokes_only_the_current_controls_proved_capabilities() {
        let (tx, _) = mpsc::unbounded_channel();
        let lens = Lens::init(tx, Path::new("/missing-rimeward-ocr"));
        let start = json!({"consented":true,"active":true});
        lens.dispatch("lens-start", &start, None, request::Cancellation::new())
            .await
            .unwrap();
        let old_control = lens.state.lock().unwrap().control_generation;
        lens.dispatch("lens-start", &start, None, request::Cancellation::new())
            .await
            .unwrap();
        let current_control = lens.state.lock().unwrap().control_generation;
        lens.backend_status(
            lens.request_generation(),
            true,
            true,
            Lens::score_id(),
            None,
        )
        .await
        .unwrap();
        let current = lens.status();
        let generation = lens.request_generation();
        assert!(!lens.cleanup_failure(old_control, "capture-teardown:old-failure"));
        assert_eq!(lens.status(), current);
        assert_eq!(lens.request_generation(), generation);
        assert!(lens.cleanup_failure(current_control, "capture-teardown:worker-panic"));
        let failed = lens.status();
        assert_eq!(failed["capabilities"]["capture"], false);
        assert_eq!(failed["capabilities"]["ax"], false);
        assert_eq!(failed["state"], "stopped");
        assert_eq!(failed["reason"], "capture-teardown:worker-panic");
        assert_eq!(failed["consented"], true);
        assert!(
            lens.state.lock().unwrap().active,
            "current demand is preserved"
        );
        assert_eq!(lens.request_generation(), generation);
    }
    #[test]
    fn rgb_threshold_ignores_alpha_and_resets_dimensions() {
        let g = FrameGeometry {
            window: [0.0, 0.0, 64.0, 32.0],
            scale: 1.0,
            content_rect: [0.0, 0.0, 64.0, 32.0],
            content_scale: 1.0,
            captured: [0.0, 0.0, 64.0, 32.0],
        };
        let old: Arc<[u8]> = vec![0; 64 * 32 * 4].into();
        let mut new = old.to_vec();
        new[3] = 255;
        new[0] = 15;
        assert!(score(Some(&([64, 32], old.clone())), &new, [64, 32], &g).is_empty());
        new[0] = 16;
        let result = score(Some(&([64, 32], old)), &new, [64, 32], &g);
        assert_eq!(result[0].bbox, [0.0, 0.0, 32.0, 32.0]);
        assert_eq!(result[0].d, 1.0 / 1024.0);
        assert_eq!(score(None, &new, [64, 32], &g)[0].d, 1.0);
    }
    #[tokio::test]
    async fn source_leases_die_on_stop_and_portable_caps_are_truthful() {
        let (tx, _) = mpsc::unbounded_channel();
        let lens = Lens::init(tx, Path::new("/missing-rimeward-ocr"));
        let result = lens
            .dispatch(
                "lens-start",
                &json!({"consented":true}),
                None,
                request::Cancellation::new(),
            )
            .await
            .unwrap();
        assert_eq!(result["capabilities"]["capture"], false);
        assert_eq!(result["capabilities"]["ocr"], false);
        assert_eq!(result["state"], "stopped");
        assert_eq!(result["reason"], "unsupported");
        let generation = lens
            .backend_status(
                lens.request_generation(),
                true,
                true,
                Lens::score_id(),
                None,
            )
            .await
            .unwrap();
        let geometry = FrameGeometry {
            window: [100.0, 100.0, 32.0, 32.0],
            scale: 1.0,
            content_rect: [0.0, 0.0, 32.0, 32.0],
            content_scale: 1.0,
            captured: [0.0, 0.0, 32.0, 32.0],
        };
        let target = Target {
            pid: 42,
            bundle: "disposable.test".into(),
            name: "Disposable".into(),
            window_id: 1,
            title: "Test".into(),
            bounds: geometry.window,
            url: None,
            display: DisplayInfo {
                id: 1,
                w: 1920.0,
                h: 1080.0,
                scale: 1.0,
            },
        };
        let lease = lens
            .accept_target(
                generation,
                target,
                geometry,
                [32, 32],
                [0.0, 0.0, 1920.0, 1080.0],
            )
            .unwrap();
        let pixels: Arc<[u8]> = vec![0; 32 * 32 * 4].into();
        assert!(lens
            .publish_frame(&lease, pixels.clone(), [32, 32], geometry)
            .is_some());
        let mut shifted = geometry;
        shifted.window[0] += 1.0;
        assert!(lens
            .publish_frame(&lease, pixels.clone(), [32, 32], shifted)
            .is_none());
        let session = lens.request_session().unwrap();
        let generation = lens.request_generation();
        lens.stop(Some("idle")).await.unwrap();
        assert!(lens.request_generation() > generation);
        assert!(lens.ring.latest().is_none());
        assert!(session.is_cancelled());
        assert!(lens
            .publish_frame(&lease, pixels, [32, 32], geometry)
            .is_none());
        assert!(!lens.publish_ax(&lease, vec![]));
    }

    #[tokio::test]
    async fn delayed_backend_mutations_cannot_adopt_or_invalidate_a_restarted_source() {
        let (tx, _) = mpsc::unbounded_channel();
        let lens = Lens::init(tx, Path::new("/missing-rimeward-ocr"));
        let start = json!({"consented":true});
        lens.dispatch("lens-start", &start, None, request::Cancellation::new())
            .await
            .unwrap();
        let delayed = lens.request_generation();
        lens.stop(Some("idle")).await.unwrap();
        lens.dispatch("lens-start", &start, None, request::Cancellation::new())
            .await
            .unwrap();
        let granted = lens
            .backend_status(
                lens.request_generation(),
                true,
                true,
                Lens::score_id(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(granted, lens.request_generation());
        let geometry = FrameGeometry {
            window: [0.0, 0.0, 1.0, 1.0],
            scale: 1.0,
            content_rect: [0.0, 0.0, 1.0, 1.0],
            content_scale: 1.0,
            captured: [0.0, 0.0, 1.0, 1.0],
        };
        let target = Target {
            pid: 42,
            bundle: "disposable.test".into(),
            name: "Disposable".into(),
            window_id: 1,
            title: "Current".into(),
            bounds: geometry.window,
            url: None,
            display: DisplayInfo {
                id: 1,
                w: 100.0,
                h: 100.0,
                scale: 1.0,
            },
        };
        let lease = lens
            .accept_target(
                granted,
                target.clone(),
                geometry,
                [1, 1],
                [0.0, 0.0, 100.0, 100.0],
            )
            .unwrap();
        assert_eq!(lease.generation, lens.request_generation());
        let current = lens.status();
        let session = lens.request_session().unwrap();

        // A provider checked this generation before Stop and completed later.
        assert_eq!(
            lens.backend_status(
                delayed,
                false,
                false,
                Lens::score_id(),
                Some("old-provider")
            )
            .await,
            Err("cancelled".into())
        );
        assert!(lens
            .accept_target(delayed, target, geometry, [1, 1], [0.0, 0.0, 100.0, 100.0])
            .is_none());
        assert!(lens.invalidate_source(delayed, "old-close").is_none());
        // Target acceptance also superseded the earlier grant's callback owner.
        assert!(lens.invalidate_source(granted, "old-geometry").is_none());
        assert_eq!(lens.status(), current, "no stale state, epoch or signals");
        assert!(!session.is_cancelled());
        assert!(lens.publish_ax(&lease, vec![]));

        let invalidated = lens
            .invalidate_source(lease.generation, "current-close")
            .unwrap();
        assert_eq!(invalidated, lens.request_generation());
        assert!(session.is_cancelled());
        assert_eq!(lens.status()["capabilities"]["capture"], false);
        let current = lens.status();
        assert!(lens
            .invalidate_source(lease.generation, "duplicate-close")
            .is_none());
        assert_eq!(lens.status(), current);
    }

    #[tokio::test]
    async fn queued_controls_do_not_teardown_a_replacement_start() {
        let (tx, _) = mpsc::unbounded_channel();
        let lens = Lens::init(tx, Path::new("/missing-rimeward-ocr"));
        assert_eq!(lens.status()["consented"], false);
        assert_eq!(lens.status()["state"], "stopped");
        let gate = lens.lifecycle.lock().await;
        let start = json!({"consented":true,"active":true});
        let old = lens.dispatch("lens-start", &start, None, request::Cancellation::new());
        tokio::pin!(old);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(5), &mut old)
                .await
                .is_err()
        );
        let old_generation = lens.request_generation();
        let stopped = lens.stop(Some("idle"));
        tokio::pin!(stopped);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(5), &mut stopped)
                .await
                .is_err()
        );
        assert!(lens.request_generation() > old_generation);
        let replacement = lens.dispatch("lens-start", &start, None, request::Cancellation::new());
        tokio::pin!(replacement);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(5), &mut replacement)
                .await
                .is_err()
        );
        let current = lens.status();
        drop(gate);
        assert_eq!(old.await, Err("cancelled".into()));
        assert_eq!(stopped.await, Err("cancelled".into()));
        assert_eq!(replacement.await.unwrap(), current);
        assert_eq!(lens.status(), current);
        let cancelled = request::Cancellation::new();
        cancelled.cancel();
        assert_eq!(
            lens.dispatch("lens-start", &start, None, cancelled).await,
            Err("cancelled".into())
        );
        assert_eq!(
            lens.status(),
            current,
            "cancelled admission never mutated the source"
        );
    }

    #[tokio::test]
    async fn portable_overlay_mutations_use_frozen_source_and_cancel_before_clear() {
        let (tx, _) = mpsc::unbounded_channel();
        let lens = Lens::init(tx, Path::new("/missing-rimeward-ocr"));
        let start = json!({"consented":true,"active":true});
        lens.dispatch("lens-start", &start, None, request::Cancellation::new())
            .await
            .unwrap();
        let geometry = FrameGeometry {
            window: [-1200.0, 50.0, 100.0, 100.0],
            scale: 1.0,
            content_rect: [0.0, 0.0, 100.0, 100.0],
            content_scale: 1.0,
            captured: [0.0, 0.0, 100.0, 100.0],
        };
        let display = [-1920.0, 0.0, 1920.0, 1080.0];
        let target = Target {
            pid: 42,
            bundle: "disposable.test".into(),
            name: "Disposable".into(),
            window_id: 1,
            title: "Current".into(),
            bounds: geometry.window,
            url: None,
            display: DisplayInfo {
                id: 1,
                w: 1920.0,
                h: 1080.0,
                scale: 1.0,
            },
        };
        let grant = lens
            .backend_status(
                lens.request_generation(),
                true,
                false,
                Lens::score_id(),
                None,
            )
            .await
            .unwrap();
        let lease = lens
            .accept_target(grant, target.clone(), geometry, [100, 100], display)
            .unwrap();
        // Stand in only for the platform's hidden-pool proof. All publication
        // and invalidation below use the actual shared source/control methods.
        lens.state.lock().unwrap().overlay = true;
        let cancellation = request::Cancellation::new();
        let source = lens
            .overlay_source(lease.epoch, cancellation.clone())
            .unwrap();
        assert_eq!(source.lease.display_bounds, display);
        assert_eq!(source.lease.geometry, geometry);
        let mut mutations = 0;
        source
            .publish(|| {
                mutations += 1;
                Ok(())
            })
            .unwrap();
        cancellation.cancel();
        assert_eq!(
            source.publish(|| {
                mutations += 1;
                Ok(())
            }),
            Err("cancelled".into())
        );
        let source = lens
            .overlay_source(lease.epoch, request::Cancellation::new())
            .unwrap();
        let gate = lens.lifecycle.lock().await;
        let stop = lens.stop(Some("idle"));
        tokio::pin!(stop);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(5), &mut stop)
                .await
                .is_err()
        );
        assert_eq!(
            source.publish(|| {
                mutations += 1;
                Ok(())
            }),
            Err("cancelled".into()),
            "reveal is refused before native clear/teardown can run"
        );
        drop(gate);
        stop.await.unwrap();
        assert!(lens.ring.latest().is_none());
        assert_eq!(lens.status()["capabilities"]["overlay"], false);
        lens.dispatch("lens-start", &start, None, request::Cancellation::new())
            .await
            .unwrap();
        let grant = lens
            .backend_status(
                lens.request_generation(),
                true,
                false,
                Lens::score_id(),
                None,
            )
            .await
            .unwrap();
        let fresh = lens
            .accept_target(grant, target, geometry, [100, 100], display)
            .unwrap();
        lens.state.lock().unwrap().overlay = true;
        let fresh = lens
            .overlay_source(fresh.epoch, request::Cancellation::new())
            .unwrap();
        assert!(source
            .publish(|| {
                mutations += 1;
                Ok(())
            })
            .is_err());
        fresh
            .publish(|| {
                mutations += 1;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            mutations, 2,
            "same native-looking target cannot revive an old generation"
        );
        lens.dispatch(
            "lens-start",
            &json!({"consented":false,"active":true}),
            None,
            request::Cancellation::new(),
        )
        .await
        .unwrap();
        assert!(fresh
            .publish(|| {
                mutations += 1;
                Ok(())
            })
            .is_err());
        assert_eq!(mutations, 2);
    }
}
