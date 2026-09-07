use gst::prelude::*;
use screencapturekit::cv::CVPixelBufferLockFlags;
use screencapturekit::prelude::*;
use serde_json::Value;

struct Samples {
    video: gst_app::AppSrc,
    audio: Option<gst_app::AppSrc>,
    width: usize,
    height: usize,
}
impl SCStreamOutputTrait for Samples {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, kind: SCStreamOutputType) {
        match kind {
            SCStreamOutputType::Screen => {
                let Some(pixel) = sample.pixel_buffer() else {
                    return;
                };
                let Ok(guard) = pixel.lock(CVPixelBufferLockFlags::READ_ONLY) else {
                    return;
                };
                // The buffer remains locked and retained for the entire bounded copy.
                let Some(source) = (unsafe { guard.as_slice() }) else {
                    return;
                };
                let row = pixel.bytes_per_row();
                if row < self.width * 4 || source.len() < row * self.height {
                    return;
                }
                let mut bytes = vec![0u8; self.width * self.height * 4];
                for y in 0..self.height {
                    bytes[y * self.width * 4..(y + 1) * self.width * 4]
                        .copy_from_slice(&source[y * row..y * row + self.width * 4]);
                }
                let _ = self.video.push_buffer(gst::Buffer::from_mut_slice(bytes));
            }
            SCStreamOutputType::Audio => {
                let Some(audio) = &self.audio else {
                    return;
                };
                let Some(list) = sample.audio_buffer_list() else {
                    return;
                };
                // ScreenCaptureKit emits float32 audio. Interleave its two mono buffers when needed.
                let Some(first) = list.buffer(0) else {
                    return;
                };
                let bytes = if list.num_buffers() == 1 && first.number_channels() == 2 {
                    first.data().to_vec()
                } else if list.num_buffers() == 2 {
                    let Some(second) = list.buffer(1) else {
                        return;
                    };
                    if first.data().len() != second.data().len() || first.data().len() > 256 * 1024
                    {
                        return;
                    }
                    let mut bytes = Vec::with_capacity(first.data().len() * 2);
                    for (left, right) in first
                        .data()
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .zip(second.data().as_chunks::<4>().0.iter())
                    {
                        bytes.extend_from_slice(left);
                        bytes.extend_from_slice(right);
                    }
                    bytes
                } else {
                    return;
                };
                if bytes.len() <= 512 * 1024 {
                    let _ = audio.push_buffer(gst::Buffer::from_mut_slice(bytes));
                }
            }
            _ => {}
        }
    }
}
fn source(caps: &gst::Caps) -> gst_app::AppSrc {
    let src = gst_app::AppSrc::builder()
        .caps(caps)
        .is_live(true)
        .format(gst::Format::Time)
        .do_timestamp(true)
        .max_buffers(1)
        .max_bytes(0)
        .build();
    src.set_property_from_str("leaky-type", "downstream");
    src
}
pub struct Screen {
    pub stream: SCStream,
    config: SCStreamConfiguration,
}
impl Screen {
    pub fn audio(&self, enabled: bool) -> Result<(), String> {
        let config = self.config.clone().with_captures_audio(enabled);
        self.stream
            .update_configuration(&config)
            .map_err(|e| e.to_string())
    }
}
pub fn attach(
    pipeline: &gst::Pipeline,
    video_sink: &gst::Element,
    audio_sink: &gst::Element,
    value: &Value,
    width: i32,
    height: i32,
    fps: i32,
) -> Result<Screen, String> {
    let content = SCShareableContent::get().map_err(|e| e.to_string())?;
    let id = value["display"].as_u64().ok_or("Invalid display")? as u32;
    let display = content
        .displays()
        .into_iter()
        .find(|d| d.display_id() == id)
        .ok_or("Display disconnected")?;
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build();

    let config = SCStreamConfiguration::new()
        .with_width(width as u32)
        .with_height(height as u32)
        .with_pixel_format(PixelFormat::BGRA)
        .with_shows_cursor(true)
        .with_queue_depth(3)
        .with_minimum_frame_interval(&CMTime::new(1, fps))
        .with_captures_audio(false)
        .with_sample_rate(48000)
        .with_channel_count(2)
        .with_excludes_current_process_audio(true);
    let video = source(
        &gst::Caps::builder("video/x-raw")
            .field("format", "BGRA")
            .field("width", width)
            .field("height", height)
            .field("framerate", gst::Fraction::new(fps, 1))
            .build(),
    );
    pipeline.add(&video).map_err(|e| e.to_string())?;
    video.link(video_sink).map_err(|e| e.to_string())?;
    let audio = {
        let audio = source(
            &gst::Caps::builder("audio/x-raw")
                .field("format", "F32LE")
                .field("layout", "interleaved")
                .field("rate", 48000i32)
                .field("channels", 2i32)
                .build(),
        );
        pipeline.add(&audio).map_err(|e| e.to_string())?;
        audio.link(audio_sink).map_err(|e| e.to_string())?;
        Some(audio)
    };
    let mut stream = SCStream::new(&filter, &config);
    stream.add_output_handler(
        Samples {
            video: video.clone(),
            audio: audio.clone(),
            width: width as usize,
            height: height as usize,
        },
        SCStreamOutputType::Screen,
    );
    {
        stream.add_output_handler(
            Samples {
                video,
                audio,
                width: width as usize,
                height: height as usize,
            },
            SCStreamOutputType::Audio,
        );
    }
    stream.start_capture().map_err(|e| e.to_string())?;
    Ok(Screen { stream, config })
}
