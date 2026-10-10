//! Shared Windows/Linux Lens lifecycle. Concrete capture providers own native
//! handles and prove their identity before accepting or publishing a source.
#[cfg(not(target_os = "macos"))]
#[path = "bridge.rs"]
pub mod bridge;
#[cfg(not(target_os = "macos"))]
#[path = "geometry.rs"]
pub mod geometry;
#[path = "portable_ocr.rs"]
pub mod ocr;
#[cfg(not(target_os = "macos"))]
#[path = "request.rs"]
pub mod request;
#[cfg(not(target_os = "macos"))]
#[path = "ring.rs"]
pub mod ring;
#[cfg(target_os = "macos")]
pub use super::{bridge, geometry, request, ring};
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
}

pub struct Lens {
    pub bridge: Arc<Bridge>,
    pub ring: ring::Ring,
    state: Mutex<State>,
    ocr: ocr::Ocr,
    pending: Mutex<Option<(String, Rect)>>,
    wake: Notify,
}
impl Lens {
    pub fn init(writer: mpsc::UnboundedSender<String>, directory: &Path) -> Arc<Self> {
        Self::new(writer, ocr::Ocr::new(directory))
    }
    fn new(writer: mpsc::UnboundedSender<String>, ocr: ocr::Ocr) -> Arc<Self> {
        let lens = Arc::new(Self {
            bridge: Bridge::new(writer),
            ring: ring::Ring::new(),
            ocr,
            pending: Mutex::new(None),
            wake: Notify::new(),
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
                score_id: Self::score_id().into(),
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
    fn score_id() -> &'static str {
        if cfg!(windows) {
            "windows:wgc:rgb16-tile32-v1"
        } else {
            "linux:x11:rgb16-tile32-v1"
        }
    }
    fn capabilities(&self, state: &State) -> Value {
        json!({"capture":state.capture,"ax":state.ax,"ocr":self.ocr.available(),"embed":false,"triage":false,"describe":false,"translate":false,"overlay":false})
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
    /// Backend grants are actual provider answers. RIME-49 leaves capture/AX
    /// false; installing OCR alone cannot grant capture or native overlays.
    pub async fn backend_status(
        &self,
        capture: bool,
        ax: bool,
        score_id: &str,
        reason: Option<&str>,
    ) -> Result<(), String> {
        let accepted = if cfg!(windows) {
            score_id == "windows:wgc:rgb16-tile32-v1"
        } else {
            matches!(
                score_id,
                "linux:x11:rgb16-tile32-v1" | "linux:pipewire:rgb16-tile32-v1"
            )
        };
        if !accepted || (ax && score_id.contains(":pipewire:")) {
            return Err("unavailable".into());
        }
        {
            let mut state = self.state.lock().unwrap();
            self.invalidate(&mut state);
            state.capture = capture;
            state.ax = ax;
            state.score_id = score_id.into();
            state.reason = reason.map(str::to_owned);
            self.announce(&state);
        }
        self.ocr.drained().await;
        Ok(())
    }
    pub async fn stop(&self, reason: Option<&str>) {
        {
            let mut state = self.state.lock().unwrap();
            self.invalidate(&mut state);
            state.active = false;
            state.reason = reason.map(str::to_owned);
            self.announce(&state);
        }
        self.ocr.drained().await;
    }
    /// A provider must invalidate its accepted generation on native destroy,
    /// unmap, resize, monitor/session change or permission withdrawal, even if
    /// an old capture surface remains readable. Old callbacks cannot publish.
    pub fn invalidate_source(&self, reason: &str) {
        let mut state = self.state.lock().unwrap();
        self.invalidate(&mut state);
        state.capture = false;
        state.ax = false;
        state.reason = Some(reason.into());
        self.announce(&state);
    }
    pub fn accept_target(
        &self,
        target: Target,
        geometry: FrameGeometry,
        size: [u32; 2],
    ) -> Option<CaptureLease> {
        if !valid_rect(target.bounds)
            || target.window_id == 0
            || target.pid < 0
            || !geometry_valid(geometry, size)
            || geometry.window != target.bounds
        {
            return None;
        }
        let mut state = self.state.lock().unwrap();
        if Self::run(&state) != "running" {
            return None;
        }
        self.invalidate(&mut state);
        state.target = Some(target.clone());
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
        Some(CaptureLease {
            epoch: self.bridge.epoch(),
            generation: state.generation,
            target,
            geometry,
            size,
        })
    }
    fn current(&self, state: &State, lease: &CaptureLease) -> bool {
        Self::run(state) == "running"
            && self.bridge.epoch() == lease.epoch
            && state.generation == lease.generation
            && state.target.as_ref() == Some(&lease.target)
    }
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
        json!({"platform":Self::platform(),"state":Self::run(&state),"reason":state.reason,"epoch":self.bridge.epoch(),"seq":self.bridge.last_seq(),"target":state.target,
            "ring":{"n":stats.n,"bytes":stats.bytes,"oldestAt":stats.oldest_at},"covered":false,"permissions":{"screen":state.capture,"ax":state.ax},
            "capabilities":self.capabilities(&state),"visual":{"scoreId":state.score_id},"overlay":{"shown":0,"interactive":false},"helper":{"state":"down","outstanding":0},"filter":"window","consented":state.consented})
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
        &self,
        op: &str,
        value: &Value,
        deadline: Option<i64>,
        cancellation: Arc<request::Cancellation>,
    ) -> Result<Value, String> {
        match op {
            "lens-status" => Ok(self.status()),
            "lens-snapshot" => Ok(self.snapshot()),
            "lens-start" => {
                {
                    let mut state = self.state.lock().unwrap();
                    self.invalidate(&mut state);
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
                }
                self.ocr.drained().await;
                Ok(self.status())
            }
            "lens-stop" => {
                self.stop(value["reason"].as_str()).await;
                Ok(self.status())
            }
            "lens-pause" => {
                {
                    self.state.lock().unwrap().paused = true;
                }
                self.stop(Some("paused")).await;
                Ok(self.status())
            }
            "lens-resume" => {
                let mut state = self.state.lock().unwrap();
                if !state.consented {
                    return Err("not-consented".into());
                }
                state.paused = false;
                state.active = true;
                state.reason = if state.capture {
                    None
                } else {
                    Some("unsupported".into())
                };
                self.announce(&state);
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
            "overlay-clear" => Ok(Value::Bool(true)),
            _ => Err("unavailable".into()),
        }
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
        lens.backend_status(true, true, Lens::score_id(), None)
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
        let lease = lens.accept_target(target, geometry, [32, 32]).unwrap();
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
        lens.stop(Some("idle")).await;
        assert!(lens.request_generation() > generation);
        assert!(lens.ring.latest().is_none());
        assert!(session.is_cancelled());
        assert!(lens
            .publish_frame(&lease, pixels, [32, 32], geometry)
            .is_none());
        assert!(!lens.publish_ax(&lease, vec![]));
    }
}
