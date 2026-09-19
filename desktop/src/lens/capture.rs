//! The ScreenCaptureKit stream and the two filter shapes it can take.
//!
//! The crate cannot combine a window filter with application exclusion, so
//! there are two candidates and M1 measures both:
//! - [`Filter::Window`] — only the target window. Misses sheets, menus and
//!   popovers that are their own windows.
//! - [`Filter::Display`] — the display, excluding this app, cropped to the
//!   window's bounds. Catches everything in that rectangle, including other
//!   applications' floating windows.
//!
//! [`Filter::Display`] is the default, because it is the only one that sees a
//! sheet, a dialog or a second window of the target's own application
//! (research/capture-matrix.md §4). Its price is cell ii of that matrix: a
//! window of ANOTHER application over the target's rectangle is captured under
//! the target's name. That is not solved here — the pixels really are what is
//! at that rectangle — it is REPORTED. Every frame asks the window server who
//! is on top ([`signals::cover_now`]), a [`Kind::Covered`] signal names the
//! application when the answer is not the target, and recognition does not run
//! while it holds, so nothing downstream is ever handed another window's text
//! under this window's identity.
//!
//! The trade-off taken, against the alternative: `SCContentFilter` can also be
//! built display-including-applications, which would composite the target's
//! own application alone and drop the foreign window from the frame entirely.
//! It needs a live screen to settle — whether an occluded window still renders,
//! what fills the rest of the rectangle, and what happens when the target is
//! not in `SCShareableContent::applications()`, where an empty include list
//! captures nothing at all. Reporting fails safe and is provable without a
//! screen; that filter is not.

use super::bridge::{Dirty, FrameGeometry, Kind, Line, Rect};
use super::ocr::{self, Print, Transform};
use super::ring;
use super::{signals, Lens, Target};
use screencapturekit::cm::{CMSampleBufferExt, CMSampleBufferSCExt, SCFrameStatus};
use screencapturekit::cv::CVPixelBuffer;
use screencapturekit::prelude::*;
use screencapturekit::stream::StreamCallbacks;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The long edge a captured frame is planned for. Vision's fast path needs
/// about 14 px of text height: at 1280 px a full-width 1800 pt window on a 2x
/// display puts 15 pt text at 10 px and reads garbage (measured 2026-09-18,
/// `research/capture-matrix.md` §6), at 2560 px it reads cleanly in 64 ms
/// against 39 ms, and native 2x adds nothing. `RIMEWARD_CAPTURE_MAX_PX`
/// overrides it for measurements.
pub const MAX_PX: u32 = 2560;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Filter {
    Window,
    #[default]
    Display,
}

