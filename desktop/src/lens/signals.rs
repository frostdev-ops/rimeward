//! Where the lens learns what it is looking at: NSWorkspace activation on the
//! main thread, and an `AXObserver` on its own run loop for focus, value,
//! title, window and sheet changes.
//!
//! Without the Accessibility grant the lens still runs, OCR-only: no focus or
//! sheet signals, `axCovered` always false, and a 2 s poll that attaches the
//! observer the moment the grant appears.
//!
//! # Coordinates
//!
//! AX and `CGWindowListCopyWindowInfo` both report screen points: the global
//! display space, origin at the main display's top-left, y down. [`Target`]`
//! .bounds` and [`Kind::Window`]`.bounds` keep that space, because capture
//! needs it to place a source rect on a display. Everything that describes
//! content *inside* the target window — [`Kind::AxFocus`], [`Kind::AxValue`],
//! [`Kind::AxText`], [`Kind::AxSheet`] — is converted with
//! [`screen_to_window`] first. [`Kind::AxWindow`] is the exception and stays
//! in screen points: it re-reports the same rectangle as `Kind::Window`, and a
//! window move is invisible in window points, where the rect is always
//! `[0, 0, w, h]`.

use super::bridge::{Cover, DisplayInfo, Kind, Line, Rect};
use super::{Lens, Target};
use objc2_core_foundation::{
    kCFRunLoopDefaultMode, CFArray, CFBoolean, CFDictionary, CFNumber, CFRetained, CFRunLoop,
    CFRunLoopMode, CFRunLoopSource, CFString, CFType, CGPoint, CGSize, Type, CFURL,
};
use objc2_core_graphics::{
    kCGWindowBounds, kCGWindowIsOnscreen, kCGWindowLayer, kCGWindowName, kCGWindowNumber,
    kCGWindowOwnerPID, CGWindowListCopyWindowInfo, CGWindowListOption,
};
use std::cell::RefCell;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// Idle cadence for re-reading the focused window's bounds.
pub const POLL_IDLE: Duration = Duration::from_millis(500);
/// Cadence for the second after a bounds change, so a drag is followed rather
/// than sampled.
pub const POLL_ACTIVE: Duration = Duration::from_millis(33);
/// How long the active cadence lasts after the last change.
pub const ACTIVE_FOR: Duration = Duration::from_secs(1);
/// How often the lens re-checks for an Accessibility grant it does not have.
pub const TRUST_POLL: Duration = Duration::from_secs(2);
/// Floor between two AX text snapshots driven by value changes. Focus and
/// window changes snapshot straight away.
pub const TEXT_EVERY: Duration = Duration::from_secs(1);
/// Elements the AX text walk will visit before giving up.
pub const MAX_ELEMENTS: usize = 300;
/// Wall-clock the AX text walk gets. A deep tree in a slow app is abandoned
/// rather than allowed to stall the poll.
pub const WALK_BUDGET: Duration = Duration::from_millis(50);
/// Characters of `AXValue` that reach a signal. A text area's value is the
/// whole document; nobody downstream wants it on every keystroke.
pub const VALUE_CAP: usize = 2000;
/// Every AX read is capped, so an unresponsive target cannot wedge the poll
/// loop or the main thread.
const AX_TIMEOUT_S: f32 = 0.25;

/// A window drag produces continuous change for as long as the mouse is down;
/// polling at 500 ms would put captions a half-second behind it.
pub fn poll_schedule(since_change: Duration) -> Duration {
    if since_change < ACTIVE_FOR {
        POLL_ACTIVE
    } else {
        POLL_IDLE
    }
}

/// Screen points → window points. AX reports every position in the global
/// display space; everything downstream of the lens speaks window points.
pub fn screen_to_window(rect: Rect, window_bounds: Rect) -> Rect {
    [
        rect[0] - window_bounds[0],
        rect[1] - window_bounds[1],
        rect[2],
        rect[3],
    ]
}

/// The roles the AX text snapshot collects. Containers are walked but never
/// contribute a line of their own.
pub fn is_text_role(role: &str) -> bool {
    matches!(
        role,
        "AXStaticText" | "AXTextField" | "AXTextArea" | "AXButton"
    )
}

/// `AXValue` as a signal carries, cut on a character boundary.
pub fn truncate_value(text: &str, cap: usize) -> String {
    match text.char_indices().nth(cap) {
        None => text.to_owned(),
        Some((end, _)) => text[..end].to_owned(),
    }
}

/// The rectangle an `ax-text` snapshot covers: the union of its lines, or an
/// empty rect when it found none.
pub fn union_rect(lines: &[Line]) -> Rect {
    let mut bounds: Option<[f64; 4]> = None;
    for line in lines {
        let [x, y, w, h] = line.bbox;
        bounds = Some(match bounds {
            None => [x, y, x + w, y + h],
            Some([l, t, r, b]) => [l.min(x), t.min(y), r.max(x + w), b.max(y + h)],
        });
    }
    match bounds {
        None => [0.0, 0.0, 0.0, 0.0],
        Some([l, t, r, b]) => [l, t, r - l, b - t],
    }
}

/// Whether a freshly resolved target is a different thing to look at, which
/// is what bumps the epoch. A move, a resize or a retitle is the same window
/// and reaches the consumer as `ax-window` instead.
pub fn needs_retarget(current: Option<&Target>, next: &Target) -> bool {
    match current {
        None => true,
        Some(current) => {
            current.pid != next.pid
                || current.window_id != next.window_id
                || current.display.id != next.display.id
        }
    }
}

/// One `CGWindowListCopyWindowInfo` entry, parsed. The lens only needs six of
/// the dictionary's keys, and parsing them out first is what makes the
/// selection rule testable without a window server.
#[derive(Clone, Debug, PartialEq)]
pub struct WindowRecord {
    pub id: u32,
    pub pid: i32,
    /// `kCGWindowLayer`. Normal document windows are 0; the menu bar, the
    /// Dock and screen-saver windows are not.
    pub layer: i32,
    pub on_screen: bool,
    /// Screen points.
    pub bounds: Rect,
    pub title: String,
}

/// The main window of `pid`: the largest on-screen layer-0 window, preferring
/// the ones that have a title. Front-to-back order alone picks the wrong thing
/// — TextEdit keeps a 66x20 accessory window titled "Window" in front of its
/// document — and `CGWindowListCopyWindowInfo` returns front to back, so on a
/// tie the frontmost still wins.
pub fn pick_window(records: &[WindowRecord], pid: i32) -> Option<&WindowRecord> {
    records
        .iter()
        .filter(|record| {
            record.pid == pid
                && record.layer == 0
                && record.on_screen
                && record.bounds[2] > 0.0
                && record.bounds[3] > 0.0
        })
        .map(|record| {
            (
                record,
                (
                    !record.title.is_empty(),
                    record.bounds[2] * record.bounds[3],
                ),
            )
        })
        .reduce(|best, next| if next.1 > best.1 { next } else { best })
        .map(|(record, _)| record)
}

/// What [`covering`] reports when the target window is not in the on-screen
/// list at all: minimised, closed, or on another Space. Everything the capture
/// holds at its rectangle then belongs to something else.
pub const OFF_SCREEN: &str = "not on screen";

/// Two rectangles that share any area at all.
fn intersects(a: Rect, b: Rect) -> bool {
    (a[0] + a[2]).min(b[0] + b[2]) > a[0].max(b[0])
        && (a[1] + a[3]).min(b[1] + b[3]) > a[1].max(b[1])
}

