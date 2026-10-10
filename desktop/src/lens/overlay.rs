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
//! `{id, generation, kind, text, w, h, origin}` to one slot window, the page renders and
//! answers `overlay:ready {id, generation}`, and the window is revealed on that
//! acknowledgement or 100 ms later, whichever comes first.

use super::bridge::{Bridge, Kind, Rect};
use super::{Lens, OverlaySource};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, Listener, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
#[cfg(target_os = "macos")]
use tauri::{LogicalPosition, LogicalSize};

/// The pool size. Eight is what the plan fixed: more than any one host asks
/// for at once, few enough that they all fit in the GPU budget.
pub const SLOTS: usize = 8;
pub const LABELS: [&str; SLOTS] = [
    "ov-0", "ov-1", "ov-2", "ov-3", "ov-4", "ov-5", "ov-6", "ov-7",
];

/// The hotkey that turns click-through off so a card can be clicked.
#[cfg(any(target_os = "macos", target_os = "linux"))]
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
    generation: u64,
    #[cfg(any(test, not(target_os = "macos")))]
    source_generation: u64,
    #[cfg(target_os = "macos")]
    kind: OverlayKind,
    #[cfg(target_os = "macos")]
    anchor: Anchor,
    /// The size the anchor asked for, before the display clamp.
    #[cfg(target_os = "macos")]
    size: (f64, f64),
    #[cfg(target_os = "macos")]
    sticky: bool,
    #[cfg(target_os = "macos")]
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
            generation: 0,
            #[cfg(any(test, not(target_os = "macos")))]
            source_generation: 0,
            #[cfg(target_os = "macos")]
            kind: OverlayKind::Card,
            #[cfg(target_os = "macos")]
            anchor: Anchor::Corner(Corner::Tr),
            #[cfg(target_os = "macos")]
            size: (CARD_W, CARD_H),
            #[cfg(target_os = "macos")]
            sticky: false,
            #[cfg(target_os = "macos")]
            epoch: 0,
            shown_at: now,
            expires_at: now,
        }
    }

    fn can_reveal(&self, id: &str, generation: u64, now: Instant) -> bool {
        self.id.as_deref() == Some(id) && self.generation == generation && self.expires_at > now
    }

    fn invalidate(&mut self) {
        self.id = None;
        self.generation = self.generation.wrapping_add(1);
    }
}

