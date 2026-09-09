//! Rimeward's inherited release watchdog. An acknowledgement precedes every post.
use std::io::{Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::net::UnixStream;
use std::sync::{Mutex, OnceLock};
use std::ffi::c_void;
use foreign_types::ForeignType;
use core_graphics::event::CGEvent;

fn exchange(message: serde_json::Value) {
    static PIPE: OnceLock<Mutex<UnixStream>> = OnceLock::new();
    let result = (|| -> Option<()> {
        let pipe = PIPE.get_or_init(|| {
            let fd = std::env::var("RIMEWARD_BACKGROUND_GUARD_FD").ok().and_then(|v| v.parse::<i32>().ok()).filter(|v| *v > 2).unwrap_or_else(|| std::process::exit(70));
            let stream = unsafe { UnixStream::from_raw_fd(fd) };
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(1)));
            let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(1)));
            Mutex::new(stream)
        });
        let mut pipe = pipe.lock().ok()?;
        let bytes = serde_json::to_vec(&message).ok()?;
        if bytes.len() > 65536 { return None; }
        pipe.write_all(&(bytes.len() as u32).to_be_bytes()).ok()?;
        pipe.write_all(&bytes).ok()?;
        let mut ack = [0]; pipe.read_exact(&mut ack).ok()?;
        (ack == [1]).then_some(())
    })();
    // The independent watchdog retains releases even if this process dies here.
    if result.is_none() { std::process::exit(70); }
}
pub fn before(pid: i32, event: *mut c_void) {
    extern "C" {
        fn CGEventCreateData(allocator: *const c_void, event: *mut c_void) -> *const c_void;
        fn CFDataGetLength(data: *const c_void) -> isize;
        fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
        fn CFRelease(data: *const c_void);
    }
    unsafe {
        let data = CGEventCreateData(std::ptr::null(), event);
        if data.is_null() { std::process::exit(70); }
        let len = CFDataGetLength(data);
        if !(1..=16000).contains(&len) { CFRelease(data); std::process::exit(70); }
        let bytes = std::slice::from_raw_parts(CFDataGetBytePtr(data), len as usize).to_vec();
        CFRelease(data);
        exchange(serde_json::json!({"pid":pid,"event":bytes}));
    }
}
pub fn after(pid: i32, event: *mut c_void) {
    extern "C" { fn CGEventGetType(event: *mut c_void) -> u32; fn CGEventGetIntegerValueField(event: *mut c_void, field: u32) -> i64; }
    let slot = unsafe { match CGEventGetType(event) { 2 => Some(1), 11 => Some(1000 + CGEventGetIntegerValueField(event, 9)), _ => None } };
    if let Some(slot) = slot { exchange(serde_json::json!({"pid":pid,"released":slot})); }
}
pub fn clear() { exchange(serde_json::json!({"clear":true})); }
pub fn public_post(pid: i32, event: &CGEvent) {
    before(pid, event.as_ptr() as *mut c_void);
    event.post_to_pid(pid);
    after(pid, event.as_ptr() as *mut c_void);
}