/// What is drawn over the target window inside the target's own rectangle, or
/// `None` when the target is the top window there.
///
/// `records` is `CGWindowListCopyWindowInfo`'s own front-to-back order, so
/// everything ahead of the target's entry is in front of it. Three kinds of
/// window are deliberately not covers:
/// - this application's own, which the content filter excludes from every
///   frame anyway (research/capture-matrix.md cell i),
/// - the target application's own: a sheet, a dialog or a second document
///   window over the target is exactly what the display filter was chosen to
///   see (cells iii, iv, v.b), and it is the target's own content,
/// - anything off layer 0.
///
/// That last class is mostly the menu bar, the Dock and notification banners,
/// which sit above every window and are not what "another window is over this
/// one" means. It is not only those, and the residual is real: an opaque
/// floating panel of another application does cover the target and this rule
/// will not report it. The line is drawn at layer 0 because counting anything
/// above it false-positives permanently — on this very Mac a layer-3 ChatGPT
/// window spans the whole display at alpha 1.0, so a wider rule would report a
/// cover that never clears and the lens would stop reading altogether. A
/// foreign floating window is therefore still read as the target, and that is
/// the one case this guard does not catch.
///
/// An empty list is a failed read, which says nothing rather than something
/// false.
pub fn covering(
    records: &[WindowRecord],
    window_id: u32,
    pid: i32,
    bounds: Rect,
    own_pid: i32,
) -> Option<Cover> {
    if records.is_empty() {
        return None;
    }
    let Some(front) = records.iter().position(|record| record.id == window_id) else {
        return Some(Cover {
            by: OFF_SCREEN.into(),
            pid: 0,
            id: 0,
            bounds: None,
        });
    };
    records[..front]
        .iter()
        .find(|record| {
            record.layer == 0
                && record.on_screen
                && record.pid != pid
                && record.pid != own_pid
                && intersects(record.bounds, bounds)
        })
        .map(|record| Cover {
            by: record.title.clone(),
            pid: record.pid,
            id: record.id,
            bounds: Some(screen_to_window(record.bounds, bounds)),
        })
}

/// [`covering`] against the window server as it stands, named by the covering
/// application rather than by its window. One `CGWindowListCopyWindowInfo`
/// read; capture calls it once per frame, which is twice a second.
pub fn cover_now(window_id: u32, pid: i32, bounds: Rect, own_pid: i32) -> Option<Cover> {
    let mut cover = covering(&window_records(), window_id, pid, bounds, own_pid)?;
    if cover.pid != 0 {
        // The application's name beats the window's title: it is what a person
        // recognises, and a foreign window's title is somebody else's content.
        if let Some(name) = app_name(cover.pid) {
            cover.by = name;
        }
        if cover.by.is_empty() {
            cover.by = format!("pid {}", cover.pid);
        }
    }
    Some(cover)
}

fn app_name(pid: i32) -> Option<String> {
    use objc2_app_kit::NSRunningApplication;
    NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?
        .localizedName()
        .map(|name| name.to_string())
        .filter(|name| !name.is_empty())
}

/// The application in front right now, read rather than waited for.
pub fn frontmost_pid() -> Option<i32> {
    objc2_app_kit::NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .map(|app| app.processIdentifier())
}

/// A display, in the same screen points as every other rectangle here.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Screen {
    pub info: DisplayInfo,
    /// Screen points, top-left origin.
    pub frame: Rect,
}

/// The display a point sits on, falling back to the first one and then to a
/// neutral 1x display, so a target always carries a scale capture can plan
/// against.
pub fn display_for(screens: &[Screen], centre: (f64, f64)) -> DisplayInfo {
    let contains = |screen: &&Screen| {
        let [x, y, w, h] = screen.frame;
        centre.0 >= x && centre.0 < x + w && centre.1 >= y && centre.1 < y + h
    };
    screens
        .iter()
        .find(contains)
        .or(screens.first())
        .map(|screen| screen.info)
        .unwrap_or(DisplayInfo {
            id: 0,
            w: 0.0,
            h: 0.0,
            scale: 1.0,
        })
}

/// Everything a [`Target`] needs that does not come from the window itself.
#[derive(Clone, Debug, PartialEq)]
pub struct AppInfo {
    pub pid: i32,
    pub bundle: String,
    pub name: String,
}

/// The one place a `Target` is assembled, so the AX path and the
/// `CGWindowList` path cannot disagree about what a target is.
pub fn target_from(
    app: &AppInfo,
    window_id: u32,
    title: String,
    bounds: Rect,
    url: Option<String>,
    screens: &[Screen],
) -> Target {
    let centre = (bounds[0] + bounds[2] / 2.0, bounds[1] + bounds[3] / 2.0);
    Target {
        pid: app.pid,
        bundle: app.bundle.clone(),
        name: app.name.clone(),
        window_id,
        title,
        bounds,
        url,
        display: display_for(screens, centre),
    }
}

/// Depth-first, document order, under both budgets. `elapsed` is injected so
/// the cut is testable without a clock.
pub fn walk<N>(
    root: N,
    children: impl Fn(&N) -> Vec<N>,
    line: impl Fn(&N) -> Option<Line>,
    elapsed: impl Fn() -> Duration,
) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut stack = vec![root];
    let mut visited = 0usize;
    while let Some(node) = stack.pop() {
        if visited >= MAX_ELEMENTS || elapsed() >= WALK_BUDGET {
            break;
        }
        visited += 1;
        if let Some(line) = line(&node) {
            lines.push(line);
        }
        // Reversed, so the first child is the next one popped.
        stack.extend(children(&node).into_iter().rev());
    }
    lines
}

// ---------------------------------------------------------------------------
// Accessibility bindings
//
// There is no `objc2-application-services` in the tree and `accessibility-sys`
// is not a dependency, so these are declared here. Every AX reference is a
// `CFTypeRef`, which is why they travel as `CFRetained<CFType>`: the attribute
// getters return +1 and `CFRetained` releases.
// ---------------------------------------------------------------------------

type AxRef = *mut c_void;
type AxError = i32;
const AX_SUCCESS: AxError = 0;
const AX_VALUE_CG_POINT: u32 = 1;
const AX_VALUE_CG_SIZE: u32 = 2;

type AxCallback = unsafe extern "C" fn(
    observer: AxRef,
    element: AxRef,
    notification: *const CFString,
    refcon: *mut c_void,
);

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXUIElementCreateApplication(pid: i32) -> AxRef;
    fn AXUIElementSetMessagingTimeout(element: AxRef, timeout: f32) -> AxError;
    fn AXUIElementCopyAttributeValue(
        element: AxRef,
        attribute: &CFString,
        value: *mut *mut c_void,
    ) -> AxError;
    fn AXObserverCreate(pid: i32, callback: AxCallback, observer: *mut AxRef) -> AxError;
    fn AXObserverAddNotification(
        observer: AxRef,
        element: AxRef,
        notification: &CFString,
        refcon: *mut c_void,
    ) -> AxError;
    fn AXObserverRemoveNotification(
        observer: AxRef,
        element: AxRef,
        notification: &CFString,
    ) -> AxError;
    fn AXObserverGetRunLoopSource(observer: AxRef) -> *mut CFRunLoopSource;
    fn AXValueGetValue(value: AxRef, value_type: u32, out: *mut c_void) -> bool;
    /// Private, and the only way to line an AX window up with the window id
    /// ScreenCaptureKit and `CGWindowList` use.
    fn _AXUIElementGetWindow(element: AxRef, out: *mut u32) -> AxError;
}

/// Registered on the application element: AX treats it as the filter root, so
/// one registration covers every window and element the app owns.
const APP_NOTIFICATIONS: [&str; 7] = [
    "AXFocusedUIElementChanged",
    "AXTitleChanged",
    "AXWindowCreated",
    "AXSheetCreated",
    "AXFocusedWindowChanged",
    "AXWindowMoved",
    "AXWindowResized",
];
const VALUE_CHANGED: &str = "AXValueChanged";

