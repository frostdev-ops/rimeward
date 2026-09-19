//! The Swift helper as a supervised child process.
//!
//! One `blackice-helper`, JSON lines both ways, an absolute deadline on every
//! call. The helper owns the on-device model; this module owns the process, the
//! id routing, and the rules for deciding the helper is wedged and starting a
//! new one. Nothing here waits on a model call without a clock: a reply that
//! misses its deadline is discarded when it eventually lands, and work the
//! helper retained past its own recovery deadline makes it exit 75, which is a
//! respawn here.
//!
//! Screen content crosses this boundary. Crops go out as base64 JPEG and
//! interpreted text comes back; neither is ever mixed into the observed text
//! the lens keeps.

use super::bridge::{now_ms, Kind};
use super::Lens;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Semaphore};

/// Model calls in flight at the helper at once.
pub const RUNNING: usize = 4;
/// Calls that may wait for a running slot. Past this the answer is `busy`
/// straight away, because a queue nobody can drain is a lie about capacity.
pub const QUEUED: usize = 8;
/// Retained work above this, held for [`Thresholds::outstanding_window`], is a
/// wedged helper rather than a busy one.
pub const OUTSTANDING_LIMIT: u32 = 4;
/// The long edge a frame is cropped to before it is shown to the model.
pub const MAX_PX: u32 = 1024;
/// The `capabilities` handshake after a spawn. Generous: the first model touch
/// in a fresh process loads assets.
const HANDSHAKE_MS: i64 = 30_000;
/// How often [`Helper::call`] looks for a live child while one is coming up.
const WAIT_STEP: Duration = Duration::from_millis(20);

/// The timings the supervisor runs on, named so a test can shorten them. The
/// defaults are the contract's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Thresholds {
    /// A `ping` this often while any work is outstanding.
    pub ping_every: Duration,
    pub ping_deadline: Duration,
    /// `outstanding > 4` held this long is a respawn.
    pub outstanding_window: Duration,
    /// Consecutive deadline misses that are a respawn. Any reply resets them.
    pub miss_limit: u32,
    pub tick: Duration,
    /// A child that dies sooner than this after spawning died early, and the
    /// next attempt backs off.
    pub spawn_grace: Duration,
    pub backoff_base: Duration,
    pub backoff_max: Duration,
    /// Consecutive early deaths before the helper is left `down` until a
    /// `helper-restart`.
    pub max_attempts: u32,
    /// `{"type":"shutdown"}` to `kill`.
    pub shutdown_grace: Duration,
}

impl Default for Thresholds {
    fn default() -> Self {
        Thresholds {
            ping_every: Duration::from_secs(10),
            ping_deadline: Duration::from_secs(5),
            outstanding_window: Duration::from_secs(30),
            miss_limit: 3,
            tick: Duration::from_secs(1),
            spawn_grace: Duration::from_secs(5),
            backoff_base: Duration::from_secs(1),
            backoff_max: Duration::from_secs(30),
            max_attempts: 5,
            shutdown_grace: Duration::from_secs(5),
        }
    }
}

/// Why the supervisor is starting a new child.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// The child is gone. `-1` stands for "no child at all".
    Exit(i32),
    Misses,
    Outstanding,
    Ping,
}

impl std::fmt::Display for Reason {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Reason::Exit(code) => write!(out, "exit {code}"),
            Reason::Misses => write!(out, "consecutive deadline misses"),
            Reason::Outstanding => write!(out, "retained work above the bound"),
            Reason::Ping => write!(out, "ping unanswered"),
        }
    }
}

/// Whether this Mac is new enough to run the helper at all. The Swift package
/// is built against the macOS 27 SDK (Foundation Models, Translation), while
/// the app's own floor is 14.0, so an older Mac gets no helper and every
/// `helper-*` op answers `unavailable`.
pub fn supported() -> bool {
    objc2_foundation::NSProcessInfo::processInfo()
        .operatingSystemVersion()
        .majorVersion
        >= 27
}

