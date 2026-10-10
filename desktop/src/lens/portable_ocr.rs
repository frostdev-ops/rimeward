//! Pinned, local Tesseract. One child per Lens, memory PNG in and bounded TSV out.
pub use super::geometry::*;
use super::{
    bridge::{now_ms, Line},
    request::Cancellation,
};
use image::ImageEncoder;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};

pub const DATA_HASH: &str = "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2";
const OUTPUT_CAP: usize = 1024 * 1024;
const WORD_CAP: usize = 4096;
const TEXT_CAP: usize = 128 * 1024;
pub const PIXEL_CAP: usize = 32 * 1024 * 1024;

pub struct Assets {
    executable: PathBuf,
    data: PathBuf,
    #[cfg(test)]
    fixture: Option<(String, PathBuf)>,
}
impl Assets {
    pub fn load(directory: &Path) -> Option<Self> {
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(directory.join("manifest.json")).ok()?).ok()?;
        if manifest["tesseract"] != "5.5.2"
            || manifest["leptonica"] != "1.87.0"
            || manifest["dataRevision"] != "87416418657359cb625c412a48b6e1d6d41c29bd"
            || manifest["platform"] != std::env::consts::OS
            || manifest["arch"] != std::env::consts::ARCH
        {
            return None;
        }
        let executable = if cfg!(windows) {
            "tesseract.exe"
        } else {
            "tesseract"
        };
        let hashes = manifest["hashes"].as_object()?;
        for name in [
            executable,
            "tessdata/eng.traineddata",
            "tessdata/configs/tsv",
        ] {
            if !hashes.contains_key(name) {
                return None;
            }
        }
        for (name, hash) in hashes {
            if Path::new(name).is_absolute()
                || Path::new(name)
                    .components()
                    .any(|c| !matches!(c, std::path::Component::Normal(_)))
            {
                return None;
            }
            let bytes = std::fs::read(directory.join(name)).ok()?;
            if format!("{:x}", Sha256::digest(bytes)) != hash.as_str()? {
                return None;
            }
        }
        if hashes["tessdata/eng.traineddata"] != DATA_HASH {
            return None;
        }
        Some(Self {
            executable: directory.join(executable),
            data: directory.join("tessdata"),
            #[cfg(test)]
            fixture: None,
        })
    }
}

pub struct Ocr {
    assets: Option<Assets>,
    running: Mutex<()>,
}
impl Ocr {
    pub fn new(directory: &Path) -> Self {
        Self {
            assets: Assets::load(directory),
            running: Mutex::new(()),
        }
    }
    pub fn available(&self) -> bool {
        self.assets.is_some()
    }
    /// Cancellation is set before this barrier. The running owner kills AND
    /// waits for its child before releasing it, so Stop's acknowledgement reaps.
    pub async fn drained(&self) {
        let _guard = self.running.lock().await;
    }
    pub async fn read(
        &self,
        frame: &super::ring::Frame,
        roi: [u32; 4],
        deadline: i64,
        explicit: bool,
        request: Arc<Cancellation>,
        session: Arc<Cancellation>,
    ) -> Result<Vec<Line>, String> {
        let assets = self.assets.as_ref().ok_or("assets-missing")?;
        let deadline = deadline.min(now_ms() + if explicit { 30_000 } else { 5_000 });
        let timeout = std::time::Duration::from_millis((deadline - now_ms()).max(0) as u64);
        let _guard = tokio::select! { biased;
            _ = request.cancelled() => return Err("cancelled".into()),
            _ = session.cancelled() => return Err("cancelled".into()),
            _ = tokio::time::sleep(timeout) => return Err("deadline".into()),
            guard = self.running.lock() => guard,
        };
        if request.is_cancelled() || session.is_cancelled() || deadline <= now_ms() {
            return Err("cancelled".into());
        }
        let png = png(
            frame.pixels.as_ref().ok_or("frame-evicted")?,
            [frame.w, frame.h],
            roi,
        )?;
        let transform = Transform::new(&frame.geometry);
        if request.is_cancelled() || session.is_cancelled() {
            return Err("cancelled".into());
        }
        if now_ms() >= deadline {
            return Err("deadline".into());
        }
        let mut command = tokio::process::Command::new(&assets.executable);
        #[cfg(test)]
        let fixture = assets.fixture.as_ref();
        #[cfg(not(test))]
        let fixture: Option<&()> = None;
        #[cfg(test)]
        if let Some((mode, pid)) = fixture {
            command
                .args([
                    "--exact",
                    if cfg!(target_os = "macos") {
                        "lens::portable::ocr::tests::child_fixture"
                    } else {
                        "lens::ocr::tests::child_fixture"
                    },
                    "--ignored",
                    "--nocapture",
                ])
                .env("RIMEWARD_OCR_TEST_CHILD", mode)
                .env("RIMEWARD_OCR_TEST_PID", pid);
        }
        if fixture.is_none() {
            command
                .args(["stdin", "stdout", "--tessdata-dir"])
                .arg(&assets.data)
                .args(["-l", "eng", "--oem", "1", "--psm", "11", "tsv"]);
        }
        command
            .env_remove("TESSDATA_PREFIX")
            .env("OMP_THREAD_LIMIT", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|_| "ocr-unavailable")?;
        let mut stdin = child.stdin.take().ok_or("ocr-unavailable")?;
        let stdout = child.stdout.take().ok_or("ocr-unavailable")?;
        let stderr = child.stderr.take().ok_or("ocr-unavailable")?;
        let operation = async {
            let write = async move {
                stdin.write_all(&png).await.map_err(|_| "ocr-failed")?;
                let result = stdin.shutdown().await.map_err(|_| "ocr-failed");
                drop(stdin);
                result
            };
            let ((), out, _, status) = tokio::try_join!(
                write,
                bounded(stdout, OUTPUT_CAP),
                bounded(stderr, 8192),
                async { child.wait().await.map_err(|_| "ocr-failed") }
            )?;
            if !status.success() {
                return Err("ocr-failed");
            }
            Ok(out)
        };
        let result = tokio::select! { biased;
            _ = request.cancelled() => Err("cancelled"),
            _ = session.cancelled() => Err("cancelled"),
            _ = tokio::time::sleep(std::time::Duration::from_millis((deadline - now_ms()).max(0) as u64)) => Err("deadline"),
            result = operation => result,
        };
        if result.is_err() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        if request.is_cancelled() || session.is_cancelled() {
            return Err("cancelled".into());
        }
        let lines =
            parse_tsv(&result.map_err(str::to_owned)?, roi, transform).map_err(str::to_owned)?;
        if request.is_cancelled() || session.is_cancelled() {
            return Err("cancelled".into());
        }
        if now_ms() >= deadline {
            return Err("deadline".into());
        }
        Ok(lines)
    }
}

