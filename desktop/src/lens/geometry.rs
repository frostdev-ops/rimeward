//! Pure capture-time transforms and region geometry, shared by native backends.
use super::bridge::Rect;

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

pub(super) fn union(a: Rect, b: Rect) -> Rect {
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

pub(super) fn intersect(a: Rect, b: Rect) -> Option<Rect> {
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
        let (i, j) = cheapest_pair(&out);
        out[i] = union(out[i], out[j]);
        out.remove(j);
    }
    out
}

pub(super) fn cheapest_pair(rects: &[Rect]) -> (usize, usize) {
    let mut best = (0usize, 1usize, f64::MAX);
    for i in 0..rects.len() {
        for j in i + 1..rects.len() {
            let waste = area(union(rects[i], rects[j])) - area(rects[i]) - area(rects[j]);
            if waste < best.2 {
                best = (i, j, waste);
            }
        }
    }
    (best.0, best.1)
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