fn raw(value: &CFType) -> AxRef {
    (value as *const CFType) as AxRef
}

/// `AXUIElementCopyAttributeValue`, owned. `None` covers both an error and an
/// attribute the element does not have; the lens treats those the same.
fn attribute(element: AxRef, name: &str) -> Option<CFRetained<CFType>> {
    let key = CFString::from_str(name);
    let mut out: *mut c_void = std::ptr::null_mut();
    let error = unsafe { AXUIElementCopyAttributeValue(element, &key, &mut out) };
    if error != AX_SUCCESS {
        return None;
    }
    NonNull::new(out.cast::<CFType>()).map(|ptr| unsafe { CFRetained::from_raw(ptr) })
}

fn string_attribute(element: AxRef, name: &str) -> Option<String> {
    let value = attribute(element, name)?;
    value.downcast_ref::<CFString>().map(CFString::to_string)
}

/// `AXValue` rendered as text. A text field's is a string, a checkbox's a
/// number, a disclosure triangle's a boolean; anything else is not text.
fn value_text(element: AxRef) -> String {
    let Some(value) = attribute(element, "AXValue") else {
        return String::new();
    };
    if let Some(text) = value.downcast_ref::<CFString>() {
        return text.to_string();
    }
    if let Some(number) = value.downcast_ref::<CFNumber>().and_then(CFNumber::as_f64) {
        return format!("{number}");
    }
    if let Some(flag) = value.downcast_ref::<CFBoolean>() {
        return flag.value().to_string();
    }
    String::new()
}

/// Screen points, from `AXPosition` and `AXSize`.
fn element_rect(element: AxRef) -> Option<Rect> {
    let position = attribute(element, "AXPosition")?;
    let size = attribute(element, "AXSize")?;
    let mut origin = CGPoint::ZERO;
    let mut extent = CGSize::ZERO;
    let ok = unsafe {
        AXValueGetValue(
            raw(&position),
            AX_VALUE_CG_POINT,
            (&mut origin as *mut CGPoint).cast(),
        ) && AXValueGetValue(
            raw(&size),
            AX_VALUE_CG_SIZE,
            (&mut extent as *mut CGSize).cast(),
        )
    };
    ok.then_some([origin.x, origin.y, extent.width, extent.height])
}

fn ax_children(element: &CFRetained<CFType>) -> Vec<CFRetained<CFType>> {
    let Some(value) = attribute(raw(element), "AXChildren") else {
        return Vec::new();
    };
    let Some(array) = value.downcast_ref::<CFArray>() else {
        return Vec::new();
    };
    (0..array.len())
        .filter_map(|index| {
            // +0: borrowed from the array, retained into an owned handle.
            let child = unsafe { array.value_at_index(index as isize) };
            NonNull::new(child.cast_mut().cast::<CFType>())
                .map(|ptr| unsafe { ptr.as_ref() }.retain())
        })
        .collect()
}

/// The `Line` an element contributes to an `ax-text` snapshot, in window
/// points, or `None` when it is a container, empty, or unplaced.
fn ax_line(element: &CFRetained<CFType>, window_bounds: Rect) -> Option<Line> {
    let element = raw(element);
    let role = string_attribute(element, "AXRole")?;
    if !is_text_role(&role) {
        return None;
    }
    let text = match value_text(element) {
        text if !text.trim().is_empty() => text,
        _ => string_attribute(element, "AXTitle").unwrap_or_default(),
    };
    if text.trim().is_empty() {
        return None;
    }
    let rect = element_rect(element)?;
    Some(Line {
        bbox: screen_to_window(rect, window_bounds),
        text: truncate_value(&text, VALUE_CAP),
        conf: None,
    })
}

/// `AXTitle`, else `AXDescription`: a toolbar button often has only the
/// second.
fn label_of(element: AxRef) -> String {
    string_attribute(element, "AXTitle")
        .filter(|title| !title.is_empty())
        .or_else(|| string_attribute(element, "AXDescription"))
        .unwrap_or_default()
}

/// The document a window is showing, when it says.
fn document_url(element: AxRef) -> Option<String> {
    if let Some(value) = attribute(element, "AXURL") {
        if let Some(url) = value.downcast_ref::<CFURL>() {
            return Some(url.string().to_string());
        }
        if let Some(text) = value.downcast_ref::<CFString>() {
            return Some(text.to_string());
        }
    }
    string_attribute(element, "AXDocument")
}

// ---------------------------------------------------------------------------
// Window server
// ---------------------------------------------------------------------------

/// Borrowed lookup into a `CGWindowList` entry. The dictionary owns the value.
unsafe fn entry<'a>(dictionary: &'a CFDictionary, key: &CFString) -> Option<&'a CFType> {
    let value = unsafe { dictionary.value((key as *const CFString).cast()) };
    (!value.is_null()).then(|| unsafe { &*value.cast::<CFType>() })
}

fn number(value: Option<&CFType>) -> Option<f64> {
    value?.downcast_ref::<CFNumber>()?.as_f64()
}

