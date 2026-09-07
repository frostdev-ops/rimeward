//! Remote access is limited to the owner's active, unlocked graphical session.
#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "linux")]
static ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn initialize() {
    #[cfg(target_os = "linux")]
    std::thread::spawn(|| {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return;
        };
        runtime.block_on(async {
            loop {
                let _ = watch_linux().await;
                ACTIVE.store(false, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        });
    });
}
#[cfg(target_os = "linux")]
async fn watch_linux() -> Result<(), Box<dyn std::error::Error>> {
    use ashpd::zbus::{zvariant::OwnedObjectPath, Connection, Proxy};
    use std::time::Duration;
    let connection = Connection::system().await?;
    let manager = Proxy::new(
        &connection,
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
    )
    .await?;
    let path: OwnedObjectPath = match manager
        .call("GetSessionByPID", &(std::process::id(),))
        .await
    {
        Ok(path) => path,
        Err(_) => {
            // Desktop autostart apps may belong to the user's systemd manager, outside a session scope.
            let user: OwnedObjectPath = manager
                .call("GetUser", &(unsafe { libc::geteuid() },))
                .await?;
            let user = Proxy::new(
                &connection,
                "org.freedesktop.login1",
                user,
                "org.freedesktop.login1.User",
            )
            .await?;
            let (_, path): (String, OwnedObjectPath) = user.get_property("Display").await?;
            path
        }
    };
    let session = Proxy::new(
        &connection,
        "org.freedesktop.login1",
        path,
        "org.freedesktop.login1.Session",
    )
    .await?;
    loop {
        let state = tokio::time::timeout(Duration::from_millis(200), async {
            let (active, locked, sleeping, class): (bool, bool, bool, String) = tokio::try_join!(
                session.get_property("Active"),
                session.get_property("LockedHint"),
                manager.get_property("PreparingForSleep"),
                session.get_property("Class")
            )?;
            Ok::<_, ashpd::zbus::Error>(active && !locked && !sleeping && class == "user")
        })
        .await;
        match state {
            Ok(Ok(active)) => ACTIVE.store(active, Ordering::SeqCst),
            _ => return Err("Desktop session state unavailable".into()),
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
#[cfg(target_os = "linux")]
pub fn active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}
#[cfg(target_os = "macos")]
pub fn active() -> bool {
    use objc2_core_foundation::{CFBoolean, CFString, CFType};
    let Some(dictionary) = objc2_core_graphics::CGSessionCopyCurrentDictionary() else {
        return false;
    };
    // CoreGraphics returns a dictionary of string keys and Core Foundation values.
    let dictionary = unsafe { dictionary.cast_unchecked::<CFString, CFType>() };
    let flag = |key| {
        dictionary
            .get(&CFString::from_str(key))
            .and_then(|value| value.downcast::<CFBoolean>().ok())
            .map(|value| value.value())
    };
    // The public kCGSessionOnConsoleKey constant's value contains the extra S.
    flag("kCGSSessionOnConsoleKey") == Some(true)
        && flag("kCGSessionLoginDoneKey") == Some(true)
        && flag("CGSSessionScreenIsLocked") != Some(true)
}
#[cfg(target_os = "windows")]
pub fn active() -> bool {
    use windows::Win32::{
        Foundation::HANDLE,
        System::StationsAndDesktops::{
            CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS,
            DESKTOP_READOBJECTS, UOI_NAME,
        },
    };
    // This is read-only: never switch desktops or acquire access to Winlogon/UAC.
    unsafe {
        let Ok(desktop) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
        else {
            return false;
        };
        let mut name = [0u16; 256];
        let read = GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            std::mem::size_of_val(&name) as u32,
            None,
        );
        let _ = CloseDesktop(desktop);
        read.is_ok()
            && String::from_utf16_lossy(
                &name[..name.iter().position(|c| *c == 0).unwrap_or(name.len())],
            )
            .eq_ignore_ascii_case("Default")
    }
}
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn active() -> bool {
    false
}