async fn bounded(mut input: impl AsyncRead + Unpin, cap: usize) -> Result<Vec<u8>, &'static str> {
    let mut out = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = input.read(&mut buffer).await.map_err(|_| "ocr-failed")?;
        if n == 0 {
            return Ok(out);
        }
        if out.len() + n > cap {
            return Err("ocr-output-too-large");
        }
        out.extend_from_slice(&buffer[..n]);
    }
}

fn png(bgra: &[u8], [w, h]: [u32; 2], [x, y, rw, rh]: [u32; 4]) -> Result<Vec<u8>, String> {
    let bytes = u64::from(w) * u64::from(h) * 4;
    if bytes == 0
        || bytes > PIXEL_CAP as u64
        || bytes != bgra.len() as u64
        || rw == 0
        || rh == 0
        || u64::from(x) + u64::from(rw) > u64::from(w)
        || u64::from(y) + u64::from(rh) > u64::from(h)
    {
        return Err("bad-rect".into());
    }
    let mut rgb = Vec::with_capacity(rw as usize * rh as usize * 3);
    for row in y..y + rh {
        for col in x..x + rw {
            let i = (row as usize * w as usize + col as usize) * 4;
            rgb.extend_from_slice(&[bgra[i + 2], bgra[i + 1], bgra[i]]);
        }
    }
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(&rgb, rw, rh, image::ExtendedColorType::Rgb8)
        .map_err(|_| "ocr-failed")?;
    Ok(out)
}

