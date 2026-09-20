//! The lens: what the app is looking at, what it has captured, and the ops a
//! host can ask of it. Read-only throughout — no synthetic input, ever.
//!
//! [`Lens`] owns the target, the frame ring and the known text; [`bridge`] owns
//! `epoch` and `seq`; [`capture`] owns the stream; [`signals`] owns the
//! observers. Nothing here sends a frame to a model on its own: a consumer asks
//! by `ref`, and the receipt carries the stamp it was answered at.

pub mod bridge;
pub mod capture;
pub mod embed;
pub mod helper;
pub mod ocr;
pub mod overlay;
pub mod ring;
pub mod signals;

use bridge::{Bridge, Cover, DisplayInfo, Kind, Line, Rect};
use capture::{Capture, Filter};
use helper::Helper;
use ring::Ring;
use serde_json::{json, Value};
use signals::Signals;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::mpsc;

/// A `lens-frame` reply crosses the pipe as base64. Past this the host asked
/// for something it should have cropped.
pub const FRAME_CAP: usize = 2 * 1024 * 1024;
/// `lens-frame` default long edge.
pub const DEFAULT_MAX_PX: u32 = 1024;
/// A `desktop` op that arrives without a deadline still gets one.
pub const DEFAULT_DEADLINE_MS: i64 = 30_000;

/// The frontmost window the lens is pointed at.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub pid: i32,
    pub bundle: String,
    pub name: String,
    pub window_id: u32,
    pub title: String,
    /// Screen points.
    pub bounds: Rect,
    pub url: Option<String>,
    pub display: DisplayInfo,
}

