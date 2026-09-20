//! Vision OCR, FeaturePrint, and the one place the coordinate spaces meet.
//!
//! Three spaces are in play:
//! - **screen points** — macOS global display coordinates, origin top-left of
//!   the main display, y down. AX positions and window bounds arrive here.
//! - **window points** — `[x, y, w, h]` f64 relative to the target window's
//!   top-left, y down. Every `Rect` in a signal, snapshot or op is this unless
//!   the field says otherwise.
//! - **captured pixels** — the sample buffer's grid. `FrameGeometry`
//!   `content_rect` says where the window content sits inside it.
//!
//! Vision reports normalized, bottom-left rects over whatever region of
//! interest it was handed. [`Transform`] is the only conversion in the crate.

use super::bridge::Rect;
use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSArray, NSDictionary};
use objc2_vision::{
    VNFeaturePrintObservation, VNGenerateImageFeaturePrintRequest, VNImageRequestHandler,
    VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
};
use screencapturekit::cv::CVPixelBuffer;
use std::ptr::NonNull;
use std::time::Instant;

/// `kCVPixelFormatType_32BGRA`. The stream is configured for it and [`warm`]
/// matches so the warm path exercises the real one.
pub const BGRA: u32 = 0x4247_5241;

/// The most merged dirty rectangles a frame reports. Past this, unioning the
/// cheapest pairs costs less than a FeaturePrint per rectangle.
pub const MAX_DIRTY: usize = 8;

/// Window points ↔ captured pixels for one frame, through that frame's own
/// geometry.
#[derive(Clone, Copy, Debug)]
pub struct Transform {
    origin: [f64; 2],
    /// Captured pixels per window point.
    scale: f64,
}

impl Transform {
    pub fn new(geometry: &super::bridge::FrameGeometry) -> Transform {
        // The content rectangle is `captured` rendered into the buffer, so its
        // width over `captured`'s width IS the pixels-per-point ratio, whatever
        // part of the window the buffer holds. Dividing by the window's width
        // read 0.994 instead of 1.42 for a window hanging off the display.
        // Deriving it beats multiplying `scale` by `content_scale`: the two are
        // reported independently and a stream that scales to fit makes them
        // disagree.
        let scale = if geometry.captured[2] > 0.0 && geometry.content_rect[2] > 0.0 {
            geometry.content_rect[2] / geometry.captured[2]
        } else {
            (geometry.scale * geometry.content_scale).max(1.0)
        };
        Transform {
            // Window point (0, 0): `captured`'s origin projected back from the
            // content rectangle. Off the buffer when the window's top-left is
            // off the display.
            origin: [
                geometry.content_rect[0] - geometry.captured[0] * scale,
                geometry.content_rect[1] - geometry.captured[1] * scale,
            ],
            scale,
        }
    }

    pub fn scale(&self) -> f64 {
        self.scale
    }

    /// Window points → captured pixels, clamped at zero so a rect that starts
    /// off the top-left of the content never wraps.
    pub fn window_to_pixels(&self, rect: Rect) -> [u32; 4] {
        let x = self.origin[0] + rect[0] * self.scale;
        let y = self.origin[1] + rect[1] * self.scale;
        [
            x.max(0.0).round() as u32,
            y.max(0.0).round() as u32,
            (rect[2] * self.scale).max(0.0).round() as u32,
            (rect[3] * self.scale).max(0.0).round() as u32,
        ]
    }

    /// Captured pixels → window points. Dirty rectangles and the content
    /// rectangle arrive in the buffer's own grid and every signal speaks
    /// window points.
    pub fn pixels_to_window(&self, rect: Rect) -> Rect {
        [
            (rect[0] - self.origin[0]) / self.scale,
            (rect[1] - self.origin[1]) / self.scale,
            rect[2] / self.scale,
            rect[3] / self.scale,
        ]
    }

    /// Vision's normalized bottom-left rect over `roi` (captured pixels) →
    /// window points.
    pub fn vision_to_window(&self, norm: Rect, roi: [u32; 4]) -> Rect {
        let (rx, ry) = (f64::from(roi[0]), f64::from(roi[1]));
        let (rw, rh) = (f64::from(roi[2]), f64::from(roi[3]));
        let x = rx + norm[0] * rw;
        // Bottom-left origin: the top edge is the region's height minus the
        // rect's top in Vision's terms.
        let y = ry + rh - (norm[1] + norm[3]) * rh;
        [
            (x - self.origin[0]) / self.scale,
            (y - self.origin[1]) / self.scale,
            norm[2] * rw / self.scale,
            norm[3] * rh / self.scale,
        ]
    }
}

fn union(a: Rect, b: Rect) -> Rect {
    let x = a[0].min(b[0]);
    let y = a[1].min(b[1]);
    let right = (a[0] + a[2]).max(b[0] + b[2]);
    let bottom = (a[1] + a[3]).max(b[1] + b[3]);
    [x, y, right - x, bottom - y]
}

fn area(r: Rect) -> f64 {
    (r[2].max(0.0)) * (r[3].max(0.0))
}

fn touches(a: Rect, b: Rect) -> bool {
    // Adjacent counts: two rects sharing an edge are one region to a reader.
    const SLACK: f64 = 1.0;
    a[0] <= b[0] + b[2] + SLACK
        && b[0] <= a[0] + a[2] + SLACK
        && a[1] <= b[1] + b[3] + SLACK
        && b[1] <= a[1] + a[3] + SLACK
}