pub fn parse_tsv(
    bytes: &[u8],
    [rx, ry, rw, rh]: [u32; 4],
    transform: Transform,
) -> Result<Vec<Line>, &'static str> {
    if bytes.len() > OUTPUT_CAP {
        return Err("ocr-output-too-large");
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "ocr-invalid-output")?;
    let mut rows = text.lines();
    if rows.next() != Some("level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext") { return Err("ocr-invalid-output"); }
    let mut groups: BTreeMap<[u32; 4], (super::bridge::Rect, String, f32, usize)> = BTreeMap::new();
    let (mut words, mut length) = (0, 0);
    for row in rows {
        let fields: Vec<_> = row.splitn(12, '\t').collect();
        if fields.len() != 12 {
            return Err("ocr-invalid-output");
        }
        let number = |i: usize| fields[i].parse::<u32>().map_err(|_| "ocr-invalid-output");
        let level = number(0)?;
        if !(1..=5).contains(&level) {
            return Err("ocr-invalid-output");
        }
        if level != 5 {
            continue;
        }
        let word = fields[11].trim();
        if word.is_empty() {
            continue;
        }
        if word.chars().any(char::is_control) {
            return Err("ocr-invalid-output");
        }
        words += 1;
        length += word.len() + 1;
        if words > WORD_CAP || length > TEXT_CAP {
            return Err("ocr-output-too-large");
        }
        let key = [number(1)?, number(2)?, number(3)?, number(4)?];
        let _ = number(5)?;
        let (x, y, w, h) = (number(6)?, number(7)?, number(8)?, number(9)?);
        let conf: f32 = fields[10].parse().map_err(|_| "ocr-invalid-output")?;
        if !conf.is_finite()
            || !(0.0..=100.0).contains(&conf)
            || w == 0
            || h == 0
            || u64::from(x) + u64::from(w) > u64::from(rw)
            || u64::from(y) + u64::from(h) > u64::from(rh)
        {
            return Err("ocr-invalid-output");
        }
        let bbox = [
            f64::from(rx) + f64::from(x),
            f64::from(ry) + f64::from(y),
            f64::from(w),
            f64::from(h),
        ];
        let entry = groups.entry(key).or_insert((bbox, String::new(), 0.0, 0));
        let right = (entry.0[0] + entry.0[2]).max(bbox[0] + bbox[2]);
        let bottom = (entry.0[1] + entry.0[3]).max(bbox[1] + bbox[3]);
        entry.0[0] = entry.0[0].min(bbox[0]);
        entry.0[1] = entry.0[1].min(bbox[1]);
        entry.0[2] = right - entry.0[0];
        entry.0[3] = bottom - entry.0[1];
        if !entry.1.is_empty() {
            entry.1.push(' ');
        }
        entry.1.push_str(word);
        entry.2 += conf / 100.0;
        entry.3 += 1;
    }
    Ok(groups
        .into_values()
        .map(|(bbox, text, confidence, n)| Line {
            bbox: transform.pixels_to_window(bbox),
            text,
            conf: Some(confidence / n as f32),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tsv_groups_words_and_maps_capture_geometry() {
        let geometry = super::super::bridge::FrameGeometry {
            window: [0.0, 0.0, 100.0, 50.0],
            scale: 2.0,
            content_rect: [0.0, 0.0, 200.0, 100.0],
            content_scale: 1.0,
            captured: [0.0, 0.0, 100.0, 50.0],
        };
        let header = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n";
        let tsv = format!("{header}5\t1\t1\t1\t1\t1\t10\t20\t20\t10\t90\tHello\n5\t1\t1\t1\t1\t2\t32\t20\t20\t10\t70\tworld\n");
        let lines =
            parse_tsv(tsv.as_bytes(), [20, 10, 100, 60], Transform::new(&geometry)).unwrap();
        assert_eq!(lines[0].text, "Hello world");
        assert_eq!(lines[0].bbox, [15.0, 15.0, 21.0, 5.0]);
        assert!((lines[0].conf.unwrap() - 0.8).abs() < 0.000001);
        assert!(parse_tsv(
            tsv.replace("\t90\t", "\tNaN\t").as_bytes(),
            [20, 10, 100, 60],
            Transform::new(&geometry)
        )
        .is_err());
        assert!(parse_tsv(tsv.as_bytes(), [0, 0, 20, 20], Transform::new(&geometry)).is_err());
    }
    #[test]
    fn tsv_refuses_oversized_words_text_and_invalid_utf8() {
        let g = super::super::bridge::FrameGeometry {
            window: [0.0, 0.0, 100.0, 50.0],
            scale: 1.0,
            content_rect: [0.0, 0.0, 100.0, 50.0],
            content_scale: 1.0,
            captured: [0.0, 0.0, 100.0, 50.0],
        };
        let header="level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n";
        let many = format!(
            "{header}{}",
            "5\t1\t1\t1\t1\t1\t0\t0\t1\t1\t90\tx\n".repeat(WORD_CAP + 1)
        );
        assert_eq!(
            parse_tsv(many.as_bytes(), [0, 0, 100, 50], Transform::new(&g)).unwrap_err(),
            "ocr-output-too-large"
        );
        let long = format!(
            "{header}5\t1\t1\t1\t1\t1\t0\t0\t1\t1\t90\t{}\n",
            "x".repeat(TEXT_CAP)
        );
        assert!(parse_tsv(long.as_bytes(), [0, 0, 100, 50], Transform::new(&g)).is_err());
        assert!(parse_tsv(&[255], [0, 0, 100, 50], Transform::new(&g)).is_err());
    }
    #[test]
    fn missing_and_corrupt_resources_are_not_available() {
        let directory =
            std::env::temp_dir().join(format!("rimeward-ocr-assets-{}", std::process::id()));
        std::fs::create_dir_all(directory.join("tessdata/configs")).unwrap();
        assert!(Assets::load(&directory).is_none());
        let executable = if cfg!(windows) {
            "tesseract.exe"
        } else {
            "tesseract"
        };
        for name in [
            executable,
            "tessdata/eng.traineddata",
            "tessdata/configs/tsv",
        ] {
            std::fs::write(directory.join(name), b"corrupt").unwrap();
        }
        let hash = format!("{:x}", Sha256::digest(b"corrupt"));
        let manifest = serde_json::json!({"tesseract":"5.5.2","leptonica":"1.87.0","dataRevision":"87416418657359cb625c412a48b6e1d6d41c29bd","platform":std::env::consts::OS,"arch":std::env::consts::ARCH,
            "hashes":{executable:hash,"tessdata/eng.traineddata":DATA_HASH,"tessdata/configs/tsv":hash}});
        std::fs::write(directory.join("manifest.json"), manifest.to_string()).unwrap();
        assert!(Assets::load(&directory).is_none());
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    #[ignore = "helper subprocess, invoked only by the bounded runner regression"]
    fn child_fixture() {
        use std::io::{Read, Write};
        let mode = std::env::var("RIMEWARD_OCR_TEST_CHILD").expect("test child mode");
        std::fs::write(
            std::env::var_os("RIMEWARD_OCR_TEST_PID").unwrap(),
            std::process::id().to_string(),
        )
        .unwrap();
        let mut png = Vec::new();
        std::io::stdin().read_to_end(&mut png).unwrap();
        assert_eq!(&png[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
        if mode == "stdout" {
            std::io::stdout()
                .write_all(&vec![b'x'; OUTPUT_CAP + 1])
                .unwrap();
            std::io::stdout().flush().unwrap();
        }
        if mode == "stderr" {
            std::io::stderr().write_all(&vec![b'x'; 8193]).unwrap();
            std::io::stderr().flush().unwrap();
        }
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
    #[tokio::test]
    async fn superseded_backend_grant_does_not_announce_after_ocr_drain() {
        use super::super::Lens;
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let lens = Lens::init(tx, Path::new("/missing-rimeward-ocr"));
        let start = serde_json::json!({"consented":true});
        lens.dispatch("lens-start", &start, None, Cancellation::new())
            .await
            .unwrap();
        // The exact drain barrier used by a running OCR owner; no child is
        // needed to hold it while provider/control futures mutate the state.
        let running = lens.ocr.running.lock().await;
        let grant = lens.backend_status(
            lens.request_generation(),
            true,
            true,
            Lens::score_id(),
            Some("old-provider"),
        );
        tokio::pin!(grant);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(5), &mut grant)
                .await
                .is_err()
        );
        let stop = lens.stop(Some("idle"));
        tokio::pin!(stop);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(5), &mut stop)
                .await
                .is_err()
        );
        let restart = lens.dispatch("lens-start", &start, None, Cancellation::new());
        tokio::pin!(restart);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(5), &mut restart)
                .await
                .is_err()
        );
        let current = lens.status();
        drop(running);
        assert_eq!(grant.await, Err("cancelled".into()));
        stop.await;
        assert_eq!(restart.await.unwrap(), current);
        assert_eq!(
            lens.status(),
            current,
            "old grant emitted no later metadata"
        );
        assert_ne!(current["reason"], "old-provider");
        let generation = lens
            .backend_status(
                lens.request_generation(),
                false,
                false,
                Lens::score_id(),
                Some("current-provider"),
            )
            .await
            .unwrap();
        assert_eq!(generation, lens.request_generation());
        assert_eq!(lens.status()["reason"], "current-provider");
        assert_eq!(lens.status()["capabilities"]["capture"], false);
    }

    #[tokio::test]
    async fn lens_stop_acknowledgement_reaps_its_background_child() {
        use super::super::{
            bridge::{DisplayInfo, FrameGeometry},
            Lens, Target,
        };
        let pid_file =
            std::env::temp_dir().join(format!("rimeward-ocr-stop-{}", std::process::id()));
        let _ = std::fs::remove_file(&pid_file);
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let lens = Lens::new(
            tx,
            Ocr {
                assets: Some(Assets {
                    executable: std::env::current_exe().unwrap(),
                    data: PathBuf::new(),
                    fixture: Some(("stop".into(), pid_file.clone())),
                }),
                running: Mutex::new(()),
            },
        );
        lens.dispatch(
            "lens-start",
            &serde_json::json!({"consented":true}),
            None,
            Cancellation::new(),
        )
        .await
        .unwrap();
        let generation = lens
            .backend_status(
                lens.request_generation(),
                true,
                false,
                Lens::score_id(),
                None,
            )
            .await
            .unwrap();
        let geometry = FrameGeometry {
            window: [0.0, 0.0, 1.0, 1.0],
            scale: 1.0,
            content_rect: [0.0, 0.0, 1.0, 1.0],
            content_scale: 1.0,
            captured: [0.0, 0.0, 1.0, 1.0],
        };
        let target = Target {
            pid: 42,
            bundle: "test".into(),
            name: "Test".into(),
            window_id: 1,
            title: "Test".into(),
            bounds: geometry.window,
            url: None,
            display: DisplayInfo {
                id: 1,
                w: 100.0,
                h: 100.0,
                scale: 1.0,
            },
        };
        let lease = lens
            .accept_target(generation, target, geometry, [1, 1])
            .unwrap();
        assert!(lens
            .publish_frame(&lease, Arc::from([255u8; 4]), [1, 1], geometry)
            .is_some());
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !pid_file.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            lens.dispatch("lens-stop", &Value::Null, None, Cancellation::new()),
        )
        .await
        .unwrap()
        .unwrap();
        let pid: u32 = std::fs::read_to_string(&pid_file).unwrap().parse().unwrap();
        #[cfg(unix)]
        {
            assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
            assert_eq!(
                unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), libc::WNOHANG) },
                -1
            );
        }
        #[cfg(windows)]
        {
            let result = std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
                .output()
                .unwrap();
            assert!(!String::from_utf8_lossy(&result.stdout).contains(&format!("\"{pid}\"")));
        }
        assert!(lens.ring.latest().is_none());
        assert!(lens.snapshot()["ocr"].as_array().unwrap().is_empty());
        std::fs::remove_file(pid_file).unwrap();
    }
    #[tokio::test]
    async fn child_abort_timeout_and_overflow_kill_and_reap_before_drain() {
        for mode in ["abort", "deadline", "stdout", "stderr"] {
            let pid_file = std::env::temp_dir()
                .join(format!("rimeward-ocr-child-{}-{mode}", std::process::id()));
            let _ = std::fs::remove_file(&pid_file);
            let runner = Arc::new(Ocr {
                assets: Some(Assets {
                    executable: std::env::current_exe().unwrap(),
                    data: PathBuf::new(),
                    fixture: Some((mode.into(), pid_file.clone())),
                }),
                running: Mutex::new(()),
            });
            let request = Cancellation::new();
            let session = Cancellation::new();
            let geometry = super::super::bridge::FrameGeometry {
                window: [0.0, 0.0, 1.0, 1.0],
                scale: 1.0,
                content_rect: [0.0, 0.0, 1.0, 1.0],
                content_scale: 1.0,
                captured: [0.0, 0.0, 1.0, 1.0],
            };
            let frame = super::super::ring::Frame {
                frame_ref: "f-1-1".into(),
                epoch: 1,
                seq: 1,
                at: now_ms(),
                w: 1,
                h: 1,
                geometry,
                jpeg: Arc::from([]),
                pixels: Some(Arc::from([255u8; 4])),
            };
            let task = {
                let runner = runner.clone();
                let request = request.clone();
                let session = session.clone();
                tokio::spawn(async move {
                    runner
                        .read(
                            &frame,
                            [0, 0, 1, 1],
                            now_ms() + if mode == "deadline" { 1000 } else { 5000 },
                            true,
                            request,
                            session,
                        )
                        .await
                })
            };
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while !pid_file.exists() {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            if mode == "abort" {
                request.cancel();
                session.cancel();
            }
            let error = task.await.unwrap().unwrap_err();
            assert_eq!(
                error,
                if mode == "abort" {
                    "cancelled"
                } else if mode == "deadline" {
                    "deadline"
                } else {
                    "ocr-output-too-large"
                }
            );
            runner.drained().await;
            let pid: u32 = std::fs::read_to_string(&pid_file).unwrap().parse().unwrap();
            #[cfg(unix)]
            {
                assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
                assert_eq!(
                    unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), libc::WNOHANG) },
                    -1
                );
            }
            #[cfg(windows)]
            {
                let result = std::process::Command::new("tasklist")
                    .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
                    .output()
                    .unwrap();
                assert!(!String::from_utf8_lossy(&result.stdout).contains(&format!("\"{pid}\"")));
            }
            std::fs::remove_file(pid_file).unwrap();
        }
    }
}