/// Text the lens already has, in window points. Observed only: a model's
/// description never lands here.
#[derive(Debug, Default)]
pub struct Known {
    /// From the last `ax-text` snapshot.
    pub ax: Vec<Line>,
    /// From the last `ocr` signal.
    pub ocr: Vec<Line>,
    /// A `Kind::AxFocus`.
    pub focus: Option<Kind>,
    /// A `Kind::AxSheet`.
    pub sheet: Option<Kind>,
    /// What is drawn over the target's rectangle, so nothing downstream reads
    /// the text there as the target's own. Epoch-scoped like the rest of
    /// `Known`: a new target is not covered until a frame says it is.
    pub covered: Option<Cover>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Run {
    Running,
    Paused,
    #[default]
    Stopped,
}

impl Run {
    pub fn name(self) -> &'static str {
        match self {
            Run::Running => "running",
            Run::Paused => "paused",
            Run::Stopped => "stopped",
        }
    }
    fn live(self) -> bool {
        matches!(self, Run::Running | Run::Paused)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct State {
    pub run: Run,
    pub reason: Option<String>,
    pub screen: bool,
    pub ax: bool,
}

/// What the probe reports. Phases B and C increment these; the stubs do not.
#[derive(Debug, Default)]
pub struct Counters {
    pub frames: AtomicU64,
    pub idle: AtomicU64,
    pub complete: AtomicU64,
    pub ocr_runs: AtomicU64,
    /// Frames whose recognition was dropped because the previous frame's was
    /// still running. Latest wins.
    pub ocr_skipped: AtomicU64,
    /// Recognitions finished after their epoch ended, so their text described
    /// a window that was no longer in front.
    pub ocr_dropped_stale: AtomicU64,
    /// Frames whose every dirty region scored identical to the last one, so
    /// there was nothing new to read.
    pub ocr_unchanged: AtomicU64,
    /// Sum of per-frame region-of-interest area ratios, in parts per million,
    /// because an atomic cannot hold an f64.
    pub roi_ratio_ppm: AtomicU64,
    pub ocr_ms: Mutex<Vec<u32>>,
    /// How long each `Capture::retarget` took, in milliseconds. The probe
    /// reports p50 and max against the 300 ms reconfigure budget.
    pub retarget_ms: Mutex<Vec<u32>>,
}

impl Counters {
    pub fn record_ocr(&self, ms: u32, roi_ratio: f64) {
        self.ocr_runs.fetch_add(1, Ordering::Relaxed);
        self.roi_ratio_ppm
            .fetch_add((roi_ratio * 1_000_000.0) as u64, Ordering::Relaxed);
        self.ocr_ms.lock().unwrap().push(ms);
    }

    pub fn record_retarget(&self, ms: u32) {
        self.retarget_ms.lock().unwrap().push(ms);
    }

    /// `(p50, p95)` milliseconds over every recorded recognition.
    #[cfg(test)]
    pub fn ocr_percentiles(&self) -> (u32, u32) {
        let mut samples = self.ocr_ms.lock().unwrap().clone();
        if samples.is_empty() {
            return (0, 0);
        }
        samples.sort_unstable();
        // Nearest rank: the p50 of 1..=100 is 50, not an interpolated 50.5.
        let pick = |p: f64| {
            let rank = ((p * samples.len() as f64).ceil() as usize).clamp(1, samples.len());
            samples[rank - 1]
        };
        (pick(0.50), pick(0.95))
    }

    /// Mean region-of-interest area ratio over the recognitions so far.
    #[cfg(test)]
    pub fn roi_ratio(&self) -> f64 {
        let runs = self.ocr_runs.load(Ordering::Relaxed);
        if runs == 0 {
            return 0.0;
        }
        self.roi_ratio_ppm.load(Ordering::Relaxed) as f64 / 1_000_000.0 / runs as f64
    }
}

/// `<data>/lens.json`. Consent is deliberately not in it: the user's answer
/// lives in the app's own settings and arrives as `lens-start`, so a stale
/// file can never say the lens was allowed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Config {
    pub filter: Filter,
}

pub fn read_config(data_dir: &Path) -> Config {
    let Some(value) = std::fs::read(data_dir.join("lens.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
        return Config::default();
    };
    Config {
        filter: value["filter"]
            .as_str()
            .and_then(Filter::parse)
            // Display: the only filter that sees sheets, dialogs and other
            // applications' windows, and the only one whose dirty rectangles
            // mean anything (research/capture-matrix.md).
            .unwrap_or(Filter::Display),
    }
}

pub struct Lens {
    pub bridge: Arc<Bridge>,
    pub ring: Ring,
    pub target: RwLock<Option<Target>>,
    pub known: RwLock<Known>,
    pub state: Mutex<State>,
    pub filter: Filter,
    pub consented: AtomicBool,
    /// `--probe capture --slow-ocr`: delay each recognition so an app switch
    /// can overtake it and prove the stale stamp is dropped.
    pub slow_ocr: AtomicBool,
    pub counters: Counters,
    /// The overlay pool's windows, by `CGWindowID`: the only thing the capture
    /// filter excludes, because a card or a caption drawn over the target
    /// would otherwise be recognized and handed back as the target's own text.
    /// Rimeward's ordinary windows — `main` and the `ward-*` popouts — are
    /// targets and covers like any other application's. Empty until
    /// [`overlay::Overlay::build`] has its windows, and empty for good when
    /// the pool failed to build.
    overlay_windows: Mutex<Vec<u32>>,
    /// The Swift helper, when its binary exists. Absent means every `helper-*`
    /// op answers `unavailable`.
    pub helper: Mutex<Option<Arc<Helper>>>,
    /// The overlay pool, once `lib.rs` has built its windows. Absent in every
    /// test, where the `overlay-*` ops answer `unavailable`.
    overlay: Mutex<Option<Arc<overlay::Overlay>>>,
    capture: Mutex<Option<Capture>>,
    signals: Mutex<Option<Signals>>,
    /// `<data>/runtime-diagnostics.jsonl`, the file the app already keeps for
    /// its own start-up trouble. The lens writes its stream events there —
    /// categories only, never content — because a GUI app's stderr reaches
    /// nobody, and the first stream loss in the field could not be explained.
    diagnostics: Option<std::path::PathBuf>,
    /// Restarts attempted since the last complete frame: what [`Lens::stream_lost`]
    /// backs off on.
    retry: AtomicU32,
}

/// How long [`Lens::stream_lost`] waits before restart attempt `attempt`
/// (0-based): 5 s doubling to a minute, then every minute for as long as the
/// user's consent stands. A display that sleeps, a lock screen, a display
/// change or a wedged capture daemon all pass; a lens that gave up after one
/// rebuild stayed dark for hours (2026-09-19).
pub fn retry_delay(attempt: u32) -> std::time::Duration {
    std::time::Duration::from_secs((5u64 << attempt.min(4)).min(60))
}

impl Lens {
    /// Reads `<data>/lens.json`, warms Vision and starts the helper when its
    /// binary is where `layout` says and this Mac is new enough to run it.
    /// Starts no capture: that waits for consent, which arrives as
    /// `lens-start`, and for the Screen Recording grant. No layout, no binary
    /// at it, or an older macOS means every `helper-*` op and `lens-embed`
    /// answer `unavailable` rather than waiting on a child that cannot exist.
    pub fn init(
        data_dir: &Path,
        writer: mpsc::UnboundedSender<String>,
        layout: Option<crate::runtime::Layout>,
    ) -> Arc<Lens> {
        let mut lens = Lens::new(read_config(data_dir), writer);
        if let Some(inner) = Arc::get_mut(&mut lens) {
            inner.diagnostics = Some(data_dir.join("runtime-diagnostics.jsonl"));
        }
        // The first Vision request in a process loads the recognition assets:
        // 23 to 34 s once during the research, 130 ms on the M1 build.
        std::thread::spawn(|| {
            ocr::warm();
        });
        // Embeddings are the helper's: it warms the Core ML text tower on its
        // own launch task, so this process has nothing to warm.
        if let Some(layout) = layout.filter(|layout| layout.helper.is_file() && helper::supported())
        {
            let helper = Helper::spawn(lens.clone(), layout.helper, layout.models, false);
            *lens.helper.lock().unwrap() = Some(helper);
        }
        lens
    }

    pub fn helper(&self) -> Option<Arc<Helper>> {
        self.helper.lock().unwrap().clone()
    }

    fn need_helper(&self) -> Result<Arc<Helper>, String> {
        self.helper().ok_or_else(|| "unavailable".to_owned())
    }

    /// Attached by `lib.rs` once the pool's windows exist.
    pub fn set_overlay(&self, overlay: Arc<overlay::Overlay>) {
        *self.overlay.lock().unwrap() = Some(overlay);
    }

    pub fn overlay(&self) -> Option<Arc<overlay::Overlay>> {
        self.overlay.lock().unwrap().clone()
    }

    fn need_overlay(&self) -> Result<Arc<overlay::Overlay>, String> {
        self.overlay().ok_or_else(|| "unavailable".to_owned())
    }

    /// The pool's `CGWindowID`s, handed over by [`overlay::Overlay::build`].
    /// A capture built before the pool existed holds a filter that names none
    /// of them, so it is rebuilt here through the same path a retarget takes:
    /// the filter changes, the epoch does not.
    pub fn set_overlay_windows(&self, windows: Vec<u32>) {
        *self.overlay_windows.lock().unwrap() = windows;
        let Some(target) = self.target.read().unwrap().clone() else {
            return;
        };
        if let Some(capture) = self.capture.lock().unwrap().as_ref() {
            if let Err(error) = capture.retarget(&target) {
                self.diag("lens-overlay-filter", &error);
            }
        }
    }

    pub fn overlay_windows(&self) -> Vec<u32> {
        self.overlay_windows.lock().unwrap().clone()
    }

    /// The target window and its display, both in screen points: what an
    /// overlay anchor is resolved against.
    fn place(&self, target: &Target) -> overlay::Place {
        overlay::Place {
            window: target.bounds,
            display: overlay::display_bounds(target.display.id),
        }
    }

    pub fn new(config: Config, writer: mpsc::UnboundedSender<String>) -> Arc<Lens> {
        let (screen, ax) = crate::permissions::preflight();
        Arc::new(Lens {
            bridge: Bridge::new(writer),
            ring: Ring::new(),
            target: RwLock::new(None),
            known: RwLock::new(Known::default()),
            state: Mutex::new(State {
                run: Run::Stopped,
                reason: None,
                screen,
                ax,
            }),
            filter: config.filter,
            // Nothing is captured until Node says the user consented.
            consented: AtomicBool::new(false),
            slow_ocr: AtomicBool::new(false),
            counters: Counters::default(),
            overlay_windows: Mutex::new(Vec::new()),
            helper: Mutex::new(None),
            overlay: Mutex::new(None),
            capture: Mutex::new(None),
            signals: Mutex::new(None),
            diagnostics: None,
            retry: AtomicU32::new(0),
        })
    }

    /// One line in the app's diagnostics file: a category, never content.
    /// The detail is cut to one short line so a system error's prose cannot
    /// carry anything past it.
    pub fn diag(&self, category: &str, detail: &str) {
        let detail: String = detail
            .chars()
            .filter(|c| !c.is_control())
            .take(120)
            .collect();
        let line = if detail.is_empty() {
            category.to_owned()
        } else {
            format!("{category}:{detail}")
        };
        eprintln!("lens: {line}");
        if let Some(file) = &self.diagnostics {
            crate::runtime::runtime_diagnostic(file, &line);
        }
    }

    /// The capture went away without the user asking — the stream stopped and
    /// could not be rebuilt on the spot, or a build failed outright. Stops
    /// with reason `stream` and schedules a restart on a backoff, for as long
    /// as consent stands and nothing else has claimed the lens since (a reader
    /// leaving marks it `idle`, the user `not-consented` or `paused`; those
    /// are not retried, the next `lens-start` is theirs).
    pub fn stream_lost(self: &Arc<Self>, detail: &str) {
        self.diag("lens-stream-lost", detail);
        self.stop(Some("stream"));
        let attempt = self.retry.fetch_add(1, Ordering::AcqRel);
        let lens = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(retry_delay(attempt));
            let still = {
                let state = lens.state.lock().unwrap();
                state.run == Run::Stopped && state.reason.as_deref() == Some("stream")
            };
            if !still || !lens.consented.load(Ordering::Acquire) {
                return;
            }
            match lens.start() {
                Ok(()) => lens.diag("lens-restarted", &format!("attempt {}", attempt + 1)),
                // A capture failure inside `start` has already scheduled the
                // next attempt; anything else is a grant, which `lens-start`
                // and `status_changed` own.
                Err(error) => lens.diag("lens-restart-failed", &error),
            }
        });
    }