fn intersect(a: Rect, b: Rect) -> Option<Rect> {
    let x = a[0].max(b[0]);
    let y = a[1].max(b[1]);
    let right = (a[0] + a[2]).min(b[0] + b[2]);
    let bottom = (a[1] + a[3]).min(b[1] + b[3]);
    (right > x && bottom > y).then_some([x, y, right - x, bottom - y])
}

/// Overlapping and adjacent rectangles become their union; past [`MAX_DIRTY`]
/// the pair whose union wastes the least area is merged until the count fits.
// ponytail: O(n²) per merge pass. ScreenCaptureKit hands us single-digit dirty
// rect counts; sort by area first if a driver ever reports hundreds.
pub fn merge_dirty(rects: &[Rect]) -> Vec<Rect> {
    let mut out: Vec<Rect> = rects.iter().copied().filter(|r| area(*r) > 0.0).collect();
    let mut merged = true;
    while merged {
        merged = false;
        'pairs: for i in 0..out.len() {
            for j in (i + 1)..out.len() {
                if touches(out[i], out[j]) {
                    out[i] = union(out[i], out[j]);
                    out.remove(j);
                    merged = true;
                    break 'pairs;
                }
            }
        }
    }
    while out.len() > MAX_DIRTY {
        let mut best = (0usize, 1usize, f64::MAX);
        for i in 0..out.len() {
            for j in (i + 1)..out.len() {
                let waste = area(union(out[i], out[j])) - area(out[i]) - area(out[j]);
                if waste < best.2 {
                    best = (i, j, waste);
                }
            }
        }
        out[best.0] = union(out[best.0], out[best.1]);
        out.remove(best.1);
    }
    out
}

/// Margin, window points, past every edge of the region handed to Vision
/// ([`read_roi`]).
///
/// Vision reads the band it is given, not the page around it, and a band that
/// cuts a glyph's top or tail comes back as fragments rather than words.
/// Measured 2026-09-20 on macOS 27, Helvetica 11/12/13/15/18 pt drawn at 2x
/// into a 1802x2260 buffer, recognized at Fast with `minimumTextHeight` 0:
/// handing Vision back its OWN line box for "Sphinx of black quartz, judge my
/// vow." reads "Inxo" in four pieces, one pixel of margin reads "S hinx of
/// black", and two pixels reads the line whole at every size. Eight pixels of
/// margin at 11 pt starts pulling in the halves of the lines above and below
/// and misreads a character of this one, so the margin is small on purpose:
/// what a neighbouring line needs is to be pulled in WHOLE, which is what
/// widening to the known lines does.
///
/// Three points is six pixels on a 2x display and three on a 1x one — both
/// measured clean.
pub const ROI_PAD: f64 = 3.0;

/// The smallest band worth handing Vision, window points. A caret-sized dirty
/// rectangle over text nothing has read yet overlaps no known line, and a
/// 3x20 pt sliver reads nothing at all. It is a floor on what is READ, never
/// on what a reading claims: a region that claimed more than the lines it took
/// in would drop the ones past them unread.
pub const ROI_MIN: f64 = 24.0;

/// Grown about its own centre to at least `min` on each axis, then held inside
/// `full`.
fn grow(rect: Rect, min: f64, full: Rect) -> Rect {
    let width = rect[2].max(min);
    let height = rect[3].max(min);
    let x = rect[0] + rect[2] / 2.0 - width / 2.0;
    let y = rect[1] + rect[3] / 2.0 - height / 2.0;
    let left = x.max(full[0]);
    let top = y.max(full[1]);
    let right = (x + width).min(full[0] + full[2]);
    let bottom = (y + height).min(full[1] + full[3]);
    [left, top, (right - left).max(0.0), (bottom - top).max(0.0)]
}

/// What one recognition of `roi` COVERS — the region whose stored text it is
/// entitled to replace, which is what rides the `ocr` signal.
///
/// An edit at the end of a long line dirties only the tail, and an edit in the
/// middle of one dirties a caret-sized sliver. Reading that alone replaces a
/// whole line with a fragment, so the region takes in every known line it
/// overlaps WHOLE — both axes, because a band the height of the dirty
/// rectangle cuts the glyphs (see [`ROI_PAD`]). Nothing else: every line in
/// here is one [`read_roi`] takes in whole, so the reading really can speak
/// for all of them.
pub fn expand_roi(roi: Rect, known: &[Rect], full: Rect) -> Rect {
    // The overlap test stays on the region as it arrived: growing into a line
    // and then testing the growth would chain line by line to the whole page.
    let mut out = roi;
    for line in known {
        if intersect(roi, *line).is_some() {
            out = union(out, *line);
        }
    }
    grow(out, 0.0, full)
}

/// The region to hand Vision for a reading of [`expand_roi`]'s region: the
/// same, with [`ROI_PAD`] of margin on every side and [`ROI_MIN`] underneath.
///
/// The two are deliberately not the same rectangle. The margin is there so the
/// glyphs at the region's own edges are whole; a line that only the MARGIN
/// reaches is cut, and Vision either drops it or returns a fragment of it — so
/// it is not in what the reading claims, and the text already stored for it
/// stands.
pub fn read_roi(roi: Rect, full: Rect) -> Rect {
    grow(
        [
            roi[0] - ROI_PAD,
            roi[1] - ROI_PAD,
            roi[2] + 2.0 * ROI_PAD,
            roi[3] + 2.0 * ROI_PAD,
        ],
        ROI_MIN,
        full,
    )
}

