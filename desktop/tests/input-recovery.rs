//! Real synthetic input in a private Xvfb, never the user's graphical session.
#[allow(dead_code, unused_imports)]
#[path = "../src/input_guardian.rs"]
mod input_guardian;
mod computer {
    pub fn permitted() -> Result<(), String> {
        Ok(())
    }
}
fn main() {
    if std::env::args().nth(1).as_deref() == Some("--rimeward-input-guardian") {
        std::process::exit(input_guardian::run());
    }
    #[cfg(target_os = "linux")]
    linux::run();
    #[cfg(not(target_os = "linux"))]
    println!(
        "Input recovery OS acceptance uses isolated Xvfb on Linux; no local input was generated."
    );
}
#[cfg(target_os = "linux")]
mod linux {
    use super::input_guardian::Input;
    use enigo::{Button, Direction, Key};
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};
    #[link(name = "X11")]
    extern "C" {
        fn XOpenDisplay(name: *const std::ffi::c_char) -> *mut std::ffi::c_void;
        fn XCloseDisplay(display: *mut std::ffi::c_void) -> i32;
        fn XQueryKeymap(display: *mut std::ffi::c_void, keys: *mut u8) -> i32;
        fn XDefaultRootWindow(display: *mut std::ffi::c_void) -> std::ffi::c_ulong;
        fn XQueryPointer(
            display: *mut std::ffi::c_void,
            window: std::ffi::c_ulong,
            root: *mut std::ffi::c_ulong,
            child: *mut std::ffi::c_ulong,
            root_x: *mut i32,
            root_y: *mut i32,
            win_x: *mut i32,
            win_y: *mut i32,
            mask: *mut u32,
        ) -> i32;
    }
    struct Process(Child);
    impl Drop for Process {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    fn line(child: &mut Child) -> String {
        let output = child.stdout.take().unwrap();
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = BufReader::new(output).read_line(&mut line);
            let _ = send.send(line);
        });
        receive
            .recv_timeout(Duration::from_secs(5))
            .expect("Native fixture did not start")
    }
    fn parent(mode: &str) {
        let mut input = Input::new().unwrap();
        input.key(Key::Shift, Direction::Press).unwrap();
        input.key(Key::Unicode('λ'), Direction::Press).unwrap();
        input.button(Button::Left, Direction::Press).unwrap();
        println!("ready");
        std::io::stdout().flush().unwrap();
        if mode == "--stop-fixture" {
            let _ = std::io::stdin().read_line(&mut String::new());
            drop(input);
        } else {
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        }
    }
    pub fn run() {
        if let Some(mode) = std::env::args()
            .nth(1)
            .filter(|arg| arg.ends_with("-fixture"))
        {
            parent(&mode);
            return;
        }
        let display = Command::new("Xvfb")
            .args([
                "-displayfd",
                "1",
                "-screen",
                "0",
                "1280x720x24",
                "-nolisten",
                "tcp",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let Ok(mut server) = display.map(Process) else {
            println!("Xvfb unavailable: native crash acceptance was not run.");
            return;
        };
        let number = line(&mut server.0);
        assert!(number.trim().parse::<u16>().is_ok());
        std::env::set_var("DISPLAY", format!(":{}", number.trim()));
        std::env::remove_var("WAYLAND_DISPLAY");
        std::env::set_var("XDG_SESSION_TYPE", "x11");
        let connection = unsafe { XOpenDisplay(std::ptr::null()) };
        assert!(!connection.is_null());
        let held = || unsafe {
            let mut keys = [0u8; 32];
            XQueryKeymap(connection, keys.as_mut_ptr());
            let (mut root, mut child, mut rx, mut ry, mut wx, mut wy, mut mask) =
                (0, 0, 0, 0, 0, 0, 0);
            XQueryPointer(
                connection,
                XDefaultRootWindow(connection),
                &mut root,
                &mut child,
                &mut rx,
                &mut ry,
                &mut wx,
                &mut wy,
                &mut mask,
            );
            (keys.iter().any(|byte| *byte != 0), mask & (7 << 8) != 0)
        };
        for mode in ["--crash-fixture", "--stall-fixture", "--stop-fixture"] {
            assert_eq!(held(), (false, false));
            let mut parent = Process(
                Command::new(std::env::current_exe().unwrap())
                    .arg(mode)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .unwrap(),
            );
            assert_eq!(line(&mut parent.0).trim(), "ready");
            assert_eq!(held(), (true, true));
            let began = Instant::now();
            if mode == "--crash-fixture" {
                parent.0.kill().unwrap();
                parent.0.wait().unwrap();
            }
            if mode == "--stop-fixture" {
                parent
                    .0
                    .stdin
                    .as_mut()
                    .unwrap()
                    .write_all(b"stop\n")
                    .unwrap();
            }
            while held() != (false, false) {
                assert!(
                    began.elapsed() < Duration::from_secs(7),
                    "Synthetic input remained held after {mode}"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            if mode == "--stop-fixture" {
                assert!(began.elapsed() < Duration::from_millis(250));
            }
            println!(
                "{mode}: all keys/buttons released in {} ms",
                began.elapsed().as_millis()
            );
        }
        unsafe {
            XCloseDisplay(connection);
        }
    }
}
