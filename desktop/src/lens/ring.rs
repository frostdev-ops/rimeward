//! The frame ring: 30 immutable JPEGs, a 60 s age ceiling that the newest
//! frame alone outlives, and cropping that goes through each frame's own
//! capture-time geometry.
//!
//! A `ref` names one frame forever. A crop taken against `f-7-310` maps its
//! window-point rect with the geometry recorded when `f-7-310` was captured,
//! never with wherever the window has moved to since.

use super::bridge::{FrameGeometry, Rect};
use super::ocr::Transform;
use image::codecs::jpeg::JpegEncoder;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

/// 30 frames is about 15 s under continuous change. 60 s is a ceiling, not a
/// guarantee: a busy screen evicts by count long before the age applies. The
/// newest frame is exempt from the ceiling: see [`expire`].
pub const CAP: usize = 30;
pub const MAX_AGE_MS: i64 = 60_000;
/// The ring's own JPEGs and every crop. Cheap, and visibly lossy only on text
/// that Vision has already read.
pub const QUALITY: u8 = 80;

#[derive(Clone, Debug)]
pub struct Frame {
    pub frame_ref: String,
    pub epoch: u64,
    pub seq: u64,
    pub at: i64,
    pub w: u32,
    pub h: u32,
    pub geometry: FrameGeometry,
    /// The full captured frame, JPEG q80.
    pub jpeg: Arc<[u8]>,
    /// A BGRA copy kept only while this is the latest frame, so `lens-ocr` can
    /// re-run recognition on it. `None` once a newer frame arrives — which on
    /// an idle screen can be a long while: the newest frame outlives the age
    /// ceiling ([`expire`]), pixels and all.
    pub pixels: Option<Arc<[u8]>>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RingStats {
    pub n: usize,
    pub bytes: usize,
    pub oldest_at: Option<i64>,
}

#[derive(Debug)]
pub struct CropOut {
    pub jpeg: Vec<u8>,
    pub w: u32,
    pub h: u32,
    pub frame: Arc<Frame>,
}

#[derive(Default)]
pub struct Ring {
    frames: Mutex<VecDeque<Arc<Frame>>>,
}

impl Ring {
    pub fn new() -> Ring {
        Ring::default()
    }

    pub fn push(&self, frame: Frame) {
        let mut frames = self.frames.lock().unwrap();
        expire(&mut frames);
        // Only the newest frame keeps its pixels; the rest are JPEG-only.
        if let Some(previous) = frames.back_mut() {
            if previous.pixels.is_some() {
                let mut stripped = Frame::clone(previous);
                stripped.pixels = None;
                *previous = Arc::new(stripped);
            }
        }
        frames.push_back(Arc::new(frame));
        while frames.len() > CAP {
            frames.pop_front();
        }
    }

    pub fn get(&self, frame_ref: &str) -> Option<Arc<Frame>> {
        let mut frames = self.frames.lock().unwrap();
        expire(&mut frames);
        frames
            .iter()
            .find(|frame| frame.frame_ref == frame_ref)
            .cloned()
    }

    pub fn latest(&self) -> Option<Arc<Frame>> {
        let mut frames = self.frames.lock().unwrap();
        expire(&mut frames);
        frames.back().cloned()
    }

    pub fn stats(&self) -> RingStats {
        let mut frames = self.frames.lock().unwrap();
        expire(&mut frames);
        RingStats {
            n: frames.len(),
            bytes: frames
                .iter()
                .map(|frame| {
                    frame.jpeg.len() + frame.pixels.as_ref().map_or(0, |pixels| pixels.len())
                })
                .sum(),
            oldest_at: frames.front().map(|frame| frame.at),
        }
    }

    pub fn clear(&self) {
        self.frames.lock().unwrap().clear();
    }