/// Whether a reading of `roi` ([`expand_roi`]'s region) speaks for this line:
/// any horizontal touch, and at least half the line's height. The same rule
/// the consumer applies to decide which stored lines a reading replaces
/// (`overlaps` in src/lib/lens/doc.ts), and it has to be, because recognition
/// runs over the larger [`read_roi`] band and comes back with whatever the
/// MARGIN clipped as well.
///
/// The consumer adopts every line it is handed and scopes only the removal
/// side by the region, so a line the margin cut would land beside the intact
/// one it was cut from — a garbled duplicate, which is the whole symptom.
/// Both regions are in hand here, so this is where the extras go.
pub fn claims(bbox: Rect, roi: Rect) -> bool {
    let x = (bbox[0] + bbox[2]).min(roi[0] + roi[2]) - bbox[0].max(roi[0]);
    let y = (bbox[1] + bbox[3]).min(roi[1] + roi[3]) - bbox[1].max(roi[1]);
    x > 0.0 && y >= bbox[3] / 2.0
}

/// The fraction of `roi` the union of `rects` covers, 0.0 to 1.0. Exact:
/// overlapping rectangles are counted once, because the caller uses the result
/// to decide whether to skip recognizing that region at all.
pub fn covered(roi: Rect, rects: &[Rect]) -> f64 {
    let total = area(roi);
    if total <= 0.0 {
        return 0.0;
    }
    let clipped: Vec<Rect> = rects.iter().filter_map(|r| intersect(roi, *r)).collect();
    if clipped.is_empty() {
        return 0.0;
    }
    // Sweep y: within a band no rectangle starts or ends, so the covered width
    // is one merge of the spans that cross it.
    let mut bands: Vec<f64> = clipped.iter().flat_map(|r| [r[1], r[1] + r[3]]).collect();
    bands.sort_by(f64::total_cmp);
    bands.dedup();
    let mut sum = 0.0;
    for band in bands.windows(2) {
        let (top, bottom) = (band[0], band[1]);
        let mut spans: Vec<(f64, f64)> = clipped
            .iter()
            .filter(|r| r[1] <= top && r[1] + r[3] >= bottom)
            .map(|r| (r[0], r[0] + r[2]))
            .collect();
        spans.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut width = 0.0;
        let mut open: Option<(f64, f64)> = None;
        for (start, end) in spans {
            open = match open {
                Some((from, to)) if start <= to => Some((from, to.max(end))),
                Some((from, to)) => {
                    width += to - from;
                    Some((start, end))
                }
                None => Some((start, end)),
            };
        }
        if let Some((from, to)) = open {
            width += to - from;
        }
        sum += width * (bottom - top);
    }
    (sum / total).clamp(0.0, 1.0)
}

/// The share of a region that must already be covered by Accessibility text
/// before recognizing it again is wasted work.
pub const AX_COVERED: f64 = 0.90;
/// Below this many lines the coverage figure is noise, not a reading.
pub const AX_MIN_LINES: usize = 3;

/// Whether the Accessibility tree already accounts for this region. The answer
/// travels on the frame that produced it, because it decides which source wins
/// for that replacement.
pub fn ax_covers(roi: Rect, ax: &[Rect]) -> bool {
    ax.len() >= AX_MIN_LINES && covered(roi, ax) >= AX_COVERED
}

/// The boxes that count towards [`ax_covers`]: one per line the tree actually
/// reads line by line. A single record spanning many lines — TextEdit's whole
/// document is one multi-line `AXTextArea` value — is not that reading, and
/// taking its box as coverage skipped OCR for good: the consumer then had the
/// text as one blob with one box and no line geometry at all (2026-09-19).
pub fn ax_coverage(lines: &[super::bridge::Line]) -> Vec<Rect> {
    lines
        .iter()
        .filter(|line| !line.text.contains('\n'))
        .map(|line| line.bbox)
        .collect()
}

/// A Vision image FeaturePrint. Distances between prints score how much a
/// region changed without hashing pixels.
#[derive(Debug)]
pub struct Print(Retained<VNFeaturePrintObservation>);

// A feature print is an immutable observation with atomic reference counting.
// The capture handler hands one frame's prints to the next frame, which SCK may
// deliver on another thread, and the `Mutex` that holds them is what serialises
// the access.
unsafe impl Send for Print {}

impl Print {
    /// Vision's own distance between two prints. An error (mismatched
    /// revisions, a released observation) reads as "completely different",
    /// which costs a recognition rather than hiding a change.
    pub fn distance(&self, other: &Print) -> f32 {
        let mut distance: f32 = 0.0;
        let result = unsafe {
            self.0.computeDistance_toFeaturePrintObservation_error(
                NonNull::from(&mut distance),
                &other.0,
            )
        };
        if result.is_err() {
            return 1.0;
        }
        distance
    }
}

/// One recognition and one feature print on a 64x64 buffer, so the asset load
/// is paid on a background thread at launch instead of on the first frame the
/// user is waiting for. Returns the milliseconds it took.
pub fn warm() -> u32 {
    let started = Instant::now();
    // A pixel buffer nobody drew into: Vision loads the same assets for noise
    // as for a screen, and 64x64 is the cheapest way to ask.
    let Ok(buffer) = CVPixelBuffer::create(64, 64, BGRA) else {
        return 0;
    };
    recognize(&buffer, None, false);
    feature_print(&buffer, None);
    since(started)
}

