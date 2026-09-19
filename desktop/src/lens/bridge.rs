//! The signal types and the one authority for `epoch` and `seq`.
//!
//! Every line the lens sends the Node core is a [`Signal`]. Rust assigns the
//! stamp, so a consumer can order and discard by it without trusting a clock.
//! Frames are disposable (one slot, latest wins); everything else is lossless
//! up to 4096 entries, after which the queue collapses to a single
//! [`Kind::Gap`] naming the range the consumer will never see.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, Notify};

/// Window points relative to the target window's top-left, y down, unless a
/// field says otherwise. `[x, y, w, h]`.
pub type Rect = [f64; 4];

/// The control queue's ceiling. One overflow collapses it to one `gap`.
pub const QUEUE_CAP: usize = 4096;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Stamp {
    pub epoch: u64,
    pub seq: u64,
}

impl Stamp {
    /// The `ref` a frame is addressed by for the rest of its life.
    pub fn frame_ref(&self) -> String {
        format!("f-{}-{}", self.epoch, self.seq)
    }
}

/// Where a captured buffer sits relative to the window it came from. Stored
/// with the frame, so a crop rect maps through capture-time geometry and never
/// through wherever the window has moved to since.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrameGeometry {
    /// Screen points at capture time.
    pub window: Rect,
    /// ScreenCaptureKit's `scale_factor`.
    pub scale: f64,
    /// Pixels: where the window content sits inside the sample buffer.
    pub content_rect: Rect,
    /// ScreenCaptureKit's `content_scale`.
    pub content_scale: f64,
    /// Window points: the part of the window `content_rect` shows. The whole
    /// window when it is on screen; a display capture of a window hanging off
    /// an edge holds only the on-screen part, and this rect says which.
    pub captured: Rect,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct DisplayInfo {
    pub id: u32,
    pub w: f64,
    pub h: f64,
    pub scale: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Line {
    pub bbox: Rect,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conf: Option<f32>,
}

/// A merged dirty rectangle and its FeaturePrint distance from the previous
/// frame's print for the same rectangle index. First frame is `1.0`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Dirty {
    pub bbox: Rect,
    pub d: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Kind {
    Frame {
        #[serde(rename = "ref")]
        frame_ref: String,
        w: u32,
        h: u32,
        /// Dirty area over frame area.
        ratio: f32,
        dirty: Vec<Dirty>,
        geometry: FrameGeometry,
    },
    App {
        bundle: String,
        name: String,
        pid: i32,
    },
    Window {
        id: u32,
        title: String,
        /// Screen points.
        bounds: Rect,
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        display: DisplayInfo,
    },
    AxFocus {
        role: String,
        label: String,
        value: String,
        bounds: Option<Rect>,
    },
    AxValue {
        role: String,
        label: String,
        value: String,
        bounds: Option<Rect>,
    },
    AxWindow {
        title: String,
        bounds: Rect,
    },
    AxSheet {
        title: String,
        bounds: Rect,
    },
    AxText {
        rect: Rect,
        lines: Vec<Line>,
    },
    Ocr {
        #[serde(rename = "ref")]
        frame_ref: String,
        rect: Rect,
        lines: Vec<Line>,
        ms: u32,
        #[serde(rename = "axCovered")]
        ax_covered: bool,
    },
    Gap {
        from: u64,
        to: u64,
    },
    Status {
        /// `warming | running | idle | paused | stopped`.
        state: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        screen: bool,
        ax: bool,
    },
    Helper {
        state: String,
        #[serde(skip_serializing_if = "Option::is_none", rename = "resetAt")]
        reset_at: Option<i64>,
        outstanding: u32,
    },
    /// Every overlay id on screen right now, after a show, a clear or a TTL
    /// expiry. Node forwards it to the feed as `{t:'overlay'}`.
    Overlay {
        ids: Vec<String>,
    },
}

impl Kind {
    fn is_frame(&self) -> bool {
        matches!(self, Kind::Frame { .. })
    }
}

fn lens() -> &'static str {
    "lens"
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Signal {
    /// Always `"lens"`. Never read back off the wire, so it stays `'static`.
    #[serde(rename = "type", skip_deserializing, default = "lens")]
    pub kind_type: &'static str,
    /// Epoch milliseconds.
    pub at: i64,
    pub epoch: u64,
    pub seq: u64,
    #[serde(flatten)]
    pub kind: Kind,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Default)]
struct Queues {
    /// The last seq handed out in the current epoch. 0 means none yet.
    seq: u64,
    frame: Option<Signal>,
    control: VecDeque<Signal>,
}

pub struct Bridge {
    epoch: AtomicU64,
    queues: Mutex<Queues>,
    writer: mpsc::UnboundedSender<String>,
    notify: Notify,
}