/// Every on-screen window, front to back, minus the desktop furniture.
fn window_records() -> Vec<WindowRecord> {
    let options =
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements;
    let Some(list) = CGWindowListCopyWindowInfo(options, 0) else {
        return Vec::new();
    };
    (0..list.len())
        .filter_map(|index| {
            let value = unsafe { list.value_at_index(index as isize) };
            let dictionary = NonNull::new(value.cast_mut().cast::<CFType>())?;
            let dictionary = unsafe { dictionary.as_ref() }.downcast_ref::<CFDictionary>()?;
            let bounds = unsafe { entry(dictionary, kCGWindowBounds) }?
                .downcast_ref::<CFDictionary>()
                .map(|rect| {
                    let read = |name: &str| {
                        let key = CFString::from_str(name);
                        number(unsafe { entry(rect, &key) }).unwrap_or(0.0)
                    };
                    [read("X"), read("Y"), read("Width"), read("Height")]
                })?;
            Some(WindowRecord {
                id: number(unsafe { entry(dictionary, kCGWindowNumber) })? as u32,
                pid: number(unsafe { entry(dictionary, kCGWindowOwnerPID) })? as i32,
                layer: number(unsafe { entry(dictionary, kCGWindowLayer) }).unwrap_or(0.0) as i32,
                on_screen: unsafe { entry(dictionary, kCGWindowIsOnscreen) }
                    .and_then(|value| value.downcast_ref::<CFBoolean>().map(CFBoolean::value))
                    .unwrap_or(true),
                bounds,
                title: unsafe { entry(dictionary, kCGWindowName) }
                    .and_then(|value| value.downcast_ref::<CFString>())
                    .map(CFString::to_string)
                    .unwrap_or_default(),
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

/// What the activation observer (main thread) and the `lens-ax` thread both
/// touch. The observer never blocks on the AX API: it leaves a pid here and
/// the AX thread picks it up within one poll.
struct Shared {
    lens: Arc<Lens>,
    stop: Arc<AtomicBool>,
    /// The pid the AX thread should be observing. 0 until the first
    /// activation.
    want_pid: AtomicI32,
    /// Refreshed on the main thread, read from the AX thread.
    screens: RwLock<Vec<Screen>>,
    changed_at: Mutex<Instant>,
}

impl Shared {
    fn mark_change(&self) {
        *self.changed_at.lock().unwrap() = Instant::now();
    }

    fn since_change(&self) -> Duration {
        self.changed_at.lock().unwrap().elapsed()
    }

    fn refresh_screens(&self, mtm: objc2_foundation::MainThreadMarker) {
        use objc2_app_kit::NSScreen;
        let screens = NSScreen::screens(mtm);
        // AppKit's global space is bottom-left origin off the first screen;
        // every rectangle the lens speaks is top-left.
        let main_height = screens
            .iter()
            .next()
            .map_or(0.0, |screen| screen.frame().size.height);
        let key = objc2_foundation::NSString::from_str("NSScreenNumber");
        let list = screens
            .iter()
            .map(|screen| {
                let frame = screen.frame();
                let id = screen
                    .deviceDescription()
                    .objectForKey(&key)
                    .and_then(|value| value.downcast::<objc2_foundation::NSNumber>().ok())
                    .map_or(0, |number| number.unsignedIntValue());
                Screen {
                    info: DisplayInfo {
                        id,
                        w: frame.size.width,
                        h: frame.size.height,
                        scale: screen.backingScaleFactor(),
                    },
                    frame: [
                        frame.origin.x,
                        main_height - frame.origin.y - frame.size.height,
                        frame.size.width,
                        frame.size.height,
                    ],
                }
            })
            .collect();
        *self.screens.write().unwrap() = list;
    }

    fn app_info(&self, pid: i32) -> Option<AppInfo> {
        use objc2_app_kit::NSRunningApplication;
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?;
        Some(AppInfo {
            pid,
            bundle: app
                .bundleIdentifier()
                .map(|id| id.to_string())
                .unwrap_or_default(),
            name: app
                .localizedName()
                .map(|name| name.to_string())
                .unwrap_or_default(),
        })
    }

    /// The window `pid` has in front, through AX when the grant is there and
    /// through the window server otherwise. `window` lets the AX thread hand
    /// in the focused element it already holds.
    fn build_target(&self, pid: i32, window: Option<&CFRetained<CFType>>) -> Option<Target> {
        let app = self.app_info(pid)?;
        let screens = self.screens.read().unwrap().clone();
        if let Some(window) = window {
            let element = raw(window);
            let mut id = 0u32;
            let ok = unsafe { _AXUIElementGetWindow(element, &mut id) } == AX_SUCCESS && id != 0;
            if let (true, Some(bounds)) = (ok, element_rect(element)) {
                return Some(target_from(
                    &app,
                    id,
                    string_attribute(element, "AXTitle").unwrap_or_default(),
                    bounds,
                    document_url(element),
                    &screens,
                ));
            }
        }
        let records = window_records();
        let record = pick_window(&records, pid)?;
        Some(target_from(
            &app,
            record.id,
            record.title.clone(),
            record.bounds,
            None,
            &screens,
        ))
    }

    /// An application came forward. Our own is never a target, which is also
    /// what keeps the probe's overlay window out of the lens.
    fn activate(&self, pid: i32) {
        if pid <= 0 || pid == self.lens.own_pid {
            return;
        }
        self.want_pid.store(pid, Ordering::Release);
        self.mark_change();
        let Some(target) = self.build_target(pid, None) else {
            return;
        };
        let current = self.lens.target.read().unwrap().clone();
        if needs_retarget(current.as_ref(), &target) {
            self.lens.retarget(target);
        }
    }
}

/// The activation observer and the AX thread.
pub struct Signals {
    stop: Arc<AtomicBool>,
}

impl Signals {
    /// Installs the NSWorkspace observer, points the lens at whatever is
    /// frontmost, and — with the Accessibility grant — starts the `lens-ax`
    /// thread. Without the grant it starts a 2 s poll that waits for it.
    ///
    /// The observer must be registered on the main thread, and NSWorkspace
    /// posts there, so the block runs there too. Rather than take an
    /// installer, this hops the main dispatch queue when it is not already on
    /// the main thread: that is the same thread Tauri's `run_on_main_thread`
    /// targets, and the probe's `CFRunLoop::run_in_mode` on the main thread
    /// drains that queue. Callers of [`Lens::start`] need no change.
    pub fn start(lens: Arc<Lens>) -> Result<Signals, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared {
            lens,
            stop: stop.clone(),
            want_pid: AtomicI32::new(0),
            screens: RwLock::new(Vec::new()),
            changed_at: Mutex::new(Instant::now()),
        });

        let installed = shared.clone();
        on_main(move || install_observer(installed));

        // A test process has no main run loop, so the hop above may not have
        // landed. Resolving the frontmost application here needs neither.
        if let Some(pid) = frontmost_pid() {
            shared.activate(pid);
        }

        if unsafe { AXIsProcessTrusted() } {
            start_ax_thread(shared);
        } else {
            // OCR-only until the grant appears; `ax: false` is already in the
            // Status the lens emitted on start.
            std::thread::Builder::new()
                .name("lens-ax-wait".into())
                .spawn(move || {
                    while !shared.stop.load(Ordering::Acquire) {
                        std::thread::sleep(TRUST_POLL);
                        if shared.stop.load(Ordering::Acquire) {
                            return;
                        }
                        if unsafe { AXIsProcessTrusted() } {
                            shared.lens.status_changed();
                            start_ax_thread(shared);
                            return;
                        }
                    }
                })
                .map_err(|error| error.to_string())?;
        }
        Ok(Signals { stop })
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
    }
}

/// Run `work` on the main thread, inline when that is already where we are.
fn on_main(work: impl FnOnce() + Send + 'static) {
    if objc2_foundation::MainThreadMarker::new().is_some() {
        work();
    } else {
        dispatch2::DispatchQueue::main().exec_async(work);
    }
}

fn install_observer(shared: Arc<Shared>) {
    use objc2_app_kit::NSRunningApplication;
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceApplicationKey, NSWorkspaceDidActivateApplicationNotification,
    };
    use objc2_foundation::{MainThreadMarker, NSNotification};

    if let Some(mtm) = MainThreadMarker::new() {
        shared.refresh_screens(mtm);
    }
    let observed = shared.clone();
    let block = block2::RcBlock::new(move |notification: NonNull<NSNotification>| {
        if observed.stop.load(Ordering::Acquire) {
            return;
        }
        // A display can be plugged in or rearranged between activations.
        if let Some(mtm) = MainThreadMarker::new() {
            observed.refresh_screens(mtm);
        }
        let pid = unsafe { notification.as_ref() }
            .userInfo()
            .and_then(|info| info.objectForKey(unsafe { NSWorkspaceApplicationKey }))
            .and_then(|app| app.downcast::<NSRunningApplication>().ok())
            .map(|app| app.processIdentifier());
        if let Some(pid) = pid {
            observed.activate(pid);
        }
    });
    // ponytail: the observer token is dropped rather than removed on stop; the
    // block returns immediately once `stop` is set. One inert block per
    // start/stop cycle, and those are driven by consent and permission
    // changes. Keep the token and remove it on the main thread if the lens
    // ever starts and stops on a timer.
    unsafe {
        NSWorkspace::sharedWorkspace()
            .notificationCenter()
            .addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidActivateApplicationNotification),
                None,
                None,
                &block,
            );
    }
    if let Some(app) = NSWorkspace::sharedWorkspace().frontmostApplication() {
        shared.activate(app.processIdentifier());
    }
}

// ---------------------------------------------------------------------------
// The `lens-ax` thread
// ---------------------------------------------------------------------------

fn start_ax_thread(shared: Arc<Shared>) {
    let _ = std::thread::Builder::new()
        .name("lens-ax".into())
        .spawn(move || ax_loop(shared));
}

/// Owns one `AXObserver` per target pid on this thread's own `CFRunLoop`.
/// Held in a `RefCell` behind a raw pointer because the C callback and the
/// loop body both need it and never run at the same time — the callback only
/// fires inside `run_in_mode`.
struct Ax {
    shared: Arc<Shared>,
    pid: i32,
    app: Option<CFRetained<CFType>>,
    observer: Option<CFRetained<CFType>>,
    /// The element `AXValueChanged` is registered on.
    focused: Option<CFRetained<CFType>>,
    refcon: *mut c_void,
    source_added: bool,
    text_due: bool,
    last_text: Instant,
}