    /// `rect` is window points against the frame's own geometry; `None` is the
    /// whole frame. The result is downsized to `max_px` on its long edge and
    /// re-encoded at q80.
    pub fn crop(
        &self,
        frame_ref: &str,
        rect: Option<Rect>,
        max_px: u32,
    ) -> Result<CropOut, &'static str> {
        let frame = self.get(frame_ref).ok_or("frame-evicted")?;
        let decoded = image::load_from_memory_with_format(&frame.jpeg, image::ImageFormat::Jpeg)
            .map_err(|_| "frame-evicted")?;
        let [x, y, w, h] = match rect {
            Some(rect) => Transform::new(&frame.geometry).window_to_pixels(rect),
            None => [0, 0, decoded.width(), decoded.height()],
        };
        if w == 0 || h == 0 || x + w > decoded.width() || y + h > decoded.height() {
            return Err("bad-rect");
        }
        let mut cropped = decoded.crop_imm(x, y, w, h);
        let long = w.max(h);
        if max_px > 0 && long > max_px {
            let scale = f64::from(max_px) / f64::from(long);
            cropped = cropped.resize(
                ((f64::from(w) * scale).round() as u32).max(1),
                ((f64::from(h) * scale).round() as u32).max(1),
                image::imageops::FilterType::Triangle,
            );
        }
        let rgb = cropped.to_rgb8();
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, QUALITY)
            .encode_image(&rgb)
            .map_err(|_| "bad-rect")?;
        Ok(CropOut {
            jpeg,
            w: rgb.width(),
            h: rgb.height(),
            frame,
        })
    }
}

