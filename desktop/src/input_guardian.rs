//! The signed app's release-only child remembers held input before a press.
//! Private stdio EOF or a five-second parent stall releases it. No sockets or logs.
use enigo::{
    Axis, Button, Coordinate, Direction, Enigo, InputError, InputResult, Key, Keyboard, Mouse,
    Settings,
};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

#[cfg(target_os = "macos")]
pub fn initialize(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

#[cfg(target_os = "macos")]
fn keycode(key: Key) -> InputResult<u16> {
    // macOS input-source lookup asserts the main queue. Keep gestures and their
    // release watchdog on the worker; only resolve the current keyboard layout here.
    let unavailable = || InputError::Simulate("Keyboard layout lookup unavailable");
    let (send, receive) = mpsc::sync_channel(1);
    APP.get()
        .ok_or_else(unavailable)?
        .run_on_main_thread(move || {
            let _ = send.send(u16::try_from(key));
        })
        .map_err(|_| unavailable())?;
    receive
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| unavailable())?
        .map_err(|_| InputError::InvalidInput("Use composed text for this character"))
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Held {
    keys: Vec<Key>,
    raw: Vec<u16>,
    buttons: Vec<Button>,
    #[cfg(target_os = "windows")]
    unicode: Vec<u16>,
}
impl Held {
    fn valid(&self) -> bool {
        #[cfg(target_os = "windows")]
        if self.unicode.len() > 2 || self.keys.iter().any(|key| matches!(key, Key::Unicode(_))) {
            return false;
        }
        self.keys.len() + self.raw.len() <= 256
            && self
                .buttons
                .iter()
                .all(|b| matches!(b, Button::Left | Button::Middle | Button::Right))
            && self.buttons.len() <= 3
    }
    fn release(&mut self, input: &mut Enigo) -> bool {
        let mut ok = true;
        for key in self.keys.drain(..) {
            ok &= input.key(key, Direction::Release).is_ok();
        }
        for code in self.raw.drain(..) {
            ok &= input.raw(code, Direction::Release).is_ok();
        }
        for button in self.buttons.drain(..) {
            ok &= input.button(button, Direction::Release).is_ok();
        }
        #[cfg(target_os = "windows")]
        {
            ok &= release_unicode(&self.unicode);
            self.unicode.clear();
        }
        ok
    }
}
fn settings() -> Settings {
    Settings {
        open_prompt_to_get_permissions: false,
        ..Settings::default()
    }
}
fn error() -> InputError {
    InputError::Simulate("Input release watchdog unavailable; acquire control again")
}
fn permitted() -> InputResult<()> {
    crate::computer::permitted().map_err(|_| InputError::Simulate("Input permission changed"))
}
#[cfg(target_os = "windows")]
fn release_unicode(units: &[u16]) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
        VIRTUAL_KEY,
    };
    let events: Vec<INPUT> = units
        .iter()
        .map(|unit| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: *unit,
                    dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 100,
                },
            },
        })
        .collect();
    events.is_empty()
        || unsafe {
            SendInput(&events, std::mem::size_of::<INPUT>() as i32) as usize == events.len()
        }
}
// Old release work must finish before another controller can press anything.
static CHILDREN: AtomicUsize = AtomicUsize::new(0);