pub struct Overlay {
    app: AppHandle,
    bridge: Arc<Bridge>,
    slots: Mutex<Vec<Slot>>,
    interactive: AtomicBool,
    /// Ids the page has acknowledged and no reveal has consumed yet.
    ready: Mutex<HashSet<(String, u64)>>,
    #[cfg(target_os = "linux")]
    hotkey: AtomicBool,
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
            #[cfg(target_os = "linux")]
            hotkey: AtomicBool::new(false),
        });
        // The capture filter excludes the pool by window id, so the ids are
        // collected as the windows are made and handed to the lens before any
        // stream could be built on them.
        #[cfg(target_os = "macos")]
        let mut windows = Vec::with_capacity(SLOTS);
        for label in LABELS {
            #[cfg(target_os = "macos")]
            windows.extend(slot_window(app, label).map_err(|error| error.to_string())?);
            #[cfg(not(target_os = "macos"))]
            slot_window(app, label).map_err(|error| error.to_string())?;
        }
        #[cfg(target_os = "macos")]
        lens.set_overlay_windows(windows);
        #[cfg(target_os = "linux")]
        lens.register_overlay_windows(
            LABELS
                .iter()
                .filter_map(|label| app.get_webview_window(label))
                .collect(),
        );
        let acked = overlay.clone();
        app.listen("overlay:ready", move |event| {
            let Some((id, generation)) = serde_json::from_str::<Value>(event.payload())
                .ok()
                .and_then(|value| {
                    Some((
                        value["id"].as_str()?.to_owned(),
                        value["generation"].as_u64()?,
                    ))
                })
            else {
                return;
            };
            let mut ready = acked.ready.lock().unwrap();
            // Bounded: a page that acknowledged ids nobody asked for cannot
            // grow this without limit.
            if ready.len() < SLOTS * 4 {
                ready.insert((id, generation));
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
        #[cfg(target_os = "macos")]
        {
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
        }
        Ok(overlay)
    }

    /// Portable registration follows a real pool proof and remains optional.
    /// Run off main; a later refusal prevents the callback from changing input.
    #[cfg(target_os = "linux")]
    pub fn enable_hotkey(self: &Arc<Self>) {
        if !self
            .app
            .try_state::<Arc<Lens>>()
            .is_some_and(|lens| lens.overlay_available())
        {
            return;
        }
        if self.hotkey.swap(true, Ordering::AcqRel) {
            return;
        }
        let overlay = self.clone();
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
        if self
            .app
            .global_shortcut()
            .on_shortcut(HOTKEY, move |app, _, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                let enabled = app
                    .try_state::<Arc<Lens>>()
                    .is_some_and(|lens| lens.overlay_available());
                if !enabled {
                    return;
                }
                let overlay = overlay.clone();
                std::thread::spawn(move || overlay.set_interactive(!overlay.interactive()));
            })
            .is_err()
        {
            self.hotkey.store(false, Ordering::Release);
        }
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

    /// Slot mutation, placement, payload and visibility share one main-thread
    /// order. No slot lock crosses dispatch; Wry executes inline on that thread.
    fn on_main<T: Send + 'static>(
        self: &Arc<Self>,
        operation: impl FnOnce(&Arc<Self>) -> T + Send + 'static,
    ) -> Result<T, String> {
        let overlay = self.clone();
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        self.app
            .run_on_main_thread(move || {
                let result = operation(&overlay);
                let _ = send.send(result);
            })
            .map_err(|_| "overlay-window-gone")?;
        #[cfg(target_os = "macos")]
        return receive.recv().map_err(|_| "overlay-window-gone".into());
        #[cfg(not(target_os = "macos"))]
        receive
            .recv_timeout(Duration::from_millis(500))
            .map_err(|_| "overlay-timeout".into())
    }

    /// Places, tells the page what to draw and reveals on the acknowledgement.
    /// Never fails for lack of a slot: the oldest one is evicted and named in
    /// the receipt.
    pub(super) fn show(
        self: &Arc<Self>,
        req: ShowReq,
        place: Place,
        source: OverlaySource,
    ) -> Result<Value, String> {
        #[cfg(not(target_os = "macos"))]
        let cancellation = source.cancellation.clone();
        let result = self
            .on_main(move |overlay| source.publish(|| overlay.show_in(req, place, source.clone())));
        #[cfg(not(target_os = "macos"))]
        if result.is_err() {
            cancellation.cancel();
        }
        result?
    }

    fn show_in(
        self: &Arc<Self>,
        req: ShowReq,
        place: Place,
        source: OverlaySource,
    ) -> Result<Value, String> {
        if req.epoch != self.bridge.epoch() {
            return Err("stale-epoch".into());
        }
        let (frame, _size) = frame_for(&req, place);
        let (index, evicted, generation) = {
            let mut slots = self.slots.lock().unwrap();
            let index = pick(&slots, &req.id);
            let evicted = slots[index]
                .id
                .as_ref()
                .filter(|id| *id != &req.id)
                .cloned();
            let now = Instant::now();
            let generation = slots[index].generation.wrapping_add(1);
            slots[index] = Slot {
                label: slots[index].label,
                id: Some(req.id.clone()),
                generation,
                #[cfg(not(target_os = "macos"))]
                source_generation: source.lease.generation,
                #[cfg(all(test, target_os = "macos"))]
                source_generation: 0,
                #[cfg(target_os = "macos")]
                kind: req.kind,
                #[cfg(target_os = "macos")]
                anchor: req.anchor.clone(),
                #[cfg(target_os = "macos")]
                size: _size,
                #[cfg(target_os = "macos")]
                sticky: req.sticky,
                #[cfg(target_os = "macos")]
                epoch: req.epoch,
                shown_at: now,
                expires_at: now + Duration::from_millis(req.ttl_ms),
            };
            (index, evicted, generation)
        };
        let label = LABELS[index];
        let window = self
            .app
            .get_webview_window(label)
            .ok_or("overlay-window-gone")?;
        // An already-visible slot must not show the preceding DOM at its new
        // placement while the current payload is waiting for its acknowledgement.
        #[cfg(target_os = "macos")]
        {
            let _ = window.hide();
            let _ = window.set_size(LogicalSize::new(frame[2], frame[3]));
            let _ = window.set_position(LogicalPosition::new(frame[0], frame[1]));
        }
        #[cfg(not(target_os = "macos"))]
        let proof = match source.place(&window, frame) {
            Ok(proof) => proof,
            Err(reason) => {
                self.slots.lock().unwrap()[index].invalidate();
                let _ = super::hide_overlay(&self.app, &window);
                self.announce();
                return Err(reason);
            }
        };
        self.ready.lock().unwrap().retain(|(id, _)| id != &req.id);
        let _ = window.emit_to(
            label,
            "overlay:show",
            json!({
                "id": req.id,
                "generation": generation,
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
        self.reveal(
            window,
            req.id.clone(),
            index,
            generation,
            source,
            #[cfg(not(target_os = "macos"))]
            proof,
        );
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
    fn reveal(
        self: &Arc<Self>,
        window: WebviewWindow,
        id: String,
        index: usize,
        generation: u64,
        source: OverlaySource,
        #[cfg(target_os = "linux")] proof: super::linux_overlay::Placement,
        #[cfg(target_os = "windows")] proof: Rect,
    ) {
        let overlay = self.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + ACK_WAIT;
            let mut acked = false;
            while !acked && Instant::now() < deadline {
                acked = overlay
                    .ready
                    .lock()
                    .unwrap()
                    .remove(&(id.clone(), generation));
                if !acked {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            // Validate on the same main-thread path that changes visibility; never
            // keep the slot lock while dispatching a blocking window operation.
            let app = overlay.app.clone();
            let _ = app.run_on_main_thread(move || {
                let result = source.publish(|| {
                    let current = overlay.slots.lock().unwrap()[index].can_reveal(
                        &id,
                        generation,
                        Instant::now(),
                    );
                    if current {
                        #[cfg(target_os = "macos")]
                        let _ = window.show();
                        #[cfg(not(target_os = "macos"))]
                        if let Err(reason) = source.reveal(&window, &proof) {
                            overlay.slots.lock().unwrap()[index].invalidate();
                            let _ = super::hide_overlay(&overlay.app, &window);
                            overlay.announce();
                            return Err(reason);
                        }
                    }
                    Ok(())
                });
                #[cfg(not(target_os = "macos"))]
                if result.is_err() {
                    source.failed();
                }
                #[cfg(target_os = "macos")]
                let _ = result;
            });
        });
    }

    /// `None` clears every slot.
    #[cfg(target_os = "macos")]
    pub fn clear(self: &Arc<Self>, id: Option<&str>) {
        let id = id.map(str::to_owned);
        let _ = self.on_main(move |overlay| overlay.clear_in(id.as_deref()));
    }

    #[cfg(not(target_os = "macos"))]
    pub fn clear_checked(self: &Arc<Self>, id: Option<&str>) -> Result<(), String> {
        let id = id.map(str::to_owned);
        let all = id.is_none();
        let result = self.on_main(move |overlay| overlay.clear_in(id.as_deref()))?;
        if all {
            self.set_interactive(false);
        }
        result
    }

    /// Native source recovery only retires its own slots. A delayed close must
    /// not hide a replacement source that reused the same slot or public id.
    #[cfg(not(target_os = "macos"))]
    pub fn clear_source(self: &Arc<Self>, generation: u64) -> Result<(), String> {
        self.on_main(move |overlay| {
            let hidden = revoke_source_slots(&mut overlay.slots.lock().unwrap(), generation);
            overlay.hide(&hidden)
        })?
    }

    fn clear_in(&self, id: Option<&str>) -> Result<(), String> {
        let mut hidden = Vec::new();
        {
            let mut slots = self.slots.lock().unwrap();
            for slot in slots.iter_mut() {
                let matched = match (id, slot.id.as_deref()) {
                    (Some(want), Some(have)) => want == have,
                    (None, _) => {
                        #[cfg(target_os = "macos")]
                        {
                            slot.id.is_some()
                        }
                        #[cfg(not(target_os = "macos"))]
                        {
                            true
                        }
                    }
                    _ => false,
                };
                if matched {
                    slot.invalidate();
                    hidden.push(slot.label);
                }
            }
        }
        self.hide(&hidden)
    }

    /// A new epoch: everything anchored to the old window described a screen
    /// nobody is looking at. A sticky corner card is the one thing that stays.
    #[cfg(target_os = "macos")]
    pub fn retarget(self: &Arc<Self>) {
        let _ = self.on_main(|overlay| overlay.retarget_in());
    }

    #[cfg(target_os = "macos")]
    fn retarget_in(&self) {
        let epoch = self.bridge.epoch();
        let mut hidden = Vec::new();
        {
            let mut slots = self.slots.lock().unwrap();
            for slot in slots.iter_mut() {
                let corner = matches!(slot.anchor, Anchor::Corner(_));
                let stale = slot.epoch != epoch;
                if slot.id.is_some() && stale && !(slot.sticky && corner) {
                    slot.invalidate();
                    hidden.push(slot.label);
                }
            }
        }
        let _ = self.hide(&hidden);
    }

    /// The target moved or resized. Every anchor is relative to it, so each
    /// live slot is re-placed; nothing is re-rendered, because a window-point
    /// anchor and the slot's own origin move by the same delta.
    #[cfg(target_os = "macos")]
    pub fn reposition(self: &Arc<Self>, place: Place) {
        let epoch = self.bridge.epoch();
        let _ = self.on_main(move |overlay| {
            if overlay.bridge.epoch() == epoch {
                overlay.reposition_in(place);
            }
        });
    }

    #[cfg(target_os = "macos")]
    fn reposition_in(&self, place: Place) {
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
        #[cfg(target_os = "linux")]
        if on
            && !self
                .app
                .try_state::<Arc<Lens>>()
                .is_some_and(|lens| lens.overlay_available())
        {
            return;
        }
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
    pub fn tick(self: &Arc<Self>) {
        let _ = self.on_main(|overlay| overlay.tick_in());
    }

    fn tick_in(&self) {
        let mut hidden = Vec::new();
        {
            let now = Instant::now();
            let mut slots = self.slots.lock().unwrap();
            for slot in slots.iter_mut() {
                if slot.id.is_some() && slot.expires_at <= now {
                    slot.invalidate();
                    hidden.push(slot.label);
                }
            }
        }
        if !hidden.is_empty() {
            let _ = self.hide(&hidden);
        }
    }

    fn hide(&self, labels: &[&'static str]) -> Result<(), String> {
        if labels.is_empty() {
            return Ok(());
        }
        #[cfg(not(target_os = "macos"))]
        let mut failed = None;
        for label in labels {
            if let Some(window) = self.app.get_webview_window(label) {
                #[cfg(target_os = "macos")]
                let _ = window.hide();
                #[cfg(not(target_os = "macos"))]
                if let Err(reason) = super::hide_overlay(&self.app, &window) {
                    failed.get_or_insert(reason);
                }
            }
        }
        self.announce();
        #[cfg(not(target_os = "macos"))]
        if let Some(reason) = failed {
            return Err(reason);
        }
        Ok(())
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

#[cfg(any(test, not(target_os = "macos")))]
fn revoke_source_slots(slots: &mut [Slot], generation: u64) -> Vec<&'static str> {
    slots
        .iter_mut()
        .filter_map(|slot| {
            // Retain source ownership when freeing a slot so a failed hide can be
            // retried; a successful replacement show overwrites that ownership.
            if slot.source_generation != generation {
                return None;
            }
            slot.invalidate();
            Some(slot.label)
        })
        .collect()
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
#[cfg(target_os = "macos")]
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
    #[cfg(target_os = "macos")]
    return Ok(native(&window));
    #[cfg(target_os = "windows")]
    super::windows::exclude_overlay(windows::Win32::Foundation::HWND(window.hwnd()?.0))
        .map_err(|_| tauri::Error::InvalidWindowHandle)?;
    #[cfg(not(target_os = "macos"))]
    Ok(None)
}

/// The level every slot sits at. Above every ordinary window, and — because
/// `CGWindowListCopyWindowInfo` reports a window's level as its layer — never
/// layer 0, which is what keeps a slot out of `signals::pick_window`'s targets
/// and out of `signals::covering`'s covers now that Rimeward's own ordinary
/// windows are both.
#[cfg(target_os = "macos")]
pub fn slot_level() -> isize {
    objc2_app_kit::NSFloatingWindowLevel + 1
}

/// What the builder cannot say: join every space, float over a full-screen
/// app, stay out of the window cycle, and sit one level above the floating
/// windows so a host's card is not covered by another utility panel. Answers
/// the slot's `CGWindowID`: Tauri builds its `NSWindow` with `defer: NO`, so
/// the window device — and with it the number — exists before the window is
/// ever shown, which is what lets the filter name a hidden slot.
#[cfg(target_os = "macos")]
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

    #[test]
    fn delayed_source_clear_never_hides_a_replacement_id_and_retries_failed_hides() {
        let mut slots = vec![Slot::new("ov-0"), Slot::new("ov-1")];
        for slot in &mut slots {
            slot.id = Some("caption".into());
            slot.generation = 7;
            slot.source_generation = 10;
        }
        // The second window has already been replaced before the old callback.
        slots[1].source_generation = 12;
        slots[1].generation = 8;
        assert_eq!(revoke_source_slots(&mut slots, 10), vec!["ov-0"]);
        assert!(slots[0].id.is_none());
        assert!(!slots[0].can_reveal("caption", 7, Instant::now()));
        assert_eq!(slots[1].id.as_deref(), Some("caption"));
        assert_eq!(slots[1].generation, 8);
        // If native hide failed, the exact old source can still retry its window.
        assert_eq!(revoke_source_slots(&mut slots, 10), vec!["ov-0"]);
        slots[0].source_generation = 12;
        slots[0].id = Some("caption".into());
        assert!(revoke_source_slots(&mut slots, 10).is_empty());
    }

    #[test]
    fn clear_retarget_and_id_reuse_never_reveal_an_old_show() {
        let now = Instant::now();
        let mut slot = Slot::new("ov-0");
        slot.id = Some("caption".into());
        slot.generation = 7;
        slot.expires_at = now + Duration::from_secs(1);
        assert!(slot.can_reveal("caption", 7, now));
        slot.invalidate(); // The same invalidation used by Clear, retarget and TTL.
        assert!(!slot.can_reveal("caption", 7, now));
        slot.id = Some("caption".into());
        slot.generation += 1;
        assert!(!slot.can_reveal("caption", 7, now));
        assert!(slot.can_reveal("caption", 9, now));
        assert!(!slot.can_reveal("caption", 9, now + Duration::from_secs(2)));
        slot.invalidate();
        assert!(!slot.can_reveal("caption", 9, now));
    }

    const WINDOW: Rect = [100.0, 200.0, 800.0, 600.0];
    const DISPLAY: Rect = [0.0, 0.0, 1512.0, 982.0];

    /// Rimeward's own ordinary windows are lens targets and covers now, and
    /// the layer-0 rule in signals.rs is the whole reason a card is neither.
    /// `NSFloatingWindowLevel` is 3, `CGWindowListCopyWindowInfo` reports a
    /// window's level as `kCGWindowLayer`, and signals.rs pins the same 4.
    #[test]
    #[cfg(target_os = "macos")]
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
