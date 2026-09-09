//! The real macOS sharing menu, scoped to the session's exact window.
use crate::background_worker::Worker;
use screencapturekit::{cm::CMTime, prelude::*, stream::StreamCallbacks};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub struct Sharing {
    stream: Option<SCStream>,
    ended: Arc<AtomicBool>,
    intentional_stop: Arc<AtomicBool>,
}
impl Sharing {
    pub fn start(pid: i32, window_id: u32, worker: Arc<Worker>) -> Result<Self, String> {
        let content = SCShareableContent::get().map_err(|e| e.to_string())?;
        let window = content
            .windows()
            .into_iter()
            .find(|w| {
                w.window_id() == window_id
                    && w.owning_application()
                        .is_some_and(|a| a.process_id() == pid)
            })
            .ok_or("Sharing target window unavailable")?;
        if !worker.is_available() {
            return Err("Background session ended before sharing started".into());
        }
        let filter = SCContentFilter::create().with_window(&window).build();
        let frame = window.frame();
        let scale = (640.0 / frame.size.width.max(frame.size.height)).min(1.0);
        let config = SCStreamConfiguration::new()
            .with_width((frame.size.width * scale).max(1.0) as u32)
            .with_height((frame.size.height * scale).max(1.0) as u32)
            .with_minimum_frame_interval(&CMTime::new(1, 2))
            .with_queue_depth(3)
            .with_shows_cursor(false);
        let ended = Arc::new(AtomicBool::new(false));
        let stopped = ended.clone();
        let intentional_stop = Arc::new(AtomicBool::new(false));
        let intentional = intentional_stop.clone();
        let delegate = StreamCallbacks::new().on_stop(move |_| {
            stopped.store(true, Ordering::SeqCst);
            if !intentional.load(Ordering::SeqCst) && worker.is_available() {
                crate::background_apps::sharing_stopped();
            }
            // The system Stop Sharing button must interrupt even a blocked tool.
            worker.cancel();
        });
        let mut stream = SCStream::new_with_delegate(&filter, &config, delegate);
        // macOS renders the preview. Frames never enter our attachment or relay paths.
        stream
            .add_output_handler(|_, _| {}, SCStreamOutputType::Screen)
            .ok_or("Unable to register the sharing preview")?;
        let sharing = Self {
            stream: Some(stream),
            ended,
            intentional_stop,
        };
        sharing
            .stream
            .as_ref()
            .unwrap()
            .start_capture()
            .map_err(|e| e.to_string())?;
        Ok(sharing)
    }
    pub fn ended(&self) -> bool {
        self.ended.load(Ordering::SeqCst)
    }
}
impl Drop for Sharing {
    fn drop(&mut self) {
        self.intentional_stop.store(true, Ordering::SeqCst);
        if let Some(stream) = self.stream.take() {
            // Completion may arrive on the UI queue; never block that queue or Stop.
            tauri::async_runtime::spawn_blocking(move || {
                let _ = stream.stop_capture();
            });
        }
    }
}