fn ax_loop(shared: Arc<Shared>) {
    let state = Box::new(RefCell::new(Ax {
        shared: shared.clone(),
        pid: 0,
        app: None,
        observer: None,
        focused: None,
        refcon: std::ptr::null_mut(),
        source_added: false,
        text_due: false,
        last_text: Instant::now() - TEXT_EVERY,
    }));
    let refcon = (&*state as *const RefCell<Ax>) as *mut c_void;
    state.borrow_mut().refcon = refcon;

    let run_loop = CFRunLoop::current();
    let mode = unsafe { kCFRunLoopDefaultMode };
    while !shared.stop.load(Ordering::Acquire) {
        let running = {
            let mut ax = state.borrow_mut();
            ax.tick(&run_loop, mode);
            ax.source_added
        };
        let wait = poll_schedule(shared.since_change());
        if running {
            // AX notifications are delivered here.
            CFRunLoop::run_in_mode(mode, wait.as_secs_f64(), false);
        } else {
            // No source in this mode: `run_in_mode` would return at once.
            std::thread::sleep(wait);
        }
    }
    state.borrow_mut().detach(&run_loop, mode);
}

impl Ax {
    fn lens(&self) -> &Arc<Lens> {
        &self.shared.lens
    }

    fn tick(&mut self, run_loop: &Option<CFRetained<CFRunLoop>>, mode: Option<&CFRunLoopMode>) {
        // The activation notification is the fast path, not the only one.
        // Nothing else writes `want_pid`, and an `AXObserver` is scoped to one
        // process, so a notification this app never received would pin the
        // lens to one application for the rest of the session — a whole
        // session of app switches inside one epoch, which is what the field
        // report showed. Re-reading the frontmost application here is one
        // cached AppKit read per poll and is what makes `want_pid`
        // self-healing. `activate` stores it before it does anything else, so
        // the notification and this poll cannot both retarget the same switch.
        if let Some(pid) = frontmost_pid() {
            if pid != self.shared.want_pid.load(Ordering::Acquire) {
                self.shared.activate(pid);
            }
        }
        let want = self.shared.want_pid.load(Ordering::Acquire);
        if want != 0 && want != self.pid {
            self.detach(run_loop, mode);
            self.attach(want, run_loop, mode);
        }
        if self.app.is_none() {
            return;
        }
        self.poll_window();
        if self.text_due {
            self.text_due = false;
            self.snapshot_text();
        }
    }

    fn attach(
        &mut self,
        pid: i32,
        run_loop: &Option<CFRetained<CFRunLoop>>,
        mode: Option<&CFRunLoopMode>,
    ) {
        let app = unsafe { AXUIElementCreateApplication(pid) };
        let Some(app) =
            NonNull::new(app.cast::<CFType>()).map(|ptr| unsafe { CFRetained::from_raw(ptr) })
        else {
            return;
        };
        unsafe { AXUIElementSetMessagingTimeout(raw(&app), AX_TIMEOUT_S) };

        let mut observer: AxRef = std::ptr::null_mut();
        if unsafe { AXObserverCreate(pid, ax_notify, &mut observer) } != AX_SUCCESS {
            return;
        }
        let Some(observer) =
            NonNull::new(observer.cast::<CFType>()).map(|ptr| unsafe { CFRetained::from_raw(ptr) })
        else {
            return;
        };
        for name in APP_NOTIFICATIONS {
            let name = CFString::from_str(name);
            unsafe { AXObserverAddNotification(raw(&observer), raw(&app), &name, self.refcon) };
        }
        if let Some(run_loop) = run_loop {
            let source = unsafe { AXObserverGetRunLoopSource(raw(&observer)) };
            if let Some(source) = NonNull::new(source) {
                run_loop.add_source(Some(unsafe { source.as_ref() }), mode);
                self.source_added = true;
            }
        }
        self.pid = pid;
        self.app = Some(app);
        self.observer = Some(observer);
        self.text_due = true;
        // `AXFocusedUIElementChanged` only fires on a change; the element that
        // is already focused when we attach has to be read.
        self.seed_focus();
    }

    fn seed_focus(&mut self) {
        let Some(app) = self.app.as_ref().map(|app| raw(app)) else {
            return;
        };
        if let Some(element) = attribute(app, "AXFocusedUIElement") {
            self.on_focus(raw(&element));
        }
    }

    fn detach(&mut self, run_loop: &Option<CFRetained<CFRunLoop>>, mode: Option<&CFRunLoopMode>) {
        if let (Some(observer), Some(run_loop), true) =
            (&self.observer, run_loop, self.source_added)
        {
            let source = unsafe { AXObserverGetRunLoopSource(raw(observer)) };
            if let Some(source) = NonNull::new(source) {
                run_loop.remove_source(Some(unsafe { source.as_ref() }), mode);
            }
        }
        self.source_added = false;
        self.observer = None;
        self.app = None;
        self.focused = None;
        self.pid = 0;
    }

    /// The focused window every poll: a different window id is a retarget, a
    /// different rectangle or title is an `ax-window`.
    fn poll_window(&mut self) {
        let Some(app) = self.app.as_ref().map(|app| raw(app)) else {
            return;
        };
        let Some(window) = attribute(app, "AXFocusedWindow") else {
            return;
        };
        let current = self.lens().target.read().unwrap().clone();
        let mut id = 0u32;
        let same = unsafe { _AXUIElementGetWindow(raw(&window), &mut id) } == AX_SUCCESS
            && current
                .as_ref()
                .is_some_and(|target| target.pid == self.pid && target.window_id == id);
        if !same {
            let Some(target) = self.shared.build_target(self.pid, Some(&window)) else {
                return;
            };
            if needs_retarget(current.as_ref(), &target) {
                self.lens().retarget(target);
                self.shared.mark_change();
                self.text_due = true;
            }
            return;
        }
        let current = current.expect("same implies a target");
        let Some(bounds) = element_rect(raw(&window)) else {
            return;
        };
        let title = string_attribute(raw(&window), "AXTitle").unwrap_or_default();
        if bounds == current.bounds && title == current.title {
            return;
        }
        let moved = bounds != current.bounds;
        let target = {
            let mut guard = self.lens().target.write().unwrap();
            let Some(target) = guard.as_mut() else {
                return;
            };
            target.bounds = bounds;
            target.title = title.clone();
            target.clone()
        };
        self.lens().bridge.emit(Kind::AxWindow { title, bounds });
        if moved {
            // The display filter's source rect and every frame's geometry
            // come from the stream, not from this thread's copy of the bounds.
            self.lens().reframe(&target);
        }
        self.shared.mark_change();
        self.due_for_text();
    }

    /// Value and geometry changes only re-read the tree once a second; focus
    /// and window changes set `text_due` directly.
    fn due_for_text(&mut self) {
        if self.last_text.elapsed() >= TEXT_EVERY {
            self.text_due = true;
        }
    }

    fn snapshot_text(&mut self) {
        let Some(bounds) = self
            .lens()
            .target
            .read()
            .unwrap()
            .as_ref()
            .map(|target| target.bounds)
        else {
            return;
        };
        let Some(app) = self.app.as_ref().map(|app| raw(app)) else {
            return;
        };
        let Some(window) = attribute(app, "AXFocusedWindow") else {
            return;
        };
        let started = Instant::now();
        let lines = walk(
            window,
            ax_children,
            |element| ax_line(element, bounds),
            || started.elapsed(),
        );
        self.last_text = Instant::now();
        let rect = union_rect(&lines);
        self.lens().known.write().unwrap().ax = lines.clone();
        self.lens().bridge.emit(Kind::AxText { rect, lines });
    }