type Request = (Held, SyncSender<bool>);
pub struct Input {
    native: Enigo,
    held: Held,
    requests: Option<SyncSender<Request>>,
    last: Instant,
    healthy: bool,
}
impl Input {
    #[cfg(target_os = "windows")]
    pub fn get_marker_value(&self) -> usize {
        self.native.get_marker_value()
    }
    pub fn new() -> Result<Self, String> {
        let began = Instant::now();
        while CHILDREN.load(Ordering::SeqCst) != 0 {
            if began.elapsed() >= Duration::from_millis(150) {
                return Err("Previous input is still being released; acquire control again".into());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let native = Enigo::new(&settings()).map_err(|e| e.to_string())?;
        let mut command =
            std::process::Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
        command
            .arg("--rimeward-input-guardian")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let mut write = child.stdin.take().ok_or("Watchdog input unavailable")?;
        let mut read = child.stdout.take().ok_or("Watchdog output unavailable")?;
        let (requests, receiver) = mpsc::sync_channel::<Request>(1);
        CHILDREN.fetch_add(1, Ordering::SeqCst);
        // Only this worker owns the pipe: one bounded message and acknowledgement.
        // A stalled child expires independently; the caller never waits indefinitely.
        std::thread::spawn(move || {
            for (held, reply) in receiver {
                let ok = (|| -> std::io::Result<()> {
                    let mut bytes = serde_json::to_vec(&held)?;
                    bytes.push(b'\n');
                    write.write_all(&bytes)?;
                    write.flush()?;
                    let mut ack = [0];
                    read.read_exact(&mut ack)?;
                    if ack != [1] {
                        return Err(std::io::Error::other("Invalid watchdog reply"));
                    }
                    Ok(())
                })()
                .is_ok();
                let _ = reply.send(ok);
                if !ok {
                    break;
                }
            }
            drop(write); // EOF requests release, including after a failed acknowledgement.
            let _ = child.wait();
            CHILDREN.fetch_sub(1, Ordering::SeqCst);
        });
        let mut input = Self {
            native,
            held: Held::default(),
            requests: Some(requests),
            last: Instant::now(),
            healthy: true,
        };
        input
            .sync(Duration::from_secs(2))
            .map_err(|e| e.to_string())?;
        Ok(input)
    }
    fn sync(&mut self, timeout: Duration) -> InputResult<()> {
        if !self.healthy || !self.held.valid() {
            return Err(error());
        }
        let (reply, response) = mpsc::sync_channel(1);
        self.healthy = self
            .requests
            .as_ref()
            .is_some_and(|requests| requests.try_send((self.held.clone(), reply)).is_ok())
            && response.recv_timeout(timeout) == Ok(true);
        self.last = Instant::now();
        if self.healthy {
            Ok(())
        } else {
            self.requests = None;
            Err(error())
        }
    }
    pub fn pulse(&mut self) -> InputResult<()> {
        if !self.healthy {
            return Err(error());
        }
        if self.last.elapsed() >= Duration::from_secs(1) {
            self.sync(Duration::from_millis(150))?;
        }
        Ok(())
    }
    pub fn has_key(&self, key: Key) -> bool {
        #[cfg(target_os = "macos")]
        if matches!(key, Key::Unicode(_)) {
            return keycode(key).is_ok_and(|code| self.has_raw(code));
        }
        #[cfg(target_os = "windows")]
        if matches!(key, Key::Unicode(_)) {
            use windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY;
            return VIRTUAL_KEY::try_from(key)
                .is_ok_and(|key| self.held.keys.contains(&Key::Other(u32::from(key.0))));
        }
        self.held.keys.contains(&key)
    }
    pub fn has_raw(&self, code: u16) -> bool {
        self.held.raw.contains(&code)
    }
    pub fn key(&mut self, key: Key, direction: Direction) -> InputResult<()> {
        // Store the actual native key, never a Unicode fallback that could type during recovery.
        #[cfg(target_os = "macos")]
        if matches!(key, Key::Unicode(_)) {
            return self.raw(keycode(key)?, direction);
        }
        #[cfg(target_os = "windows")]
        let key = if matches!(key, Key::Unicode(_)) {
            use windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY;
            Key::Other(u32::from(
                VIRTUAL_KEY::try_from(key)
                    .map_err(|_| InputError::InvalidInput("Use composed text for this character"))?
                    .0,
            ))
        } else {
            key
        };
        if direction == Direction::Click {
            self.key(key, Direction::Press)?;
            return self.key(key, Direction::Release);
        }
        if direction == Direction::Press {
            if self.has_key(key) {
                return Ok(());
            }
            if self.held.keys.len() + self.held.raw.len() >= 256 {
                return Err(error());
            }
            self.held.keys.push(key);
            self.sync(Duration::from_millis(150))?;
            permitted()?;
        }
        self.native.key(key, direction)?;
        if direction == Direction::Release {
            self.held.keys.retain(|k| *k != key);
            self.sync(Duration::from_millis(150))?;
        }
        Ok(())
    }
    pub fn raw(&mut self, code: u16, direction: Direction) -> InputResult<()> {
        if direction == Direction::Click {
            self.raw(code, Direction::Press)?;
            return self.raw(code, Direction::Release);
        }
        if direction == Direction::Press {
            if self.has_raw(code) {
                return Ok(());
            }
            if self.held.keys.len() + self.held.raw.len() >= 256 {
                return Err(error());
            }
            self.held.raw.push(code);
            self.sync(Duration::from_millis(150))?;
            permitted()?;
        }
        self.native.raw(code, direction)?;
        if direction == Direction::Release {
            self.held.raw.retain(|k| *k != code);
            self.sync(Duration::from_millis(150))?;
        }
        Ok(())
    }
    pub fn button(&mut self, button: Button, direction: Direction) -> InputResult<()> {
        if direction == Direction::Click {
            self.button(button, Direction::Press)?;
            return self.button(button, Direction::Release);
        }
        if direction == Direction::Press {
            if self.held.buttons.contains(&button) {
                return Ok(());
            }
            self.held.buttons.push(button);
            self.sync(Duration::from_millis(150))?;
            permitted()?;
        }
        self.native.button(button, direction)?;
        if direction == Direction::Release {
            self.held.buttons.retain(|b| *b != button);
            self.sync(Duration::from_millis(150))?;
        }
        Ok(())
    }
    pub fn text(&mut self, text: &str) -> InputResult<()> {
        if !self.held.keys.is_empty() || !self.held.raw.is_empty() || !self.held.buttons.is_empty()
        {
            return Err(InputError::InvalidInput(
                "Release held keys before sending composed text",
            ));
        }
        for character in text.chars() {
            permitted()?;
            if matches!(character, '\n' | '\t') {
                self.key(
                    if character == '\n' {
                        Key::Return
                    } else {
                        Key::Tab
                    },
                    Direction::Click,
                )?;
                continue;
            }
            if character == '\0' {
                return Err(InputError::InvalidInput("Text contains a null character"));
            }
            #[cfg(target_os = "linux")]
            self.key(Key::Unicode(character), Direction::Click)?;
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            {
                #[cfg(target_os = "macos")]
                self.held.raw.push(0); // Enigo's CoreGraphics Unicode events use virtual key zero.
                #[cfg(target_os = "windows")]
                self.held
                    .unicode
                    .extend(character.encode_utf16(&mut [0; 2]).iter().copied());
                self.sync(Duration::from_millis(150))?;
                permitted()?;
                self.native.text(character.encode_utf8(&mut [0; 4]))?;
                if !self.held.release(&mut self.native) {
                    return Err(error());
                }
                self.sync(Duration::from_millis(150))?;
            }
        }
        Ok(())
    }
    pub fn move_mouse(&mut self, x: i32, y: i32, coordinate: Coordinate) -> InputResult<()> {
        self.pulse()?;
        self.native.move_mouse(x, y, coordinate)
    }
    pub fn scroll(&mut self, amount: i32, axis: Axis) -> InputResult<()> {
        self.pulse()?;
        self.native.scroll(amount, axis)
    }
}
impl Drop for Input {
    fn drop(&mut self) {
        // The guardian retains the snapshot and independently repeats key-up on EOF.
        // Never clear its state based on an uncertain native release result.
        if self.held.release(&mut self.native) {
            let _ = self.sync(Duration::from_millis(150));
        }
        self.requests = None;
    }
}

fn messages(reader: impl BufRead, send: SyncSender<Held>) {
    let mut reader = reader;
    loop {
        let mut line = Vec::new();
        if reader
            .by_ref()
            .take(16385)
            .read_until(b'\n', &mut line)
            .is_err()
            || line.last() != Some(&b'\n')
            || line.len() > 16384
        {
            break;
        }
        let Ok(held) = serde_json::from_slice::<Held>(&line) else {
            break;
        };
        if !held.valid() || send.send(held).is_err() {
            break;
        }
    }
}
fn watch(
    receive: Receiver<Held>,
    timeout: Duration,
    mut acknowledge: impl FnMut() -> bool,
) -> Held {
    let mut held = Held::default();
    while let Ok(next) = receive.recv_timeout(timeout) {
        held = next;
        if !acknowledge() {
            break;
        }
    }
    held
}
pub fn run() -> i32 {
    let Ok(mut input) = Enigo::new(&settings()) else {
        return 1;
    };
    let (send, receive) = mpsc::sync_channel(1);
    std::thread::spawn(move || messages(BufReader::new(std::io::stdin()), send));
    let mut held = watch(receive, Duration::from_secs(5), || {
        let mut output = std::io::stdout().lock();
        output.write_all(&[1]).and_then(|_| output.flush()).is_ok()
    });
    // X11 keymap bindings may have changed since startup (e.g. composed Unicode).
    #[cfg(target_os = "linux")]
    if let Ok(current) = Enigo::new(&settings()) {
        input = current;
    }
    held.release(&mut input);
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parent_eof_stall_and_bad_message_preserve_only_last_acknowledged_state() {
        let state = Held {
            keys: vec![Key::Shift],
            raw: vec![42],
            buttons: vec![Button::Left],
            #[cfg(target_os = "windows")]
            unicode: Vec::new(),
        };
        let mut data = serde_json::to_vec(&state).unwrap();
        data.extend_from_slice(b"\ninvalid\n");
        let (send, receive) = mpsc::sync_channel(1);
        std::thread::spawn(move || messages(std::io::Cursor::new(data), send));
        let mut acknowledged = 0;
        let held = watch(receive, Duration::from_millis(50), || {
            acknowledged += 1;
            true
        });
        assert_eq!(acknowledged, 1);
        assert_eq!(held.keys, state.keys);
        assert_eq!(held.raw, state.raw);
        assert_eq!(held.buttons, state.buttons);
        let (send, receive) = mpsc::sync_channel(1);
        send.send(state).unwrap();
        let held = watch(receive, Duration::from_millis(1), || true);
        assert_eq!(held.raw, vec![42]);
        drop(send);
        let (send, receive) = mpsc::sync_channel(1);
        let oversized = Held {
            raw: vec![1; 257],
            ..Held::default()
        };
        let mut data = serde_json::to_vec(&oversized).unwrap();
        data.push(b'\n');
        messages(std::io::Cursor::new(data), send);
        assert!(receive.recv().is_err());
    }
}