    fn set_state(&self, run: Run, reason: Option<&str>) {
        let (screen, ax) = crate::permissions::preflight();
        let state = {
            let mut state = self.state.lock().unwrap();
            state.run = run;
            state.reason = reason.map(str::to_owned);
            state.screen = screen;
            state.ax = ax;
            state.clone()
        };
        self.bridge.emit(Kind::Status {
            state: state.run.name().into(),
            reason: state.reason,
            screen: state.screen,
            ax: state.ax,
        });
    }

    /// Needs consent and Screen Recording. Idempotent while running.
    pub fn start(self: &Arc<Self>) -> Result<(), String> {
        if !self.consented.load(Ordering::Acquire) {
            return Err("not-consented".into());
        }
        if !crate::permissions::preflight().0 {
            return Err("permission".into());
        }
        if self.state.lock().unwrap().run.live() {
            return Ok(());
        }
        // Running before the observers exist, because `retarget` only builds
        // capture while the lens is live and signals.rs calls it as soon as it
        // has resolved the frontmost window — which can be on the main thread,
        // after this returns.
        self.set_state(Run::Running, None);
        let signals = match Signals::start(self.clone()) {
            Ok(signals) => signals,
            Err(error) => {
                self.set_state(Run::Stopped, Some(&error));
                return Err(error);
            }
        };
        *self.signals.lock().unwrap() = Some(signals);
        // A restart with the target already known rebuilds capture on it;
        // otherwise the first activation signal calls `retarget`, which may
        // already have built it above.
        let target = self.target.read().unwrap().clone();
        if self.capture.lock().unwrap().is_none() {
            if let Some(target) = target {
                if let Err(error) = self.build_capture(&target) {
                    // Left as it was, the state read `running` with nothing
                    // capturing, and every later `lens-start` saw a live lens
                    // and returned early: dark for good.
                    self.stream_lost(&error);
                    return Err("stream".into());
                }
            }
        }
        Ok(())
    }

    /// Re-announce the current run state with freshly read grants. signals.rs
    /// calls it when the Accessibility grant appears after launch, so a
    /// consumer sees `ax` flip without a restart.
    pub fn status_changed(&self) {
        let (run, reason) = {
            let state = self.state.lock().unwrap();
            (state.run, state.reason.clone())
        };
        self.set_state(run, reason.as_deref());
    }

    pub fn stop(&self, reason: Option<&str>) {
        self.set_state(Run::Stopped, reason);
        if let Some(capture) = self.capture.lock().unwrap().take() {
            capture.stop();
        }
        if let Some(signals) = self.signals.lock().unwrap().take() {
            signals.stop();
        }
        self.ring.clear();
        // A later reader must start a fresh epoch, even in the same window:
        // its contents may have changed while nobody was observing it.
        *self.target.write().unwrap() = None;
        *self.known.write().unwrap() = Known::default();
    }

    /// The stream stays built; frames are dropped. Resuming costs nothing.
    pub fn pause(&self) {
        if let Some(capture) = self.capture.lock().unwrap().as_ref() {
            capture.set_paused(true);
        }
        self.set_state(Run::Paused, None);
    }

    pub fn resume(&self) {
        if let Some(capture) = self.capture.lock().unwrap().as_ref() {
            capture.set_paused(false);
        }
        self.set_state(Run::Running, None);
    }

    fn build_capture(self: &Arc<Self>, target: &Target) -> Result<(), String> {
        let capture = Capture::start(self.clone(), target, self.filter)?;
        *self.capture.lock().unwrap() = Some(capture);
        Ok(())
    }

