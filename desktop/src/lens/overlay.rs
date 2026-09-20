//! The overlay: a pool of eight transparent click-through windows a host draws
//! into, and nothing else.
//!
//! The pool is built hidden at setup and reused forever, because building a
//! `WebviewWindow` costs a webview and destroying one under a running capture
//! costs a filter rebuild. Every window is small and sized to its content:
//! VISION.md §11 measured a transparent Tauri window at about eight times the
//! GPU power on macOS 26.x, so the overlay is never one full-screen sheet.
//!
//! Rust owns placement, the page owns rendering. Rust emits `overlay:show`
//! `{id, kind, text, w, h, origin}` to one slot window, the page renders and
//! answers `overlay:ready {id}`, and the window is revealed on that
//! acknowledgement or 100 ms later, whichever comes first.

use super::bridge::{Bridge, Kind, Rect};
use super::Lens;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, Listener, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

/// The pool size. Eight is what the plan fixed: more than any one host asks
/// for at once, few enough that they all fit in the GPU budget.
pub const SLOTS: usize = 8;
pub const LABELS: [&str; SLOTS] = [
    "ov-0", "ov-1", "ov-2", "ov-3", "ov-4", "ov-5", "ov-6", "ov-7",
];

/// The hotkey that turns click-through off so a card can be clicked.
pub const HOTKEY: &str = "CmdOrCtrl+Shift+L";
/// Registered only while interactive, so Esc is the user's own way back.
pub const ESCAPE: &str = "Escape";

const CARD_W: f64 = 360.0;
const CARD_H: f64 = 160.0;
/// A corner-anchored caption wraps at this width.
const CAPTION_MAX_W: f64 = 480.0;
/// A highlight is the rect plus this much on every side.
const HIGHLIGHT_PAD: f64 = 4.0;
/// A corner anchor sits this far inside the target window's corner.
const CORNER_INSET: f64 = 16.0;
/// Smaller than this and the page has nothing to draw into.
const MIN_W: f64 = 24.0;
const MIN_H: f64 = 16.0;

const DEFAULT_TTL_MS: u64 = 10_000;
const MIN_TTL_MS: u64 = 500;
const MAX_TTL_MS: u64 = 600_000;
/// The page's own cap. Longer text is refused rather than silently cut.
const MAX_TEXT: usize = 2_000;
/// How long a reveal waits for `overlay:ready` before showing anyway.
const ACK_WAIT: Duration = Duration::from_millis(100);
const TICK: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OverlayKind {
    Card,
    Caption,
    Highlight,
}