/// Everything past the ceiling goes except the newest frame. The stream only
/// delivers a frame when something changed, so on a screen that stands still
/// the newest one is the only picture of what the document describes — and it
/// is what a crop, a description or a caption anchors to when nothing names a
/// `ref`. Ageing it out made every one of those fail `frame-evicted` a minute
/// into an idle screen. It goes when the next frame arrives, or with the ring
/// when the target changes.
fn expire(frames: &mut VecDeque<Arc<Frame>>) {
    let floor = super::bridge::now_ms() - MAX_AGE_MS;
    while frames.len() > 1 && frames.front().is_some_and(|frame| frame.at < floor) {
        frames.pop_front();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lens::bridge::now_ms;

    fn geometry() -> FrameGeometry {
        FrameGeometry {
            window: [100.0, 200.0, 800.0, 600.0],
            scale: 2.0,
            content_rect: [10.0, 20.0, 1600.0, 1200.0],
            content_scale: 1.0,
            captured: [0.0, 0.0, 800.0, 600.0],
        }
    }

    /// A 1620x1240 image: a white field with a black block at pixels
    /// (410, 220) 200x100, which is window points (200, 100) 100x50 through
    /// the 2x geometry above.
    fn jpeg() -> Arc<[u8]> {
        let mut image = image::RgbImage::from_pixel(1620, 1240, image::Rgb([255, 255, 255]));
        for y in 220..320 {
            for x in 410..610 {
                image.put_pixel(x, y, image::Rgb([0, 0, 0]));
            }
        }
        let mut out = Vec::new();
        JpegEncoder::new_with_quality(&mut out, 95)
            .encode_image(&image)
            .unwrap();
        out.into()
    }

    fn frame(seq: u64, at: i64) -> Frame {
        Frame {
            frame_ref: format!("f-1-{seq}"),
            epoch: 1,
            seq,
            at,
            w: 1620,
            h: 1240,
            geometry: geometry(),
            jpeg: jpeg(),
            pixels: Some(Arc::from(vec![0u8; 16].as_slice())),
        }
    }

    #[test]
    fn the_ring_evicts_by_count_and_only_the_newest_keeps_pixels() {
        let ring = Ring::new();
        let now = now_ms();
        for seq in 1..=(CAP as u64 + 3) {
            ring.push(frame(seq, now));
        }
        let stats = ring.stats();
        assert_eq!(stats.n, CAP);
        assert!(ring.get("f-1-1").is_none(), "evicted by count");
        assert!(ring.get("f-1-4").is_some());
        assert!(ring.get("f-1-4").unwrap().pixels.is_none());
        assert!(ring.latest().unwrap().pixels.is_some());
        assert_eq!(ring.latest().unwrap().seq, CAP as u64 + 3);
    }

    #[test]
    fn the_ring_evicts_by_age() {
        let ring = Ring::new();
        let now = now_ms();
        ring.push(frame(1, now - MAX_AGE_MS - 1));
        ring.push(frame(2, now));
        assert_eq!(ring.stats().n, 1);
        assert!(ring.get("f-1-1").is_none());
        assert_eq!(ring.stats().oldest_at, Some(now));
    }

    /// An idle screen's last frame is the only one there is, and a crop of
    /// "the newest frame" a minute later must still find it.
    #[test]
    fn the_newest_frame_outlives_the_age_ceiling() {
        let ring = Ring::new();
        let old = now_ms() - MAX_AGE_MS - 1;
        ring.push(frame(1, old));
        ring.push(frame(2, old));
        assert_eq!(ring.stats().n, 1, "older frames still expire");
        assert!(ring.get("f-1-1").is_none());
        assert_eq!(ring.latest().map(|frame| frame.seq), Some(2));
        assert!(ring.crop("f-1-2", None, 1024).is_ok());
        ring.clear();
        assert!(ring.latest().is_none(), "a cleared ring keeps nothing");
    }

    #[test]
    fn a_stored_frames_geometry_never_changes() {
        let ring = Ring::new();
        let now = now_ms();
        ring.push(frame(1, now));
        let before = ring.get("f-1-1").unwrap().geometry;
        let mut moved = frame(2, now);
        moved.geometry.window = [900.0, 900.0, 400.0, 300.0];
        ring.push(moved);
        assert_eq!(ring.get("f-1-1").unwrap().geometry, before);
        assert_eq!(
            ring.get("f-1-2").unwrap().geometry.window,
            [900.0, 900.0, 400.0, 300.0]
        );
    }

    #[test]
    fn crop_maps_window_points_through_the_frames_own_geometry() {
        let ring = Ring::new();
        ring.push(frame(1, now_ms()));
        // The black block, named in window points.
        let out = ring
            .crop("f-1-1", Some([200.0, 100.0, 100.0, 50.0]), 1024)
            .unwrap();
        assert_eq!((out.w, out.h), (200, 100));
        let image = image::load_from_memory_with_format(&out.jpeg, image::ImageFormat::Jpeg)
            .unwrap()
            .to_rgb8();
        for (x, y) in [(2, 2), (100, 50), (197, 97)] {
            let pixel = image.get_pixel(x, y);
            assert!(
                pixel.0.iter().all(|c| *c < 40),
                "black at {x},{y}: {pixel:?}"
            );
        }
    }

    #[test]
    fn crop_downsizes_to_max_px_on_the_long_edge() {
        let ring = Ring::new();
        ring.push(frame(1, now_ms()));
        let out = ring
            .crop("f-1-1", Some([0.0, 0.0, 800.0, 400.0]), 512)
            .unwrap();
        assert_eq!((out.w, out.h), (512, 256));
    }

    #[test]
    fn crop_reports_eviction_and_bad_rects() {
        let ring = Ring::new();
        ring.push(frame(1, now_ms()));
        assert_eq!(ring.crop("f-1-9", None, 1024).err(), Some("frame-evicted"));
        assert_eq!(
            ring.crop("f-1-1", Some([0.0, 0.0, 0.0, 10.0]), 1024).err(),
            Some("bad-rect")
        );
        assert_eq!(
            ring.crop("f-1-1", Some([0.0, 0.0, 5000.0, 10.0]), 1024)
                .err(),
            Some("bad-rect")
        );
        ring.clear();
        assert_eq!(ring.stats(), RingStats::default());
    }
}