    /// App switch, or a window switch inside the same app. Everything the old
    /// epoch produced is void: the frames describe a window that is no longer
    /// in front, and the text describes content nobody is looking at. A target
    /// that is not a different thing to look at is not a switch, and answers
    /// nothing.
    pub fn retarget(self: &Arc<Self>, target: Target) {
        {
            // Held across the bump and the announcements, so a snapshot taken
            // meanwhile sees either the old epoch whole or the new one whole.
            let mut current = self.target.write().unwrap();
            // Two activations can describe one switch — the NSWorkspace
            // notification and the frontmost poll in signals.rs — and each
            // caller decides outside this lock. Deciding again under it is
            // what keeps one switch to one epoch: a second epoch would clear
            // the ring and the known text for nothing.
            if !signals::needs_retarget(current.as_ref(), &target) {
                return;
            }
            self.bridge.bump_epoch();
            self.ring.clear();
            *self.known.write().unwrap() = Known::default();
            *current = Some(target.clone());
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
        }
        // Everything the old epoch drew described a window that is no longer
        // in front, sticky corner cards excepted.
        if let Some(overlay) = self.overlay() {
            overlay.retarget();
        }
        if !self.state.lock().unwrap().run.live() {
            return;
        }
        let reconfigured = self
            .capture
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|capture| capture.retarget(&target).is_ok());
        if !reconfigured {
            if let Err(error) = self.build_capture(&target) {
                self.stream_lost(&error);
            }
        }
    }

    /// The target moved or resized, same window: the stream follows it and the
    /// next frame's geometry records the new bounds. No epoch bump.
    pub fn reframe(&self, target: &Target) {
        // A window that shrank: the OCR lines outside it now describe pixels
        // the stream no longer captures, no read can claim them back — a region
        // of interest never reaches past the window — and a snapshot would
        // restate them as the window's own. (Measured: a Claude window tiled
        // from the full display to its left half kept 39 lines out to x=1742
        // in a 901-point window.) AX lines are left alone: the tree is read
        // against the current bounds, and an element scrolled out of view sits
        // outside the window on purpose. The consumer prunes its document on
        // the same `ax-window`; this is the copy a snapshot answers from,
        // pruned before the stream reconfigures so the gap a snapshot can land
        // in is short.
        self.known
            .write()
            .unwrap()
            .ocr
            .retain(|line| signals::within(line.bbox, target.bounds));
        if let Some(capture) = self.capture.lock().unwrap().as_ref() {
            if let Err(error) = capture.reframe(target) {
                eprintln!("lens: reframe failed: {error}");
            }
        }
        // Every anchor is relative to the target, so the slots follow it.
        if let Some(overlay) = self.overlay() {
            overlay.reposition(self.place(target));
        }
    }

    /// Every known line's box, for widening a region of interest.
    pub fn known_rects(&self) -> Vec<Rect> {
        let known = self.known.read().unwrap();
        known
            .ax
            .iter()
            .chain(known.ocr.iter())
            .map(|line| line.bbox)
            .collect()
    }

    pub fn status(&self) -> Value {
        let state = self.state.lock().unwrap().clone();
        let stats = self.ring.stats();
        let target = self.target.read().unwrap().clone();
        let helper = self.helper();
        // What the helper answered its last handshake with, so every model
        // stage below is this Mac's own answer rather than a promise.
        let caps = helper
            .as_deref()
            .map(Helper::capabilities)
            .unwrap_or_default();
        let model = &caps["model"];
        json!({
            "state": state.run.name(),
            "reason": state.reason,
            "epoch": self.bridge.epoch(),
            "seq": self.bridge.last_seq(),
            "target": target,
            "ring": { "n": stats.n, "bytes": stats.bytes, "oldestAt": stats.oldest_at },
            // Whether another window is over the target right now. The
            // covering window itself rides `lens-snapshot`; this is the flag.
            "covered": self.known.read().unwrap().covered.is_some(),
            "permissions": { "screen": state.screen, "ax": state.ax },
            // What this build can actually answer. The model stages come
            // from the helper's `capabilities`; the overlay is its own pool,
            // which `lib.rs` builds, so it reads false until it exists.
            "capabilities": {
                "capture": state.screen,
                "ax": state.ax,
                "ocr": true,
                "embed": helper.as_deref().is_some_and(Helper::embedding),
                "triage": model["available"] == true,
                "describe": model["available"] == true && model["vision"] == true,
                "translate": caps["translation"]
                    .as_array()
                    .is_some_and(|pairs| !pairs.is_empty()),
                "overlay": self.overlay().is_some(),
            },
            "overlay": self.overlay().map_or_else(
                || json!({ "shown": 0, "interactive": false }),
                |overlay| overlay.status(),
            ),
            "helper": helper_status(helper.as_deref()),
            "filter": self.filter,
            "consented": self.consented.load(Ordering::Acquire),
        })
    }

    /// Complete state at one boundary `seq`: the consumer discards everything
    /// already represented and applies only what came after.
    pub fn snapshot(&self) -> Value {
        // The target lock excludes `retarget`, so the boundary and the state
        // belong to one epoch. The boundary is read first: every writer stores
        // its state before it emits, so nothing here is older than the
        // boundary, and a signal past it re-applies what it already shows.
        let target = self.target.read().unwrap();
        let boundary = self.bridge.boundary();
        let known = self.known.read().unwrap();
        let latest = self.ring.latest();
        json!({
            "epoch": boundary.epoch,
            "seq": boundary.seq,
            "app": target.as_ref().map(|t| json!({ "bundle": &t.bundle, "name": &t.name, "pid": t.pid })),
            "window": target.as_ref().map(|t| json!({
                "id": t.window_id, "title": &t.title, "bounds": t.bounds,
                "url": &t.url, "display": t.display,
            })),
            "display": target.as_ref().map(|t| t.display),
            "focus": &known.focus,
            "sheet": &known.sheet,
            "covered": &known.covered,
            "axText": &known.ax,
            "ocr": &known.ocr,
            "latest": latest.map(|frame| json!({ "ref": frame.frame_ref, "geometry": frame.geometry })),
            "live": false,
        })
    }

    /// `deadline` is the absolute epoch-millisecond deadline the op arrived
    /// with; it is passed to the helper unchanged, so one clock governs the
    /// whole chain.
    pub async fn desktop_request(
        &self,
        op: &str,
        value: &Value,
        deadline: Option<i64>,
    ) -> Result<Value, String> {
        match op {
            "lens-status" => Ok(self.status()),
            "lens-snapshot" => Ok(self.snapshot()),
            "lens-frame" => self.frame(value),
            "lens-ocr" => self.ocr(value),
            "lens-pause" => {
                self.pause();
                Ok(Value::Bool(true))
            }
            "lens-resume" => {
                self.resume();
                Ok(Value::Bool(true))
            }
            "lens-embed" => self.embed(value, deadline).await,
            // Straight through, with the op's own epoch: the helper's reply is
            // dropped if that epoch ends while the model is thinking.
            "helper-capabilities" | "helper-triage" | "helper-translate" => {
                let epoch = value["epoch"].as_u64();
                self.need_helper()?
                    .call(&op["helper-".len()..], value.clone(), by(deadline), epoch)
                    .await
            }
            "helper-describe" | "helper-document" => self.helper_frame(op, value, deadline).await,
            "helper-restart" => {
                self.need_helper()?.restart().await;
                Ok(Value::Bool(true))
            }
            // Without a pool a consumer hears that the capability is missing
            // rather than waiting on a window that will never exist.
            "overlay-show" => self.overlay_show(value),
            "overlay-clear" => {
                self.need_overlay()?.clear(value["id"].as_str());
                Ok(Value::Bool(true))
            }
            "overlay-interactive" => {
                self.need_overlay()?.set_interactive(value["on"] == true);
                Ok(Value::Bool(true))
            }
            _ => Err("unknown-op".into()),
        }
    }

    /// `{dims, vectors}` for a batch of texts, from the helper's Core ML text
    /// tower. The caps are checked here, before a model call is spent on a
    /// batch that would be refused anyway. No helper, or a helper with no model
    /// directory, is `assets-missing`: Node reads any error as "no vectors", so
    /// the string is for the log.
    async fn embed(&self, value: &Value, deadline: Option<i64>) -> Result<Value, String> {
        let texts: Vec<String> = value["texts"]
            .as_array()
            .ok_or("bad-request")?
            .iter()
            .map(|text| text.as_str().map(str::to_owned).ok_or("bad-request"))
            .collect::<Result<_, _>>()?;
        embed::check(&texts)?;
        let call = match self.helper() {
            Some(helper) => {
                helper
                    .call("embed", json!({ "texts": texts }), by(deadline), None)
                    .await
            }
            None => Err("unavailable".to_owned()),
        };
        call.map_err(|error| match error.as_str() {
            "unavailable" => "assets-missing".to_owned(),
            _ => error,
        })
    }

    /// A host draws on the overlay. The `ref` on a rect anchor is only checked
    /// against the ring: placement uses the *current* target bounds, because
    /// the window may have moved since that frame was captured.
    fn overlay_show(&self, value: &Value) -> Result<Value, String> {
        let overlay = self.need_overlay()?;
        let request = overlay::ShowReq::parse(value)?;
        if request.epoch != self.bridge.epoch() {
            return Err("stale-epoch".into());
        }
        if let overlay::Anchor::Rect { frame_ref, .. } = &request.anchor {
            if self.ring.get(frame_ref).is_none() {
                return Err("frame-evicted".into());
            }
        }
        let target = self.target.read().unwrap().clone().ok_or("no-target")?;
        overlay.show(request, self.place(&target))
    }

    /// The crop path: pixels come from the immutable frame named by `ref` and
    /// never from whatever is on screen now, and the reply carries that
    /// frame's stamp so the caller can tell what was looked at.
    async fn helper_frame(
        &self,
        op: &str,
        value: &Value,
        deadline: Option<i64>,
    ) -> Result<Value, String> {
        use base64::Engine as _;
        let helper = self.need_helper()?;
        // A caller whose pixels the app never captured — a browser lens, whose
        // page is not this Mac's screen — hands them over instead of a `ref`.
        // Nothing of the screen is involved, so no frame is cropped and no
        // epoch governs the reply: the receipt is the answer alone.
        if let Some(jpeg) = value["jpeg"].as_str() {
            if jpeg.len() > FRAME_CAP {
                return Err("too-large".into());
            }
            let mut payload = json!({ "jpeg": jpeg });
            for field in ["prompt", "schema"] {
                if !value[field].is_null() {
                    payload[field] = value[field].clone();
                }
            }
            let answer = helper
                .call(&op["helper-".len()..], payload, by(deadline), None)
                .await?;
            return Ok(json!({ "value": answer }));
        }
        let frame_ref = value["ref"].as_str().ok_or("frame-evicted")?;
        let rect = match &value["rect"] {
            Value::Null => None,
            other => Some(rect(other).ok_or("bad-rect")?),
        };
        let out = self.ring.crop(frame_ref, rect, helper::MAX_PX)?;
        let mut payload = json!({
            "epoch": out.frame.epoch,
            "seq": out.frame.seq,
            "ref": out.frame.frame_ref,
            "jpeg": base64::engine::general_purpose::STANDARD.encode(&out.jpeg),
        });
        for field in ["prompt", "schema"] {
            if !value[field].is_null() {
                payload[field] = value[field].clone();
            }
        }
        let answer = helper
            .call(
                &op["helper-".len()..],
                payload,
                by(deadline),
                Some(out.frame.epoch),
            )
            .await?;
        Ok(json!({
            "epoch": out.frame.epoch,
            "seq": out.frame.seq,
            "ref": out.frame.frame_ref,
            "value": answer,
        }))
    }

    fn frame(&self, value: &Value) -> Result<Value, String> {
        use base64::Engine as _;
        let frame_ref = value["ref"].as_str().ok_or("frame-evicted")?;
        let rect = match &value["rect"] {
            Value::Null => None,
            other => Some(rect(other).ok_or("bad-rect")?),
        };
        let max_px = value["maxPx"]
            .as_u64()
            .unwrap_or(u64::from(DEFAULT_MAX_PX))
            .clamp(1, u64::from(u32::MAX)) as u32;
        let out = self.ring.crop(frame_ref, rect, max_px)?;
        let jpeg = base64::engine::general_purpose::STANDARD.encode(&out.jpeg);
        if jpeg.len() > FRAME_CAP {
            return Err("too-large".into());
        }
        Ok(json!({
            "ref": out.frame.frame_ref,
            "epoch": out.frame.epoch,
            "seq": out.frame.seq,
            "at": out.frame.at,
            "w": out.w,
            "h": out.h,
            "geometry": out.frame.geometry,
            "jpeg": jpeg,
        }))
    }

    /// Re-runs recognition on the latest frame's retained pixels. Older frames
    /// keep only their JPEG, so their `ref` answers `frame-evicted`.
    fn ocr(&self, value: &Value) -> Result<Value, String> {
        let frame_ref = value["ref"].as_str().ok_or("frame-evicted")?;
        let rect = rect(&value["rect"]).ok_or("bad-rect")?;
        let frame = self
            .ring
            .latest()
            .filter(|frame| frame.frame_ref == frame_ref && frame.pixels.is_some())
            .ok_or("frame-evicted")?;
        let size = frame.geometry.window;
        let full = [0.0, 0.0, size[2], size[3]];
        let roi = ocr::expand_roi(rect, &self.known_rects(), full);
        let ax: Vec<Rect> = self
            .known
            .read()
            .unwrap()
            .ax
            .iter()
            .map(|line| line.bbox)
            .collect();
        let pixels = frame.pixels.clone().ok_or("frame-evicted")?;
        let transform = ocr::Transform::new(&frame.geometry);
        // Read with the margin, answer with the region the reading covers.
        let roi_px = transform.window_to_pixels(ocr::read_roi(roi, full));
        let (raw, _ms) = ocr::recognize_bgra(
            &pixels,
            frame.w,
            frame.h,
            Some(ocr::pixels_to_norm(roi_px, frame.w, frame.h)),
            value["accurate"] == true,
        );
        let lines: Vec<Line> = raw
            .into_iter()
            .map(|(norm, text, confidence)| Line {
                bbox: transform.vision_to_window(norm, roi_px),
                text,
                conf: Some(confidence),
            })
            // What the margin cut is not part of this reading, only of the
            // band it was read from.
            .filter(|line| ocr::claims(line.bbox, roi))
            .collect();
        Ok(json!({
            "epoch": frame.epoch,
            "seq": frame.seq,
            "ref": frame.frame_ref,
            "rect": roi,
            "lines": lines,
            "axCovered": ocr::ax_covers(roi, &ax),
        }))
    }
}