impl Filter {
    pub fn parse(name: &str) -> Option<Filter> {
        match name {
            "window" => Some(Filter::Window),
            "display" => Some(Filter::Display),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Plan {
    pub width: u32,
    pub height: u32,
    /// Display points. `Some` only in [`Filter::Display`], where the stream
    /// covers the whole display and is cropped to the window.
    pub source_rect: Option<Rect>,
    /// Captured pixels per window point.
    pub scale: f64,
}

/// `RIMEWARD_CAPTURE_MAX_PX` when set and parseable, else [`MAX_PX`].
pub fn max_px() -> u32 {
    std::env::var("RIMEWARD_CAPTURE_MAX_PX")
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(MAX_PX)
}

pub fn plan(target: &Target, filter: Filter) -> Plan {
    plan_capped(target, filter, max_px())
}

/// Never sample above the display's own scale: extra pixels past native
/// resolution cost OCR time and buy no glyphs.
pub fn plan_capped(target: &Target, filter: Filter, cap: u32) -> Plan {
    let [.., width, height] = target.bounds;
    let scale = if width > 0.0 {
        (f64::from(cap) / width).min(target.display.scale).max(0.01)
    } else {
        target.display.scale.max(1.0)
    };
    Plan {
        width: even(width * scale),
        height: even(height * scale),
        source_rect: match filter {
            Filter::Display => Some(target.bounds),
            Filter::Window => None,
        },
        scale,
    }
}

/// Odd dimensions make ScreenCaptureKit pad the buffer, which moves the
/// content rectangle for no gain.
fn even(value: f64) -> u32 {
    let rounded = value.round().max(2.0).min(f64::from(u32::MAX)) as u32;
    rounded & !1
}

/// Frames the stream may hold before it starts dropping them. Five is two and
/// a half seconds at the 500 ms interval: enough to ride out one slow
/// recognition, short enough that a stall is visible rather than buffered.
pub const QUEUE_DEPTH: u32 = 5;
/// `--slow-ocr`: long enough for an operator to switch apps mid-recognition.
const SLOW_OCR: Duration = Duration::from_secs(2);
/// A stream that stops is given one rebuild, and never faster than this.
const REBUILD_FLOOR: Duration = Duration::from_secs(5);

/// What a frame is worth doing. Pure, so the rule is a test rather than a
/// screen.
#[derive(Clone, Debug, PartialEq)]
pub enum Decision {
    /// Not a complete frame, or the lens is paused: nothing changed that
    /// anyone can act on.
    Skip,
    Process {
        /// The dirty rectangles, merged to at most [`ocr::MAX_DIRTY`], in
        /// window points.
        merged: Vec<Rect>,
        /// Their union, widened to every known line it overlaps.
        roi: Rect,
        /// Whether the Accessibility tree already accounts for that region.
        ax_covered: bool,
    },
}

/// `dirty` and `known` are window points; `full` is the whole window, which is
/// the region a frame that reports no dirty rectangles is treated as.
pub fn decide(
    status: Option<SCFrameStatus>,
    paused: bool,
    dirty: &[Rect],
    full: Rect,
    ax: &[Rect],
    known: &[Rect],
) -> Decision {
    if paused || status != Some(SCFrameStatus::Complete) {
        return Decision::Skip;
    }
    let merged = match ocr::merge_dirty(dirty) {
        empty if empty.is_empty() => vec![full],
        merged => merged,
    };
    let union = merged
        .iter()
        .copied()
        .reduce(|a, b| {
            let x = a[0].min(b[0]);
            let y = a[1].min(b[1]);
            [
                x,
                y,
                (a[0] + a[2]).max(b[0] + b[2]) - x,
                (a[1] + a[3]).max(b[1] + b[3]) - y,
            ]
        })
        .unwrap_or(full);
    let roi = ocr::expand_roi(union, known);
    Decision::Process {
        merged,
        ax_covered: ocr::ax_covers(roi, ax),
        roi,
    }
}

/// A FeaturePrint distance at or below this is the same pixels again. Measured
/// on macOS 27: identical pixels score exactly 0.0 (every corner rect on a
/// still window, and a caret rect at 2 fps, where the 1 s blink aliases to one
/// phase), a caret in its own 2x17 pt rect scores 0.29, and a whole-window
/// rect whose only change is the backdrop behind a translucent toolbar scores
/// 0.008 to 0.03. A one-character edit inside a whole-window rect lands in
/// that same band, so the threshold admits nothing but identical pixels;
/// scoring how much a region changed is the gate's job, not this one's.
pub const UNCHANGED: f32 = 0.001;

/// Whether every dirty rectangle of this frame scored "identical". The window
/// server redraws a window's transparent rounded corners whenever anything
/// behind them moves, so a still screen keeps reporting dirty rectangles with
/// nothing new in them.
pub fn unchanged(scored: &[Dirty]) -> bool {
    !scored.is_empty() && scored.iter().all(|dirty| dirty.d <= UNCHANGED)
}

/// The multiplier that turns `contentRect` into captured pixels. Measured on
/// macOS 27 (M5 Pro): a 1280x852 buffer reports `contentRect` 639x426,
/// `scaleFactor` 2.0 and `contentScale` 0.71, so the rectangle is in the
/// surface's own points and `scaleFactor` is the multiplier. Rather than pin
/// that, take whichever candidate lands the rectangle on the buffer's width.
/// (The dirty rectangles are already in captured pixels; the same measurement
/// shows them spanning the full 1280x852.)
pub fn px_per_unit(content_w: f64, scale_factor: f64, content_scale: f64, buffer_w: f64) -> f64 {
    if content_w <= 0.0 || buffer_w <= 0.0 {
        return 1.0;
    }
    [1.0, scale_factor, content_scale]
        .into_iter()
        .filter(|candidate| *candidate > 0.0)
        .min_by(|a, b| {
            (content_w * a - buffer_w)
                .abs()
                .total_cmp(&(content_w * b - buffer_w).abs())
        })
        .unwrap_or(1.0)
}

/// ScreenCaptureKit's own frame status, read off the sample buffer's
/// attachments. `screencapturekit` 6.1.0 casts that attachment to a Swift enum
/// and always misses, so both its accessors answer `None` on macOS 27; every
/// other attachment it reads is a primitive and arrives intact.
pub fn frame_status(sample: &CMSampleBuffer) -> Option<SCFrameStatus> {
    unsafe {
        let attachments = raw::CMSampleBufferGetSampleAttachmentsArray(sample.as_ptr(), false);
        if attachments.is_null() || raw::CFArrayGetCount(attachments) < 1 {
            return None;
        }
        let first = raw::CFArrayGetValueAtIndex(attachments, 0);
        if first.is_null() {
            return None;
        }
        let value = raw::CFDictionaryGetValue(first, raw::SCStreamFrameInfoStatus);
        if value.is_null() {
            return None;
        }
        let mut status: i32 = -1;
        // kCFNumberIntType.
        if !raw::CFNumberGetValue(value, 9, std::ptr::from_mut(&mut status).cast()) {
            return None;
        }
        SCFrameStatus::from_raw(status)
    }
}

#[allow(non_upper_case_globals, non_snake_case)]
mod raw {
    use std::ffi::c_void;

    #[link(name = "CoreMedia", kind = "framework")]
    extern "C" {
        pub fn CMSampleBufferGetSampleAttachmentsArray(
            sample: *mut c_void,
            create: bool,
        ) -> *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFArrayGetCount(array: *const c_void) -> isize;
        pub fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
        pub fn CFDictionaryGetValue(dictionary: *const c_void, key: *const c_void)
            -> *const c_void;
        pub fn CFNumberGetValue(number: *const c_void, kind: i32, out: *mut c_void) -> bool;
    }

    #[link(name = "ScreenCaptureKit", kind = "framework")]
    extern "C" {
        pub static SCStreamFrameInfoStatus: *const c_void;
    }
}

fn scaled(rect: Rect, by: f64) -> Rect {
    [rect[0] * by, rect[1] * by, rect[2] * by, rect[3] * by]
}

fn area(rect: Rect) -> f64 {
    rect[2].max(0.0) * rect[3].max(0.0)
}

/// Where the stream is pointed, screen points: the window and the display it
/// is captured from.
#[derive(Clone, Copy, Debug)]
struct Placement {
    bounds: Rect,
    display: Rect,
}

/// The part of the window a frame holds, in window points. A display capture
/// is clipped to the display, so a window hanging off an edge yields only its
/// on-screen part; a window capture holds the whole window wherever it is. A
/// window entirely off the display reads as whole, for want of anything better.
pub fn captured_rect(bounds: Rect, display: Rect, filter: Filter) -> Rect {
    let whole = [0.0, 0.0, bounds[2], bounds[3]];
    if filter == Filter::Window {
        return whole;
    }
    let x = bounds[0].max(display[0]);
    let y = bounds[1].max(display[1]);
    let right = (bounds[0] + bounds[2]).min(display[0] + display[2]);
    let bottom = (bounds[1] + bounds[3]).min(display[1] + display[3]);
    if right <= x || bottom <= y {
        return whole;
    }
    [x - bounds[0], y - bounds[1], right - x, bottom - y]
}

/// `bytes_per_row` is padded to whatever the hardware likes; everything
/// downstream wants `width * 4`. A row the buffer does not actually hold is
/// left black rather than read out of bounds.
pub fn pack_bgra(source: &[u8], stride: usize, width: u32, height: u32) -> Vec<u8> {
    let row = width as usize * 4;
    let mut out = Vec::with_capacity(row * height as usize);
    for y in 0..height as usize {
        match source.get(y * stride..y * stride + row) {
            Some(slice) => out.extend_from_slice(slice),
            None => out.resize(out.len() + row, 0),
        }
    }
    out
}

/// Packed BGRA → packed RGB, which is what the JPEG encoder takes.
pub fn bgra_to_rgb(bgra: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bgra.len() / 4 * 3);
    for [b, g, r, _] in bgra.as_chunks::<4>().0 {
        out.extend_from_slice(&[*r, *g, *b]);
    }
    out
}

fn jpeg(rgb: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    let image = image::RgbImage::from_raw(width, height, rgb.to_vec())?;
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, ring::QUALITY)
        .encode_image(&image)
        .ok()?;
    Some(out)
}

/// Everything the output handler needs. It runs on ScreenCaptureKit's queue,
/// so nothing here may block on the Node writer or take a lock the main thread
/// holds across a capture call.
struct Shared {
    lens: Arc<Lens>,
    /// As of the last (re)configure: what each frame's geometry records, so a
    /// crop maps through the window the frame came from.
    placement: Mutex<Placement>,
    filter: Filter,
    /// Whether the content filter in force names this app as an exclusion.
    excluded: AtomicBool,
    paused: AtomicBool,
    /// The previous frame's FeaturePrint per merged dirty-rectangle index.
    prints: Mutex<Vec<Option<Print>>>,
    /// Latest wins: a frame whose predecessor is still being recognized is
    /// pushed without recognition rather than queued behind it.
    recognizing: AtomicBool,
    /// Sample handlers running right now. The stream's context owns the
    /// handler closure, so releasing the stream under a running callback frees
    /// the environment it is executing in.
    in_flight: AtomicUsize,
    /// Our own `stop()`, so the delegate does not try to recover from it.
    intentional: AtomicBool,
    retried: AtomicBool,
}

/// One `SCStream` on one target.
pub struct Capture {
    /// `SCStream` is a reference wrapper: the clone in `stop` names the same
    /// stream.
    stream: SCStream,
    shared: Arc<Shared>,
    display_id: u32,
    own_pid: i32,
    stopped: AtomicBool,
}

impl Capture {
    pub fn start(
        lens: Arc<Lens>,
        target: &Target,
        filter: Filter,
        own_pid: i32,
    ) -> Result<Capture, String> {
        let content = SCShareableContent::get().map_err(|error| error.to_string())?;
        let (content_filter, excluded) = content_filter(&content, target, filter, own_pid)?;
        let display = display_frame(&content, target)?;
        let configuration = configuration(target, filter, display);
        let shared = Arc::new(Shared {
            lens,
            excluded: AtomicBool::new(excluded),
            placement: Mutex::new(Placement {
                bounds: target.bounds,
                display,
            }),
            filter,
            paused: AtomicBool::new(false),
            prints: Mutex::new(Vec::new()),
            recognizing: AtomicBool::new(false),
            in_flight: AtomicUsize::new(0),
            intentional: AtomicBool::new(false),
            retried: AtomicBool::new(false),
        });
        let (on_stop, on_error) = (shared.clone(), shared.clone());
        let delegate = StreamCallbacks::new()
            .on_stop(move |error| recover(&on_stop, error))
            .on_error(move |error| recover(&on_error, Some(error.to_string())));
        let mut stream = SCStream::new_with_delegate(&content_filter, &configuration, delegate);
        let handler = shared.clone();
        stream
            .add_output_handler(
                move |sample: CMSampleBuffer, kind: SCStreamOutputType| {
                    if kind == SCStreamOutputType::Screen {
                        handler.in_flight.fetch_add(1, Ordering::AcqRel);
                        on_frame(&handler, &sample);
                        handler.in_flight.fetch_sub(1, Ordering::AcqRel);
                    }
                },
                SCStreamOutputType::Screen,
            )
            .ok_or("output-handler")?;
        stream.start_capture().map_err(|error| error.to_string())?;
        Ok(Capture {
            stream,
            shared,
            display_id: target.display.id,
            own_pid,
            stopped: AtomicBool::new(false),
        })
    }