impl Bridge {
    pub fn new(writer: mpsc::UnboundedSender<String>) -> Arc<Bridge> {
        Arc::new(Bridge {
            epoch: AtomicU64::new(1),
            queues: Mutex::new(Queues::default()),
            writer,
            notify: Notify::new(),
        })
    }

    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::Acquire)
    }

    /// App switch, window switch, display change or stream rebuild. Both
    /// buffers belong to the old epoch, so both go with it.
    pub fn bump_epoch(&self) -> u64 {
        let mut queues = self.queues.lock().unwrap();
        let epoch = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        queues.seq = 0;
        queues.frame = None;
        queues.control.clear();
        epoch
    }

    /// The next stamp in the current epoch. Use it only when the `ref` has to
    /// exist before the signal does; otherwise [`Bridge::emit`] stamps for you.
    pub fn stamp(&self) -> Stamp {
        let mut queues = self.queues.lock().unwrap();
        self.next(&mut queues)
    }

    /// The next stamp, but only while `epoch` is still current. `None` means
    /// the work that started in that epoch is stale and must be dropped.
    pub fn stamp_in(&self, epoch: u64) -> Option<Stamp> {
        let mut queues = self.queues.lock().unwrap();
        if self.epoch() != epoch {
            return None;
        }
        Some(self.next(&mut queues))
    }

    fn next(&self, queues: &mut Queues) -> Stamp {
        queues.seq += 1;
        Stamp {
            epoch: self.epoch(),
            seq: queues.seq,
        }
    }

    pub fn emit(&self, kind: Kind) -> Stamp {
        let mut queues = self.queues.lock().unwrap();
        let stamp = self.next(&mut queues);
        self.push(&mut queues, stamp, kind);
        drop(queues);
        self.notify.notify_one();
        stamp
    }

    /// Enqueue with a stamp taken earlier. A stamp from a past epoch is
    /// dropped: its work described a screen that is no longer on screen.
    pub fn emit_stamped(&self, stamp: Stamp, kind: Kind) {
        let mut queues = self.queues.lock().unwrap();
        if stamp.epoch != self.epoch() {
            return;
        }
        self.push(&mut queues, stamp, kind);
        drop(queues);
        self.notify.notify_one();
    }

    fn push(&self, queues: &mut Queues, stamp: Stamp, kind: Kind) {
        let frame = kind.is_frame();
        let signal = Signal {
            kind_type: "lens",
            at: now_ms(),
            epoch: stamp.epoch,
            seq: stamp.seq,
            kind,
        };
        if frame {
            queues.frame = Some(signal);
            return;
        }
        if queues.control.len() < QUEUE_CAP {
            queues.control.push_back(signal);
            return;
        }
        // Overflow: the incoming signal is dropped with the queue, and one gap
        // covering every dropped seq takes their place. Clearing first is what
        // guarantees the marker fits.
        let from = queues
            .control
            .front()
            .map_or(signal.seq, |oldest| oldest.seq);
        queues.control.clear();
        let marker = self.next(queues);
        queues.control.push_back(Signal {
            kind_type: "lens",
            at: now_ms(),
            epoch: marker.epoch,
            seq: marker.seq,
            kind: Kind::Gap {
                from,
                to: signal.seq,
            },
        });
    }

    /// The last seq handed out: the boundary a `lens-snapshot` reply carries.
    pub fn last_seq(&self) -> u64 {
        self.queues.lock().unwrap().seq
    }

    /// Epoch and last seq read together, so a snapshot's boundary can never
    /// pair one epoch's seq with another's state.
    pub fn boundary(&self) -> Stamp {
        let queues = self.queues.lock().unwrap();
        Stamp {
            epoch: self.epoch(),
            seq: queues.seq,
        }
    }

    #[cfg(test)]
    pub fn queue_len(&self) -> usize {
        self.queues.lock().unwrap().control.len()
    }

    fn take_next(&self) -> Option<Signal> {
        let mut queues = self.queues.lock().unwrap();
        queues.control.pop_front().or_else(|| queues.frame.take())
    }

    /// Drains control first, then the frame slot, for as long as the Node side
    /// of the channel exists.
    pub async fn run_writer(self: Arc<Self>) {
        loop {
            let waiting = self.notify.notified();
            while let Some(signal) = self.take_next() {
                let Ok(line) = serde_json::to_string(&signal) else {
                    continue;
                };
                if self.writer.send(line).is_err() {
                    return;
                }
            }
            if self.writer.is_closed() {
                return;
            }
            waiting.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bridge() -> (Arc<Bridge>, mpsc::UnboundedReceiver<String>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Bridge::new(tx), rx)
    }

    fn geometry() -> FrameGeometry {
        FrameGeometry {
            window: [0.0, 0.0, 800.0, 600.0],
            scale: 2.0,
            content_rect: [0.0, 0.0, 1600.0, 1200.0],
            content_scale: 1.0,
            captured: [0.0, 0.0, 800.0, 600.0],
        }
    }

    fn frame(stamp: Stamp) -> Kind {
        Kind::Frame {
            frame_ref: stamp.frame_ref(),
            w: 1600,
            h: 1200,
            ratio: 0.5,
            dirty: vec![],
            geometry: geometry(),
        }
    }

    fn status() -> Kind {
        Kind::Status {
            state: "running".into(),
            reason: None,
            screen: true,
            ax: false,
        }
    }

    #[test]
    fn the_frame_slot_keeps_only_the_newest() {
        let (bridge, _rx) = bridge();
        for _ in 0..5 {
            let stamp = bridge.stamp();
            bridge.emit_stamped(stamp, frame(stamp));
        }
        assert_eq!(bridge.queue_len(), 0);
        assert_eq!(bridge.last_seq(), 5);
        let signal = bridge.take_next().expect("one frame");
        assert_eq!(signal.seq, 5);
        assert!(bridge.take_next().is_none());
    }

    #[test]
    fn overflow_collapses_to_exactly_one_gap() {
        let (bridge, _rx) = bridge();
        for _ in 0..QUEUE_CAP {
            bridge.emit(status());
        }
        assert_eq!(bridge.queue_len(), QUEUE_CAP);
        bridge.emit(status()); // seq 4097, dropped with the queue
        assert_eq!(bridge.queue_len(), 1);
        let signal = bridge.take_next().expect("the gap");
        assert_eq!(
            signal.kind,
            Kind::Gap {
                from: 1,
                to: QUEUE_CAP as u64 + 1
            }
        );
        // The gap's own seq continues past the range it covers.
        assert_eq!(signal.seq, QUEUE_CAP as u64 + 2);
        assert_eq!(bridge.last_seq(), QUEUE_CAP as u64 + 2);
        assert!(bridge.take_next().is_none());
    }

    #[test]
    fn an_epoch_bump_resets_seq_and_drops_both_buffers() {
        let (bridge, _rx) = bridge();
        bridge.emit(status());
        let stamp = bridge.stamp();
        bridge.emit_stamped(stamp, frame(stamp));
        assert_eq!(bridge.epoch(), 1);
        assert_eq!(bridge.bump_epoch(), 2);
        assert_eq!(bridge.last_seq(), 0);
        assert_eq!(bridge.queue_len(), 0);
        assert!(bridge.take_next().is_none());
        assert_eq!(bridge.emit(status()), Stamp { epoch: 2, seq: 1 });
    }

    #[test]
    fn a_stale_stamp_is_dropped_by_emit_stamped_and_stamp_in() {
        let (bridge, _rx) = bridge();
        let stamp = bridge.stamp();
        bridge.bump_epoch();
        bridge.emit_stamped(stamp, frame(stamp));
        assert!(bridge.take_next().is_none());
        assert!(bridge.stamp_in(1).is_none());
        assert_eq!(bridge.stamp_in(2), Some(Stamp { epoch: 2, seq: 1 }));
    }

    #[tokio::test]
    async fn the_writer_drains_control_before_the_frame() {
        let (bridge, mut rx) = bridge();
        let stamp = bridge.stamp();
        bridge.emit_stamped(stamp, frame(stamp));
        bridge.emit(status());
        tokio::spawn(bridge.clone().run_writer());
        let first = rx.recv().await.expect("control first");
        assert!(first.contains(r#""kind":"status""#), "{first}");
        let second = rx.recv().await.expect("then the frame");
        assert!(second.contains(r#""kind":"frame""#), "{second}");
    }

    /// The exact field names the Node side parses. Changing one changes the
    /// protocol, so it is pinned literally rather than round-tripped.
    #[test]
    fn every_kind_serialises_to_the_documented_field_names() {
        let line = |kind: Kind| {
            serde_json::to_string(&Signal {
                kind_type: "lens",
                at: 1_758_120_000_000,
                epoch: 7,
                seq: 310,
                kind,
            })
            .unwrap()
        };
        let head = r#"{"type":"lens","at":1758120000000,"epoch":7,"seq":310,"#;

        assert_eq!(
            line(frame(Stamp { epoch: 7, seq: 310 })),
            format!(
                r#"{head}"kind":"frame","ref":"f-7-310","w":1600,"h":1200,"ratio":0.5,"dirty":[],"geometry":{{"window":[0.0,0.0,800.0,600.0],"scale":2.0,"contentRect":[0.0,0.0,1600.0,1200.0],"contentScale":1.0,"captured":[0.0,0.0,800.0,600.0]}}}}"#
            )
        );
        assert_eq!(
            line(Kind::App {
                bundle: "com.apple.Safari".into(),
                name: "Safari".into(),
                pid: 42
            }),
            format!(r#"{head}"kind":"app","bundle":"com.apple.Safari","name":"Safari","pid":42}}"#)
        );
        assert_eq!(
            line(Kind::Window {
                id: 9,
                title: "Docs".into(),
                bounds: [0.0, 0.0, 10.0, 20.0],
                url: None,
                display: DisplayInfo {
                    id: 1,
                    w: 1512.0,
                    h: 982.0,
                    scale: 2.0
                }
            }),
            format!(
                r#"{head}"kind":"window","id":9,"title":"Docs","bounds":[0.0,0.0,10.0,20.0],"display":{{"id":1,"w":1512.0,"h":982.0,"scale":2.0}}}}"#
            )
        );
        assert_eq!(
            line(Kind::AxFocus {
                role: "AXTextField".into(),
                label: "Search".into(),
                value: "cat".into(),
                bounds: Some([1.0, 2.0, 3.0, 4.0])
            }),
            format!(
                r#"{head}"kind":"ax-focus","role":"AXTextField","label":"Search","value":"cat","bounds":[1.0,2.0,3.0,4.0]}}"#
            )
        );
        assert_eq!(
            line(Kind::AxValue {
                role: "AXTextArea".into(),
                label: String::new(),
                value: "x".into(),
                bounds: None
            }),
            format!(
                r#"{head}"kind":"ax-value","role":"AXTextArea","label":"","value":"x","bounds":null}}"#
            )
        );
        assert_eq!(
            line(Kind::AxWindow {
                title: "Docs".into(),
                bounds: [0.0, 0.0, 1.0, 1.0]
            }),
            format!(r#"{head}"kind":"ax-window","title":"Docs","bounds":[0.0,0.0,1.0,1.0]}}"#)
        );
        assert_eq!(
            line(Kind::AxSheet {
                title: "Save".into(),
                bounds: [0.0, 0.0, 1.0, 1.0]
            }),
            format!(r#"{head}"kind":"ax-sheet","title":"Save","bounds":[0.0,0.0,1.0,1.0]}}"#)
        );
        assert_eq!(
            line(Kind::AxText {
                rect: [0.0, 0.0, 8.0, 9.0],
                lines: vec![Line {
                    bbox: [1.0, 2.0, 3.0, 4.0],
                    text: "hi".into(),
                    conf: None
                }]
            }),
            format!(
                r#"{head}"kind":"ax-text","rect":[0.0,0.0,8.0,9.0],"lines":[{{"bbox":[1.0,2.0,3.0,4.0],"text":"hi"}}]}}"#
            )
        );
        assert_eq!(
            line(Kind::Ocr {
                frame_ref: "f-7-309".into(),
                rect: [0.0, 0.0, 8.0, 9.0],
                lines: vec![Line {
                    bbox: [1.0, 2.0, 3.0, 4.0],
                    text: "hi".into(),
                    conf: Some(0.5)
                }],
                ms: 115,
                ax_covered: false
            }),
            format!(
                r#"{head}"kind":"ocr","ref":"f-7-309","rect":[0.0,0.0,8.0,9.0],"lines":[{{"bbox":[1.0,2.0,3.0,4.0],"text":"hi","conf":0.5}}],"ms":115,"axCovered":false}}"#
            )
        );
        assert_eq!(
            line(Kind::Gap { from: 4, to: 9 }),
            format!(r#"{head}"kind":"gap","from":4,"to":9}}"#)
        );
        assert_eq!(
            line(status()),
            format!(r#"{head}"kind":"status","state":"running","screen":true,"ax":false}}"#)
        );
        assert_eq!(
            line(Kind::Status {
                state: "stopped".into(),
                reason: Some("permission".into()),
                screen: false,
                ax: false
            }),
            format!(
                r#"{head}"kind":"status","state":"stopped","reason":"permission","screen":false,"ax":false}}"#
            )
        );
        assert_eq!(
            line(Kind::Helper {
                state: "rate-limited".into(),
                reset_at: Some(1_758_120_060_000),
                outstanding: 2
            }),
            format!(
                r#"{head}"kind":"helper","state":"rate-limited","resetAt":1758120060000,"outstanding":2}}"#
            )
        );
        assert_eq!(
            line(Kind::Helper {
                state: "down".into(),
                reset_at: None,
                outstanding: 0
            }),
            format!(r#"{head}"kind":"helper","state":"down","outstanding":0}}"#)
        );
    }
}