/// Route one `desktop` op to the lens this app built at setup. `lens-start`
/// is how Node hands the user's consent over: nothing captures before it.
/// The two ops that decode, encode or recognise pixels run on a blocking
/// thread so a crop cannot stall the async runtime the tunnel shares.
pub async fn desktop_request(
    app: &tauri::AppHandle,
    op: &str,
    value: &Value,
    deadline: Option<i64>,
) -> Result<Value, String> {
    use tauri::Manager;
    // Cloned out of the state map: a Tauri state reference cannot be held
    // across an await.
    let lens = app
        .try_state::<Arc<Lens>>()
        .map(|lens| Arc::clone(&lens))
        .ok_or("unavailable")?;
    match op {
        "lens-start" => {
            let consented = value["consented"] == true;
            lens.consented.store(consented, Ordering::Release);
            if consented && value["active"] != false && value["paused"] != true {
                lens.start()?;
            } else {
                // Tear down ScreenCaptureKit itself, including its macOS
                // sharing indicator. Dropping frames leaves that stream open.
                let reason = if !consented {
                    "not-consented"
                } else if value["paused"] == true {
                    "paused"
                } else {
                    "idle"
                };
                let stopped = {
                    let state = lens.state.lock().unwrap();
                    state.run == Run::Stopped && state.reason.as_deref() == Some(reason)
                };
                if !stopped {
                    lens.stop(Some(reason));
                }
            }
            Ok(lens.status())
        }
        "lens-frame" | "lens-ocr" => {
            let (op, value) = (op.to_owned(), value.clone());
            tokio::task::spawn_blocking(move || match op.as_str() {
                "lens-frame" => lens.frame(&value),
                _ => lens.ocr(&value),
            })
            .await
            .map_err(|_| "cancelled".to_owned())?
        }
        _ => lens.desktop_request(op, value, deadline).await,
    }
}