/// Recognition over packed BGRA bytes — the ring's retained copy of the latest
/// frame, `width * 4` bytes per row. Core Video wraps the bytes in place, so
/// the caller must hold them for the length of the call.
pub fn recognize_bgra(
    bgra: &[u8],
    width: u32,
    height: u32,
    roi_norm: Option<Rect>,
    accurate: bool,
) -> (Vec<(Rect, String, f32)>, u32) {
    let row = width as usize * 4;
    if row == 0 || bgra.len() < row * height as usize {
        return (Vec::new(), 0);
    }
    // Safety: `create_with_bytes` neither copies nor takes ownership, Vision
    // only reads, and `buffer` is dropped at the end of this call — before the
    // borrow of `bgra` ends.
    let buffer = unsafe {
        CVPixelBuffer::create_with_bytes(
            width as usize,
            height as usize,
            BGRA,
            bgra.as_ptr().cast::<std::ffi::c_void>().cast_mut(),
            row,
        )
    };
    match buffer {
        Ok(buffer) => recognize(&buffer, roi_norm, accurate),
        Err(_) => (Vec::new(), 0),
    }
}

/// Fast level, `minimumTextHeight` 0.0 (the 1/32-of-image-height default
/// returns nothing at all for normal UI text), correction off, automatic
/// language. `roi_norm` is normalized with a bottom-left origin over the whole
/// buffer; the rects come back normalized over that region, also bottom-left.
pub fn recognize(
    pixels: &CVPixelBuffer,
    roi_norm: Option<Rect>,
    accurate: bool,
) -> (Vec<(Rect, String, f32)>, u32) {
    let started = Instant::now();
    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(if accurate {
        VNRequestTextRecognitionLevel::Accurate
    } else {
        VNRequestTextRecognitionLevel::Fast
    });
    request.setMinimumTextHeight(0.0);
    request.setUsesLanguageCorrection(false);
    request.setAutomaticallyDetectsLanguage(true);
    if let Some(roi) = roi_norm {
        unsafe { request.setRegionOfInterest(cg_rect(roi)) };
    }
    if !perform(pixels, &request) {
        return (Vec::new(), since(started));
    }
    let mut lines = Vec::new();
    if let Some(results) = request.results() {
        for observation in &results {
            let Some(candidate) = observation.topCandidates(1).firstObject() else {
                continue;
            };
            let box_ = unsafe { observation.boundingBox() };
            lines.push((
                [
                    box_.origin.x,
                    box_.origin.y,
                    box_.size.width,
                    box_.size.height,
                ],
                candidate.string().to_string(),
                candidate.confidence(),
            ));
        }
    }
    (lines, since(started))
}

/// The feature print of one region, for scoring how much it changed against
/// the same region of the previous frame.
pub fn feature_print(pixels: &CVPixelBuffer, roi_norm: Option<Rect>) -> Option<Print> {
    let request = unsafe { VNGenerateImageFeaturePrintRequest::new() };
    if let Some(roi) = roi_norm {
        unsafe { request.setRegionOfInterest(cg_rect(roi)) };
    }
    if !perform(pixels, &request) {
        return None;
    }
    unsafe { request.results() }?.firstObject().map(Print)
}

/// Captured pixels (top-left origin) → Vision's normalized bottom-left region
/// over the whole buffer. A region that reaches outside the buffer is accepted
/// by Vision and then fails the request, so it is clamped here instead.
pub fn pixels_to_norm(roi: [u32; 4], width: u32, height: u32) -> Rect {
    if width == 0 || height == 0 {
        return [0.0, 0.0, 1.0, 1.0];
    }
    let (width, height) = (f64::from(width), f64::from(height));
    let x = (f64::from(roi[0]) / width).clamp(0.0, 1.0);
    let w = (f64::from(roi[2]) / width).clamp(0.0, 1.0 - x);
    let h = (f64::from(roi[3]) / height).clamp(0.0, 1.0);
    let y = (1.0 - f64::from(roi[1]) / height - h).clamp(0.0, 1.0 - h);
    [x, y, w, h]
}

/// `apple-cf` (what ScreenCaptureKit hands us) and `objc2-core-video` (what
/// Vision takes) are two wrappers over the same `CVPixelBufferRef`, so the
/// buffer crosses by pointer with no copy. The caller owns the retain for the
/// length of the call.
fn perform(pixels: &CVPixelBuffer, request: &VNRequest) -> bool {
    let buffer: &objc2_core_video::CVPixelBuffer = unsafe { &*pixels.as_ptr().cast() };
    let handler = unsafe {
        VNImageRequestHandler::initWithCVPixelBuffer_options(
            VNImageRequestHandler::alloc(),
            buffer,
            &NSDictionary::new(),
        )
    };
    handler
        .performRequests_error(&NSArray::from_slice(&[request]))
        .is_ok()
}

fn cg_rect(rect: Rect) -> CGRect {
    CGRect::new(
        CGPoint::new(rect[0], rect[1]),
        CGSize::new(rect[2], rect[3]),
    )
}

fn since(started: Instant) -> u32 {
    started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32
}