impl OverlayKind {
    fn parse(name: &str) -> Option<OverlayKind> {
        match name {
            "card" => Some(OverlayKind::Card),
            "caption" => Some(OverlayKind::Caption),
            "highlight" => Some(OverlayKind::Highlight),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Corner {
    Tl,
    Tr,
    Bl,
    Br,
}

impl Corner {
    fn parse(name: &str) -> Option<Corner> {
        match name {
            "tl" => Some(Corner::Tl),
            "tr" => Some(Corner::Tr),
            "bl" => Some(Corner::Bl),
            "br" => Some(Corner::Br),
            _ => None,
        }
    }
}

/// Where the overlay is pinned. A `Rect` is window points measured against the
/// frame named by `frame_ref`; placement still uses the *current* target
/// bounds, because the window may have moved since that frame was captured.
#[derive(Clone, Debug, PartialEq)]
pub enum Anchor {
    Rect { rect: Rect, frame_ref: String },
    Corner(Corner),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ShowReq {
    pub id: String,
    pub kind: OverlayKind,
    pub text: String,
    pub anchor: Anchor,
    pub ttl_ms: u64,
    pub epoch: u64,
    /// A corner-anchored slot with `sticky` survives a retarget.
    pub sticky: bool,
}

impl ShowReq {
    /// `bad-request` for anything malformed: the values cross a process
    /// boundary and one of them becomes a window key.
    pub fn parse(value: &Value) -> Result<ShowReq, String> {
        let id = value["id"].as_str().ok_or("bad-request")?;
        if id.is_empty() || id.len() > 32 || !id.bytes().all(is_id_byte) {
            return Err("bad-request".into());
        }
        let kind = value["kind"]
            .as_str()
            .and_then(OverlayKind::parse)
            .ok_or("bad-request")?;
        let text = value["text"].as_str().unwrap_or_default();
        if text.chars().count() > MAX_TEXT {
            return Err("too-large".into());
        }
        let anchor = &value["anchor"];
        let anchor = match anchor["corner"].as_str() {
            Some(corner) => Anchor::Corner(Corner::parse(corner).ok_or("bad-request")?),
            None => Anchor::Rect {
                rect: super::rect(&anchor["rect"]).ok_or("bad-rect")?,
                frame_ref: anchor["ref"].as_str().ok_or("bad-request")?.to_owned(),
            },
        };
        Ok(ShowReq {
            id: id.to_owned(),
            kind,
            text: text.to_owned(),
            anchor,
            ttl_ms: ttl_ms(value),
            epoch: value["epoch"].as_u64().ok_or("bad-request")?,
            sticky: value["sticky"] == true,
        })
    }
}

fn is_id_byte(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
}

/// `ttlMs`, the one spelling the op has: `captions.ts` converts the tool's
/// `ttl_s`. Absent means the default, out of range means the nearer bound.
fn ttl_ms(value: &Value) -> u64 {
    let ms = value["ttlMs"].as_f64().unwrap_or(DEFAULT_TTL_MS as f64);
    (ms as u64).clamp(MIN_TTL_MS, MAX_TTL_MS)
}

/// What an anchor is resolved against: the target window and the display it
/// sits on, both in screen points.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Place {
    pub window: Rect,
    pub display: Rect,
}

/// One window in the pool. Free when `id` is `None`.
struct Slot {
    label: &'static str,
    id: Option<String>,
    kind: OverlayKind,
    anchor: Anchor,
    /// The size the anchor asked for, before the display clamp.
    size: (f64, f64),
    sticky: bool,
    epoch: u64,
    shown_at: Instant,
    expires_at: Instant,
}

impl Slot {
    fn new(label: &'static str) -> Slot {
        let now = Instant::now();
        Slot {
            label,
            id: None,
            kind: OverlayKind::Card,
            anchor: Anchor::Corner(Corner::Tr),
            size: (CARD_W, CARD_H),
            sticky: false,
            epoch: 0,
            shown_at: now,
            expires_at: now,
        }
    }
}

pub struct Overlay {
    app: AppHandle,
    bridge: Arc<Bridge>,
    slots: Mutex<Vec<Slot>>,
    interactive: AtomicBool,
    /// Ids the page has acknowledged and no reveal has consumed yet.
    ready: Mutex<HashSet<String>>,
}

impl Overlay {
    /// Builds the pool hidden and wires the acknowledgement listener, the TTL
    /// tick and the hotkey. Main thread only: it touches raw `NSWindow`s.
    pub fn build(app: &AppHandle, lens: &Arc<Lens>) -> Result<Arc<Overlay>, String> {
        let overlay = Arc::new(Overlay {
            app: app.clone(),
            bridge: lens.bridge.clone(),
            slots: Mutex::new(LABELS.iter().map(|label| Slot::new(label)).collect()),
            interactive: AtomicBool::new(false),
            ready: Mutex::new(HashSet::new()),
        });
        // The capture filter excludes the pool by window id, so the ids are
        // collected as the windows are made and handed to the lens before any
        // stream could be built on them.
        let mut windows = Vec::with_capacity(SLOTS);
        for label in LABELS {
            windows.extend(slot_window(app, label).map_err(|error| error.to_string())?);
        }
        lens.set_overlay_windows(windows);
        let acked = overlay.clone();
        app.listen("overlay:ready", move |event| {
            let Some(id) = serde_json::from_str::<Value>(event.payload())
                .ok()
                .and_then(|value| value["id"].as_str().map(str::to_owned))
            else {
                return;
            };
            let mut ready = acked.ready.lock().unwrap();
            // Bounded: a page that acknowledged ids nobody asked for cannot
            // grow this without limit.
            if ready.len() < SLOTS * 4 {
                ready.insert(id);
            }
        });
        let ticking = overlay.clone();
        std::thread::Builder::new()
            .name("overlay-tick".into())
            .spawn(move || loop {
                std::thread::sleep(TICK);
                ticking.tick();
            })
            .map_err(|error| error.to_string())?;
        let hotkey = overlay.clone();
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
        app.global_shortcut()
            .on_shortcut(HOTKEY, move |_, _, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                // The macOS hotkey handler runs on the main thread, and both
                // `set_ignore_cursor_events` and `unregister` block on it.
                let hotkey = hotkey.clone();
                std::thread::spawn(move || {
                    hotkey.set_interactive(!hotkey.interactive());
                });
            })
            .map_err(|error| error.to_string())?;
        Ok(overlay)
    }

    pub fn interactive(&self) -> bool {
        self.interactive.load(Ordering::Acquire)
    }

    /// `{shown, interactive}` for `lens-status`.
    pub fn status(&self) -> Value {
        let shown = self
            .slots
            .lock()
            .unwrap()
            .iter()
            .filter(|slot| slot.id.is_some())
            .count();
        json!({ "shown": shown, "interactive": self.interactive() })
    }

    /// Places, tells the page what to draw and reveals on the acknowledgement.
    /// Never fails for lack of a slot: the oldest one is evicted and named in
    /// the receipt.
    pub fn show(self: &Arc<Self>, req: ShowReq, place: Place) -> Result<Value, String> {
        let (frame, size) = frame_for(&req, place);
        let (index, evicted) = {
            let mut slots = self.slots.lock().unwrap();
            let index = pick(&slots, &req.id);
            let evicted = slots[index]
                .id
                .as_ref()
                .filter(|id| *id != &req.id)
                .cloned();
            let now = Instant::now();
            slots[index] = Slot {
                label: slots[index].label,
                id: Some(req.id.clone()),
                kind: req.kind,
                anchor: req.anchor.clone(),
                size,
                sticky: req.sticky,
                epoch: req.epoch,
                shown_at: now,
                expires_at: now + Duration::from_millis(req.ttl_ms),
            };
            (index, evicted)
        };
        let label = LABELS[index];
        let window = self
            .app
            .get_webview_window(label)
            .ok_or("overlay-window-gone")?;
        let _ = window.set_size(LogicalSize::new(frame[2], frame[3]));
        let _ = window.set_position(LogicalPosition::new(frame[0], frame[1]));
        self.ready.lock().unwrap().remove(&req.id);
        let _ = window.emit_to(
            label,
            "overlay:show",
            json!({
                "id": req.id,
                "kind": req.kind,
                "text": req.text,
                "w": frame[2],
                "h": frame[3],
                // The slot's top-left in target-window points: the caption
                // item form positions each line at its rect minus this.
                "origin": [frame[0] - place.window[0], frame[1] - place.window[1]],
            }),
        );
        let _ = window.emit_to(
            label,
            "overlay:interactive",
            json!({ "on": self.interactive() }),
        );
        self.reveal(window, req.id.clone());
        self.announce();
        let mut receipt = json!({ "id": req.id });
        if let Some(evicted) = evicted {
            receipt["evicted"] = Value::String(evicted);
        }
        Ok(receipt)
    }

    /// One short-lived thread per show: the acknowledgement wait sleeps, and
    /// must not hold the caller's async worker.
    ///
    /// Nothing here touches the capture filter: it excludes the pool's windows
    /// by id (`Lens::set_overlay_windows`, named at build), so every slot is
    /// out of every frame however it is revealed.
    fn reveal(self: &Arc<Self>, window: WebviewWindow, id: String) {
        let overlay = self.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + ACK_WAIT;
            let mut acked = false;
            while !acked && Instant::now() < deadline {
                acked = overlay.ready.lock().unwrap().remove(&id);
                if !acked {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            let _ = window.show();
        });
    }

    /// `None` clears every slot.
    pub fn clear(&self, id: Option<&str>) {
        let mut hidden = Vec::new();
        {
            let mut slots = self.slots.lock().unwrap();
            for slot in slots.iter_mut() {
                let matched = match (id, slot.id.as_deref()) {
                    (Some(want), Some(have)) => want == have,
                    (None, Some(_)) => true,
                    _ => false,
                };
                if matched {
                    slot.id = None;
                    hidden.push(slot.label);
                }
            }
        }
        self.hide(&hidden);
    }

    /// A new epoch: everything anchored to the old window described a screen
    /// nobody is looking at. A sticky corner card is the one thing that stays.
    pub fn retarget(&self) {
        let epoch = self.bridge.epoch();
        let mut hidden = Vec::new();
        {
            let mut slots = self.slots.lock().unwrap();
            for slot in slots.iter_mut() {
                let corner = matches!(slot.anchor, Anchor::Corner(_));
                let stale = slot.epoch != epoch;
                if slot.id.is_some() && stale && !(slot.sticky && corner) {
                    slot.id = None;
                    hidden.push(slot.label);
                }
            }
        }
        self.hide(&hidden);
    }

    /// The target moved or resized. Every anchor is relative to it, so each
    /// live slot is re-placed; nothing is re-rendered, because a window-point
    /// anchor and the slot's own origin move by the same delta.
    pub fn reposition(&self, place: Place) {
        let moves: Vec<(&'static str, Rect)> = self
            .slots
            .lock()
            .unwrap()
            .iter()
            .filter(|slot| slot.id.is_some())
            .map(|slot| {
                (
                    slot.label,
                    placed(slot.kind, &slot.anchor, slot.size, place),
                )
            })
            .collect();
        for (label, frame) in moves {
            if let Some(window) = self.app.get_webview_window(label) {
                let _ = window.set_size(LogicalSize::new(frame[2], frame[3]));
                let _ = window.set_position(LogicalPosition::new(frame[0], frame[1]));
            }
        }
    }

    /// Cursor events on for every slot, plus the page's own 1 px border, plus
    /// Esc as the way back. Never called on the main thread: `unregister`
    /// blocks on it.
    pub fn set_interactive(&self, on: bool) {
        if self.interactive.swap(on, Ordering::AcqRel) == on {
            return;
        }
        for label in LABELS {
            if let Some(window) = self.app.get_webview_window(label) {
                let _ = window.set_ignore_cursor_events(!on);
                let _ = window.emit_to(label, "overlay:interactive", json!({ "on": on }));
            }
        }
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
        let shortcut = self.app.global_shortcut();
        if on {
            let app = self.app.clone();
            let _ = shortcut.on_shortcut(ESCAPE, move |_, _, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                let app = app.clone();
                std::thread::spawn(move || {
                    if let Some(overlay) = app.try_state::<Arc<Overlay>>() {
                        overlay.set_interactive(false);
                    }
                });
            });
        } else {
            let _ = shortcut.unregister(ESCAPE);
        }
    }

    /// TTL expiry.
    pub fn tick(&self) {
        let mut hidden = Vec::new();
        {
            let now = Instant::now();
            let mut slots = self.slots.lock().unwrap();
            for slot in slots.iter_mut() {
                if slot.id.is_some() && slot.expires_at <= now {
                    slot.id = None;
                    hidden.push(slot.label);
                }
            }
        }
        if !hidden.is_empty() {
            self.hide(&hidden);
        }
    }

    fn hide(&self, labels: &[&'static str]) {
        if labels.is_empty() {
            return;
        }
        for label in labels {
            if let Some(window) = self.app.get_webview_window(label) {
                let _ = window.hide();
            }
        }
        self.announce();
    }

    fn announce(&self) {
        let ids = self
            .slots
            .lock()
            .unwrap()
            .iter()
            .filter_map(|slot| slot.id.clone())
            .collect();
        self.bridge.emit(Kind::Overlay { ids });
    }
}

/// The slot to draw into: the one already holding this id, else the first
/// free one, else the one shown longest ago.
fn pick(slots: &[Slot], id: &str) -> usize {
    slots
        .iter()
        .position(|slot| slot.id.as_deref() == Some(id))
        .or_else(|| slots.iter().position(|slot| slot.id.is_none()))
        .unwrap_or_else(|| {
            slots
                .iter()
                .enumerate()
                .min_by_key(|(_, slot)| slot.shown_at)
                .map_or(0, |(index, _)| index)
        })
}

/// The window rectangle in screen points, and the size the anchor asked for
/// before the display clamp (what a later `reposition` re-places with).
fn frame_for(req: &ShowReq, place: Place) -> (Rect, (f64, f64)) {
    let size = match (req.kind, &req.anchor) {
        (OverlayKind::Highlight, Anchor::Rect { rect, .. }) => {
            (rect[2] + HIGHLIGHT_PAD * 2.0, rect[3] + HIGHLIGHT_PAD * 2.0)
        }
        // The caption item form positions each line inside the window, so the
        // window is exactly the union rectangle the lines were measured in.
        (OverlayKind::Caption, Anchor::Rect { rect, .. }) => (rect[2], rect[3]),
        (OverlayKind::Caption, Anchor::Corner(_)) => measure(&req.text),
        _ => (CARD_W, CARD_H),
    };
    let size = (size.0.max(MIN_W), size.1.max(MIN_H));
    (placed(req.kind, &req.anchor, size, place), size)
}

fn placed(kind: OverlayKind, anchor: &Anchor, size: (f64, f64), place: Place) -> Rect {
    let (w, h) = size;
    let origin = match anchor {
        Anchor::Rect { rect, .. } => {
            let pad = if kind == OverlayKind::Highlight {
                HIGHLIGHT_PAD
            } else {
                0.0
            };
            (
                place.window[0] + rect[0] - pad,
                place.window[1] + rect[1] - pad,
            )
        }
        Anchor::Corner(corner) => {
            let (wx, wy, ww, wh) = (
                place.window[0],
                place.window[1],
                place.window[2],
                place.window[3],
            );
            match corner {
                Corner::Tl => (wx + CORNER_INSET, wy + CORNER_INSET),
                Corner::Tr => (wx + ww - CORNER_INSET - w, wy + CORNER_INSET),
                Corner::Bl => (wx + CORNER_INSET, wy + wh - CORNER_INSET - h),
                Corner::Br => (wx + ww - CORNER_INSET - w, wy + wh - CORNER_INSET - h),
            }
        }
    };
    clamp([origin.0, origin.1, w, h], place.display)
}

/// Inside the display, shrinking only when the rectangle is larger than it.
fn clamp(rect: Rect, display: Rect) -> Rect {
    let w = rect[2].min(display[2]);
    let h = rect[3].min(display[3]);
    let x = rect[0].clamp(display[0], display[0] + display[2] - w);
    let y = rect[1].clamp(display[1], display[1] + display[3] - h);
    [x, y, w, h]
}

/// A corner caption's size. An estimate, not a layout: the page's font is
/// 13 px and averages about 6.5 pt a character, and a caption that guesses a
/// line short is still readable because the page wraps inside the window.
fn measure(text: &str) -> (f64, f64) {
    const CHAR_W: f64 = 6.5;
    const LINE_H: f64 = 18.0;
    const PADDING: f64 = 16.0;
    let longest = text
        .lines()
        .map(|line| line.chars().count())
        .max()
        .unwrap_or(0);
    let width = ((longest as f64 * CHAR_W) + PADDING).clamp(MIN_W, CAPTION_MAX_W);
    let per_line = ((width - PADDING) / CHAR_W).max(1.0);
    let rows: usize = text
        .lines()
        .map(|line| (line.chars().count() as f64 / per_line).ceil().max(1.0) as usize)
        .sum();
    (width, rows.max(1) as f64 * LINE_H + PADDING)
}

/// The display a target sits on, in screen points.
pub fn display_bounds(display_id: u32) -> Rect {
    let frame = objc2_core_graphics::CGDisplayBounds(display_id);
    [
        frame.origin.x,
        frame.origin.y,
        frame.size.width,
        frame.size.height,
    ]
}

/// One hidden slot window, and its `CGWindowID` — what the capture filter
/// excludes it by. Transparency needs `macOSPrivateApi`, which is on. `None`
/// means AppKit gave no window back, so that slot cannot be named in the
/// filter.
fn slot_window(app: &AppHandle, label: &'static str) -> tauri::Result<Option<u32>> {
    let window =
        WebviewWindowBuilder::new(app, label, WebviewUrl::App("overlay/index.html".into()))
            .title("Rimeward overlay")
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible_on_all_workspaces(true)
            .focused(false)
            .shadow(false)
            .visible(false)
            .resizable(false)
            .accept_first_mouse(false)
            .inner_size(CARD_W, CARD_H)
            .position(0.0, 0.0)
            .build()?;
    window.set_ignore_cursor_events(true)?;
    Ok(native(&window))
}

/// The level every slot sits at. Above every ordinary window, and — because
/// `CGWindowListCopyWindowInfo` reports a window's level as its layer — never
/// layer 0, which is what keeps a slot out of `signals::pick_window`'s targets
/// and out of `signals::covering`'s covers now that Rimeward's own ordinary
/// windows are both.
pub fn slot_level() -> isize {
    objc2_app_kit::NSFloatingWindowLevel + 1
}

/// What the builder cannot say: join every space, float over a full-screen
/// app, stay out of the window cycle, and sit one level above the floating
/// windows so a host's card is not covered by another utility panel. Answers
/// the slot's `CGWindowID`: Tauri builds its `NSWindow` with `defer: NO`, so
/// the window device — and with it the number — exists before the window is
/// ever shown, which is what lets the filter name a hidden slot.
fn native(window: &WebviewWindow) -> Option<u32> {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    let Ok(pointer) = window.ns_window() else {
        return None;
    };
    // Tauri made this `NSWindow` on the thread that is building the pool, and
    // the pool is built in `setup`, which is the main thread.
    let ns: &NSWindow = unsafe { &*pointer.cast::<NSWindow>() };
    ns.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    ns.setLevel(slot_level());
    ns.setHasShadow(false);
    ns.setOpaque(false);
    ns.setBackgroundColor(Some(&objc2_app_kit::NSColor::clearColor()));
    u32::try_from(ns.windowNumber()).ok().filter(|id| *id > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: Rect = [100.0, 200.0, 800.0, 600.0];
    const DISPLAY: Rect = [0.0, 0.0, 1512.0, 982.0];

    /// Rimeward's own ordinary windows are lens targets and covers now, and
    /// the layer-0 rule in signals.rs is the whole reason a card is neither.
    /// `NSFloatingWindowLevel` is 3, `CGWindowListCopyWindowInfo` reports a
    /// window's level as `kCGWindowLayer`, and signals.rs pins the same 4.
    #[test]
    fn a_slot_sits_off_layer_zero_so_it_is_never_a_target_or_a_cover() {
        assert_eq!(slot_level(), 4);
    }

    fn place() -> Place {
        Place {
            window: WINDOW,
            display: DISPLAY,
        }
    }

    fn request(kind: &str, anchor: Value) -> ShowReq {
        ShowReq::parse(&json!({
            "id": "cap-0", "kind": kind, "text": "hello", "anchor": anchor, "epoch": 3,
        }))
        .expect("the request parses")
    }

    #[test]
    fn a_window_point_rect_becomes_screen_points_against_the_current_bounds() {
        let req = request(
            "caption",
            json!({ "rect": [10.0, 20.0, 300.0, 40.0], "ref": "f-3-9" }),
        );
        let (frame, size) = frame_for(&req, place());
        assert_eq!(frame, [110.0, 220.0, 300.0, 40.0]);
        assert_eq!(size, (300.0, 40.0));
    }

    #[test]
    fn a_highlight_is_the_rect_plus_four_points_on_every_side() {
        let req = request(
            "highlight",
            json!({ "rect": [10.0, 20.0, 300.0, 40.0], "ref": "f-3-9" }),
        );
        let (frame, _) = frame_for(&req, place());
        assert_eq!(frame, [106.0, 216.0, 308.0, 48.0]);
    }

    #[test]
    fn a_corner_card_sits_sixteen_points_inside_the_targets_corner() {
        let top_left = frame_for(&request("card", json!({ "corner": "tl" })), place()).0;
        assert_eq!(top_left, [116.0, 216.0, CARD_W, CARD_H]);
        let bottom_right = frame_for(&request("card", json!({ "corner": "br" })), place()).0;
        assert_eq!(
            bottom_right,
            [
                100.0 + 800.0 - 16.0 - CARD_W,
                200.0 + 600.0 - 16.0 - CARD_H,
                CARD_W,
                CARD_H
            ]
        );
    }

    #[test]
    fn a_card_hanging_off_the_display_is_pulled_back_inside_it() {
        let place = Place {
            window: [1300.0, 900.0, 400.0, 300.0],
            display: DISPLAY,
        };
        let frame = frame_for(&request("card", json!({ "corner": "tl" })), place).0;
        assert_eq!(frame, [1512.0 - CARD_W, 982.0 - CARD_H, CARD_W, CARD_H]);
        // Bigger than the display shrinks rather than hangs off.
        assert_eq!(clamp([0.0, 0.0, 2000.0, 2000.0], DISPLAY), DISPLAY);
    }

    #[test]
    fn a_corner_caption_wraps_at_the_maximum_width() {
        let long = "x".repeat(400);
        let (width, height) = measure(&long);
        assert_eq!(width, CAPTION_MAX_W);
        assert!(height > 18.0, "a 400 character line is more than one row");
        assert!(measure("hi").0 < CAPTION_MAX_W);
    }

    #[test]
    fn the_time_to_live_is_ttl_ms_alone_and_clamped() {
        assert_eq!(ttl_ms(&json!({ "ttlMs": 4000 })), 4000);
        assert_eq!(ttl_ms(&json!({ "ttl_s": 20 })), DEFAULT_TTL_MS, "no alias");
        assert_eq!(ttl_ms(&json!({})), DEFAULT_TTL_MS);
        assert_eq!(ttl_ms(&json!({ "ttlMs": 1 })), MIN_TTL_MS);
        assert_eq!(ttl_ms(&json!({ "ttlMs": 9_000_000 })), MAX_TTL_MS);
    }

    #[test]
    fn a_malformed_request_is_refused_rather_than_placed() {
        let anchor = json!({ "rect": [0.0, 0.0, 10.0, 10.0], "ref": "f-1-1" });
        let ok = json!({ "id": "a", "kind": "card", "anchor": anchor, "epoch": 1 });
        assert!(ShowReq::parse(&ok).is_ok());
        for (name, value) in [
            (
                "no id",
                json!({ "kind": "card", "anchor": anchor, "epoch": 1 }),
            ),
            (
                "upper case id",
                json!({ "id": "A", "kind": "card", "anchor": anchor, "epoch": 1 }),
            ),
            (
                "unknown kind",
                json!({ "id": "a", "kind": "toast", "anchor": anchor, "epoch": 1 }),
            ),
            (
                "no epoch",
                json!({ "id": "a", "kind": "card", "anchor": anchor }),
            ),
            (
                "rect without a ref",
                json!({ "id": "a", "kind": "card", "anchor": { "rect": [0, 0, 1, 1] }, "epoch": 1 }),
            ),
            (
                "unknown corner",
                json!({ "id": "a", "kind": "card", "anchor": { "corner": "middle" }, "epoch": 1 }),
            ),
            (
                "text past the cap",
                json!({ "id": "a", "kind": "card", "anchor": anchor, "epoch": 1,
                        "text": "x".repeat(MAX_TEXT + 1) }),
            ),
        ] {
            assert!(ShowReq::parse(&value).is_err(), "{name} must be refused");
        }
    }

    #[test]
    fn a_slot_is_reused_by_id_then_taken_free_then_evicted_oldest_first() {
        let mut slots: Vec<Slot> = LABELS.iter().map(|label| Slot::new(label)).collect();
        assert_eq!(pick(&slots, "a"), 0, "every slot is free");
        slots[0].id = Some("a".into());
        assert_eq!(pick(&slots, "b"), 1, "the first free slot");
        assert_eq!(pick(&slots, "a"), 0, "the slot already holding the id");
        for (index, slot) in slots.iter_mut().enumerate() {
            slot.id = Some(format!("id-{index}"));
            slot.shown_at = Instant::now() + Duration::from_secs(index as u64);
        }
        assert_eq!(pick(&slots, "new"), 0, "the oldest slot is evicted");
    }
}