/// `{state, outstanding}` for `lens-status`. No helper at all is `down`.
fn helper_status(helper: Option<&Helper>) -> Value {
    let (state, outstanding) =
        helper.map_or_else(|| ("down".to_owned(), 0), |helper| helper.state());
    json!({ "state": state, "outstanding": outstanding })
}

/// The absolute deadline an op carried, or the default when it carried none.
fn by(deadline: Option<i64>) -> i64 {
    deadline.unwrap_or_else(|| bridge::now_ms() + DEFAULT_DEADLINE_MS)
}

fn rect(value: &Value) -> Option<Rect> {
    let values = value.as_array()?;
    let [x, y, w, h] = values.as_slice() else {
        return None;
    };
    Some([x.as_f64()?, y.as_f64()?, w.as_f64()?, h.as_f64()?])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lens() -> (Arc<Lens>, mpsc::UnboundedReceiver<String>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Lens::new(
                Config {
                    filter: Filter::Display,
                },
                tx,
            ),
            rx,
        )
    }

    fn target() -> Target {
        Target {
            pid: 42,
            bundle: "com.apple.Safari".into(),
            name: "Safari".into(),
            window_id: 9,
            title: "Docs".into(),
            bounds: [100.0, 200.0, 800.0, 600.0],
            url: Some("https://example.test/".into()),
            display: DisplayInfo {
                id: 1,
                w: 1512.0,
                h: 982.0,
                scale: 2.0,
            },
        }
    }

    /// The M0 stub's shape, grown to what M1 answers.
    #[test]
    fn lens_status_carries_the_target_filter_and_consent() {
        let (lens, _rx) = lens();
        let status = lens.status();
        assert_eq!(status["state"], "stopped");
        assert_eq!(status["epoch"], 1);
        assert_eq!(status["seq"], 0);
        assert!(status["target"].is_null());
        assert_eq!(status["filter"], "display");
        assert_eq!(status["consented"], false, "until lens-start says so");
        assert_eq!(
            status["ring"],
            json!({ "n": 0, "bytes": 0, "oldestAt": null })
        );
        // OCR is in this process; every model stage is the helper's, and a
        // unit test has no helper, so they read false rather than promised.
        assert_eq!(status["capabilities"]["ocr"], true);
        for stage in ["embed", "triage", "describe", "translate", "overlay"] {
            assert_eq!(status["capabilities"][stage], false, "{stage}");
        }
        assert_eq!(
            status["helper"],
            json!({ "state": "down", "outstanding": 0 })
        );
        assert_eq!(
            status["capabilities"]["capture"],
            status["permissions"]["screen"]
        );
        assert_eq!(status["capabilities"]["ax"], status["permissions"]["ax"]);
        assert!(status["permissions"]["screen"].is_boolean());
        assert!(status["permissions"]["ax"].is_boolean());

        *lens.target.write().unwrap() = Some(target());
        let status = lens.status();
        assert_eq!(status["target"]["windowId"], 9);
        assert_eq!(status["target"]["bundle"], "com.apple.Safari");
        assert_eq!(status["target"]["display"]["scale"], 2.0);
    }

    #[test]
    fn a_snapshot_is_empty_and_consistent_before_anything_is_seen() {
        let (lens, _rx) = lens();
        let snapshot = lens.snapshot();
        assert_eq!(snapshot["epoch"], 1);
        assert_eq!(snapshot["seq"], 0);
        assert!(snapshot["app"].is_null());
        assert!(snapshot["window"].is_null());
        assert!(snapshot["latest"].is_null());
        assert_eq!(snapshot["axText"], json!([]));
        assert_eq!(snapshot["ocr"], json!([]));
        assert_eq!(snapshot["live"], false);
    }

    #[test]
    fn retargeting_bumps_the_epoch_and_announces_the_new_window() {
        let (lens, _rx) = lens();
        lens.known.write().unwrap().ax = vec![Line {
            bbox: [0.0, 0.0, 1.0, 1.0],
            text: "stale".into(),
            conf: None,
        }];
        lens.retarget(target());
        assert_eq!(lens.bridge.epoch(), 2);
        assert!(lens.known_rects().is_empty(), "known text is epoch-scoped");
        let snapshot = lens.snapshot();
        assert_eq!(snapshot["epoch"], 2);
        assert_eq!(snapshot["seq"], 2, "app then window");
        assert_eq!(snapshot["app"]["pid"], 42);
        assert_eq!(snapshot["window"]["url"], "https://example.test/");
        assert_eq!(snapshot["display"]["id"], 1);
    }

    /// The chain a front-window change goes through: `needs_retarget` decides,
    /// `Lens::retarget` bumps. Worth a test of its own because the field
    /// report showed a whole session of app switches inside one epoch — the
    /// epoch is how a consumer knows the window it is reading about changed.
    #[test]
    fn every_front_window_change_opens_a_new_epoch() {
        let (lens, _rx) = lens();
        let switch = |lens: &Arc<Lens>, next: Target| {
            let current = lens.target.read().unwrap().clone();
            let changed = signals::needs_retarget(current.as_ref(), &next);
            if changed {
                lens.retarget(next);
            }
            changed
        };
        assert_eq!(lens.bridge.epoch(), 1);
        assert!(switch(&lens, target()), "the first target of all");
        assert_eq!(lens.bridge.epoch(), 2);

        // Another application's window over it, which is what stops the lens
        // reading the text at that rectangle as the target's.
        lens.known.write().unwrap().covered = Some(Cover {
            by: "Google Chrome".into(),
            pid: 501,
            id: 902,
            bounds: Some([0.0, 0.0, 800.0, 600.0]),
        });
        assert_eq!(lens.status()["covered"], true);
        assert_eq!(lens.snapshot()["covered"]["by"], "Google Chrome");

        // The operator switches to it: a different process is a new epoch, and
        // the new target is not covered until a frame of it says so.
        let browser = Target {
            pid: 501,
            bundle: "com.google.Chrome".into(),
            name: "Google Chrome".into(),
            window_id: 12,
            ..target()
        };
        assert!(switch(&lens, browser.clone()));
        assert_eq!(lens.bridge.epoch(), 3);
        assert_eq!(lens.snapshot()["app"]["pid"], 501);
        assert_eq!(lens.status()["covered"], false);
        assert!(lens.snapshot()["covered"].is_null());

        // A second window of the same application is a front-window change too.
        let second = Target {
            window_id: 13,
            ..browser.clone()
        };
        assert!(switch(&lens, second.clone()));
        assert_eq!(lens.bridge.epoch(), 4);

        // One switch seen twice — the activation notification and the
        // frontmost poll both reach `retarget` — is still one epoch. The
        // callers decide outside the lock, so `retarget` decides again inside
        // it.
        lens.retarget(second.clone());
        assert_eq!(lens.bridge.epoch(), 4, "the second activation is not news");

        // A move and a retitle of the same window are not: they reach the
        // consumer as `ax-window` inside the epoch they belong to.
        let moved = Target {
            bounds: [140.0, 240.0, 800.0, 600.0],
            title: "Renamed".into(),
            ..second
        };
        assert!(!switch(&lens, moved));
        assert_eq!(lens.bridge.epoch(), 4);
    }

    #[test]
    fn start_refuses_without_consent() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let lens = Lens::new(Config::default(), tx);
        assert_eq!(lens.start().err().as_deref(), Some("not-consented"));
        assert_eq!(lens.state.lock().unwrap().run, Run::Stopped);
    }

    #[tokio::test]
    async fn unknown_and_missing_refs_are_named_not_guessed() {
        let (lens, _rx) = lens();
        assert_eq!(
            lens.desktop_request("lens-frame", &json!({ "ref": "f-1-1" }), None)
                .await
                .err()
                .as_deref(),
            Some("frame-evicted")
        );
        assert_eq!(
            lens.desktop_request(
                "lens-ocr",
                &json!({ "ref": "f-1-1", "rect": [0, 0, 1, 1] }),
                None
            )
            .await
            .err()
            .as_deref(),
            Some("frame-evicted")
        );
        assert_eq!(
            lens.desktop_request("lens-nope", &json!({}), None)
                .await
                .err()
                .as_deref(),
            Some("unknown-op")
        );
    }

    /// The batch caps are answered before the helper is reached, so a host
    /// that sends a corpus hears `bad-request` whether or not this Mac has the
    /// model files. Without a helper a legal batch is `assets-missing`, never
    /// a hang.
    #[tokio::test]
    async fn lens_embed_refuses_a_batch_that_breaks_the_caps() {
        let (lens, _rx) = lens();
        for value in [
            json!({}),
            json!({ "texts": "not an array" }),
            json!({ "texts": [1, 2] }),
            json!({ "texts": vec![""; embed::MAX_TEXTS + 1] }),
            json!({ "texts": ["x".repeat(embed::MAX_CHARS + 1)] }),
        ] {
            assert_eq!(
                lens.desktop_request("lens-embed", &value, None)
                    .await
                    .err()
                    .as_deref(),
                Some("bad-request"),
                "{value}"
            );
        }
        assert_eq!(
            lens.desktop_request("lens-embed", &json!({ "texts": ["a line"] }), None)
                .await
                .err()
                .as_deref(),
            Some("assets-missing")
        );
    }

    /// Without a helper binary there is no helper, and a unit test builds no
    /// overlay pool. Every op that needs one says so rather than hanging on a
    /// child or a window that does not exist.
    #[tokio::test]
    async fn the_helper_and_overlay_ops_are_unavailable_in_this_build() {
        let (lens, _rx) = lens();
        for op in [
            "helper-capabilities",
            "helper-triage",
            "helper-translate",
            "helper-describe",
            "helper-document",
            "helper-restart",
            "overlay-show",
            "overlay-clear",
            "overlay-interactive",
        ] {
            assert_eq!(
                lens.desktop_request(op, &json!({ "texts": ["a line"] }), None)
                    .await
                    .err()
                    .as_deref(),
                Some("unavailable"),
                "{op}"
            );
        }
        assert_eq!(lens.status()["capabilities"]["overlay"], false);
        assert_eq!(
            lens.status()["overlay"],
            json!({ "shown": 0, "interactive": false }),
            "what a consumer reads before any window has been built"
        );
        assert_eq!(
            lens.status()["helper"],
            json!({ "state": "down", "outstanding": 0 })
        );
    }

    /// A frame that would not fit is refused rather than truncated: a cut
    /// JPEG is worse than no JPEG, and the pipe is shared with every signal.
    #[tokio::test]
    async fn a_frame_reply_over_two_mebibytes_is_refused() {
        let (lens, _rx) = lens();
        // Noise does not compress, so a modest image clears the cap.
        let mut noise = image::RgbImage::new(1400, 1400);
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        for pixel in noise.pixels_mut() {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            pixel.0 = [seed as u8, (seed >> 8) as u8, (seed >> 16) as u8];
        }
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, ring::QUALITY)
            .encode_image(&noise)
            .unwrap();
        lens.ring.push(ring::Frame {
            frame_ref: "f-1-1".into(),
            epoch: 1,
            seq: 1,
            at: bridge::now_ms(),
            w: 1400,
            h: 1400,
            geometry: bridge::FrameGeometry {
                window: [0.0, 0.0, 1400.0, 1400.0],
                scale: 1.0,
                content_rect: [0.0, 0.0, 1400.0, 1400.0],
                content_scale: 1.0,
                captured: [0.0, 0.0, 1400.0, 1400.0],
            },
            jpeg: jpeg.into(),
            pixels: None,
        });
        assert_eq!(
            lens.desktop_request(
                "lens-frame",
                &json!({ "ref": "f-1-1", "maxPx": 4096 }),
                None
            )
            .await
            .err()
            .as_deref(),
            Some("too-large")
        );
        // The same frame answered at the default long edge fits easily.
        let reply = lens
            .desktop_request("lens-frame", &json!({ "ref": "f-1-1" }), None)
            .await
            .unwrap();
        assert_eq!(reply["w"], DEFAULT_MAX_PX);
        assert_eq!(reply["ref"], "f-1-1");
        assert_eq!(reply["epoch"], 1);
        assert!(reply["jpeg"].as_str().unwrap().len() < FRAME_CAP);
    }

    #[tokio::test]
    async fn pause_and_resume_report_true_and_move_the_state() {
        let (lens, _rx) = lens();
        assert_eq!(
            lens.desktop_request("lens-pause", &Value::Null, None)
                .await
                .unwrap(),
            json!(true)
        );
        assert_eq!(lens.state.lock().unwrap().run, Run::Paused);
        assert_eq!(
            lens.desktop_request("lens-resume", &Value::Null, None)
                .await
                .unwrap(),
            json!(true)
        );
        assert_eq!(lens.state.lock().unwrap().run, Run::Running);
    }

    #[test]
    fn retry_delay_doubles_from_five_seconds_to_a_minute_and_holds() {
        let secs: Vec<u64> = (0..7).map(|n| retry_delay(n).as_secs()).collect();
        assert_eq!(secs, [5, 10, 20, 40, 60, 60, 60]);
    }

    /// A lost stream is a stop with reason `stream` — what the consumer reads
    /// as "lost its capture" — and one status signal saying so. The restart
    /// it schedules never runs here: nothing has consented.
    #[tokio::test]
    async fn a_lost_stream_stops_with_its_reason_and_says_so() {
        let (lens, mut rx) = lens();
        // The wire needs its drain, which lib.rs spawns in the app.
        tokio::spawn(lens.bridge.clone().run_writer());
        lens.stream_lost("SCStreamErrorUserStopped");
        let state = lens.state.lock().unwrap().clone();
        assert_eq!(state.run, Run::Stopped);
        assert_eq!(state.reason.as_deref(), Some("stream"));
        assert_eq!(lens.retry.load(Ordering::Acquire), 1);
        let status = rx.recv().await.expect("a status signal");
        let value: Value = serde_json::from_str(&status).unwrap();
        assert_eq!(value["kind"], "status");
        assert_eq!(value["state"], "stopped");
        assert_eq!(value["reason"], "stream");
    }

    /// Whatever the file says, a fresh lens has not been consented to: that
    /// answer only ever arrives as `lens-start`.
    #[test]
    fn lens_json_carries_the_filter_and_never_consent() {
        let dir = std::env::temp_dir().join(format!("rimeward-lens-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_config(&dir), Config::default());
        assert_eq!(read_config(&dir).filter, Filter::Display);
        std::fs::write(dir.join("lens.json"), r#"{"consented":true}"#).unwrap();
        assert_eq!(read_config(&dir), Config::default());
        std::fs::write(dir.join("lens.json"), r#"{"filter":"window"}"#).unwrap();
        assert_eq!(read_config(&dir).filter, Filter::Window);
        let (tx, _rx) = mpsc::unbounded_channel();
        let lens = Lens::new(read_config(&dir), tx);
        assert_eq!(lens.status()["consented"], false);
        assert_eq!(lens.start().err().as_deref(), Some("not-consented"));
        std::fs::write(dir.join("lens.json"), "not json").unwrap();
        assert_eq!(read_config(&dir), Config::default());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn percentiles_and_the_roi_mean_come_back_out_of_the_counters() {
        let counters = Counters::default();
        assert_eq!(counters.ocr_percentiles(), (0, 0));
        assert_eq!(counters.roi_ratio(), 0.0);
        for ms in 1..=100u32 {
            counters.record_ocr(ms, 0.25);
        }
        assert_eq!(counters.ocr_percentiles(), (50, 95));
        assert!((counters.roi_ratio() - 0.25).abs() < 1e-9);
        assert_eq!(counters.ocr_runs.load(Ordering::Relaxed), 100);
    }

    /// A 1x frame with no content offset, so the reply's boxes are window
    /// points straight out of Vision.
    fn synthetic_frame(lens: &Lens, frame_ref: &str, text: &str) -> (u32, u32) {
        let (w, h) = (640u32, 200u32);
        lens.ring.push(ring::Frame {
            frame_ref: frame_ref.into(),
            epoch: 1,
            seq: 1,
            at: bridge::now_ms(),
            w,
            h,
            geometry: bridge::FrameGeometry {
                window: [0.0, 0.0, f64::from(w), f64::from(h)],
                scale: 1.0,
                content_rect: [0.0, 0.0, f64::from(w), f64::from(h)],
                content_scale: 1.0,
                captured: [0.0, 0.0, f64::from(w), f64::from(h)],
            },
            jpeg: Vec::new().into(),
            pixels: Some(ocr::text_frame(text, 14, w, h).into()),
        });
        (w, h)
    }

    /// Only the latest frame keeps its pixels, so an older `ref` has nothing to
    /// recognize even though the ring still holds its JPEG.
    #[tokio::test]
    async fn lens_ocr_only_answers_for_the_frame_that_still_has_pixels() {
        let (lens, _rx) = lens();
        synthetic_frame(&lens, "f-1-1", "LENS");
        synthetic_frame(&lens, "f-1-2", "OCR");
        assert_eq!(
            lens.desktop_request(
                "lens-ocr",
                &json!({ "ref": "f-1-1", "rect": [0, 0, 10, 10] }),
                None
            )
            .await
            .err()
            .as_deref(),
            Some("frame-evicted")
        );
        assert_eq!(
            lens.desktop_request("lens-ocr", &json!({ "ref": "f-1-2", "rect": "nope" }), None)
                .await
                .err()
                .as_deref(),
            Some("bad-rect")
        );
    }

    /// Needs Vision, so it is ignored by default: `lens-ocr` re-reads the
    /// retained BGRA bytes of the latest frame.
    #[tokio::test]
    #[ignore]
    async fn lens_ocr_reads_the_latest_frames_retained_pixels() {
        let (lens, _rx) = lens();
        let (w, h) = synthetic_frame(&lens, "f-1-1", "LENS OCR");
        let reply = lens
            .desktop_request(
                "lens-ocr",
                &json!({ "ref": "f-1-1", "rect": [0, 0, w, h], "accurate": true }),
                None,
            )
            .await
            .unwrap();
        eprintln!("{reply}");
        let lines = reply["lines"].as_array().expect("lines");
        assert!(!lines.is_empty(), "the retained pixels are recognized");
        assert_eq!(reply["ref"], "f-1-1");
        assert_eq!(reply["axCovered"], false);
        for line in lines {
            let bbox: Vec<f64> = line["bbox"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_f64().unwrap())
                .collect();
            assert!(
                bbox[0] >= -1.0
                    && bbox[1] >= -1.0
                    && bbox[0] + bbox[2] <= f64::from(w) + 1.0
                    && bbox[1] + bbox[3] <= f64::from(h) + 1.0,
                "line box {bbox:?} outside the frame"
            );
        }
    }
}