    /// Window points for anything inside the target, `None` when there is no
    /// target to be relative to.
    fn in_window(&self, rect: Option<Rect>) -> Option<Rect> {
        let bounds = self.lens().target.read().unwrap().as_ref()?.bounds;
        rect.map(|rect| screen_to_window(rect, bounds))
    }

    fn on_focus(&mut self, element: AxRef) {
        let Some(element) = NonNull::new(element.cast::<CFType>()) else {
            return;
        };
        let element = unsafe { element.as_ref() }.retain();
        // `AXValueChanged` follows the focus: on the app element it is every
        // progress bar in the process.
        if let (Some(observer), Some(previous)) = (&self.observer, &self.focused) {
            let name = CFString::from_str(VALUE_CHANGED);
            unsafe { AXObserverRemoveNotification(raw(observer), raw(previous), &name) };
        }
        if let Some(observer) = &self.observer {
            let name = CFString::from_str(VALUE_CHANGED);
            unsafe { AXObserverAddNotification(raw(observer), raw(&element), &name, self.refcon) };
        }
        let kind = self.describe(raw(&element), true);
        self.focused = Some(element);
        self.lens().known.write().unwrap().focus = Some(kind.clone());
        self.lens().bridge.emit(kind);
        self.shared.mark_change();
        self.text_due = true;
    }

    fn on_value(&mut self, element: AxRef) {
        let kind = self.describe(element, false);
        self.lens().bridge.emit(kind);
        self.shared.mark_change();
        self.due_for_text();
    }

    fn on_sheet(&mut self, element: AxRef) {
        let title = label_of(element);
        let bounds = self.in_window(element_rect(element)).unwrap_or_default();
        let kind = Kind::AxSheet { title, bounds };
        self.lens().known.write().unwrap().sheet = Some(kind.clone());
        self.lens().bridge.emit(kind);
        self.shared.mark_change();
    }

    fn describe(&self, element: AxRef, focus: bool) -> Kind {
        let role = string_attribute(element, "AXRole").unwrap_or_default();
        let label = label_of(element);
        let value = truncate_value(&value_text(element), VALUE_CAP);
        let bounds = self.in_window(element_rect(element));
        if focus {
            Kind::AxFocus {
                role,
                label,
                value,
                bounds,
            }
        } else {
            Kind::AxValue {
                role,
                label,
                value,
                bounds,
            }
        }
    }
}

