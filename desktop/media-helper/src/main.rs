//! Private helper: media stays in GStreamer/WebRTC; stdin/stdout carry only bounded control messages.
#[cfg(target_os = "macos")]
mod macos;
mod signaller;
use gst::prelude::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::sync::{mpsc, OnceLock};
use std::time::{Duration, Instant};
static OUTPUT: OnceLock<mpsc::SyncSender<Value>> = OnceLock::new();
fn emit(value: Value) {
    // Failing closed avoids an unbounded signal/input queue when the parent disappears.
    if OUTPUT.get().is_none_or(|out| out.try_send(value).is_err()) {
        std::process::exit(2);
    }
}
struct Capture {
    pipeline: gst::Pipeline,
    video: gst::Element,
    audio: gst::Element,
    listening: bool,
    audio_source: Option<gst::Element>,
    synthetic: bool,
    #[cfg(target_os = "macos")]
    screen: Option<macos::Screen>,
}
impl Capture {
    fn listen(&mut self, listen: bool) -> Result<(), String> {
        if self.listening == listen {
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        if let Some(screen) = &self.screen {
            screen.audio(listen)?;
            self.listening = listen;
            return Ok(());
        }
        if listen {
            let source = if self.synthetic {
                gst::parse::bin_from_description("audiotestsrc is-live=true volume=0.1 ! audio/x-raw,rate=48000,channels=2 ! queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 leaky=downstream", true).map_err(|e| e.to_string())?.upcast::<gst::Element>()
            } else {
                #[cfg(target_os = "linux")]
                {
                    linux_audio()?
                }
                #[cfg(target_os = "windows")]
                {
                    gst::parse::bin_from_description("wasapi2src loopback=true ! audioconvert ! audioresample ! queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 leaky=downstream", true).map_err(|e| e.to_string())?.upcast::<gst::Element>()
                }
                #[cfg(target_os = "macos")]
                {
                    return Err("System audio unavailable".into());
                }
            };
            self.pipeline.add(&source).map_err(|e| e.to_string())?;
            if let Err(error) = source
                .link(&self.audio)
                .and_then(|_| source.sync_state_with_parent())
            {
                let _ = source.set_state(gst::State::Null);
                let _ = self.pipeline.remove(&source);
                return Err(error.to_string());
            }
            self.audio_source = Some(source);
        } else if let Some(source) = self.audio_source.take() {
            source
                .set_state(gst::State::Null)
                .map_err(|e| e.to_string())?;
            source.unlink(&self.audio);
            self.pipeline.remove(&source).map_err(|e| e.to_string())?;
        }
        self.listening = listen;
        Ok(())
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        if let Some(screen) = self.screen.as_mut() {
            let _ = screen.stream.stop_capture();
        }
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}
struct Viewer {
    source: String,
    expires: Instant,
    answered: bool,
    listening: bool,
    branch: gst::Bin,
    signaller: signaller::Adapter,
}
impl Drop for Viewer {
    fn drop(&mut self) {
        // Block each tee output at an idle boundary while removing only this viewer's branch.
        for pad in self.branch.sink_pads() {
            if let Some(peer) = pad.peer() {
                let (send, receive) = mpsc::sync_channel(1);
                let probe = peer.add_probe(gst::PadProbeType::IDLE, move |_, _| {
                    let _ = send.try_send(());
                    gst::PadProbeReturn::Ok
                });
                let _ = receive.recv_timeout(Duration::from_millis(150));
                let _ = peer.unlink(&pad);
                if let Some(element) = peer.parent_element() {
                    element.release_request_pad(&peer);
                }
                if let Some(probe) = probe {
                    peer.remove_probe(probe);
                }
            }
        }
        let _ = self.branch.set_state(gst::State::Null);
        if let Some(parent) = self
            .branch
            .parent()
            .and_then(|p| p.downcast::<gst::Bin>().ok())
        {
            let _ = parent.remove(&self.branch);
        }
    }
}
fn viewer(value: &Value, source: String, capture: &mut Capture) -> Result<Viewer, String> {
    let adapter = signaller::Adapter::new();
    let sink = gstrswebrtc::webrtcsink::BaseWebRTCSink::with_signaller(adapter.clone().upcast());
    sink.set_property("stun-server", None::<String>);
    sink.set_property("enable-control-data-channel", false);
    sink.set_property("enable-data-channel-navigation", false);
    sink.set_property(
        "video-caps",
        gst::Caps::from_str("video/x-h264;video/x-vp8").map_err(|e| e.to_string())?,
    );
    sink.set_property(
        "audio-caps",
        gst::Caps::from_str("audio/x-opus").map_err(|e| e.to_string())?,
    );
    if value["forceTurn"] == true {
        sink.set_property_from_str("ice-transport-policy", "relay");
    }
    let turns: Vec<String> = value["turn"]
        .as_array()
        .map(|v| {
            v.iter()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    sink.set_property("turn-servers", gst::Array::new(turns));
    let max = match value["quality"].as_str() {
        Some("saver") => 2_000_000u32,
        Some("sharp") => 20_000_000,
        _ => 8_000_000,
    };
    sink.set_property("max-bitrate", max);
    sink.set_property("start-bitrate", max.min(4_000_000));
    // ponytail: webrtcsink 0.15.3 cannot steer VideoToolbox/Media Foundation bitrate or
    // negotiate TWCC for them. These are fixed targets, NOT congestion adaptation; use
    // upstream encoder support before claiming adaptive hardware encoding.
    let fixed_kbps = max / 1000 * 3 / 5;
    sink.connect("encoder-setup", false, move |args| {
        let enc = args[3].get::<gst::Element>().ok()?;
        let name = enc
            .factory()
            .map(|f| f.name().to_string())
            .unwrap_or_default();
        let set = |property: &str, text: &str| {
            if enc.has_property(property) {
                enc.set_property_from_str(property, text);
            }
        };
        if name.starts_with("vtenc_h264") {
            // webrtcsink 0.15.3 forces constrained-baseline in its parser filter, but
            // VideoToolbox emits baseline. Use its real profile, never relabel SDP/SPS.
            // The internal name is pinned to 0.15.3. The separate negotiated encoder
            // and RTP filters still enforce the peer's answer, including its profile.
            let filter_name = if args[1].get::<String>().is_ok_and(|id| id == "discovery") {
                "codec-parser-caps".to_owned()
            } else {
                format!("codec-parser-caps-{}", args[2].get::<String>().ok()?)
            };
            if let Some(filter) = enc
                .parent()
                .and_then(|p| p.downcast::<gst::Bin>().ok())
                .and_then(|bin| bin.by_name(&filter_name))
            {
                filter.set_property(
                    "caps",
                    gst::Caps::builder("video/x-h264")
                        .field("stream-format", "avc")
                        .field("profile", "baseline")
                        .build(),
                );
            }
            set("realtime", "true");
            set("allow-frame-reordering", "false");
            set("bitrate", &fixed_kbps.to_string());
            // ABR is a target, not a ceiling. Bound its one-second average to the preset.
            set("data-rate-limits", &format!("{},1", max / 1000));
            set("max-keyframe-interval", "2560");
        } else if name.starts_with("mfh264") {
            set("low-latency", "true");
            set("bframes", "0");
            set("rc-mode", "cbr");
            set("bitrate", &fixed_kbps.to_string());
            set("gop-size", "2560");
        } else {
            return Some(false.to_value());
        }
        Some(true.to_value())
    });
    sink.connect("consumer-added", false, |args| {
        let session = args[1].get::<String>().ok()?;
        let bin = args[2].get::<gst::Element>().ok()?;
        let channel = bin.emit_by_name::<Option<gst_webrtc::WebRTCDataChannel>>(
            "create-data-channel",
            &[&"rimeward-input-v1", &None::<gst::Structure>],
        );
        if let Some(channel) = channel {
            channel.connect_on_message_string(move |_, message| {
                if let Some(text) = message.filter(|s| s.len() <= 64 * 1024) {
                    if let Ok(input) = serde_json::from_str::<Value>(text) {
                        emit(json!({"event":"input","session":session,"input":input}));
                    }
                }
            });
        }
        None
    });
    let mut listening = value["audio"] == true;
    if listening {
        if let Err(reason) = capture.listen(true) {
            listening = false;
            emit(
                json!({"event":"capability-unavailable","session":value["session"],"capability":"audio","reason":reason}),
            );
        }
    }
    let width = value["width"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 3840)
        .ok_or("Invalid video width")?;
    let height = value["height"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 3840)
        .ok_or("Invalid video height")?;
    let fps = if value["quality"] == "saver" { 15 } else { 30 };
    let branch = gst::Bin::new();
    branch.add(&sink).map_err(|e| e.to_string())?;
    let video = gst::parse::bin_from_description(&format!("queue max-size-buffers=1 max-size-bytes=0 max-size-time=0 leaky=downstream ! videoconvert ! videoscale ! videorate ! capsfilter caps=\"video/x-raw,width={width},height={height},framerate={fps}/1\""), true).map_err(|e| e.to_string())?;
    branch.add(&video).map_err(|e| e.to_string())?;
    video.link(&sink).map_err(|e| e.to_string())?;
    let pad =
        gst::GhostPad::builder_with_target(&video.static_pad("sink").ok_or("Missing video pad")?)
            .map_err(|e| e.to_string())?
            .name("video_sink")
            .build();
    branch.add_pad(&pad).map_err(|e| e.to_string())?;
    if listening {
        let audio = gst::parse::bin_from_description("queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 leaky=downstream ! audioconvert ! audioresample ! capsfilter caps=\"audio/x-raw,rate=48000,channels=2\"", true).map_err(|e| e.to_string())?;
        branch.add(&audio).map_err(|e| e.to_string())?;
        audio.link(&sink).map_err(|e| e.to_string())?;
        let pad = gst::GhostPad::builder_with_target(
            &audio.static_pad("sink").ok_or("Missing audio pad")?,
        )
        .map_err(|e| e.to_string())?
        .name("audio_sink")
        .build();
        branch.add_pad(&pad).map_err(|e| e.to_string())?;
    }
    // RAII also unlinks a partially attached viewer if a later pad/state operation fails.
    let viewer = Viewer {
        source,
        expires: Instant::now() + Duration::from_secs(5),
        answered: false,
        listening,
        branch,
        signaller: adapter,
    };
    capture
        .pipeline
        .add(&viewer.branch)
        .map_err(|e| e.to_string())?;
    // A live tee must not push into a NULL-state queue: FLUSHING stops the source.
    viewer
        .branch
        .sync_state_with_parent()
        .map_err(|e| e.to_string())?;
    capture
        .video
        .link_pads(None, &viewer.branch, Some("video_sink"))
        .map_err(|e| e.to_string())?;
    if listening {
        capture
            .audio
            .link_pads(None, &viewer.branch, Some("audio_sink"))
            .map_err(|e| e.to_string())?;
    }
    Ok(viewer)
}
fn capture(value: &Value, synthetic: bool) -> Result<Capture, String> {
    let pipeline = gst::Pipeline::new();
    let tee = || {
        gst::ElementFactory::make("tee")
            .property("allow-not-linked", true)
            .build()
            .map_err(|e| e.to_string())
    };
    let video = tee()?;
    let audio = tee()?;
    pipeline
        .add_many([&video, &audio])
        .map_err(|e| e.to_string())?;
    let width = value["captureWidth"]
        .as_u64()
        .or(value["width"].as_u64())
        .filter(|n| *n > 0 && *n <= 3840)
        .ok_or("Invalid capture width")? as i32;
    let height = value["captureHeight"]
        .as_u64()
        .or(value["height"].as_u64())
        .filter(|n| *n > 0 && *n <= 3840)
        .ok_or("Invalid capture height")? as i32;
    #[cfg(target_os = "macos")]
    let mut screen = None;
    if synthetic {
        let src = gst::parse::bin_from_description(&format!("videotestsrc is-live=true pattern=ball ! video/x-raw,width={width},height={height},framerate=30/1 ! queue max-size-buffers=1 max-size-bytes=0 max-size-time=0 leaky=downstream"), true).map_err(|e| e.to_string())?;
        pipeline.add(&src).map_err(|e| e.to_string())?;
        src.link(&video).map_err(|e| e.to_string())?;
    } else {
        #[cfg(target_os = "macos")]
        {
            screen = Some(macos::attach(
                &pipeline, &video, &audio, value, width, height, 30,
            )?);
        }
        #[cfg(target_os = "windows")]
        {
            let id = value["display"].as_u64().ok_or("Invalid display")?;
            let src = gst::parse::bin_from_description(&format!("d3d11screencapturesrc monitor-handle={id} show-cursor=true ! d3d11download ! videoconvert ! videoscale ! videorate ! video/x-raw,width={width},height={height},framerate=30/1 ! queue max-size-buffers=1 max-size-bytes=0 max-size-time=0 leaky=downstream"), true).map_err(|e| e.to_string())?;
            pipeline.add(&src).map_err(|e| e.to_string())?;
            src.link(&video).map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "linux")]
        {
            let source = if std::env::var_os("WAYLAND_DISPLAY").is_some()
                || std::env::var_os("RIMEWARD_PIPEWIRE_FD").is_some()
            {
                pipewire_source(value)?
            } else {
                let x = value["x"].as_i64().ok_or("Missing display x")?;
                let y = value["y"].as_i64().ok_or("Missing display y")?;
                let sw = value["sourceWidth"]
                    .as_i64()
                    .ok_or("Missing display width")?;
                let sh = value["sourceHeight"]
                    .as_i64()
                    .ok_or("Missing display height")?;
                format!("ximagesrc use-damage=false show-pointer=true startx={x} starty={y} endx={} endy={}", x+sw-1, y+sh-1)
            };
            let src = gst::parse::bin_from_description(&format!("{source} ! videoconvert ! videoscale ! videorate ! video/x-raw,width={width},height={height},framerate=30/1 ! queue max-size-buffers=1 max-size-bytes=0 max-size-time=0 leaky=downstream"), true).map_err(|e| e.to_string())?;
            pipeline.add(&src).map_err(|e| e.to_string())?;
            src.link(&video).map_err(|e| e.to_string())?;
        }
    }
    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| e.to_string())?;
    Ok(Capture {
        pipeline,
        video,
        audio,
        listening: false,
        audio_source: None,
        synthetic,
        #[cfg(target_os = "macos")]
        screen,
    })
}
#[cfg(target_os = "linux")]
fn pipewire_source(value: &Value) -> Result<String, String> {
    let fd = std::env::var("RIMEWARD_PIPEWIRE_FD")
        .ok()
        .and_then(|s| s.parse::<i32>().ok())
        .filter(|fd| *fd >= 3)
        .ok_or("Authorized portal PipeWire descriptor required")?;
    let node = value["display"]
        .as_u64()
        .filter(|v| *v <= u32::MAX as u64)
        .ok_or("Invalid portal stream")?;
    Ok(format!("pipewiresrc fd={fd} path={node} do-timestamp=true"))
}
#[cfg(target_os = "linux")]
fn snapshot(value: &Value) -> Result<Value, String> {
    use base64::Engine;
    let width = value["width"]
        .as_u64()
        .filter(|w| *w > 0 && *w <= 1600)
        .ok_or("Invalid snapshot size")?;
    let height = value["height"]
        .as_u64()
        .filter(|h| *h > 0 && *h <= 1600)
        .ok_or("Invalid snapshot size")?;
    let source = pipewire_source(value)?;
    let pipeline = gst::parse::launch(&format!("{source} ! queue max-size-buffers=1 max-size-bytes=0 max-size-time=0 leaky=downstream ! videoconvert ! videoscale ! video/x-raw,width={width},height={height} ! jpegenc quality=80 ! appsink name=frame sync=false max-buffers=1 drop=true")).map_err(|e| e.to_string())?.downcast::<gst::Pipeline>().map_err(|_| "Invalid snapshot pipeline")?;
    let result = (|| {
        let sink = pipeline
            .by_name("frame")
            .ok_or("Missing frame sink")?
            .downcast::<gst_app::AppSink>()
            .map_err(|_| "Invalid frame sink")?;
        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| e.to_string())?;
        let sample = sink
            .try_pull_sample(gst::ClockTime::from_seconds(2))
            .ok_or("Portal screen frame timed out")?;
        let buffer = sample
            .buffer()
            .ok_or("Empty portal frame")?
            .map_readable()
            .map_err(|e| e.to_string())?;
        if buffer.size() > 2 * 1024 * 1024 {
            return Err("Portal snapshot is too large".into());
        }
        Ok(
            json!({"image":base64::engine::general_purpose::STANDARD.encode(buffer.as_slice()),"imageWidth":width,"imageHeight":height}),
        )
    })();
    let _ = pipeline.set_state(gst::State::Null);
    result
}
#[cfg(target_os = "linux")]
fn linux_audio() -> Result<gst::Element, String> {
    let monitor = gst::DeviceMonitor::new();
    monitor.add_filter(
        Some("Audio"),
        Some(&gst::Caps::from_str("audio/x-raw").map_err(|e| e.to_string())?),
    );
    monitor.start().map_err(|e| e.to_string())?;
    let devices = monitor.devices();
    monitor.stop();
    let output = devices
        .iter()
        .find(|d| {
            d.device_class().as_str() == "Audio/Sink"
                && d.properties()
                    .is_some_and(|p| p.get::<bool>("is-default").unwrap_or(false))
        })
        .ok_or("No selected PulseAudio system output is available")?;
    if output.find_property("internal-name").is_none() {
        return Err("System output monitor unavailable".into());
    }
    let name = format!("{}.monitor", output.property::<String>("internal-name"));
    // Never use the default source: it is commonly the microphone. Resolve a real monitor device first.
    let device = devices
        .iter()
        .find(|d| {
            d.device_class().as_str() == "Audio/Source"
                && d.find_property("internal-name").is_some()
                && d.property::<String>("internal-name") == name
                && d.properties().is_some_and(|p| {
                    p.get::<String>("device.class")
                        .is_ok_and(|c| c == "monitor")
                })
        })
        .ok_or("The selected system output has no available monitor source")?;
    let source = device
        .create_element(Some("system_output"))
        .map_err(|e| e.to_string())?;
    let convert = gst::parse::bin_from_description("audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2 ! queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 leaky=downstream", true).map_err(|e| e.to_string())?;
    let bin = gst::Bin::new();
    bin.add_many([&source, convert.upcast_ref()])
        .map_err(|e| e.to_string())?;
    source.link(&convert).map_err(|e| e.to_string())?;
    let pad = gst::GhostPad::builder_with_target(
        &convert.static_pad("src").ok_or("Missing audio output")?,
    )
    .map_err(|e| e.to_string())?
    .name("src")
    .build();
    bin.add_pad(&pad).map_err(|e| e.to_string())?;
    Ok(bin.upcast())
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let synthetic = std::env::args().any(|a| a == "--synthetic-test");
    // The parent sets a bundled-only plugin path and scanner. Never inherit a user's plugin override.
    if std::env::var_os("RIMEWARD_MEDIA_PLUGIN_DIR").is_none() {
        return Err("Bundled media runtime required".into());
    }
    let plugins = std::env::var("RIMEWARD_MEDIA_PLUGIN_DIR")?;
    std::env::set_var("GST_PLUGIN_SYSTEM_PATH_1_0", &plugins);
    std::env::set_var("GST_PLUGIN_PATH_1_0", "");
    std::env::set_var("GST_PLUGIN_PATH", "");
    std::env::set_var("GST_PLUGIN_SYSTEM_PATH", &plugins);
    gst::init()?;
    gstrsrtp::plugin_register_static()?;
    if gst::version().0 != 1 || gst::version().1 != 28 || gst::version().2 != 6 {
        return Err("GStreamer 1.28.6 required".into());
    }
    let (out, output) = mpsc::sync_channel(64);
    OUTPUT.set(out).ok();
    std::thread::spawn(move || {
        let mut stdout = std::io::stdout().lock();
        for message in output {
            if writeln!(stdout, "{message}")
                .and_then(|_| stdout.flush())
                .is_err()
            {
                std::process::exit(0);
            }
        }
    });
    let (commands, input) = mpsc::sync_channel(32);
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        loop {
            let mut bytes = Vec::new();
            let read = std::io::Read::by_ref(&mut stdin)
                .take(1024 * 1024 + 1)
                .read_until(b'\n', &mut bytes);
            if !matches!(read, Ok(n) if n > 0 && n <= 1024 * 1024) {
                std::process::exit(0);
            }
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                if commands.try_send(value).is_err() {
                    std::process::exit(2);
                }
            }
        }
    });
    emit(json!({"event":"ready","protocol":1,"gstreamer":"1.28.6"}));
    let mut captures = HashMap::<String, Capture>::new();
    let mut viewers = HashMap::<String, Viewer>::new();
    let mut last_counts = (0, 0, 0);
    loop {
        let now = Instant::now();
        // Drain native errors on the control loop: no GLib main loop or blocking bus thread.
        let mut failed = Vec::new();
        for (key, capture) in &captures {
            if let Some(bus) = capture.pipeline.bus() {
                for message in bus.iter().take(64) {
                    let reason = match message.view() {
                        gst::MessageView::Error(error) => error.error().to_string(),
                        gst::MessageView::Eos(_) => "Capture ended".into(),
                        _ => continue,
                    };
                    failed.push((key.clone(), message.src().cloned(), reason));
                }
            }
        }
        for (source, origin, reason) in failed {
            let within = |element: &gst::Element| {
                origin.as_ref().is_some_and(|o| {
                    o == element.upcast_ref::<gst::Object>() || o.has_as_ancestor(element)
                })
            };
            if let Some(id) = viewers
                .iter()
                .find(|(_, v)| v.source == source && within(v.branch.upcast_ref()))
                .map(|(id, _)| id.clone())
            {
                viewers.remove(&id);
                emit(json!({"event":"closed","session":id,"reason":reason}));
                continue;
            }
            if let Some(capture) = captures.get_mut(&source) {
                // Teardown can leave queued errors from a branch that has already been removed.
                if origin.is_some() && !within(capture.pipeline.upcast_ref()) {
                    continue;
                }
                if capture.audio_source.as_ref().is_some_and(within)
                    && capture.listen(false).is_ok()
                {
                    for (id, viewer) in viewers
                        .iter_mut()
                        .filter(|(_, v)| v.source == source && v.listening)
                    {
                        viewer.listening = false;
                        emit(
                            json!({"event":"capability-unavailable","session":id,"capability":"audio","reason":reason}),
                        );
                    }
                    continue;
                }
            }
            viewers.retain(|id, viewer| {
                if viewer.source != source {
                    return true;
                }
                emit(json!({"event":"closed","session":id,"reason":reason}));
                false
            });
        }
        let expired: Vec<String> = viewers
            .iter()
            .filter(|(_, v)| v.expires <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            if let Some(v) = viewers.remove(&id) {
                v.signaller.disconnect_viewer(&id);
            }
        }
        captures.retain(|key, capture| {
            if !viewers.values().any(|v| &v.source == key) {
                return false;
            }
            let listen = viewers.values().any(|v| &v.source == key && v.listening);
            if let Err(reason) = capture.listen(listen) {
                viewers.retain(|id, v| {
                    if &v.source == key {
                        emit(json!({"event":"closed","session":id,"reason":reason}));
                        false
                    } else {
                        true
                    }
                });
                return false;
            }
            true
        });
        let counts = (
            captures.len(),
            viewers.len(),
            captures
                .values()
                .filter(|capture| capture.listening)
                .count(),
        );
        if counts != last_counts {
            last_counts = counts;
            for session in viewers.keys() {
                emit(
                    json!({"event":"state","session":session,"captures":counts.0,"viewers":counts.1,"audioCaptures":counts.2}),
                );
            }
        }
        let Ok(value) = input.recv_timeout(Duration::from_millis(50)) else {
            continue;
        };
        let session = value["session"].as_str().unwrap_or("").to_owned();
        if session.len() != 36 {
            emit(json!({"event":"error","reason":"Invalid session"}));
            continue;
        }
        let result = (|| -> Result<(), String> {
            match value["command"].as_str() {
                #[cfg(target_os = "linux")]
                Some("snapshot") => {
                    let frame = snapshot(&value)?;
                    emit(json!({"event":"snapshot","session":session,"frame":frame}));
                }
                Some("start") => {
                    if viewers.contains_key(&session) || viewers.len() >= 4 {
                        return Err("Viewer limit or duplicate session".into());
                    }
                    // The host requests viewer-sized macOS captures. Sharing by display alone
                    // would upscale the first small capture for later sharp viewers. Other hosts
                    // supply a common capture size, so their mixed-quality viewers still share.
                    let source = format!(
                        "{}:{}x{}",
                        value["display"],
                        value["captureWidth"]
                            .as_u64()
                            .or(value["width"].as_u64())
                            .unwrap_or(0),
                        value["captureHeight"]
                            .as_u64()
                            .or(value["height"].as_u64())
                            .unwrap_or(0)
                    );
                    if !captures.contains_key(&source) {
                        captures.insert(source.clone(), capture(&value, synthetic)?);
                    }
                    let viewer = viewer(
                        &value,
                        source.clone(),
                        captures.get_mut(&source).ok_or("Capture unavailable")?,
                    )?;
                    viewer.signaller.connect_viewer(&session);
                    viewers.insert(session.clone(), viewer);
                }
                Some("test-error") if synthetic => {
                    let viewer = viewers.get(&session).ok_or("Unknown test viewer")?;
                    let capture = captures.get(&viewer.source).ok_or("Unknown test capture")?;
                    let element = if value["audio"] == true {
                        capture
                            .audio_source
                            .as_ref()
                            .ok_or("No test audio source")?
                    } else {
                        viewer.branch.upcast_ref()
                    };
                    element
                        .post_message(
                            gst::message::Error::builder(
                                gst::ResourceError::Failed,
                                "Generated acceptance fault",
                            )
                            .src(element)
                            .build(),
                        )
                        .map_err(|e| e.to_string())?;
                }
                Some("renew") => {
                    viewers.get_mut(&session).ok_or("Unknown session")?.expires =
                        now + Duration::from_secs(5);
                }
                Some("stop") => {
                    if let Some(v) = viewers.remove(&session) {
                        v.signaller.disconnect_viewer(&session);
                    }
                }
                Some("answer") => {
                    let v = viewers.get_mut(&session).ok_or("Unknown session")?;
                    if v.answered {
                        return Err("SDP answer already bound".into());
                    }
                    v.signaller
                        .answer(&session, value["sdp"].as_str().ok_or("Missing SDP")?)?;
                    v.answered = true;
                }
                Some("ice") => {
                    let v = viewers.get(&session).ok_or("Unknown session")?;
                    v.signaller.ice(
                        &session,
                        value["candidate"].as_str().ok_or("Missing ICE")?,
                        value["sdpMLineIndex"]
                            .as_u64()
                            .and_then(|n| u32::try_from(n).ok())
                            .ok_or("Invalid ICE index")?,
                    )?;
                }
                _ => return Err("Unknown media command".into()),
            }
            Ok(())
        })();
        if let Err(reason) = result {
            emit(json!({"event":"error","session":session,"reason":reason}));
        }
    }
}
use std::str::FromStr;