/// A blocky 5x7 font, enough for the test strings. Vision is trained on real
/// typefaces, so the glyphs are drawn large.
#[cfg(test)]
const GLYPHS: [(char, [u8; 7]); 8] = [
    (
        'L',
        [
            0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111,
        ],
    ),
    (
        'E',
        [
            0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111,
        ],
    ),
    (
        'N',
        [
            0b10001, 0b11001, 0b10101, 0b10101, 0b10011, 0b10001, 0b10001,
        ],
    ),
    (
        'S',
        [
            0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110,
        ],
    ),
    (
        'O',
        [
            0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
        ],
    ),
    (
        'C',
        [
            0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110,
        ],
    ),
    (
        'R',
        [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001,
        ],
    ),
    (' ', [0, 0, 0, 0, 0, 0, 0]),
];

/// Packed BGRA (`width * 4` per row): black text on white, which is what the
/// ring hands [`recognize_bgra`].
#[cfg(test)]
pub fn text_frame(text: &str, scale: u32, width: u32, height: u32) -> Vec<u8> {
    let mut pixels = vec![0xFFu8; (width as usize) * (height as usize) * 4];
    let mut pen = scale * 2;
    for character in text.chars() {
        if let Some((_, rows)) = GLYPHS.iter().find(|(glyph, _)| *glyph == character) {
            for (row, bits) in rows.iter().enumerate() {
                for column in 0..5u32 {
                    if bits & (1 << (4 - column)) == 0 {
                        continue;
                    }
                    for dy in 0..scale {
                        for dx in 0..scale {
                            let x = pen + column * scale + dx;
                            let y = scale * 2 + row as u32 * scale + dy;
                            if x >= width || y >= height {
                                continue;
                            }
                            let at = ((y * width + x) as usize) * 4;
                            pixels[at..at + 4].copy_from_slice(&[0, 0, 0, 255]);
                        }
                    }
                }
            }
        }
        pen += 6 * scale;
    }
    pixels
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lens::bridge::FrameGeometry;

    /// A 2x window at screen (100, 200), 800x600 points, landing at pixel
    /// (10, 20) in a buffer that is 1600x1200 pixels of content.
    fn geometry() -> FrameGeometry {
        FrameGeometry {
            window: [100.0, 200.0, 800.0, 600.0],
            scale: 2.0,
            content_rect: [10.0, 20.0, 1600.0, 1200.0],
            content_scale: 1.0,
            captured: [0.0, 0.0, 800.0, 600.0],
        }
    }

    fn close(a: Rect, b: Rect) -> bool {
        a.iter().zip(b).all(|(a, b)| (a - b).abs() < 1e-6)
    }

    /// A 900x600 pt window with 270 pt past the right edge of an 1800 pt
    /// display, captured at 1.42 px/pt: the buffer holds only the 630 pt that
    /// were on screen (the numbers of research/capture-matrix.md cell vi).
    /// Then the same window off the left edge, where window point 300 is the
    /// buffer's left column.
    #[test]
    fn a_window_hanging_off_the_display_keeps_its_scale_and_offset() {
        let right = FrameGeometry {
            window: [1170.0, 100.0, 900.0, 600.0],
            scale: 2.0,
            content_rect: [1.0, 0.0, 894.6, 852.0],
            content_scale: 0.71,
            captured: [0.0, 0.0, 630.0, 600.0],
        };
        let transform = Transform::new(&right);
        assert!(
            (transform.scale() - 1.42).abs() < 1e-9,
            "{}",
            transform.scale()
        );
        assert_eq!(
            transform.window_to_pixels([600.0, 0.0, 30.0, 600.0]),
            [853, 0, 43, 852]
        );

        let left = FrameGeometry {
            window: [-300.0, 100.0, 900.0, 600.0],
            scale: 2.0,
            content_rect: [0.0, 0.0, 852.0, 852.0],
            content_scale: 0.71,
            captured: [300.0, 0.0, 600.0, 600.0],
        };
        let transform = Transform::new(&left);
        assert!(
            (transform.scale() - 1.42).abs() < 1e-9,
            "{}",
            transform.scale()
        );
        assert_eq!(
            transform.window_to_pixels([300.0, 0.0, 10.0, 10.0]),
            [0, 0, 14, 14]
        );
        assert!(close(
            transform.pixels_to_window([0.0, 0.0, 852.0, 852.0]),
            [300.0, 0.0, 600.0, 600.0]
        ));
        assert!(close(
            transform.vision_to_window([0.0, 0.0, 1.0, 1.0], [0, 0, 852, 852]),
            [300.0, 0.0, 600.0, 600.0]
        ));
    }

    #[test]
    fn window_points_become_pixels_at_the_content_offset() {
        let transform = Transform::new(&geometry());
        assert_eq!(transform.scale(), 2.0);
        assert_eq!(
            transform.window_to_pixels([0.0, 0.0, 800.0, 600.0]),
            [10, 20, 1600, 1200]
        );
        assert_eq!(
            transform.window_to_pixels([200.0, 100.0, 100.0, 50.0]),
            [410, 220, 200, 100]
        );
        // Negative window coordinates clamp instead of wrapping around u32.
        assert_eq!(
            transform.window_to_pixels([-100.0, -100.0, 10.0, 10.0]),
            [0, 0, 20, 20]
        );
    }

    #[test]
    fn vision_rects_come_back_as_window_points() {
        let transform = Transform::new(&geometry());
        // The whole content region: a full-extent normalized rect is the window.
        let roi = [10u32, 20, 1600, 1200];
        assert_eq!(
            transform.vision_to_window([0.0, 0.0, 1.0, 1.0], roi),
            [0.0, 0.0, 800.0, 600.0]
        );
        // Bottom-left origin: a rect in the top-left quarter of the region has
        // a Vision y near 1.
        assert_eq!(
            transform.vision_to_window([0.0, 0.5, 0.5, 0.5], roi),
            [0.0, 0.0, 400.0, 300.0]
        );
        // A region that is itself offset inside the buffer.
        let roi = [410u32, 220, 200, 100];
        assert_eq!(
            transform.vision_to_window([0.0, 0.0, 1.0, 1.0], roi),
            [200.0, 100.0, 100.0, 50.0]
        );
        assert_eq!(
            transform.vision_to_window([0.5, 0.0, 0.5, 0.5], roi),
            [250.0, 125.0, 50.0, 25.0]
        );
    }

    #[test]
    fn pixels_become_visions_bottom_left_normalised_region() {
        // The whole buffer.
        assert_eq!(
            pixels_to_norm([0, 0, 800, 600], 800, 600),
            [0.0, 0.0, 1.0, 1.0]
        );
        // The top-left quarter is high in Vision's space.
        assert_eq!(
            pixels_to_norm([0, 0, 400, 300], 800, 600),
            [0.0, 0.5, 0.5, 0.5]
        );
        // The bottom-right quarter is low.
        assert_eq!(
            pixels_to_norm([400, 300, 400, 300], 800, 600),
            [0.5, 0.0, 0.5, 0.5]
        );
        // A region that runs off the buffer is clamped, because Vision accepts
        // it and then fails the request.
        assert_eq!(
            pixels_to_norm([600, 400, 400, 400], 800, 600),
            [0.75, 0.0, 0.25, 0.6666666666666666]
        );
        assert_eq!(pixels_to_norm([0, 0, 10, 10], 0, 0), [0.0, 0.0, 1.0, 1.0]);
    }

    #[test]
    fn pixels_become_window_points_through_the_content_offset() {
        let transform = Transform::new(&geometry());
        assert_eq!(
            transform.pixels_to_window([10.0, 20.0, 1600.0, 1200.0]),
            [0.0, 0.0, 800.0, 600.0]
        );
        assert_eq!(
            transform.pixels_to_window([410.0, 220.0, 200.0, 100.0]),
            [200.0, 100.0, 100.0, 50.0]
        );
        // The inverse of window_to_pixels, on the same numbers.
        let rect = [123.0, 45.0, 67.0, 89.0];
        let pixels = transform.window_to_pixels(rect);
        assert_eq!(
            transform.pixels_to_window([
                f64::from(pixels[0]),
                f64::from(pixels[1]),
                f64::from(pixels[2]),
                f64::from(pixels[3])
            ]),
            rect
        );
    }

    /// Needs a screen: the first Vision request in a process loads the
    /// recognition assets.
    #[test]
    #[ignore]
    fn warming_pays_the_cold_vision_cost_once() {
        let cold = warm();
        let buffer = CVPixelBuffer::create(64, 64, BGRA).expect("pixel buffer");
        let (_lines, warm_ms) = recognize(&buffer, None, false);
        assert!(
            feature_print(&buffer, None).is_some(),
            "a feature print of a 64x64 buffer"
        );
        eprintln!("vision cold {cold} ms, warm recognition {warm_ms} ms");
        assert!(warm_ms < 1_000, "a warm recognition took {warm_ms} ms");
    }

    #[test]
    fn merge_dirty_unions_overlapping_and_adjacent_rects() {
        // Two overlapping, one touching edge-to-edge, one apart.
        let merged = merge_dirty(&[
            [0.0, 0.0, 10.0, 10.0],
            [5.0, 5.0, 10.0, 10.0],
            [15.0, 0.0, 5.0, 15.0],
            [100.0, 100.0, 4.0, 4.0],
        ]);
        assert_eq!(merged.len(), 2);
        assert!(merged.contains(&[0.0, 0.0, 20.0, 15.0]), "{merged:?}");
        assert!(merged.contains(&[100.0, 100.0, 4.0, 4.0]), "{merged:?}");
        // Zero-area rects are dropped, not merged.
        assert!(merge_dirty(&[[0.0, 0.0, 0.0, 10.0]]).is_empty());
    }

    #[test]
    fn merge_dirty_caps_at_eight() {
        let scattered: Vec<Rect> = (0..20)
            .map(|i| [f64::from(i) * 50.0, f64::from(i) * 50.0, 4.0, 4.0])
            .collect();
        let merged = merge_dirty(&scattered);
        assert_eq!(merged.len(), MAX_DIRTY);
        // Nothing is lost: the union of the result still covers every input.
        let hull = merged.iter().copied().reduce(union).unwrap();
        assert_eq!(hull, [0.0, 0.0, 954.0, 954.0]);
    }

    /// Vision's rule, which is the only thing a region is for: the line is
    /// inside the region, whole, with the margin its glyphs need.
    fn holds(roi: Rect, line: Rect) -> bool {
        roi[0] <= line[0] - ROI_PAD
            && roi[1] <= line[1] - ROI_PAD
            && roi[0] + roi[2] >= line[0] + line[2] + ROI_PAD
            && roi[1] + roi[3] >= line[1] + line[3] + ROI_PAD
    }

    #[test]
    fn expand_roi_widens_to_the_lines_it_overlaps() {
        let window = [0.0, 0.0, 901.0, 1130.0];
        let lines = [
            [10.0, 100.0, 500.0, 14.0],
            [10.0, 120.0, 300.0, 14.0],
            [10.0, 400.0, 900.0, 14.0],
        ];
        // An edit at the tail of the first line pulls in the whole line —
        // sideways, as it always did, and now its full height too — and the
        // band read for it clears the glyphs top and bottom.
        let covered = expand_roi([480.0, 102.0, 20.0, 8.0], &lines, window);
        assert_eq!(covered, [10.0, 100.0, 500.0, 14.0]);
        assert_eq!(read_roi(covered, window), [7.0, 95.0, 506.0, 24.0]);
        // Overlapping two lines reaches the far edge of the wider one, and
        // the bottom of the lower one.
        assert_eq!(
            expand_roi([200.0, 105.0, 20.0, 30.0], &lines, window),
            [10.0, 100.0, 500.0, 35.0]
        );
        // Overlapping none is the dirty rectangle itself; the floor is on what
        // is read, never on what the reading claims.
        let covered = expand_roi([600.0, 200.0, 20.0, 20.0], &lines, window);
        assert_eq!(covered, [600.0, 200.0, 20.0, 20.0]);
        assert_eq!(read_roi(covered, window), [597.0, 197.0, 26.0, 26.0]);
        // Neither region ever leaves the window, so what a reading claims is
        // somewhere the reading looked.
        let covered = expand_roi([0.0, 0.0, 4.0, 4.0], &[], window);
        assert_eq!(covered, [0.0, 0.0, 4.0, 4.0]);
        assert_eq!(read_roi(covered, window), [0.0, 0.0, 14.0, 14.0]);
        let covered = expand_roi([895.0, 1126.0, 6.0, 4.0], &[], window);
        assert_eq!(covered, [895.0, 1126.0, 6.0, 4.0]);
        assert_eq!(read_roi(covered, window), [886.0, 1116.0, 15.0, 14.0]);
    }

    /// The bug OCR-GARBLE: a caret-sized dirty rectangle inside a line used to
    /// widen only sideways, so Vision was handed a band the height of the
    /// caret — or, once the line's own tight OCR box was `known`, the height of
    /// the glyphs exactly. Both cut the glyphs, and a cut band reads as
    /// fragments ("Inxo" for "Sphinx of black quartz, judge my vow.",
    /// measured 2026-09-20).
    #[test]
    fn a_caret_inside_a_line_never_reads_that_line_clipped() {
        let window = [0.0, 0.0, 901.0, 1130.0];
        // What the lens knows: Vision's own boxes, tight around the glyphs.
        let line = [40.5, 51.5, 199.0, 11.0];
        let known = [line, [40.5, 67.5, 210.0, 11.0]];
        // A caret mid-line, 3x20 pt, and the line's own box handed back.
        for dirty in [[120.0, 50.0, 3.0, 20.0], line] {
            let covered = expand_roi(dirty, &known, window);
            let read = read_roi(covered, window);
            assert!(holds(read, line), "{dirty:?} -> {read:?} clips {line:?}");
        }
        // A caret on a line nothing has read yet still gets a band to read.
        let read = read_roi(expand_roi([120.0, 50.0, 3.0, 20.0], &[], window), window);
        assert!(read[2] >= ROI_MIN && read[3] >= ROI_MIN, "{read:?}");
    }

    /// A line only the MARGIN reaches is read clipped, so the reading neither
    /// claims it nor reports it: the stored text for it stands until something
    /// reads it whole. Reporting it would be worse than dropping it — the
    /// consumer adopts every line it is handed and scopes only the removal by
    /// the region, so the clipped copy would land BESIDE the intact one.
    #[test]
    fn a_reading_never_claims_a_line_only_its_margin_reaches() {
        let window = [0.0, 0.0, 901.0, 1130.0];
        let line = [40.5, 51.5, 199.0, 11.0];
        // The next line down, close enough that the margin runs into it.
        let next = [40.5, 64.0, 210.0, 11.0];
        let covered = expand_roi(line, &[line, next], window);
        let read = read_roi(covered, window);
        assert!(
            intersect(read, next).is_some(),
            "the margin reaches {next:?}: {read:?}"
        );
        assert!(
            intersect(covered, next).is_none(),
            "but the reading claims it: {covered:?}"
        );
        // So what Vision returns from the margin is dropped, and what the
        // reading covers is kept.
        assert!(claims(line, covered), "the line the reading covers");
        assert!(!claims(next, covered), "the line only the margin reached");
        // Half the line's height inside is in; a hair less is out. A line off
        // the region's side is out however much of its height lines up.
        assert!(claims([40.5, 57.0, 100.0, 11.0], covered));
        assert!(!claims([40.5, 57.5, 100.0, 11.0], covered));
        assert!(!claims([300.0, 51.5, 100.0, 11.0], covered));
    }

    #[test]
    fn covered_is_the_union_area_fraction() {
        let roi = [0.0, 0.0, 100.0, 100.0];
        assert_eq!(covered(roi, &[]), 0.0);
        assert_eq!(covered(roi, &[[0.0, 0.0, 100.0, 100.0]]), 1.0);
        assert_eq!(covered(roi, &[[0.0, 0.0, 50.0, 100.0]]), 0.5);
        // Overlap is counted once, not twice.
        assert_eq!(
            covered(roi, &[[0.0, 0.0, 60.0, 100.0], [40.0, 0.0, 60.0, 100.0]]),
            1.0
        );
        // Outside the region contributes nothing.
        assert_eq!(covered(roi, &[[90.0, 0.0, 100.0, 100.0]]), 0.1);
        assert_eq!(covered(roi, &[[200.0, 200.0, 10.0, 10.0]]), 0.0);
    }

    #[test]
    fn a_multi_line_record_never_counts_as_coverage() {
        use super::super::bridge::Line;
        let line = |bbox: Rect, text: &str| Line {
            bbox,
            text: text.into(),
            conf: None,
        };
        let lines = [
            line([0.0, 0.0, 100.0, 10.0], "lens-fixture.txt"),
            line([0.0, 10.0, 100.0, 90.0], "line 01\nline 02\nline 03"),
            line([0.0, 90.0, 50.0, 10.0], "Regular"),
        ];
        assert_eq!(
            ax_coverage(&lines),
            [[0.0, 0.0, 100.0, 10.0], [0.0, 90.0, 50.0, 10.0]]
        );
        assert!(!ax_covers([0.0, 0.0, 100.0, 100.0], &ax_coverage(&lines)));
    }

    #[test]
    fn ax_covers_needs_both_the_area_and_the_line_count() {
        let roi = [0.0, 0.0, 100.0, 100.0];
        let three = [
            [0.0, 0.0, 100.0, 30.0],
            [0.0, 30.0, 100.0, 30.0],
            [0.0, 60.0, 100.0, 31.0],
        ];
        assert!(ax_covers(roi, &three));
        // One rect covering everything is still too thin a reading to trust.
        assert!(!ax_covers(roi, &[[0.0, 0.0, 100.0, 100.0]]));
        // Three lines that leave a fifth of the region uncovered do not.
        let sparse = [
            [0.0, 0.0, 100.0, 20.0],
            [0.0, 20.0, 100.0, 20.0],
            [0.0, 40.0, 100.0, 20.0],
        ];
        assert!(!ax_covers(roi, &sparse));
    }

    /// The ring hands out packed rows; a buffer that cannot hold the geometry it
    /// claims is refused rather than read past its end.
    #[test]
    fn a_buffer_too_short_for_its_geometry_is_refused() {
        assert_eq!(
            recognize_bgra(&[0u8; 16], 4, 2, None, false),
            (Vec::new(), 0)
        );
        assert_eq!(
            recognize_bgra(&[0u8; 16], 0, 2, None, false),
            (Vec::new(), 0)
        );
    }

    /// Needs Vision, so it is ignored by default: the measurement behind
    /// [`ROI_PAD`]. Recognize a frame whole, hand Vision one line's own box
    /// straight back, and hand it [`expand_roi`]'s widening of that same box.
    /// The tight box loses glyphs; the widened one reads what the whole frame
    /// read.
    #[test]
    #[ignore]
    fn a_line_read_in_its_own_box_needs_the_margin() {
        let (width, height) = (1802u32, 2260u32);
        let bgra = text_frame("LENS OCR", 6, width, height);
        let window = [0.0, 0.0, f64::from(width), f64::from(height)];
        let (whole, _) = recognize_bgra(&bgra, width, height, None, false);
        let Some((box_, expected, _)) = whole.first().cloned() else {
            panic!("the whole frame read nothing at all");
        };
        // Vision's normalized bottom-left box over the whole buffer, back into
        // the pixel rect the lens stores as a known line.
        let line = [
            box_[0] * f64::from(width),
            (1.0 - box_[1] - box_[3]) * f64::from(height),
            box_[2] * f64::from(width),
            box_[3] * f64::from(height),
        ];
        let read = |roi: Rect| {
            let px = [
                roi[0].max(0.0).round() as u32,
                roi[1].max(0.0).round() as u32,
                roi[2].round() as u32,
                roi[3].round() as u32,
            ];
            let (lines, _) = recognize_bgra(
                &bgra,
                width,
                height,
                Some(pixels_to_norm(px, width, height)),
                false,
            );
            lines
                .into_iter()
                .map(|line| line.1)
                .collect::<Vec<_>>()
                .join(" ")
        };
        let tight = read(line);
        let widened = read(read_roi(expand_roi(line, &[line], window), window));
        eprintln!(
            "whole {expected:?}\n  tight box {line:?} -> {tight:?}\n  widened -> {widened:?}"
        );
        assert_eq!(widened, expected, "the widened region reads the whole line");
    }

    /// Needs Vision, so it is ignored by default: proof that the ring's BGRA
    /// bytes reach the recognizer with the right stride and format.
    #[test]
    #[ignore]
    fn recognition_reads_a_synthetic_bgra_frame() {
        let (width, height) = (640u32, 200u32);
        let bgra = text_frame("LENS OCR", 14, width, height);
        let (lines, ms) = recognize_bgra(&bgra, width, height, None, false);
        let read: Vec<&str> = lines.iter().map(|line| line.1.as_str()).collect();
        eprintln!("{ms} ms, {} lines: {read:?}", lines.len());
        assert!(!lines.is_empty(), "blocky text is still text");
        for (box_, ..) in &lines {
            assert!(
                box_[0] >= 0.0 && box_[1] >= 0.0 && box_[0] + box_[2] <= 1.001,
                "normalized box {box_:?}"
            );
        }
    }
}