/// The `AXObserver` callback. Runs on the `lens-ax` thread inside
/// `run_in_mode`, so the loop body is never mid-borrow.
unsafe extern "C" fn ax_notify(
    _observer: AxRef,
    element: AxRef,
    notification: *const CFString,
    refcon: *mut c_void,
) {
    let Some(state) = (unsafe { (refcon as *const RefCell<Ax>).as_ref() }) else {
        return;
    };
    let Ok(mut ax) = state.try_borrow_mut() else {
        return;
    };
    let Some(name) = (unsafe { notification.as_ref() }).map(CFString::to_string) else {
        return;
    };
    match name.as_str() {
        "AXFocusedUIElementChanged" => ax.on_focus(element),
        VALUE_CHANGED => ax.on_value(element),
        "AXSheetCreated" => ax.on_sheet(element),
        // Everything else is geometry or identity: the poll one tick later
        // reads the focused window and decides between `ax-window` and a
        // retarget, so there is one code path for both.
        _ => ax.shared.mark_change(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_poll_speeds_up_for_a_second_after_a_change() {
        assert_eq!(poll_schedule(Duration::ZERO), POLL_ACTIVE);
        assert_eq!(poll_schedule(Duration::from_millis(999)), POLL_ACTIVE);
        assert_eq!(poll_schedule(ACTIVE_FOR), POLL_IDLE);
        assert_eq!(poll_schedule(Duration::from_secs(30)), POLL_IDLE);
    }

    #[test]
    fn screen_rects_become_window_rects() {
        let window = [100.0, 200.0, 800.0, 600.0];
        assert_eq!(
            screen_to_window([150.0, 260.0, 40.0, 14.0], window),
            [50.0, 60.0, 40.0, 14.0]
        );
        // The window's own origin is the origin.
        assert_eq!(screen_to_window(window, window), [0.0, 0.0, 800.0, 600.0]);
        // Content scrolled above the window keeps a negative y rather than
        // clamping: the caller decides whether it is visible.
        assert_eq!(
            screen_to_window([90.0, 180.0, 10.0, 10.0], window),
            [-10.0, -20.0, 10.0, 10.0]
        );
    }

    #[test]
    fn only_text_bearing_roles_are_collected() {
        for role in ["AXStaticText", "AXTextField", "AXTextArea", "AXButton"] {
            assert!(is_text_role(role), "{role}");
        }
        for role in [
            "AXWindow",
            "AXGroup",
            "AXScrollArea",
            "AXImage",
            "",
            "AXCell",
        ] {
            assert!(!is_text_role(role), "{role}");
        }
    }

    #[test]
    fn a_long_value_is_cut_on_a_character_boundary() {
        assert_eq!(truncate_value("short", VALUE_CAP), "short");
        let long = "x".repeat(VALUE_CAP + 500);
        assert_eq!(truncate_value(&long, VALUE_CAP).len(), VALUE_CAP);
        // A multi-byte character at the cut must not be split.
        let accents = "é".repeat(10);
        assert_eq!(truncate_value(&accents, 4), "éééé");
        assert_eq!(truncate_value("", 10), "");
    }

    fn line(bbox: Rect, text: &str) -> Line {
        Line {
            bbox,
            text: text.into(),
            conf: None,
        }
    }

    #[test]
    fn the_snapshot_rect_is_the_union_of_its_lines() {
        assert_eq!(union_rect(&[]), [0.0, 0.0, 0.0, 0.0]);
        assert_eq!(
            union_rect(&[line([10.0, 20.0, 30.0, 14.0], "a")]),
            [10.0, 20.0, 30.0, 14.0]
        );
        assert_eq!(
            union_rect(&[
                line([10.0, 20.0, 30.0, 14.0], "a"),
                line([5.0, 40.0, 100.0, 14.0], "b"),
            ]),
            [5.0, 20.0, 100.0, 34.0]
        );
    }

    fn record(id: u32, pid: i32, layer: i32) -> WindowRecord {
        WindowRecord {
            id,
            pid,
            layer,
            on_screen: true,
            bounds: [0.0, 0.0, 800.0, 600.0],
            title: format!("w{id}"),
        }
    }

    #[test]
    fn the_frontmost_real_window_of_a_process_wins() {
        let records = vec![
            // The menu bar sits above everything and is never a target.
            WindowRecord {
                layer: 25,
                ..record(1, 42, 25)
            },
            // An offscreen window of the right process is skipped.
            WindowRecord {
                on_screen: false,
                ..record(2, 42, 0)
            },
            // So is a zero-sized one.
            WindowRecord {
                bounds: [0.0, 0.0, 0.0, 0.0],
                ..record(3, 42, 0)
            },
            record(4, 42, 0),
            record(5, 42, 0),
            record(6, 99, 0),
        ];
        assert_eq!(pick_window(&records, 42).map(|r| r.id), Some(4));
        assert_eq!(pick_window(&records, 99).map(|r| r.id), Some(6));
        assert_eq!(pick_window(&records, 7), None);
    }

    /// TextEdit puts a 66x20 accessory window titled "Window" in front of the
    /// document, and an untitled panel can be large. Neither is the target.
    #[test]
    fn a_tiny_accessory_window_never_beats_the_document_window() {
        let accessory = WindowRecord {
            bounds: [201.0, 98.0, 66.0, 20.0],
            title: "Window".into(),
            ..record(1, 42, 0)
        };
        let document = WindowRecord {
            bounds: [100.0, 60.0, 900.0, 700.0],
            title: "lines.txt".into(),
            ..record(2, 42, 0)
        };
        let untitled_panel = WindowRecord {
            bounds: [0.0, 0.0, 1512.0, 982.0],
            title: String::new(),
            ..record(3, 42, 0)
        };
        assert_eq!(
            pick_window(
                &[accessory.clone(), untitled_panel.clone(), document.clone()],
                42
            )
            .map(|r| r.id),
            Some(2)
        );
        // With nothing titled, the largest untitled window is still a window.
        assert_eq!(
            pick_window(&[accessory, untitled_panel], 42).map(|r| r.id),
            Some(1),
            "a titled accessory still beats an untitled panel"
        );
    }

    /// The Claude-for-Desktop delivery that started this: the app, the window
    /// and the focus were Claude's, every OCR line was a browser's, because a
    /// display filter captures whatever is drawn at the target's rectangle.
    /// Front to back, which is the order `CGWindowListCopyWindowInfo` returns.
    fn over_the_target() -> Vec<WindowRecord> {
        vec![
            // The menu bar sits above every window and is not a cover.
            WindowRecord {
                bounds: [0.0, 0.0, 1800.0, 39.0],
                title: String::new(),
                ..record(1, 300, 25)
            },
            // Ours: the content filter already keeps it out of every frame.
            WindowRecord {
                bounds: [1500.0, 100.0, 280.0, 120.0],
                title: "captions".into(),
                ..record(2, 999, 0)
            },
            // The browser the operator switched to, maximised over Claude.
            WindowRecord {
                bounds: [0.0, 39.0, 1800.0, 1130.0],
                title: "Pick an account".into(),
                ..record(3, 501, 0)
            },
            // Claude's own sheet, over Claude and behind the browser.
            WindowRecord {
                bounds: [500.0, 300.0, 400.0, 200.0],
                title: "Save".into(),
                ..record(4, 42, 0)
            },
            // The target.
            WindowRecord {
                bounds: [0.0, 39.0, 1800.0, 1130.0],
                title: "Claude".into(),
                ..record(7286, 42, 0)
            },
            // Behind it, so not a cover however large.
            WindowRecord {
                bounds: [0.0, 0.0, 1800.0, 1169.0],
                title: "Finder".into(),
                ..record(9, 77, 0)
            },
        ]
    }

    const TARGET: Rect = [0.0, 39.0, 1800.0, 1130.0];

    #[test]
    fn another_applications_window_over_the_target_is_a_cover() {
        let cover = covering(&over_the_target(), 7286, 42, TARGET, 999).expect("covered");
        assert_eq!(cover.pid, 501);
        assert_eq!(
            cover.by, "Pick an account",
            "the title, until AppKit names it"
        );
        // Window points: where it sits over the target, the way every other
        // in-window rectangle is reported.
        assert_eq!(cover.bounds, Some([0.0, 0.0, 1800.0, 1130.0]));
    }

    /// The whole reason the display filter was chosen over a window filter
    /// (research/capture-matrix.md cells iii, iv, v.b): a sheet, a dialog or a
    /// second document window of the target's own application is its content.
    #[test]
    fn the_targets_own_sheets_dialogs_and_second_windows_are_never_covers() {
        let mut records = over_the_target();
        records.retain(|record| record.pid != 501);
        assert_eq!(covering(&records, 7286, 42, TARGET, 999), None);
    }

    #[test]
    fn the_menu_bar_the_dock_and_our_own_windows_are_never_covers() {
        let mut records = over_the_target();
        records.retain(|record| record.pid != 501 && record.pid != 42 || record.id == 7286);
        // What is left in front of the target is the menu bar (layer 25) and
        // this application's own overlay.
        assert_eq!(covering(&records, 7286, 42, TARGET, 999), None);
        // Ours only stops being ours when it belongs to somebody else.
        assert_eq!(
            covering(&records, 7286, 42, TARGET, 1).map(|cover| cover.pid),
            Some(999)
        );
    }

    #[test]
    fn a_foreign_window_that_misses_the_target_is_not_a_cover() {
        let mut records = over_the_target();
        // Starting exactly on the target's right edge: touching, not covering.
        records[2].bounds = [1800.0, 39.0, 400.0, 300.0];
        assert_eq!(covering(&records, 7286, 42, TARGET, 999), None);
        records[2].bounds = [1400.0, 39.0, 400.0, 300.0];
        assert_eq!(
            covering(&records, 7286, 42, TARGET, 999).map(|cover| cover.pid),
            Some(501),
            "one point of overlap is still a cover"
        );
    }

    /// A target that is not in the on-screen list was minimised, closed or
    /// moved to another Space, so nothing at its rectangle is its own — the
    /// same failure as a cover, with no window to name.
    #[test]
    fn a_target_that_is_not_on_screen_is_reported_rather_than_read() {
        let records = over_the_target();
        let gone = covering(&records, 9999, 42, TARGET, 999).expect("not on screen");
        assert_eq!(gone.by, OFF_SCREEN);
        assert_eq!(gone.pid, 0);
        assert_eq!(gone.bounds, None);
        // A failed window-server read says nothing rather than something false.
        assert_eq!(covering(&[], 7286, 42, TARGET, 999), None);
    }

    fn screens() -> Vec<Screen> {
        vec![
            Screen {
                info: DisplayInfo {
                    id: 1,
                    w: 1512.0,
                    h: 982.0,
                    scale: 2.0,
                },
                frame: [0.0, 0.0, 1512.0, 982.0],
            },
            Screen {
                info: DisplayInfo {
                    id: 2,
                    w: 1920.0,
                    h: 1080.0,
                    scale: 1.0,
                },
                frame: [1512.0, 0.0, 1920.0, 1080.0],
            },
        ]
    }

    #[test]
    fn a_window_takes_the_display_its_centre_sits_on() {
        assert_eq!(display_for(&screens(), (100.0, 100.0)).id, 1);
        assert_eq!(display_for(&screens(), (2000.0, 500.0)).id, 2);
        // Off every display: the first one, so a target always has a scale.
        assert_eq!(display_for(&screens(), (-4000.0, 0.0)).id, 1);
        assert_eq!(display_for(&[], (0.0, 0.0)).scale, 1.0);
    }

    fn app() -> AppInfo {
        AppInfo {
            pid: 42,
            bundle: "com.apple.TextEdit".into(),
            name: "TextEdit".into(),
        }
    }

    #[test]
    fn a_window_record_becomes_a_target_on_the_display_it_sits_on() {
        let record = WindowRecord {
            bounds: [1600.0, 100.0, 800.0, 600.0],
            title: "Untitled".into(),
            ..record(11, 42, 0)
        };
        let target = target_from(
            &app(),
            record.id,
            record.title.clone(),
            record.bounds,
            None,
            &screens(),
        );
        assert_eq!(target.pid, 42);
        assert_eq!(target.bundle, "com.apple.TextEdit");
        assert_eq!(target.name, "TextEdit");
        assert_eq!(target.window_id, 11);
        assert_eq!(target.title, "Untitled");
        // Screen points, straight through: capture places a source rect with
        // them and every in-window rect is measured off this origin.
        assert_eq!(target.bounds, [1600.0, 100.0, 800.0, 600.0]);
        assert_eq!(target.url, None);
        assert_eq!(target.display.id, 2);
        assert_eq!(target.display.scale, 1.0);
    }

    #[test]
    fn a_different_window_of_the_same_app_is_a_retarget_but_a_move_is_not() {
        let first = target_from(
            &app(),
            11,
            "One".into(),
            [0.0, 0.0, 800.0, 600.0],
            None,
            &screens(),
        );
        assert!(needs_retarget(None, &first), "nothing to compare with");

        let moved = target_from(
            &app(),
            11,
            "One".into(),
            [40.0, 40.0, 800.0, 600.0],
            None,
            &screens(),
        );
        assert!(!needs_retarget(Some(&first), &moved), "a move is ax-window");

        let retitled = target_from(
            &app(),
            11,
            "Two".into(),
            [0.0, 0.0, 800.0, 600.0],
            None,
            &screens(),
        );
        assert!(
            !needs_retarget(Some(&first), &retitled),
            "a retitle is ax-window"
        );

        let other_window = target_from(
            &app(),
            12,
            "One".into(),
            [0.0, 0.0, 800.0, 600.0],
            None,
            &screens(),
        );
        assert!(needs_retarget(Some(&first), &other_window));

        let other_app = target_from(
            &AppInfo { pid: 43, ..app() },
            11,
            "One".into(),
            [0.0, 0.0, 800.0, 600.0],
            None,
            &screens(),
        );
        assert!(needs_retarget(Some(&first), &other_app));

        // Dragged to the other display: a new epoch, because the scale and
        // the capture stream change with it.
        let other_display = target_from(
            &app(),
            11,
            "One".into(),
            [1600.0, 0.0, 800.0, 600.0],
            None,
            &screens(),
        );
        assert!(needs_retarget(Some(&first), &other_display));
    }

    /// A fake tree: node `n` has `fanout` children until `depth` runs out.
    struct Fake {
        fanout: usize,
        depth: usize,
    }

    impl Fake {
        fn children(&self, node: &(usize, usize)) -> Vec<(usize, usize)> {
            let (level, index) = *node;
            if level >= self.depth {
                return Vec::new();
            }
            (0..self.fanout)
                .map(|n| (level + 1, index * 10 + n))
                .collect()
        }
    }

    #[test]
    fn the_walk_stops_at_three_hundred_elements() {
        let tree = Fake {
            fanout: 4,
            depth: 6,
        };
        let seen = std::cell::Cell::new(0usize);
        let lines = walk(
            (0usize, 0usize),
            |node| tree.children(node),
            |node| {
                seen.set(seen.get() + 1);
                Some(line([0.0, 0.0, 1.0, 1.0], &format!("{node:?}")))
            },
            Duration::default,
        );
        assert_eq!(lines.len(), MAX_ELEMENTS);
        assert_eq!(seen.get(), MAX_ELEMENTS);
    }

    #[test]
    fn the_walk_stops_at_the_fifty_millisecond_budget() {
        let tree = Fake {
            fanout: 4,
            depth: 6,
        };
        // A clock that advances 10 ms per visit: the budget cuts at five.
        let tick = std::cell::Cell::new(0u32);
        let lines = walk(
            (0usize, 0usize),
            |node| tree.children(node),
            |_| Some(line([0.0, 0.0, 1.0, 1.0], "x")),
            || {
                let now = tick.get();
                tick.set(now + 10);
                Duration::from_millis(u64::from(now))
            },
        );
        assert_eq!(lines.len(), 5, "0, 10, 20, 30 and 40 ms are under budget");
    }

    #[test]
    fn the_walk_is_depth_first_in_document_order() {
        let tree = Fake {
            fanout: 2,
            depth: 2,
        };
        let lines = walk(
            (0usize, 0usize),
            |node| tree.children(node),
            |node| {
                Some(line(
                    [0.0, 0.0, 1.0, 1.0],
                    &format!("{}.{}", node.0, node.1),
                ))
            },
            Duration::default,
        );
        let order: Vec<&str> = lines.iter().map(|line| line.text.as_str()).collect();
        assert_eq!(order, ["0.0", "1.0", "2.0", "2.1", "1.1", "2.10", "2.11"]);
    }

    // --- integration: needs a real desktop, Accessibility and a second app ---

    /// A lens whose signals reach a channel the test can read, drained by the
    /// same writer task the app and the probe run.
    fn channel_backed() -> (
        Arc<super::super::Lens>,
        tokio::sync::mpsc::UnboundedReceiver<String>,
    ) {
        use super::super::{Config, Lens};
        let (writer, lines) = tokio::sync::mpsc::unbounded_channel::<String>();
        let lens = Lens::new(Config::default(), writer);
        let bridge = lens.bridge.clone();
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("test runtime")
                .block_on(bridge.run_writer());
        });
        (lens, lines)
    }

    /// Starts the lens on whatever is frontmost and reads the signals back off
    /// the writer channel. `cargo test -- --ignored` with TextEdit installed.
    #[test]
    #[ignore = "drives the real desktop: needs Accessibility and TextEdit"]
    fn signals_target_the_frontmost_application() {
        use serde_json::Value;

        // No Accessibility grant needed: without it the frontmost window is
        // resolved through `CGWindowListCopyWindowInfo` instead.
        // Bring a known application forward before starting, so the initial
        // resolution has something to find. Switch notifications need a main
        // run loop, which a test process does not have; the probe covers them.
        let _ = std::process::Command::new("osascript")
            .args(["-e", "tell application \"TextEdit\" to activate"])
            .status();
        std::thread::sleep(Duration::from_millis(1500));

        let (lens, mut lines) = channel_backed();
        let signals = Signals::start(lens.clone()).expect("signals start");
        std::thread::sleep(Duration::from_secs(3));
        signals.stop();

        let mut kinds = Vec::new();
        while let Ok(line) = lines.try_recv() {
            let value: Value = serde_json::from_str(&line).unwrap();
            kinds.push(value["kind"].as_str().unwrap_or_default().to_owned());
        }
        assert!(kinds.iter().any(|kind| kind == "app"), "{kinds:?}");
        assert!(kinds.iter().any(|kind| kind == "window"), "{kinds:?}");
        let target = lens.target.read().unwrap().clone().expect("a target");
        assert_eq!(target.bundle, "com.apple.TextEdit");
        assert!(target.window_id > 0);
        assert!(target.bounds[2] > 0.0 && target.bounds[3] > 0.0);
    }

    /// With the grant, the AX thread reports the focused element and a text
    /// snapshot of the window it is in.
    #[test]
    #[ignore = "drives the real desktop: needs Accessibility and TextEdit"]
    fn the_ax_thread_reports_focus_and_text() {
        use serde_json::Value;

        if !unsafe { AXIsProcessTrusted() } {
            eprintln!("skipped: this process has no Accessibility grant");
            return;
        }
        let _ = std::process::Command::new("osascript")
            .args([
                "-e",
                "tell application \"TextEdit\"\nactivate\nif (count of documents) = 0 then make new document\nset text of document 1 to \"rimeward lens line one\"\nend tell",
            ])
            .status();
        std::thread::sleep(Duration::from_millis(1500));

        let (lens, mut lines) = channel_backed();
        let signals = Signals::start(lens.clone()).expect("signals start");
        std::thread::sleep(Duration::from_secs(3));
        signals.stop();

        let mut kinds = Vec::new();
        while let Ok(line) = lines.try_recv() {
            let value: Value = serde_json::from_str(&line).unwrap();
            kinds.push(value["kind"].as_str().unwrap_or_default().to_owned());
        }
        assert!(kinds.iter().any(|kind| kind == "ax-text"), "{kinds:?}");
        assert!(
            !lens.known.read().unwrap().ax.is_empty(),
            "the snapshot is kept for ROI expansion"
        );
    }
}