    /// Same display and same filter mode reconfigures in place; anything else
    /// rebuilds. Never bumps the epoch — [`super::Lens::retarget`] owns that.
    pub fn retarget(&self, target: &Target) -> Result<(), String> {
        let started = Instant::now();
        if target.display.id != self.display_id {
            return Err("display-changed".into());
        }
        let content = SCShareableContent::get().map_err(|error| error.to_string())?;
        let filter = self.shared.filter;
        let (content_filter, excluded) = content_filter(&content, target, filter, self.own_pid)?;
        self.shared.excluded.store(excluded, Ordering::Release);
        let display = display_frame(&content, target)?;
        self.stream
            .update_configuration(&configuration(target, filter, display))
            .map_err(|error| error.to_string())?;
        self.stream
            .update_content_filter(&content_filter)
            .map_err(|error| error.to_string())?;
        *self.shared.placement.lock().unwrap() = Placement {
            bounds: target.bounds,
            display,
        };
        // The prints describe the old window's pixels at the old indexes.
        self.shared.prints.lock().unwrap().clear();
        self.shared
            .lens
            .counters
            .record_retarget(started.elapsed().as_millis() as u32);
        Ok(())
    }

    /// The same window moved or resized: the source rect and the planned size
    /// follow it, and the next frame's geometry records the new bounds. No
    /// filter rebuild, and never an epoch bump.
    pub fn reframe(&self, target: &Target) -> Result<(), String> {
        let display = self.shared.placement.lock().unwrap().display;
        self.stream
            .update_configuration(&configuration(target, self.shared.filter, display))
            .map_err(|error| error.to_string())?;
        self.shared.placement.lock().unwrap().bounds = target.bounds;
        // The prints describe the old rectangle's pixels.
        self.shared.prints.lock().unwrap().clear();
        Ok(())
    }

    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        self.shared.intentional.store(true, Ordering::Release);
        // `stop_capture` is asynchronous; a frame that arrives while it lands
        // would be emitted after the caller has already reported the state.
        self.shared.paused.store(true, Ordering::Release);
        // `stop_capture` blocks on a completion that can land on the main
        // queue, so the caller — often the main thread — never waits for it.
        let stream = self.stream.clone();
        let shared = self.shared.clone();
        std::thread::spawn(move || {
            let _ = stream.stop_capture();
            // The last reference to the stream frees the handler closure. A
            // sample handler that is still running lives *inside* that
            // closure, so dropping here without waiting segfaults on
            // ScreenCaptureKit's own queue (measured: every run of M1's probe).
            for _ in 0..200 {
                if shared.in_flight.load(Ordering::Acquire) == 0 {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            std::thread::sleep(Duration::from_millis(100));
            drop(stream);
        });
    }

    /// Paused keeps the stream built and drops the frames, so resuming costs
    /// nothing and the exclusion filter is never rebuilt.
    pub fn set_paused(&self, on: bool) {
        self.shared.paused.store(on, Ordering::Release);
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The filter, and whether it names this app as an exclusion or has nothing it
/// could name (a window filter, or the test flag that asks for no exclusion).
/// `false` means the process owned no window at all when the filter was built.
/// The app never does: its hidden `main` window and the overlay pool exist
/// before any capture, and `SCShareableContent::get` lists off-screen windows,
/// so the app's filter names it from the first frame (measured 2026-09-18).
fn content_filter(
    content: &SCShareableContent,
    target: &Target,
    filter: Filter,
    own_pid: i32,
) -> Result<(SCContentFilter, bool), String> {
    match filter {
        Filter::Window => {
            let window = content
                .windows()
                .into_iter()
                .find(|window| window.window_id() == target.window_id)
                .ok_or("window-gone")?;
            let built = SCContentFilter::create()
                .with_window(&window)
                .try_build()
                .map_err(|error| error.to_string())?;
            // A window filter shows one window that is never ours, so there is
            // nothing left to exclude and nothing to rebuild for.
            Ok((built, true))
        }
        Filter::Display => {
            let display = display(content, target)?;
            // The app is always excluded from its own capture. The one
            // exception is the inverse half of the `overlay_excluded` test,
            // which has to be able to see the overlay to prove the test works.
            let ours: Vec<SCRunningApplication> = if no_exclude() {
                Vec::new()
            } else {
                content
                    .applications()
                    .into_iter()
                    .filter(|application| application.process_id() == own_pid)
                    .collect()
            };
            if ours.is_empty() && !no_exclude() {
                // Only a process with no window reaches this: `--probe
                // capture` (research/capture-matrix.md, cell i.b). It has
                // nothing of its own to capture, so the hard rule holds.
                eprintln!("lens: own application is not in the shareable content; exclusion empty");
            }
            let built = SCContentFilter::create()
                .with_display(&display)
                .with_excluding_applications(&ours.iter().collect::<Vec<_>>(), &[])
                .try_build()
                .map_err(|error| error.to_string())?;
            Ok((built, !ours.is_empty() || no_exclude()))
        }
    }
}

/// `RIMEWARD_TEST_NO_EXCLUDE=1`: build the display filter without the
/// self-exclusion. Test-only, and the only way the exclusion test can prove it
/// is looking at a frame the overlay would have shown up in.
fn no_exclude() -> bool {
    std::env::var("RIMEWARD_TEST_NO_EXCLUDE").as_deref() == Ok("1")
}

fn display(content: &SCShareableContent, target: &Target) -> Result<SCDisplay, String> {
    let displays = content.displays();
    displays
        .iter()
        .find(|display| display.display_id() == target.display.id)
        .or_else(|| displays.first())
        .cloned()
        .ok_or_else(|| "no-display".into())
}

/// The captured display's frame in screen points.
fn display_frame(content: &SCShareableContent, target: &Target) -> Result<Rect, String> {
    let frame = display(content, target)?.frame();
    Ok([
        frame.origin.x,
        frame.origin.y,
        frame.size.width,
        frame.size.height,
    ])
}

/// `display` is the frame of the display the stream captures, screen points.
fn configuration(target: &Target, filter: Filter, display: Rect) -> SCStreamConfiguration {
    let plan = plan(target, filter);
    let mut configuration = SCStreamConfiguration::new()
        .with_width(plan.width)
        .with_height(plan.height)
        // 2 fps. The gate, not the stream, decides what reaches a model.
        .with_minimum_frame_interval(&CMTime::new(1, 2))
        .with_queue_depth(QUEUE_DEPTH)
        .with_shows_cursor(false)
        .with_scales_to_fit(false)
        .with_preserves_aspect_ratio(true)
        .with_pixel_format(PixelFormat::BGRA);
    if let Some(rect) = plan.source_rect {
        // The source rectangle is relative to its own display; window bounds
        // are global screen points.
        configuration = configuration.with_source_rect(CGRect::new(
            rect[0] - display[0],
            rect[1] - display[1],
            rect[2],
            rect[3],
        ));
    }
    configuration
}

/// The stream stopped without us asking. A revoked Screen Recording grant is
/// terminal; anything else is worth exactly one rebuild.
fn recover(shared: &Arc<Shared>, reason: Option<String>) {
    if shared.intentional.load(Ordering::Acquire) {
        return;
    }
    let shared = shared.clone();
    // Never rebuild on the delegate's own queue: the rebuild drops this
    // stream, which is what is calling us.
    std::thread::spawn(move || {
        if !crate::permissions::preflight().0 {
            shared.lens.stop(Some("permission"));
            return;
        }
        if shared.retried.swap(true, Ordering::AcqRel) || !rebuild_allowed() {
            eprintln!("lens: stream stopped ({reason:?}), not rebuilding");
            shared.lens.stop(Some("stream"));
            return;
        }
        let target = shared.lens.target.read().unwrap().clone();
        let rebuilt = target
            .as_ref()
            .is_some_and(|target| shared.lens.build_capture(target).is_ok());
        if !rebuilt {
            shared.lens.stop(Some("stream"));
        }
    });
}

// ponytail: one process runs one stream, so one clock bounds the rebuild loop.
// Per-`Capture` state cannot: every rebuild brings a fresh flag with it.
static LAST_REBUILD: Mutex<Option<Instant>> = Mutex::new(None);

fn rebuild_allowed() -> bool {
    let mut last = LAST_REBUILD.lock().unwrap();
    if last.is_some_and(|at| at.elapsed() < REBUILD_FLOOR) {
        return false;
    }
    *last = Some(Instant::now());
    true
}

/// One captured frame, on ScreenCaptureKit's queue.
fn on_frame(shared: &Shared, sample: &CMSampleBuffer) {
    let lens = &shared.lens;
    let counters = &lens.counters;
    counters.frames.fetch_add(1, Ordering::Relaxed);
    let info = sample.frame_info().unwrap_or_default();
    // A missing status attachment means a macOS key changed, not that the
    // frame is empty: keep looking rather than going quietly blind.
    let status = frame_status(sample).or(Some(SCFrameStatus::Complete));
    if status != Some(SCFrameStatus::Complete) {
        counters.idle.fetch_add(1, Ordering::Relaxed);
        return;
    }
    let paused = shared.paused.load(Ordering::Acquire);
    if paused {
        return;
    }
    let Some(pixels) = sample.image_buffer() else {
        return;
    };
    counters.complete.fetch_add(1, Ordering::Relaxed);
    // The stamp is taken before any recognition, so everything this frame
    // produces carries the epoch the frame was captured in.
    let stamp = lens.bridge.stamp();

    let Placement { bounds, display } = *shared.placement.lock().unwrap();
    let target = lens
        .target
        .read()
        .unwrap()
        .as_ref()
        .map(|target| (target.window_id, target.pid));
    let (width, height) = (pixels.width() as u32, pixels.height() as u32);
    let content =
        info.content_rect
            .map_or([0.0, 0.0, f64::from(width), f64::from(height)], |rect| {
                [
                    rect.origin.x,
                    rect.origin.y,
                    rect.size.width,
                    rect.size.height,
                ]
            });
    let content_scale = info.content_scale.unwrap_or(1.0);
    let scale = info.scale_factor.unwrap_or(1.0);
    let geometry = FrameGeometry {
        window: bounds,
        scale,
        content_rect: scaled(
            content,
            px_per_unit(content[2], scale, content_scale, f64::from(width)),
        ),
        content_scale,
        captured: captured_rect(bounds, display, shared.filter),
    };
    let transform = Transform::new(&geometry);

    let dirty: Vec<Rect> = sample
        .dirty_rects()
        .unwrap_or_default()
        .iter()
        .map(|rect| {
            transform.pixels_to_window([
                rect.origin.x,
                rect.origin.y,
                rect.size.width,
                rect.size.height,
            ])
        })
        .collect();
    let full = [0.0, 0.0, bounds[2], bounds[3]];
    let known = lens.known_rects();
    let ax: Vec<Rect> = lens
        .known
        .read()
        .unwrap()
        .ax
        .iter()
        .map(|line| line.bbox)
        .collect();
    let Decision::Process {
        merged,
        roi,
        ax_covered,
    } = decide(status, paused, &dirty, full, &ax, &known)
    else {
        return;
    };

    // Whose pixels these are. A display filter is scoped to the target's
    // RECTANGLE, not to its window, so a window of another application drawn
    // over that rectangle is captured under the target's name — the trade-off
    // recorded when the filter was chosen (research/capture-matrix.md §4, cell
    // ii). The pixels are real, so the frame still goes to the ring and the
    // consumer; recognition does not run, because reading them would file
    // another window's text as the target's. A sheet, a dialog or a second
    // window of the target's own application is not a cover: seeing those is
    // why the display filter was chosen over a window filter in the first
    // place.
    // ponytail: any overlap at all suppresses the whole read rather than the
    // overlapped part of it. Recognizing around the cover is the upgrade, and
    // it wants the cover's rectangle subtracted from the region of interest
    // rather than a flag.
    let cover = target.and_then(|(window_id, target_pid)| {
        // A window filter composites the target's own window, so nothing drawn
        // on top of it is in the frame to begin with.
        (shared.filter == Filter::Display)
            .then(|| signals::cover_now(window_id, target_pid, bounds, lens.own_pid))
            .flatten()
    });
    // Edge-triggered, and only while the frame's own epoch still stands: a
    // cover read for the old target must not be filed against the new one.
    let changed = lens.bridge.epoch() == stamp.epoch && {
        let mut known = lens.known.write().unwrap();
        let changed = known.covered != cover;
        if changed {
            known.covered.clone_from(&cover);
        }
        changed
    };
    if changed {
        if let Some(at) = lens.bridge.stamp_in(stamp.epoch) {
            lens.bridge.emit_stamped(
                at,
                Kind::Covered {
                    over: cover.clone(),
                },
            );
        }
    }

    let scored = score(shared, &pixels, &transform, &merged, width, height);
    let nothing_new = unchanged(&scored);
    if nothing_new {
        counters.ocr_unchanged.fetch_add(1, Ordering::Relaxed);
    }
    let (lines, ocr_ms, recognized) = if cover.is_some() {
        // Another window is over the target. The `covered` signal says so; an
        // `ocr` signal here would say the target shows this text.
        (Vec::new(), 0, false)
    } else if nothing_new {
        // Same pixels as last frame: reading them again would cost a
        // recognition per frame for as long as the screen stands still.
        (Vec::new(), 0, false)
    } else if ax_covered {
        (Vec::new(), 0, true)
    } else {
        recognize(shared, &pixels, &transform, roi, width, height)
    };
    if recognized && !lines.is_empty() {
        lens.known.write().unwrap().ocr = lines.clone();
    }

    let packed = lock_and_pack(&pixels, width, height);
    let Some(jpeg) = packed
        .as_ref()
        .and_then(|bgra| jpeg(&bgra_to_rgb(bgra), width, height))
    else {
        return;
    };
    lens.ring.push(ring::Frame {
        frame_ref: stamp.frame_ref(),
        epoch: stamp.epoch,
        seq: stamp.seq,
        at: super::bridge::now_ms(),
        w: width,
        h: height,
        geometry,
        jpeg: jpeg.into(),
        pixels: packed.map(Arc::from),
    });
    let covered: f64 = scored.iter().map(|dirty| area(dirty.bbox)).sum();
    lens.bridge.emit_stamped(
        stamp,
        Kind::Frame {
            frame_ref: stamp.frame_ref(),
            w: width,
            h: height,
            ratio: ratio(covered, area(full)),
            dirty: scored,
            geometry,
        },
    );
    if !recognized {
        // Latest wins: this frame has no recognition to report, and claiming
        // an empty result would erase the text the last one found.
        return;
    }
    if lens.slow_ocr.load(Ordering::Acquire) {
        std::thread::sleep(SLOW_OCR);
    }
    // The epoch may have moved while this frame was recognized, in which case
    // the text describes a window nobody is looking at any more.
    let Some(ocr_stamp) = lens.bridge.stamp_in(stamp.epoch) else {
        counters.ocr_dropped_stale.fetch_add(1, Ordering::Relaxed);
        return;
    };
    lens.bridge.emit_stamped(
        ocr_stamp,
        Kind::Ocr {
            frame_ref: stamp.frame_ref(),
            rect: roi,
            lines,
            ms: ocr_ms,
            ax_covered,
        },
    );
}

/// A FeaturePrint per merged dirty rectangle, scored against the previous
/// frame's print for the same index. A first frame, a new index or a failed
/// request all read as 1.0: changed as much as it can be.
fn score(
    shared: &Shared,
    pixels: &CVPixelBuffer,
    transform: &Transform,
    merged: &[Rect],
    width: u32,
    height: u32,
) -> Vec<Dirty> {
    let current: Vec<Option<Print>> = merged
        .iter()
        .map(|rect| {
            let roi = ocr::pixels_to_norm(transform.window_to_pixels(*rect), width, height);
            ocr::feature_print(pixels, Some(roi))
        })
        .collect();
    let mut previous = shared.prints.lock().unwrap();
    let scored = pair(merged, &previous, &current, Print::distance);
    *previous = current;
    scored
}

/// The pairing rule on its own: rectangle `i` of this frame is scored against
/// rectangle `i` of the last one. A rectangle count that changed means the
/// regions no longer line up, so the new indexes read as fully changed.
pub fn pair<T>(
    merged: &[Rect],
    previous: &[Option<T>],
    current: &[Option<T>],
    distance: impl Fn(&T, &T) -> f32,
) -> Vec<Dirty> {
    merged
        .iter()
        .enumerate()
        .map(|(index, bbox)| Dirty {
            bbox: *bbox,
            d: match (
                previous.get(index).and_then(Option::as_ref),
                current.get(index).and_then(Option::as_ref),
            ) {
                (Some(before), Some(now)) => distance(now, before),
                _ => 1.0,
            },
        })
        .collect()
}

/// Returns the lines in window points, the milliseconds it took, and whether
/// recognition ran at all.
fn recognize(
    shared: &Shared,
    pixels: &CVPixelBuffer,
    transform: &Transform,
    roi: Rect,
    width: u32,
    height: u32,
) -> (Vec<Line>, u32, bool) {
    if shared.recognizing.swap(true, Ordering::AcqRel) {
        shared
            .lens
            .counters
            .ocr_skipped
            .fetch_add(1, Ordering::Relaxed);
        return (Vec::new(), 0, false);
    }
    let roi_px = transform.window_to_pixels(roi);
    let (raw, ms) = ocr::recognize(
        pixels,
        Some(ocr::pixels_to_norm(roi_px, width, height)),
        false,
    );
    shared.recognizing.store(false, Ordering::Release);
    let lines = raw
        .into_iter()
        .map(|(norm, text, confidence)| Line {
            bbox: transform.vision_to_window(norm, roi_px),
            text,
            conf: Some(confidence),
        })
        .collect();
    let window = area([0.0, 0.0, f64::from(width), f64::from(height)]);
    shared.lens.counters.record_ocr(
        ms,
        f64::from(ratio(area(roi) * transform.scale().powi(2), window)),
    );
    (lines, ms, true)
}

fn ratio(part: f64, whole: f64) -> f32 {
    if whole <= 0.0 {
        return 0.0;
    }
    (part / whole).clamp(0.0, 1.0) as f32
}

fn lock_and_pack(pixels: &CVPixelBuffer, width: u32, height: u32) -> Option<Vec<u8>> {
    let guard = pixels.lock_read_only().ok()?;
    let base = guard.base_address();
    if base.is_null() {
        return None;
    }
    let stride = guard.bytes_per_row();
    let size = guard.data_size().max(stride * height as usize);
    // Safety: the guard holds the lock for the length of the borrow, and the
    // buffer is `size` bytes of BGRA the stream owns.
    let source = unsafe { std::slice::from_raw_parts(base, size) };
    Some(pack_bgra(source, stride, width, height))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lens::bridge::DisplayInfo;
    use tokio::sync::mpsc;

    fn target(width: f64, height: f64, scale: f64) -> Target {
        Target {
            pid: 42,
            bundle: "com.apple.Safari".into(),
            name: "Safari".into(),
            window_id: 9,
            title: "Docs".into(),
            bounds: [100.0, 200.0, width, height],
            url: None,
            display: DisplayInfo {
                id: 1,
                w: 1512.0,
                h: 982.0,
                scale,
            },
        }
    }

    #[test]
    fn a_wide_window_is_capped_at_the_long_edge() {
        let plan = plan_capped(&target(1600.0, 900.0, 2.0), Filter::Display, 1280);
        assert_eq!(plan.scale, 0.8);
        assert_eq!((plan.width, plan.height), (1280, 720));
        assert_eq!(plan.source_rect, Some([100.0, 200.0, 1600.0, 900.0]));
    }

    #[test]
    fn a_narrow_window_stops_at_the_displays_own_scale() {
        // 1280/600 would be 2.13x; the display only has 2x of real pixels.
        let plan = plan_capped(&target(600.0, 401.0, 2.0), Filter::Window, 1280);
        assert_eq!(plan.scale, 2.0);
        // 802 rounds down to an even 802; 401*2 = 802 already even.
        assert_eq!((plan.width, plan.height), (1200, 802));
        assert_eq!(plan.source_rect, None);
    }

    #[test]
    fn odd_pixel_counts_round_down_to_even() {
        let plan = plan_capped(&target(641.0, 401.0, 1.0), Filter::Window, 1280);
        assert_eq!(plan.scale, 1.0);
        assert_eq!((plan.width, plan.height), (640, 400));
    }

    #[test]
    fn a_degenerate_window_still_plans_something_capturable() {
        let plan = plan_capped(&target(0.0, 0.0, 2.0), Filter::Display, 1280);
        assert_eq!((plan.width, plan.height), (2, 2));
        assert_eq!(plan.scale, 2.0);
    }

    #[test]
    fn the_env_cap_replaces_the_default() {
        let wide = target(1600.0, 900.0, 2.0);
        assert_eq!(plan_capped(&wide, Filter::Display, 1600).width, 1600);
        assert_eq!(plan_capped(&wide, Filter::Display, 640).width, 640);
        assert_eq!(MAX_PX, 2560);
    }

    #[test]
    fn a_frame_that_is_not_complete_or_is_paused_is_skipped() {
        let full = [0.0, 0.0, 100.0, 100.0];
        for status in [
            None,
            Some(SCFrameStatus::Idle),
            Some(SCFrameStatus::Blank),
            Some(SCFrameStatus::Suspended),
            Some(SCFrameStatus::Started),
            Some(SCFrameStatus::Stopped),
        ] {
            assert_eq!(decide(status, false, &[], full, &[], &[]), Decision::Skip);
        }
        assert_eq!(
            decide(Some(SCFrameStatus::Complete), true, &[], full, &[], &[]),
            Decision::Skip
        );
    }

    #[test]
    fn a_complete_frame_merges_its_dirty_rects_and_widens_the_region() {
        let full = [0.0, 0.0, 200.0, 200.0];
        let known = [[10.0, 100.0, 180.0, 14.0]];
        // Two touching edits at the tail of a known line.
        let decision = decide(
            Some(SCFrameStatus::Complete),
            false,
            &[[150.0, 102.0, 20.0, 8.0], [170.0, 102.0, 10.0, 8.0]],
            full,
            &[],
            &known,
        );
        let Decision::Process {
            merged,
            roi,
            ax_covered,
        } = decision
        else {
            panic!("a complete frame is processed");
        };
        assert_eq!(merged, vec![[150.0, 102.0, 30.0, 8.0]]);
        assert_eq!(roi, [10.0, 102.0, 180.0, 8.0], "widened to the whole line");
        assert!(!ax_covered, "no Accessibility text at all");
    }

    /// A frame that reports no dirty rectangles changed somewhere unnamed, so
    /// the whole window is the region.
    #[test]
    fn no_dirty_rects_means_the_whole_window() {
        let full = [0.0, 0.0, 200.0, 100.0];
        let ax = [
            [0.0, 0.0, 200.0, 34.0],
            [0.0, 34.0, 200.0, 33.0],
            [0.0, 67.0, 200.0, 33.0],
        ];
        let Decision::Process {
            merged,
            roi,
            ax_covered,
        } = decide(Some(SCFrameStatus::Complete), false, &[], full, &ax, &[])
        else {
            panic!("a complete frame is processed");
        };
        assert_eq!(merged, vec![full]);
        assert_eq!(roi, full);
        assert!(ax_covered, "the tree already accounts for the whole window");
    }

    #[test]
    fn feature_prints_pair_by_index_and_a_new_index_reads_as_changed() {
        let merged = [[0.0, 0.0, 10.0, 10.0], [20.0, 0.0, 10.0, 10.0]];
        let distance = |a: &f32, b: &f32| (a - b).abs();
        // Both indexes present in both frames: the real distance.
        let scored = pair(
            &merged,
            &[Some(1.0), Some(5.0)],
            &[Some(1.25), Some(5.0)],
            distance,
        );
        assert_eq!(scored[0].d, 0.25);
        assert_eq!(scored[1].d, 0.0);
        assert_eq!(scored[0].bbox, merged[0]);
        // A first frame, a shorter history, and a failed request all read 1.0.
        assert_eq!(
            pair(&merged, &[], &[Some(1.0), Some(2.0)], distance)
                .iter()
                .map(|dirty| dirty.d)
                .collect::<Vec<_>>(),
            vec![1.0, 1.0]
        );
        assert_eq!(
            pair(
                &merged,
                &[Some(1.0), Some(2.0)],
                &[Some(1.0), None],
                distance
            )[1]
            .d,
            1.0
        );
    }

    #[test]
    fn a_frame_whose_every_region_scored_identical_is_not_read_again() {
        let same = |d: f32| Dirty {
            bbox: [0.0, 0.0, 10.0, 10.0],
            d,
        };
        assert!(unchanged(&[same(0.0), same(0.0)]));
        assert!(unchanged(&[same(UNCHANGED)]));
        // One region that really changed is enough to read the frame.
        assert!(!unchanged(&[same(0.0), same(0.3)]));
        // A first frame scores 1.0 per region, so it is always read.
        assert!(!unchanged(&[same(1.0)]));
        // No regions at all is not a claim that nothing changed.
        assert!(!unchanged(&[]));
    }

    #[test]
    fn bgra_becomes_rgb_and_padded_rows_are_dropped() {
        // 2x2 BGRA with a padded stride of 12 bytes: blue, green / red, white.
        let source = vec![
            255, 0, 0, 255, 0, 255, 0, 255, 9, 9, 9, 9, // row 0 + padding
            0, 0, 255, 255, 255, 255, 255, 255, 9, 9, 9, 9, // row 1 + padding
        ];
        let packed = pack_bgra(&source, 12, 2, 2);
        assert_eq!(packed.len(), 16);
        assert_eq!(&packed[0..4], &[255, 0, 0, 255], "padding is gone");
        assert_eq!(
            bgra_to_rgb(&packed),
            vec![0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255]
        );
        // A row the buffer does not hold is black, never read out of bounds.
        assert_eq!(pack_bgra(&source[..12], 12, 2, 2), {
            let mut expected = source[..8].to_vec();
            expected.extend_from_slice(&[0; 8]);
            expected
        });
    }

    #[test]
    fn a_display_capture_holds_only_the_on_screen_part_of_the_window() {
        let display = [0.0, 0.0, 1800.0, 1169.0];
        // On screen: the whole window.
        assert_eq!(
            captured_rect([195.0, 92.0, 898.0, 768.0], display, Filter::Display),
            [0.0, 0.0, 898.0, 768.0]
        );
        // 270 pt past the right edge (research/capture-matrix.md cell vi).
        assert_eq!(
            captured_rect([1170.0, 100.0, 900.0, 600.0], display, Filter::Display),
            [0.0, 0.0, 630.0, 600.0]
        );
        // 300 pt past the left edge and 50 above the top.
        assert_eq!(
            captured_rect([-300.0, -50.0, 900.0, 600.0], display, Filter::Display),
            [300.0, 50.0, 600.0, 550.0]
        );
        // A window capture is never clipped by the display.
        assert_eq!(
            captured_rect([1170.0, 100.0, 900.0, 600.0], display, Filter::Window),
            [0.0, 0.0, 900.0, 600.0]
        );
        // A second display to the right, in the same screen space.
        assert_eq!(
            captured_rect(
                [1700.0, 0.0, 400.0, 300.0],
                [1800.0, 0.0, 1920.0, 1080.0],
                Filter::Display
            ),
            [100.0, 0.0, 300.0, 300.0]
        );
        // Entirely off the display: nothing to clip to.
        assert_eq!(
            captured_rect([5000.0, 0.0, 10.0, 10.0], display, Filter::Display),
            [0.0, 0.0, 10.0, 10.0]
        );
    }

    #[test]
    fn the_content_rect_grid_is_whichever_reading_lands_on_the_buffer() {
        // Measured on macOS 27: contentRect in surface points, scaleFactor 2.
        assert_eq!(px_per_unit(639.0, 2.0, 0.71, 1280.0), 2.0);
        // A contentRect already in pixels is left alone.
        assert_eq!(px_per_unit(1280.0, 2.0, 0.71, 1280.0), 1.0);
        // A build that reports it against contentScale is followed too.
        assert_eq!(px_per_unit(1800.0, 2.0, 0.71, 1278.0), 0.71);
        // Degenerate readings never scale.
        assert_eq!(px_per_unit(0.0, 2.0, 0.71, 1280.0), 1.0);
        assert_eq!(px_per_unit(640.0, 0.0, 0.0, 0.0), 1.0);
    }

    /// A target on the main display, because discovering the frontmost window
    /// is phase C's job and a display filter never looks at the window id.
    #[cfg(test)]
    fn display_target() -> Target {
        use objc2_core_graphics::{CGDisplayBounds, CGMainDisplayID};
        let id = CGMainDisplayID();
        let frame = CGDisplayBounds(id);
        Target {
            pid: std::process::id() as i32,
            bundle: "io.frostdev.rimeward.test".into(),
            name: "probe".into(),
            window_id: 0,
            title: "display".into(),
            bounds: [
                frame.origin.x,
                frame.origin.y,
                frame.size.width.min(900.0),
                frame.size.height.min(600.0),
            ],
            url: None,
            display: DisplayInfo {
                id,
                w: frame.size.width,
                h: frame.size.height,
                scale: 2.0,
            },
        }
    }

    /// Needs a screen and the Screen Recording grant: three seconds of a real
    /// display filter, asserting a complete frame reached the bridge with the
    /// geometry a crop is mapped through.
    #[test]
    #[ignore]
    fn a_display_capture_emits_frames_with_geometry() {
        assert!(
            crate::permissions::preflight().0,
            "this terminal has no Screen Recording grant"
        );
        let (writer, mut reader) = mpsc::unbounded_channel::<String>();
        let lens = Lens::new(
            crate::lens::Config {
                filter: Filter::Display,
            },
            writer,
        );
        let signals: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let collected = signals.clone();
        let bridge = lens.bridge.clone();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            runtime.block_on(async move {
                tokio::spawn(bridge.run_writer());
                while let Some(line) = reader.recv().await {
                    collected.lock().unwrap().push(line);
                }
            });
        });
        let target = display_target();
        *lens.target.write().unwrap() = Some(target.clone());
        let capture = Capture::start(lens.clone(), &target, Filter::Display, lens.own_pid)
            .expect("the stream starts");
        std::thread::sleep(Duration::from_millis(1500));
        // Reconfigure in place: same display, same filter mode.
        let mut moved = target.clone();
        moved.bounds[0] += 40.0;
        moved.bounds[1] += 40.0;
        let started = std::time::Instant::now();
        capture.retarget(&moved).expect("the stream reconfigures");
        eprintln!("retarget took {} ms", started.elapsed().as_millis());
        std::thread::sleep(Duration::from_millis(1500));
        capture.stop();
        std::thread::sleep(Duration::from_millis(250));

        let counters = &lens.counters;
        let (p50, p95) = counters.ocr_percentiles();
        eprintln!(
            "frames={} idle={} complete={} ocr={} p50={p50}ms p95={p95}ms roi={:.3} skipped={} stale={}",
            counters.frames.load(Ordering::Relaxed),
            counters.idle.load(Ordering::Relaxed),
            counters.complete.load(Ordering::Relaxed),
            counters.ocr_runs.load(Ordering::Relaxed),
            counters.roi_ratio(),
            counters.ocr_skipped.load(Ordering::Relaxed),
            counters.ocr_dropped_stale.load(Ordering::Relaxed),
        );
        assert!(
            counters.complete.load(Ordering::Relaxed) >= 1,
            "no complete frame in three seconds"
        );
        let frame = lens.ring.latest().expect("a frame in the ring");
        eprintln!(
            "buffer {}x{} geometry {:?}",
            frame.w, frame.h, frame.geometry
        );
        assert!(frame.pixels.is_some(), "the latest frame keeps its pixels");
        assert!(frame.jpeg.len() > 1024, "a real JPEG");
        let lines = signals.lock().unwrap().clone();
        let frames: Vec<serde_json::Value> = lines
            .iter()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .filter(|signal| signal["kind"] == "frame")
            .collect();
        let signal = frames.first().expect("a frame signal");
        assert_eq!(signal["type"], "lens");
        assert_eq!(signal["w"], frame.w);
        assert!(signal["geometry"]["contentRect"][2].as_f64().unwrap() > 0.0);
        assert!(signal["geometry"]["scale"].as_f64().unwrap() >= 1.0);
        assert!(!signal["ref"].as_str().unwrap().is_empty());

        // Every recognized box lands inside the window it was read from: the
        // whole chain of content rect, region of interest and Vision's own
        // bottom-left normalisation. Text is never printed — it is a picture
        // of the operator's screen.
        let recognized: Vec<serde_json::Value> = lines
            .iter()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .filter(|signal| signal["kind"] == "ocr")
            .collect();
        let mut boxes = 0;
        for signal in &recognized {
            for line in signal["lines"].as_array().unwrap_or(&Vec::new()) {
                let bbox: Vec<f64> = line["bbox"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|value| value.as_f64().unwrap())
                    .collect();
                assert!(
                    bbox[0] >= -2.0
                        && bbox[1] >= -2.0
                        && bbox[0] + bbox[2] <= target.bounds[2] + 2.0
                        && bbox[1] + bbox[3] <= target.bounds[3] + 2.0,
                    "line box {bbox:?} outside the window {:?}",
                    target.bounds
                );
                boxes += 1;
            }
        }
        eprintln!(
            "ocr signals={} lines={boxes} first roi={:?}",
            recognized.len(),
            recognized.first().map(|signal| signal["rect"].clone())
        );
    }

    /// Needs a screen: `--slow-ocr` in one test. A recognition that finishes
    /// after its epoch ended describes a window nobody is looking at, so it is
    /// dropped rather than emitted against the new epoch.
    #[test]
    #[ignore]
    fn a_recognition_that_outlives_its_epoch_is_dropped() {
        assert!(
            crate::permissions::preflight().0,
            "this terminal has no Screen Recording grant"
        );
        let (writer, _reader) = mpsc::unbounded_channel::<String>();
        let lens = Lens::new(
            crate::lens::Config {
                filter: Filter::Display,
            },
            writer,
        );
        lens.slow_ocr.store(true, Ordering::Release);
        let target = display_target();
        *lens.target.write().unwrap() = Some(target.clone());
        let capture = Capture::start(lens.clone(), &target, Filter::Display, lens.own_pid)
            .expect("the stream starts");
        // Long enough for a frame to be inside its two-second delay.
        std::thread::sleep(Duration::from_millis(1200));
        let mut moved = target.clone();
        moved.window_id += 1;
        // The lens is not running, so this bumps the epoch and announces the
        // new window without touching the stream.
        lens.retarget(moved);
        assert_eq!(lens.bridge.epoch(), 2);
        std::thread::sleep(Duration::from_millis(2600));
        capture.stop();
        let dropped = lens.counters.ocr_dropped_stale.load(Ordering::Relaxed);
        eprintln!(
            "slow-ocr: complete={} ocr={} dropped_stale={dropped}",
            lens.counters.complete.load(Ordering::Relaxed),
            lens.counters.ocr_runs.load(Ordering::Relaxed),
        );
        assert!(dropped >= 1, "a recognition should have outlived the epoch");
    }

    /// Needs a screen and the Screen Recording grant. A test cannot drag a
    /// window off the display, so the source rectangle is what hangs over the
    /// edge: 900 pt wide with 270 of them (30 %) past the right edge.
    #[test]
    #[ignore]
    fn a_source_rect_that_hangs_off_the_display_reports_what_it_captured() {
        assert!(
            crate::permissions::preflight().0,
            "this terminal has no Screen Recording grant"
        );
        let (writer, _reader) = mpsc::unbounded_channel::<String>();
        let lens = Lens::new(
            crate::lens::Config {
                filter: Filter::Display,
            },
            writer,
        );
        let mut target = display_target();
        target.bounds = [target.display.w - 630.0, 100.0, 900.0, 600.0];
        *lens.target.write().unwrap() = Some(target.clone());
        let capture = Capture::start(lens.clone(), &target, Filter::Display, lens.own_pid)
            .expect("the stream starts");
        std::thread::sleep(Duration::from_millis(1500));
        capture.stop();
        std::thread::sleep(Duration::from_millis(500));
        let frame = lens.ring.latest().expect("a frame in the ring");
        eprintln!(
            "off-screen target {:?} on a {}x{} display -> plan {:?}, buffer {}x{}, geometry {:?}",
            target.bounds,
            target.display.w,
            target.display.h,
            plan(&target, Filter::Display),
            frame.w,
            frame.h,
            frame.geometry,
        );
        assert!(frame.w > 0 && frame.h > 0, "a frame of something arrived");
        assert_eq!(frame.geometry.captured, [0.0, 0.0, 630.0, 600.0]);
        // The transform's scale is the planned one, not 0.7 of it.
        let scale = Transform::new(&frame.geometry).scale();
        let planned = plan(&target, Filter::Display).scale;
        assert!(
            (scale - planned).abs() < 0.02,
            "transform {scale} px/pt against the planned {planned}"
        );
    }

    #[test]
    fn filter_names_round_trip() {
        assert_eq!(Filter::parse("window"), Some(Filter::Window));
        assert_eq!(Filter::parse("display"), Some(Filter::Display));
        assert_eq!(Filter::parse("Display"), None);
        assert_eq!(Filter::default(), Filter::Display);
        assert_eq!(
            serde_json::to_string(&Filter::Window).unwrap(),
            r#""window""#
        );
    }
}