/// The whole respawn decision, with nothing to observe. Exit code 75 is the
/// helper's own recovery deadline firing; any other exit is just as fatal to
/// the calls in flight, so it is treated the same way and named differently.
pub fn should_respawn(
    exit: Option<i32>,
    misses: u32,
    outstanding_over: Option<Duration>,
    ping_unanswered: bool,
    limits: &Thresholds,
) -> Option<Reason> {
    if let Some(code) = exit {
        return Some(Reason::Exit(code));
    }
    if misses >= limits.miss_limit {
        return Some(Reason::Misses);
    }
    if outstanding_over.is_some_and(|held| held >= limits.outstanding_window) {
        return Some(Reason::Outstanding);
    }
    ping_unanswered.then_some(Reason::Ping)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct HelperState {
    /// `ok | rate-limited | unavailable | down | recovering`.
    state: String,
    reset_at: Option<i64>,
}

struct Pending {
    tx: oneshot::Sender<Result<Value, String>>,
    /// The epoch the request described. A reply that outlives it is dropped.
    epoch: Option<u64>,
}

pub struct Helper {
    lens: Weak<Lens>,
    path: PathBuf,
    /// The directory holding `mobileclip-s0/`, passed as `--models` when it is
    /// one. Absent means the helper answers `embed` with `unavailable`.
    models: PathBuf,
    test_ops: bool,
    limits: Thresholds,
    /// Extra environment for the child, on top of HOME, PATH and TMPDIR. Empty
    /// in the app; the tests use it to drive the fake helper.
    env: Vec<(String, String)>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Pending>>,
    /// 4 running + 8 waiting. `try_acquire` on this is the `busy` bound.
    admission: Arc<Semaphore>,
    running: Arc<Semaphore>,
    /// The helper's own count of work it has started and not finished, as of
    /// the last line it sent.
    outstanding: AtomicU32,
    /// The last `capabilities` reply. `lens-status` reads the model, vision
    /// and translation stages straight out of it, so what the app promises is
    /// what this Mac answered.
    caps: Mutex<Value>,
    misses: AtomicU32,
    ping_unanswered: AtomicBool,
    state: Mutex<HelperState>,
    stdin: Mutex<Option<mpsc::UnboundedSender<String>>>,
    child: tokio::sync::Mutex<Option<Child>>,
    pid: AtomicU32,
    spawned_at: Mutex<Instant>,
    /// Consecutive early deaths.
    attempts: AtomicU32,
    stopping: AtomicBool,
}

impl Helper {
    /// Spawns the child and its reader, ping and supervisor tasks. Returns
    /// immediately: the first `capabilities` happens on the supervisor task, so
    /// a call made before it lands waits for the child rather than failing.
    pub fn spawn(lens: Arc<Lens>, path: PathBuf, models: PathBuf, test_ops: bool) -> Arc<Helper> {
        Helper::with_thresholds(lens, path, models, test_ops, Thresholds::default())
    }

    pub fn with_thresholds(
        lens: Arc<Lens>,
        path: PathBuf,
        models: PathBuf,
        test_ops: bool,
        limits: Thresholds,
    ) -> Arc<Helper> {
        Helper::build(lens, path, models, test_ops, limits, Vec::new())
    }

    fn build(
        lens: Arc<Lens>,
        path: PathBuf,
        models: PathBuf,
        test_ops: bool,
        limits: Thresholds,
        env: Vec<(String, String)>,
    ) -> Arc<Helper> {
        let helper = Arc::new(Helper {
            lens: Arc::downgrade(&lens),
            path,
            models,
            test_ops,
            limits,
            env,
            next_id: AtomicU64::new(0),
            pending: Mutex::new(HashMap::new()),
            admission: Arc::new(Semaphore::new(RUNNING + QUEUED)),
            running: Arc::new(Semaphore::new(RUNNING)),
            outstanding: AtomicU32::new(0),
            caps: Mutex::new(Value::Null),
            misses: AtomicU32::new(0),
            ping_unanswered: AtomicBool::new(false),
            state: Mutex::new(HelperState {
                state: "recovering".into(),
                reset_at: None,
            }),
            stdin: Mutex::new(None),
            child: tokio::sync::Mutex::new(None),
            pid: AtomicU32::new(0),
            spawned_at: Mutex::new(Instant::now()),
            attempts: AtomicU32::new(0),
            stopping: AtomicBool::new(false),
        });
        let supervisor = helper.clone();
        tauri::async_runtime::spawn(async move {
            supervisor.start().await;
            supervisor.supervise().await;
        });
        let pinger = helper.clone();
        tauri::async_runtime::spawn(async move { pinger.ping_loop().await });
        helper
    }

    /// `(state, outstanding)` for `lens-status`.
    pub fn state(&self) -> (String, u32) {
        (
            self.state.lock().unwrap().state.clone(),
            self.outstanding.load(Ordering::Acquire),
        )
    }

    /// The last `capabilities` reply, or null before the handshake landed.
    pub fn capabilities(&self) -> Value {
        self.caps.lock().unwrap().clone()
    }

    /// Whether that reply said the Core ML text tower is loadable, which is
    /// what `lens-status.capabilities.embed` reports.
    pub fn embedding(&self) -> bool {
        self.caps.lock().unwrap()["embedding"] == true
    }

    /// The current child's process id.
    #[cfg(test)]
    pub fn pid(&self) -> Option<u32> {
        match self.pid.load(Ordering::Acquire) {
            0 => None,
            pid => Some(pid),
        }
    }

    /// One request, one reply, one deadline. `deadline_ms` is absolute epoch
    /// milliseconds as it arrived from the caller; `epoch` is the lens epoch the
    /// request described, and a reply that outlives it is dropped.
    pub async fn call(
        &self,
        op: &str,
        value: Value,
        deadline_ms: i64,
        epoch: Option<u64>,
    ) -> Result<Value, String> {
        let remaining = deadline_ms - now_ms();
        if remaining <= 0 {
            return Err("deadline".into());
        }
        let limit = tokio::time::Instant::now() + Duration::from_millis(remaining as u64);
        // `ping` and `capabilities` answer while model work is wedged, so they
        // never wait behind the model slots: a ping queued behind four slow
        // describes would report a healthy helper as unanswered.
        let control = matches!(op, "ping" | "capabilities");
        // Admission first: past 4 running and 8 waiting, saying `busy` now is
        // more useful than a queue slot that will time out anyway.
        let _admitted = if control {
            None
        } else {
            match self.admission.clone().try_acquire_owned() {
                Ok(permit) => Some(permit),
                Err(_) => return Err("busy".into()),
            }
        };
        let _slot = if control {
            None
        } else {
            match tokio::time::timeout_at(limit, self.running.clone().acquire_owned()).await {
                Ok(Ok(permit)) => Some(permit),
                Ok(Err(_)) => return Err("down".into()),
                Err(_) => {
                    self.miss();
                    return Err("deadline".into());
                }
            }
        };
        let stdin = self.live_stdin(limit).await?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap()
            .insert(id, Pending { tx, epoch });
        let line = json!({ "id": id, "op": op, "deadline": deadline_ms, "value": value });
        if stdin.send(line.to_string()).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err("down".into());
        }
        match tokio::time::timeout_at(limit, rx).await {
            // Any reply at all, error included, means the helper is answering.
            Ok(Ok(result)) => {
                self.misses.store(0, Ordering::Release);
                if op == "capabilities" {
                    if let Ok(value) = &result {
                        *self.caps.lock().unwrap() = value.clone();
                    }
                }
                result
            }
            // A respawn took the pending map with it.
            Ok(Err(_)) => Err("down".into()),
            Err(_) => {
                // Removed here, so the reply that lands later finds nothing and
                // is discarded rather than delivered to a caller that has gone.
                self.pending.lock().unwrap().remove(&id);
                self.miss();
                Err("deadline".into())
            }
        }
    }

    /// `{"type":"shutdown"}`, then the grace period, then kill.
    pub async fn shutdown(&self) {
        self.stopping.store(true, Ordering::Release);
        if let Some(stdin) = self.stdin.lock().unwrap().take() {
            let _ = stdin.send(r#"{"type":"shutdown"}"#.into());
        }
        let mut slot = self.child.lock().await;
        if let Some(mut child) = slot.take() {
            if tokio::time::timeout(self.limits.shutdown_grace, child.wait())
                .await
                .is_err()
            {
                let _ = child.kill().await;
            }
        }
        self.pid.store(0, Ordering::Release);
        self.fail_pending();
        self.set_state("down", None);
    }

    /// `helper-restart`: clears the give-up latch and starts a new child.
    pub async fn restart(self: &Arc<Self>) {
        self.attempts.store(0, Ordering::Release);
        self.respawn(Reason::Exit(-1)).await;
    }

    // ---- child lifecycle -------------------------------------------------

    async fn start(self: &Arc<Self>) {
        let mut slot = self.child.lock().await;
        if self.stopping.load(Ordering::Acquire) {
            return;
        }
        if let Err(error) = self.start_child(&mut slot) {
            eprintln!("[helper] spawn failed: {error}");
            self.set_state("down", None);
            return;
        }
        drop(slot);
        self.handshake();
    }

    /// `env_clear` plus HOME, PATH and TMPDIR. Nothing else crosses, and no
    /// secret ever travels this way: those go on stdin.
    fn start_child(self: &Arc<Self>, slot: &mut Option<Child>) -> Result<(), String> {
        // Before the spawn can fail, so a binary that will not start counts as
        // an early death and backs off rather than looping.
        *self.spawned_at.lock().unwrap() = Instant::now();
        let mut command = Command::new(&self.path);
        if self.test_ops {
            command.arg("--test-ops");
        }
        // A missing model directory is not an error here: the helper starts
        // without it and answers `embed` with `unavailable`.
        if self.models.is_dir() {
            command.arg("--models").arg(&self.models);
        }
        command.env_clear();
        for name in ["HOME", "PATH", "TMPDIR"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command.envs(self.env.iter().map(|(k, v)| (k, v)));
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| error.to_string())?;
        let stdout = child.stdout.take().ok_or("missing helper stdout")?;
        let stderr = child.stderr.take().ok_or("missing helper stderr")?;
        let mut stdin = child.stdin.take().ok_or("missing helper stdin")?;
        self.pid.store(child.id().unwrap_or(0), Ordering::Release);

        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        tauri::async_runtime::spawn(async move {
            while let Some(line) = rx.recv().await {
                if stdin
                    .write_all(format!("{line}\n").as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        *self.stdin.lock().unwrap() = Some(tx);

        // Weak, so a dropped helper ends its reader rather than being kept
        // alive by it.
        let reader = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Some(helper) = reader.upgrade() else {
                    return;
                };
                helper.on_line(&line);
            }
        });
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[helper] {line}");
            }
        });
        *slot = Some(child);
        Ok(())
    }

    /// The first `capabilities` after a spawn is what makes the helper `ok`. On
    /// its own task: a child that answers nothing must not hold the supervisor
    /// for the length of the handshake deadline.
    fn handshake(self: &Arc<Self>) {
        let helper = self.clone();
        tauri::async_runtime::spawn(async move {
            match helper
                .call("capabilities", json!({}), now_ms() + HANDSHAKE_MS, None)
                .await
            {
                Ok(_) => helper.set_state("ok", None),
                // Left `recovering`: the supervisor sees the misses or the exit
                // and starts another child. A respawn that overtakes this fails
                // the call with `down`, so a stale handshake never says `ok`.
                Err(error) => eprintln!("[helper] capabilities after spawn: {error}"),
            }
        });
    }

    async fn supervise(self: &Arc<Self>) {
        let mut over_since: Option<Instant> = None;
        loop {
            tokio::time::sleep(self.limits.tick).await;
            if self.stopping.load(Ordering::Acquire) {
                return;
            }
            let exit = {
                let mut slot = self.child.lock().await;
                match slot.as_mut() {
                    Some(child) => child
                        .try_wait()
                        .ok()
                        .flatten()
                        .map(|status| status.code().unwrap_or(-1)),
                    None => Some(-1),
                }
            };
            if self.outstanding.load(Ordering::Acquire) > OUTSTANDING_LIMIT {
                over_since.get_or_insert_with(Instant::now);
            } else {
                over_since = None;
            }
            let reason = should_respawn(
                exit,
                self.misses.load(Ordering::Acquire),
                over_since.map(|since| since.elapsed()),
                self.ping_unanswered.load(Ordering::Acquire),
                &self.limits,
            );
            if let Some(reason) = reason {
                over_since = None;
                self.respawn(reason).await;
            }
        }
    }

    async fn respawn(self: &Arc<Self>, reason: Reason) {
        let mut slot = self.child.lock().await;
        if self.stopping.load(Ordering::Acquire) {
            return;
        }
        let attempts = if self.spawned_at().elapsed() < self.limits.spawn_grace {
            self.attempts.fetch_add(1, Ordering::AcqRel) + 1
        } else {
            self.attempts.store(0, Ordering::Release);
            0
        };
        if attempts > self.limits.max_attempts {
            // Nothing else starts a child now; `helper-restart` clears it.
            self.set_state("down", None);
            return;
        }
        eprintln!("[helper] respawn: {reason} (attempt {attempts})");
        *self.stdin.lock().unwrap() = None;
        if let Some(mut child) = slot.take() {
            let _ = child.kill().await;
        }
        self.pid.store(0, Ordering::Release);
        self.fail_pending();
        self.misses.store(0, Ordering::Release);
        self.ping_unanswered.store(false, Ordering::Release);
        self.outstanding.store(0, Ordering::Release);
        self.set_state("recovering", None);
        if attempts > 0 {
            tokio::time::sleep(self.backoff(attempts)).await;
        }
        if let Err(error) = self.start_child(&mut slot) {
            eprintln!("[helper] respawn failed: {error}");
            return;
        }
        drop(slot);
        self.handshake();
    }

    fn backoff(&self, attempts: u32) -> Duration {
        let shift = attempts.saturating_sub(1).min(16);
        (self.limits.backoff_base * (1u32 << shift)).min(self.limits.backoff_max)
    }

    async fn ping_loop(self: &Arc<Self>) {
        loop {
            tokio::time::sleep(self.limits.ping_every).await;
            if self.stopping.load(Ordering::Acquire) {
                return;
            }
            // Nothing outstanding means nothing to be wedged on.
            if self.outstanding.load(Ordering::Acquire) == 0 {
                continue;
            }
            let deadline = now_ms() + self.limits.ping_deadline.as_millis() as i64;
            if let Err(error) = self.call("ping", Value::Null, deadline, None).await {
                if error == "deadline" {
                    self.ping_unanswered.store(true, Ordering::Release);
                }
            }
        }
    }

    // ---- replies ---------------------------------------------------------

    /// One line from the helper's stdout: a reply by id, or an unsolicited
    /// state change.
    fn on_line(&self, line: &str) {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            eprintln!("[helper] unparsable line");
            return;
        };
        if let Some(outstanding) = message["outstanding"].as_u64() {
            self.outstanding.store(
                outstanding.min(u64::from(u32::MAX)) as u32,
                Ordering::Release,
            );
        }
        if message["type"] == "state" {
            let model = message["model"]
                .as_str()
                .unwrap_or("unavailable")
                .to_owned();
            self.set_state(&model, message["reset_at"].as_i64());
            return;
        }
        let Some(id) = message["id"].as_u64() else {
            return;
        };
        // Absent from the map means the caller's deadline already passed or a
        // respawn failed it: the reply is discarded here and goes no further.
        let Some(pending) = self.pending.lock().unwrap().remove(&id) else {
            return;
        };
        let error = message["error"].as_str();
        if let (Some(error), Some(detail)) = (error, message["detail"].as_str()) {
            // The code is what the caller gets; the reason belongs in the log.
            eprintln!("[helper] id={id} {error}: {detail}");
        }
        if error == Some("rate-limited") {
            self.set_state("rate-limited", message["reset_at"].as_i64());
        }
        let result = if self.stale(pending.epoch) {
            Err("stale-epoch".into())
        } else if let Some(error) = error {
            Err(error.to_owned())
        } else {
            Ok(message["value"].clone())
        };
        let _ = pending.tx.send(result);
    }

    /// Whether the epoch a request was made in has since ended.
    fn stale(&self, epoch: Option<u64>) -> bool {
        match (epoch, self.lens.upgrade()) {
            (Some(epoch), Some(lens)) => lens.bridge.epoch() != epoch,
            _ => false,
        }
    }

    fn fail_pending(&self) {
        let pending: Vec<Pending> = self
            .pending
            .lock()
            .unwrap()
            .drain()
            .map(|(_, entry)| entry)
            .collect();
        for entry in pending {
            let _ = entry.tx.send(Err("down".into()));
        }
    }

    fn miss(&self) {
        self.misses.fetch_add(1, Ordering::AcqRel);
    }

    fn spawned_at(&self) -> Instant {
        *self.spawned_at.lock().unwrap()
    }

    /// The current child's stdin, waiting through a spawn or a respawn rather
    /// than failing a call that arrived in the gap.
    async fn live_stdin(
        &self,
        limit: tokio::time::Instant,
    ) -> Result<mpsc::UnboundedSender<String>, String> {
        loop {
            if let Some(stdin) = self.stdin.lock().unwrap().clone() {
                return Ok(stdin);
            }
            if self.state.lock().unwrap().state == "down" {
                return Err("down".into());
            }
            if tokio::time::Instant::now() + WAIT_STEP >= limit {
                self.miss();
                return Err("deadline".into());
            }
            tokio::time::sleep(WAIT_STEP).await;
        }
    }

    fn set_state(&self, state: &str, reset_at: Option<i64>) {
        let next = HelperState {
            state: state.to_owned(),
            reset_at,
        };
        {
            let mut current = self.state.lock().unwrap();
            if *current == next {
                return;
            }
            *current = next.clone();
        }
        if let Some(lens) = self.lens.upgrade() {
            lens.bridge.emit(Kind::Helper {
                state: next.state,
                reset_at: next.reset_at,
                outstanding: self.outstanding.load(Ordering::Acquire),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lens::{Config, Lens};
    use tokio::sync::mpsc::UnboundedReceiver;

    /// The fake helper speaks the wire protocol with no model behind it, so
    /// every rule below is exercised without Apple Intelligence. It runs
    /// through its own `#!/usr/bin/env node` line, so PATH is all it needs.
    fn fake() -> Option<PathBuf> {
        let node = std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_ok_and(|out| out.status.success());
        if !node {
            eprintln!("skipped: `node` is not on PATH, so the fake helper cannot run");
            return None;
        }
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake-helper.mjs"))
    }

    /// Everything the supervisor waits for, in milliseconds instead of seconds.
    fn quick() -> Thresholds {
        Thresholds {
            ping_every: Duration::from_secs(10),
            ping_deadline: Duration::from_millis(300),
            outstanding_window: Duration::from_millis(300),
            miss_limit: 3,
            tick: Duration::from_millis(50),
            spawn_grace: Duration::from_millis(50),
            backoff_base: Duration::from_millis(50),
            backoff_max: Duration::from_millis(100),
            max_attempts: 5,
            shutdown_grace: Duration::from_secs(1),
        }
    }

    fn lens() -> (Arc<Lens>, UnboundedReceiver<String>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let lens = Lens::new(Config::default(), tx);
        tauri::async_runtime::spawn(lens.bridge.clone().run_writer());
        (lens, rx)
    }

    /// A helper on the fake child, with the knobs that child reads. The
    /// environment is per-child, so tests never race over process-wide state.
    fn fake_helper(
        limits: Thresholds,
        env: &[(&str, &str)],
    ) -> Option<(Arc<Lens>, Arc<Helper>, UnboundedReceiver<String>)> {
        let path = fake()?;
        let (lens, rx) = lens();
        let env = env
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect();
        let helper = Helper::build(lens.clone(), path, PathBuf::new(), true, limits, env);
        Some((lens, helper, rx))
    }

    /// The same, waited until the handshake has landed and its `ok` signal has
    /// been taken off the channel.
    async fn ready(
        limits: Thresholds,
    ) -> Option<(Arc<Lens>, Arc<Helper>, UnboundedReceiver<String>)> {
        let (lens, helper, mut rx) = fake_helper(limits, &[])?;
        assert_eq!(states(&mut rx, 1).await, vec!["ok"]);
        Some((lens, helper, rx))
    }

    fn deadline(ms: i64) -> i64 {
        now_ms() + ms
    }

    /// The next `want` helper states, in order, or what was seen before the
    /// wait ran out.
    async fn states(rx: &mut UnboundedReceiver<String>, want: usize) -> Vec<String> {
        let mut seen = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(20), async {
            while seen.len() < want {
                let Some(line) = rx.recv().await else { return };
                let Ok(signal) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if signal["kind"] == "helper" {
                    seen.push(signal["state"].as_str().unwrap_or_default().to_owned());
                }
            }
        })
        .await;
        seen
    }

    fn alive(pid: u32) -> bool {
        std::process::Command::new("ps")
            .args(["-p", &pid.to_string()])
            .output()
            .is_ok_and(|out| out.status.success())
    }

    #[tokio::test]
    async fn a_call_goes_out_and_its_reply_comes_back_by_id() {
        let Some((lens, helper, _rx)) = ready(quick()).await else {
            return;
        };
        // The handshake's `capabilities` is what `lens-status.embed` reads.
        assert!(
            helper.embedding(),
            "capabilities said the text tower is there"
        );
        *lens.helper.lock().unwrap() = Some(helper.clone());
        // The fake answers the handshake with every stage available, so the
        // capabilities block reports them rather than promising them.
        for stage in ["embed", "triage", "describe", "translate"] {
            assert_eq!(lens.status()["capabilities"][stage], true, "{stage}");
        }
        let value = helper
            .call("echo", json!({ "hello": 1 }), deadline(5_000), None)
            .await
            .unwrap();
        assert_eq!(value, json!({ "hello": 1 }));
        assert_eq!(
            helper
                .call("capabilities", json!({}), deadline(5_000), None)
                .await
                .unwrap()["model"]["available"],
            true
        );
        assert_eq!(helper.state().0, "ok");
        assert_eq!(
            helper
                .call("nope", Value::Null, deadline(5_000), None)
                .await
                .err()
                .as_deref(),
            Some("unknown-op")
        );
        helper.shutdown().await;
    }

    /// The reply lands after the caller has gone. Nothing panics, and the
    /// pending map does not keep the entry.
    #[tokio::test]
    async fn a_deadline_miss_returns_deadline_and_the_late_reply_is_discarded() {
        let Some((_lens, helper, _rx)) = ready(quick()).await else {
            return;
        };
        let result = helper
            .call("sleep", json!({ "ms": 400 }), deadline(120), None)
            .await;
        assert_eq!(result.err().as_deref(), Some("deadline"));
        assert!(helper.pending.lock().unwrap().is_empty());
        assert_eq!(helper.misses.load(Ordering::Acquire), 1);
        // Long enough for the late reply to arrive and be dropped.
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(helper.pending.lock().unwrap().is_empty());
        assert!(helper
            .call("ping", Value::Null, deadline(5_000), None)
            .await
            .is_ok());
        assert_eq!(helper.misses.load(Ordering::Acquire), 0, "a reply resets");
        helper.shutdown().await;
    }

    #[tokio::test]
    async fn a_reply_from_a_finished_epoch_is_dropped() {
        let Some((lens, helper, _rx)) = ready(quick()).await else {
            return;
        };
        let epoch = lens.bridge.epoch();
        let call = helper.call("sleep", json!({ "ms": 200 }), deadline(5_000), Some(epoch));
        let bump = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            lens.bridge.bump_epoch();
        };
        let (result, ()) = tokio::join!(call, bump);
        assert_eq!(result.err().as_deref(), Some("stale-epoch"));
        // The same call stamped with the current epoch is answered.
        let epoch = lens.bridge.epoch();
        assert!(helper
            .call("ping", Value::Null, deadline(5_000), Some(epoch))
            .await
            .is_ok());
        helper.shutdown().await;
    }

    #[tokio::test]
    async fn twelve_calls_fit_and_the_thirteenth_is_busy() {
        let limits = Thresholds {
            // Twelve concurrent sleeps are retained work by design here.
            outstanding_window: Duration::from_secs(60),
            ..quick()
        };
        let Some((_lens, helper, _rx)) = ready(limits).await else {
            return;
        };
        let mut running = Vec::new();
        for _ in 0..(RUNNING + QUEUED) {
            let helper = helper.clone();
            running.push(tauri::async_runtime::spawn(async move {
                helper
                    .call("sleep", json!({ "ms": 600 }), deadline(10_000), None)
                    .await
            }));
        }
        // Long enough for every slot to be taken before one more is asked for.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            helper
                .call("sleep", json!({ "ms": 0 }), deadline(2_000), None)
                .await
                .err()
                .as_deref(),
            Some("busy")
        );
        // A ping is a control op: it goes round the slots, not through them.
        assert!(helper
            .call("ping", Value::Null, deadline(2_000), None)
            .await
            .is_ok());
        for task in running {
            assert!(task.await.unwrap().is_ok());
        }
        // The slots came back.
        assert!(helper
            .call("sleep", json!({ "ms": 0 }), deadline(5_000), None)
            .await
            .is_ok());
        helper.shutdown().await;
    }

    #[tokio::test]
    async fn three_consecutive_misses_start_a_new_child() {
        let Some((_lens, helper, mut rx)) = ready(quick()).await else {
            return;
        };
        let first = helper.pid().expect("a child");
        for _ in 0..helper.limits.miss_limit {
            assert_eq!(
                helper
                    .call("sleep", json!({ "ms": 5_000 }), deadline(80), None)
                    .await
                    .err()
                    .as_deref(),
                Some("deadline")
            );
        }
        assert_eq!(states(&mut rx, 2).await, vec!["recovering", "ok"]);
        let second = helper.pid().expect("a new child");
        assert_ne!(first, second);
        assert!(!alive(first), "the wedged child is gone");
        helper.shutdown().await;
    }

    #[tokio::test]
    async fn an_exit_seventy_five_starts_a_new_child() {
        let Some((_lens, helper, mut rx)) =
            fake_helper(quick(), &[("FAKE_EXIT_75_AFTER_MS", "400")])
        else {
            return;
        };
        assert_eq!(states(&mut rx, 3).await, vec!["ok", "recovering", "ok"]);
        helper.shutdown().await;
    }

    /// `FAKE_OUTSTANDING` keeps retained work visible, so the ping task has
    /// something to be watching; the child then never answers the ping.
    #[tokio::test]
    async fn an_unanswered_ping_starts_a_new_child() {
        let limits = Thresholds {
            ping_every: Duration::from_millis(100),
            outstanding_window: Duration::from_secs(60),
            ..quick()
        };
        let Some((_lens, helper, mut rx)) = fake_helper(
            limits,
            &[("FAKE_IGNORE_PINGS", "1"), ("FAKE_OUTSTANDING", "1")],
        ) else {
            return;
        };
        assert_eq!(states(&mut rx, 3).await, vec!["ok", "recovering", "ok"]);
        helper.shutdown().await;
    }

    #[tokio::test]
    async fn retained_work_above_the_bound_starts_a_new_child() {
        let Some((_lens, helper, mut rx)) = fake_helper(quick(), &[("FAKE_OUTSTANDING", "5")])
        else {
            return;
        };
        assert_eq!(states(&mut rx, 3).await, vec!["ok", "recovering", "ok"]);
        assert!(helper.outstanding.load(Ordering::Acquire) > OUTSTANDING_LIMIT);
        helper.shutdown().await;
    }

    /// Apple Intelligence off: the process answers, so the handshake lands and
    /// `capabilities` says `available:false`; the first model op comes back
    /// `unavailable` and the helper's `state` line makes `lens-status` say so.
    #[tokio::test]
    async fn an_unavailable_model_is_reported_not_hidden() {
        let Some((lens, helper, mut rx)) = fake_helper(quick(), &[("FAKE_UNAVAILABLE", "1")])
        else {
            return;
        };
        *lens.helper.lock().unwrap() = Some(helper.clone());
        assert_eq!(states(&mut rx, 1).await, vec!["ok"]);
        let capabilities = lens
            .desktop_request("helper-capabilities", &json!({}), Some(deadline(5_000)))
            .await
            .unwrap();
        assert_eq!(capabilities["model"]["available"], false);
        let triage = json!({
            "epoch": lens.bridge.epoch(), "seq": 1,
            "watch": "an error dialog", "diff": "+ Build failed", "app": "Xcode",
        });
        assert_eq!(
            lens.desktop_request("helper-triage", &triage, Some(deadline(5_000)))
                .await
                .err()
                .as_deref(),
            Some("unavailable")
        );
        assert_eq!(states(&mut rx, 1).await, vec!["unavailable"]);
        assert_eq!(
            lens.status()["helper"],
            json!({ "state": "unavailable", "outstanding": 0 })
        );
        helper.shutdown().await;
    }

    /// A helper that answers nothing at all, including the handshake.
    #[tokio::test]
    async fn a_helper_that_never_replies_is_replaced() {
        let Some((_lens, helper, _rx)) = fake_helper(quick(), &[("FAKE_HANG", "1")]) else {
            return;
        };
        for _ in 0..3 {
            assert_eq!(
                helper
                    .call("ping", Value::Null, deadline(80), None)
                    .await
                    .err()
                    .as_deref(),
                Some("deadline")
            );
        }
        let first = helper.pid();
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_ne!(helper.pid(), first, "a new child");
        assert_eq!(helper.state().0, "recovering", "it never answers");
        helper.shutdown().await;
    }

    /// `helper-describe` crops from the frame the caller named, at 1024 px,
    /// and the reply carries that frame's stamp rather than the current one.
    #[tokio::test]
    async fn the_describe_crop_path_sends_a_bounded_jpeg_from_the_named_frame() {
        use base64::Engine as _;
        let Some((lens, helper, _rx)) = ready(quick()).await else {
            return;
        };
        *lens.helper.lock().unwrap() = Some(helper.clone());
        // 1600x1200 at 1x, so the long edge has to come down to 1024.
        let (w, h) = (1600u32, 1200u32);
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, crate::lens::ring::QUALITY)
            .encode_image(&image::RgbImage::from_pixel(w, h, image::Rgb([9, 9, 9])))
            .unwrap();
        lens.ring.push(crate::lens::ring::Frame {
            frame_ref: "f-1-7".into(),
            epoch: lens.bridge.epoch(),
            seq: 7,
            at: now_ms(),
            w,
            h,
            geometry: crate::lens::bridge::FrameGeometry {
                window: [0.0, 0.0, f64::from(w), f64::from(h)],
                scale: 1.0,
                content_rect: [0.0, 0.0, f64::from(w), f64::from(h)],
                content_scale: 1.0,
                captured: [0.0, 0.0, f64::from(w), f64::from(h)],
            },
            jpeg: jpeg.into(),
            pixels: None,
        });
        let reply = lens
            .desktop_request(
                "helper-describe",
                &json!({ "ref": "f-1-7", "prompt": "what is this" }),
                Some(deadline(5_000)),
            )
            .await
            .unwrap();
        assert_eq!(reply["ref"], "f-1-7");
        assert_eq!(reply["epoch"], lens.bridge.epoch());
        assert_eq!(reply["seq"], 7);
        // The fake echoes the payload back, so this is the JPEG that crossed.
        let sent = &reply["value"];
        assert_eq!(sent["ref"], "f-1-7");
        assert_eq!(sent["prompt"], "what is this");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(sent["jpeg"].as_str().expect("a jpeg"))
            .expect("base64");
        let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg)
            .expect("a decodable jpeg");
        assert_eq!(decoded.width().max(decoded.height()), MAX_PX);
        assert_eq!((decoded.width(), decoded.height()), (1024, 768));
        // An evicted ref never reaches the helper.
        assert_eq!(
            lens.desktop_request("helper-describe", &json!({ "ref": "f-9-9" }), None)
                .await
                .err()
                .as_deref(),
            Some("frame-evicted")
        );
        assert_eq!(
            lens.status()["helper"],
            json!({ "state": "ok", "outstanding": 0 })
        );
        helper.shutdown().await;
    }

    #[test]
    fn the_respawn_rules_are_a_table() {
        let limits = Thresholds::default();
        assert_eq!(should_respawn(None, 0, None, false, &limits), None);
        assert_eq!(should_respawn(None, 2, None, false, &limits), None);
        assert_eq!(
            should_respawn(None, 3, None, false, &limits),
            Some(Reason::Misses)
        );
        assert_eq!(
            should_respawn(Some(75), 0, None, false, &limits),
            Some(Reason::Exit(75))
        );
        assert_eq!(
            should_respawn(Some(0), 0, None, false, &limits),
            Some(Reason::Exit(0)),
            "a child that exited cannot answer, whatever the code"
        );
        assert_eq!(
            should_respawn(None, 0, Some(Duration::from_secs(29)), false, &limits),
            None
        );
        assert_eq!(
            should_respawn(None, 0, Some(Duration::from_secs(31)), false, &limits),
            Some(Reason::Outstanding)
        );
        assert_eq!(
            should_respawn(None, 0, None, true, &limits),
            Some(Reason::Ping)
        );
        // Shortened thresholds move the line, not the rule.
        let quick = Thresholds {
            miss_limit: 1,
            outstanding_window: Duration::from_millis(10),
            ..limits
        };
        assert_eq!(
            should_respawn(None, 1, None, false, &quick),
            Some(Reason::Misses)
        );
        assert_eq!(
            should_respawn(None, 0, Some(Duration::from_millis(11)), false, &quick),
            Some(Reason::Outstanding)
        );
        assert_eq!(Reason::Exit(75).to_string(), "exit 75");
    }

    #[test]
    fn the_backoff_climbs_to_its_ceiling() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let lens = Lens::new(Config::default(), tx);
        // Never started: a path that does not exist can still answer the pure
        // questions, and the supervisor task leaves it `down`.
        let helper = Helper::with_thresholds(
            lens,
            PathBuf::from("/nonexistent/blackice-helper"),
            PathBuf::new(),
            false,
            Thresholds::default(),
        );
        assert_eq!(helper.backoff(1), Duration::from_secs(1));
        assert_eq!(helper.backoff(2), Duration::from_secs(2));
        assert_eq!(helper.backoff(5), Duration::from_secs(16));
        assert_eq!(helper.backoff(6), Duration::from_secs(30), "the ceiling");
        assert_eq!(helper.backoff(60), Duration::from_secs(30));
        assert_eq!(helper.pid(), None);
    }

    /// The real helper, which needs the Swift build and Apple Intelligence.
    #[tokio::test]
    #[ignore]
    async fn the_real_helper_answers_and_recovers_from_a_wedge() {
        let layout = crate::runtime::debug_layout();
        assert!(layout.helper.is_file(), "run `npm run helper:dev` first");
        let (lens, mut rx) = lens();
        // The helper's own recovery deadline, shortened for the test only.
        let helper = Helper::build(
            lens.clone(),
            layout.helper,
            layout.models,
            true,
            Thresholds::default(),
            vec![("RIMEWARD_HELPER_ABANDON_MS".into(), "2000".into())],
        );
        *lens.helper.lock().unwrap() = Some(helper.clone());
        assert_eq!(states(&mut rx, 1).await, vec!["ok"]);
        let capabilities = helper
            .call("capabilities", json!({}), deadline(40_000), None)
            .await
            .expect("capabilities");
        eprintln!("capabilities: {capabilities}");
        assert!(helper
            .call("ping", Value::Null, deadline(5_000), None)
            .await
            .is_ok());

        // A model call that outlives its deadline, then its recovery deadline:
        // the helper exits 75 and Rust brings a new one up.
        assert_eq!(
            helper
                .call("sleep", json!({ "ms": 3_000 }), deadline(500), None)
                .await
                .err()
                .as_deref(),
            Some("deadline")
        );
        assert_eq!(states(&mut rx, 2).await, vec!["recovering", "ok"]);
        let started = Instant::now();
        assert!(helper
            .call("ping", Value::Null, deadline(5_000), None)
            .await
            .is_ok());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(lens.status()["helper"]["state"], "ok");
        helper.shutdown().await;
    }
}
