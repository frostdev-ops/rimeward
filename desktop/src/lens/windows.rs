//! Exact-window WGC. Native handles and provider objects never cross the wire.
use super::{
    bridge::{DisplayInfo, FrameGeometry, Line, Rect},
    request::Cancellation,
    CaptureLease, Lens, Target,
};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
    time::{Duration, Instant},
};
use windows::{
    core::{factory, Interface, PWSTR},
    Foundation::TypedEventHandler,
    Graphics::{
        Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession},
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
    },
    Wdk::System::SystemServices::RtlGetVersion,
    Win32::{
        Foundation::{CloseHandle, FILETIME, HANDLE, HWND, LPARAM, RECT, STILL_ACTIVE, WPARAM},
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_HARDWARE,
            Direct3D11::*,
            Dwm::{
                DwmGetWindowAttribute, DwmIsCompositionEnabled, DWMWA_CLOAKED,
                DWMWA_EXTENDED_FRAME_BOUNDS,
            },
            Dxgi::IDXGIDevice,
            Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
        },
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_MULTITHREADED,
            },
            Performance::{QueryPerformanceCounter, QueryPerformanceFrequency},
            SystemInformation::OSVERSIONINFOW,
            Threading::{
                GetCurrentThreadId, GetExitCodeProcess, GetProcessTimes, OpenProcess,
                QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
            },
            WinRT::{
                Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
                Graphics::Capture::IGraphicsCaptureItemInterop,
            },
        },
        UI::{
            Accessibility::*,
            HiDpi::{
                GetDpiForWindow, SetThreadDpiAwarenessContext,
                DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            },
            WindowsAndMessaging::*,
        },
    },
};

const SCORE: &str = "windows:wgc:rgb16-tile32-v1";
const FRAME: u32 = WM_APP + 1;
const CLOSED: u32 = WM_APP + 2;
const EVENT: u32 = WM_APP + 3;
const AX_NODES: usize = 300;
const AX_TEXT: usize = 128 * 1024;
const AX_WAIT_MS: u32 = 100;
const AX_BUDGET: Duration = Duration::from_millis(50);

struct Worker {
    stop: Arc<AtomicBool>,
    stopped: Arc<Cancellation>,
    generation: Arc<AtomicU64>,
    thread: std::thread::JoinHandle<Result<(), String>>,
}
pub struct Backend {
    lens: Weak<Lens>,
    worker: Mutex<Option<Worker>>,
    operation: tokio::sync::Mutex<()>,
    closing: Arc<AtomicBool>,
    ordinal: Arc<AtomicU32>,
}
impl Backend {
    /// Setup only. Consent and demand must enter through the shared dispatcher.
    pub fn attach(_app: &tauri::AppHandle, lens: Weak<Lens>) -> Arc<Self> {
        Arc::new(Self {
            lens,
            worker: Mutex::new(None),
            operation: tokio::sync::Mutex::new(()),
            closing: Arc::new(AtomicBool::new(false)),
            ordinal: Arc::new(AtomicU32::new(1)),
        })
    }
    /// The generation belongs to the control which authorized this start.
    pub async fn start(
        &self,
        expected: u64,
        cancellation: Arc<Cancellation>,
    ) -> Result<(), String> {
        let _operation = self.operation.lock().await;
        self.close().await?;
        if cancellation.is_cancelled() {
            return Err("cancelled".into());
        }
        let lens = self.lens.upgrade().ok_or("unavailable")?;
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Cancellation::new();
        let generation = Arc::new(AtomicU64::new(expected));
        let (ready, receipt) = tokio::sync::oneshot::channel();
        let runtime = tokio::runtime::Handle::current();
        let stopping = stop.clone();
        let owner = generation.clone();
        let ordinal = self.ordinal.clone();
        let request = cancellation.clone();
        let thread = std::thread::Builder::new()
            .name("lens-wgc".into())
            .spawn(move || {
                let mut ready = Some(ready);
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run(
                        &lens, &stopping, &owner, &ordinal, &request, &runtime, &mut ready,
                    )
                }))
                .unwrap_or_else(|_| Err("capture-teardown:worker-panic".into()));
                if let Err(reason) = &result {
                    if !stopping.swap(true, Ordering::AcqRel) || native_cleanup_failed(reason) {
                        if let Some(next) =
                            lens.invalidate_source(owner.load(Ordering::Acquire), reason)
                        {
                            owner.store(next, Ordering::Release);
                        }
                    }
                    if let Some(ready) = ready.take() {
                        let _ = ready.send(Err(reason.clone()));
                    }
                }
                result
            })
            .map_err(|_| "unavailable")?;
        *self.worker.lock().unwrap() = Some(Worker {
            stop,
            stopped: stopped.clone(),
            generation,
            thread,
        });
        let (result, invalidate) = tokio::select! { biased;
            _ = cancellation.cancelled() => (Err("cancelled".into()),true),
            _ = stopped.cancelled() => (Err("cancelled".into()),false),
            result = tokio::time::timeout(Duration::from_secs(5), receipt) => match result {
                Ok(Ok(result)) => (result,false),
                _ => (Err("capture-timeout".into()),true),
            },
        };
        if let Err(reason) = &result {
            if invalidate {
                self.invalidate(reason);
            } else {
                self.cancel();
            }
            self.close().await?;
        }
        result
    }
    /// Never waits for capture, UIA, OCR or a native queue. Call before Stop ACK.
    /// Does not enter LensState; safe for its synchronous control boundary.
    pub fn cancel(&self) {
        let worker = self.worker.lock().unwrap();
        if let Some(worker) = worker.as_ref() {
            worker.stop.store(true, Ordering::Release);
            worker.stopped.cancel();
            worker.thread.thread().unpark();
        }
    }
    pub fn invalidate(&self, reason: &str) {
        self.cancel();
        let owner = self
            .worker
            .lock()
            .unwrap()
            .as_ref()
            .map(|worker| worker.generation.clone());
        if let (Some(lens), Some(owner)) = (self.lens.upgrade(), owner) {
            if let Some(next) = lens.invalidate_source(owner.load(Ordering::Acquire), reason) {
                owner.store(next, Ordering::Release);
            }
        }
    }
    pub async fn stop(&self) -> Result<(), String> {
        self.invalidate("stopped");
        let _operation = self.operation.lock().await;
        self.close().await
    }
    async fn close(&self) -> Result<(), String> {
        if self.closing.load(Ordering::Acquire) {
            return Err("capture-closing".into());
        }
        let worker = self.worker.lock().unwrap().take();
        let Some(worker) = worker else {
            return Ok(());
        };
        worker.stop.store(true, Ordering::Release);
        worker.stopped.cancel();
        self.closing.store(true, Ordering::Release);
        let closing = self.closing.clone();
        let join = tokio::task::spawn_blocking(move || {
            let result = worker.thread.join();
            let proved = match &result {
                Ok(Err(reason)) => !native_cleanup_failed(reason),
                Ok(Ok(())) => true,
                Err(_) => false,
            };
            closing.store(!proved, Ordering::Release);
            result
        });
        match tokio::time::timeout(Duration::from_secs(2), join).await {
            Ok(Ok(Ok(Err(reason)))) if native_cleanup_failed(&reason) => Err(reason),
            Ok(Ok(Ok(_))) => Ok(()),
            Ok(_) => Err("capture-teardown".into()),
            Err(_) => Err("capture-teardown-timeout".into()),
        }
    }
}
fn native_cleanup_failed(reason: &str) -> bool {
    reason.starts_with("capture-teardown") || reason.starts_with("observer-teardown")
}

struct Process(HANDLE);
impl Drop for Process {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
struct Pin {
    hwnd: HWND,
    process: Process,
    pid: u32,
    created: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Placement {
    bounds: [i32; 4],
    dpi: u32,
    monitor: usize,
}
struct GeometryToken {
    placement: Placement,
    size: [u32; 2],
    since: i64,
}
impl GeometryToken {
    fn accepts(&self, timestamp: i64, size: [u32; 2], before: Placement, after: Placement) -> bool {
        timestamp >= self.since
            && size == self.size
            && before == self.placement
            && after == self.placement
    }
    fn geometry(&self) -> Result<FrameGeometry, String> {
        // shortcut: WGC has sample-local ContentSize/QPC, but no capture-time
        // HWND bounds/DPI timeline. Current DWM bounds and asynchronous WinEvents
        // cannot prove the association. Refuse before granting or publishing.
        Err("capture-time-geometry-unavailable".into())
    }
}
fn creation(process: HANDLE) -> Result<u64, String> {
    let (mut created, mut exited, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) }
        .map_err(|_| "process-unavailable")?;
    Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}
impl Pin {
    fn new(hwnd: HWND) -> Result<Self, String> {
        let pin = Self::open(hwnd)?;
        pin.check()?;
        Ok(pin)
    }
    fn open(hwnd: HWND) -> Result<Self, String> {
        let mut pid = 0;
        if unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) } == 0
            || pid == 0
            || pid > i32::MAX as u32
        {
            return Err("window-unavailable".into());
        }
        let process = Process(
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
                .map_err(|_| "process-unavailable")?,
        );
        let created = creation(process.0)?;
        Ok(Self {
            hwnd,
            process,
            pid,
            created,
        })
    }
    fn identity(&self) -> Result<(), String> {
        let mut pid = 0;
        unsafe {
            if !IsWindow(Some(self.hwnd)).as_bool()
                || GetWindowThreadProcessId(self.hwnd, Some(&mut pid)) == 0
                || pid != self.pid
                || creation(self.process.0)? != self.created
            {
                return Err("window-destroyed".into());
            }
            let mut code = 0;
            if GetExitCodeProcess(self.process.0, &mut code).is_err()
                || code != STILL_ACTIVE.0 as u32
            {
                return Err("window-destroyed".into());
            }
        }
        Ok(())
    }
    fn check(&self) -> Result<Placement, String> {
        if !crate::remote_session::active() {
            return Err("locked".into());
        }
        self.identity()?;
        unsafe {
            if IsIconic(self.hwnd).as_bool() || !IsWindowVisible(self.hwnd).as_bool() {
                return Err("window-minimized".into());
            }
            let mut cloaked = 0u32;
            DwmGetWindowAttribute(
                self.hwnd,
                DWMWA_CLOAKED,
                (&mut cloaked as *mut u32).cast(),
                4,
            )
            .map_err(|_| "window-unavailable")?;
            if cloaked != 0 {
                return Err("window-cloaked".into());
            }
            let mut affinity = 0;
            let read = GetWindowDisplayAffinity(self.hwnd, &mut affinity);
            if (read.is_ok() && affinity != WDA_NONE.0)
                || (read.is_err()
                    && GetWindowLongPtrW(self.hwnd, GWL_EXSTYLE) & WS_EX_LAYERED.0 as isize != 0)
            {
                return Err("window-protected".into());
            }
            let mut rect = RECT::default();
            DwmGetWindowAttribute(
                self.hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                (&mut rect as *mut RECT).cast(),
                std::mem::size_of::<RECT>() as u32,
            )
            .map_err(|_| "geometry-unavailable")?;
            let dpi = GetDpiForWindow(self.hwnd);
            let monitor = MonitorFromWindow(self.hwnd, MONITOR_DEFAULTTONEAREST).0 as usize;
            if rect.right <= rect.left || rect.bottom <= rect.top || dpi == 0 || monitor == 0 {
                return Err("geometry-unavailable".into());
            }
            Ok(Placement {
                bounds: [
                    rect.left,
                    rect.top,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                ],
                dpi,
                monitor,
            })
        }
    }
    fn target(&self, placement: Placement, ordinal: u32) -> Result<(Target, Rect), String> {
        let mut path = [0u16; 32768];
        let mut len = path.len() as u32;
        unsafe {
            QueryFullProcessImageNameW(
                self.process.0,
                PROCESS_NAME_WIN32,
                PWSTR(path.as_mut_ptr()),
                &mut len,
            )
        }
        .map_err(|_| "process-unavailable")?;
        let path = String::from_utf16_lossy(&path[..len as usize]);
        let name = std::path::Path::new(&path)
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("Application")
            .to_owned();
        let mut title = [0u16; 2048];
        let n = unsafe { GetWindowTextW(self.hwnd, &mut title) }.max(0) as usize;
        let mut monitor = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !unsafe {
            GetMonitorInfoW(
                windows::Win32::Graphics::Gdi::HMONITOR(placement.monitor as *mut _),
                &mut monitor,
            )
        }
        .as_bool()
        {
            return Err("geometry-unavailable".into());
        }
        let [x, y, w, h] = placement.bounds;
        Ok((
            Target {
                pid: self.pid as i32,
                bundle: name.to_lowercase(),
                name,
                window_id: ordinal,
                title: String::from_utf16_lossy(&title[..n]),
                bounds: [x as f64, y as f64, w as f64, h as f64],
                url: None,
                display: DisplayInfo {
                    id: 1,
                    w: (monitor.rcMonitor.right - monitor.rcMonitor.left) as f64,
                    h: (monitor.rcMonitor.bottom - monitor.rcMonitor.top) as f64,
                    scale: 1.0,
                },
            },
            [
                monitor.rcMonitor.left as f64,
                monitor.rcMonitor.top as f64,
                (monitor.rcMonitor.right - monitor.rcMonitor.left) as f64,
                (monitor.rcMonitor.bottom - monitor.rcMonitor.top) as f64,
            ],
        ))
    }
}

fn qpc_time() -> Result<i64, String> {
    let (mut count, mut frequency) = (0, 0);
    unsafe {
        QueryPerformanceCounter(&mut count).and_then(|_| QueryPerformanceFrequency(&mut frequency))
    }
    .map_err(|_| "clock-unavailable")?;
    if frequency <= 0 {
        return Err("clock-unavailable".into());
    }
    i64::try_from(i128::from(count) * 10_000_000 / i128::from(frequency))
        .map_err(|_| "clock-unavailable".into())
}
struct Apartment;
impl Apartment {
    fn new() -> Result<Self, String> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|_| "provider-unavailable")?;
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
struct DpiContext(windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT);
impl DpiContext {
    fn physical() -> Result<Self, String> {
        let old =
            unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        if old.0.is_null() {
            Err("geometry-unavailable".into())
        } else {
            Ok(Self(old))
        }
    }
}
impl Drop for DpiContext {
    fn drop(&mut self) {
        unsafe {
            SetThreadDpiAwarenessContext(self.0);
        }
    }
}
struct Hooks(Vec<HWINEVENTHOOK>);
impl Hooks {
    fn close(&mut self) -> Result<(), String> {
        let mut removed = true;
        for hook in self.0.drain(..) {
            removed &= unsafe { UnhookWinEvent(hook) }.as_bool();
        }
        if removed {
            Ok(())
        } else {
            Err("observer-teardown".into())
        }
    }
}
impl Drop for Hooks {
    fn drop(&mut self) {
        for hook in &self.0 {
            unsafe {
                let _ = UnhookWinEvent(*hook);
            }
        }
    }
}
unsafe extern "system" fn native_event(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object: i32,
    _child: i32,
    _thread: u32,
    _at: u32,
) {
    if object == 0 || event == EVENT_SYSTEM_FOREGROUND || event == EVENT_SYSTEM_MINIMIZESTART {
        // Out-of-context hooks execute on this Lens-owned message thread.
        let _ = unsafe {
            PostThreadMessageW(
                GetCurrentThreadId(),
                EVENT,
                WPARAM(hwnd.0 as usize),
                LPARAM(event as isize),
            )
        };
    }
}
fn hooks() -> Result<Hooks, String> {
    let mut hooks = Hooks(vec![]);
    for event in [
        EVENT_OBJECT_DESTROY,
        EVENT_SYSTEM_FOREGROUND,
        EVENT_SYSTEM_MINIMIZESTART,
        EVENT_OBJECT_LOCATIONCHANGE,
    ] {
        let hook = unsafe {
            SetWinEventHook(
                event,
                event,
                None,
                Some(native_event),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            )
        };
        if hook.0.is_null() {
            hooks.close()?;
            return Err("observer-unavailable".into());
        }
        hooks.0.push(hook);
    }
    Ok(hooks)
}
fn drain_events(hwnd: HWND, identity: u32) -> Result<bool, String> {
    let mut message = MSG::default();
    let mut frame = false;
    while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
        match message.message {
            CLOSED if message.wParam.0 == identity as usize => {
                return Err("window-destroyed".into())
            }
            EVENT => {
                let event = message.lParam.0 as u32;
                if (event == EVENT_SYSTEM_FOREGROUND && message.wParam.0 != hwnd.0 as usize)
                    || message.wParam.0 == hwnd.0 as usize
                {
                    return Err(if event == EVENT_OBJECT_DESTROY {
                        "window-destroyed"
                    } else {
                        "geometry-changed"
                    }
                    .into());
                }
            }
            FRAME if message.wParam.0 == identity as usize => frame = true,
            _ => unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            },
        }
    }
    Ok(frame)
}
struct Capture {
    pool: Direct3D11CaptureFramePool,
    session: Option<GraphicsCaptureSession>,
    item: GraphicsCaptureItem,
    frame_event: Option<i64>,
    closed_event: Option<i64>,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    callbacks: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
}
#[cfg(test)]
type InitFault<'a> = &'a mut dyn FnMut(&Capture, u8) -> windows::core::Result<()>;
impl Drop for Capture {
    fn drop(&mut self) {
        // Also close on a panic: late callbacks must never address a reused
        // native thread ID. Normal shutdown verifies each operation explicitly.
        self.callbacks.store(false, Ordering::Release);
        let _ = self.close();
    }
}
impl Capture {
    fn new(hwnd: HWND, size: [u32; 2], thread: u32, identity: u32) -> Result<Self, String> {
        #[cfg(not(test))]
        {
            Self::new_inner(hwnd, size, thread, identity)
        }
        #[cfg(test)]
        {
            Self::new_inner(hwnd, size, thread, identity, None)
        }
    }
    fn new_inner(
        hwnd: HWND,
        size: [u32; 2],
        thread: u32,
        identity: u32,
        #[cfg(test)] mut fault: Option<InitFault<'_>>,
    ) -> Result<Self, String> {
        let result = (|| -> windows::core::Result<Self> {
            unsafe {
                if !GraphicsCaptureSession::IsSupported()? {
                    return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                        0x80004001u32 as i32,
                    )));
                }
                let (mut device, mut context) = (None, None);
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_HARDWARE,
                    windows::Win32::Foundation::HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                )?;
                let device = device.ok_or_else(windows::core::Error::from_win32)?;
                let context = context.ok_or_else(windows::core::Error::from_win32)?;
                let dxgi: IDXGIDevice = device.cast()?;
                let winrt: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)?.cast()?;
                let interop: IGraphicsCaptureItemInterop =
                    factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
                let item: GraphicsCaptureItem = interop.CreateForWindow(hwnd)?;
                let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
                    &winrt,
                    DirectXPixelFormat::B8G8R8A8UIntNormalized,
                    2,
                    windows::Graphics::SizeInt32 {
                        Width: size[0] as i32,
                        Height: size[1] as i32,
                    },
                )?;
                let callbacks = Arc::new(AtomicBool::new(true));
                let closed = Arc::new(AtomicBool::new(false));
                Ok(Self {
                    pool,
                    session: None,
                    item,
                    frame_event: None,
                    closed_event: None,
                    device,
                    context,
                    callbacks,
                    closed,
                })
            }
        })();
        let mut capture = result
            .map_err(|error| format!("capture-unavailable:{:#010x}", error.code().0 as u32))?;
        // The Drop guard exists before the first event is installed. Every
        // partial failure runs the same verified cleanup as a started session.
        let initialized = (|| -> windows::core::Result<()> {
            unsafe {
                let active = capture.callbacks.clone();
                capture.frame_event = Some(capture.pool.FrameArrived(&TypedEventHandler::new(
                    move |_, _| {
                        if active.load(Ordering::Acquire) {
                            let _ = PostThreadMessageW(
                                thread,
                                FRAME,
                                WPARAM(identity as usize),
                                LPARAM(0),
                            );
                        }
                        Ok(())
                    },
                ))?);
                #[cfg(test)]
                if let Some(fault) = fault.as_mut() {
                    fault(&capture, 1)?;
                }
                let active = capture.callbacks.clone();
                let destroyed = capture.closed.clone();
                capture.closed_event =
                    Some(capture.item.Closed(&TypedEventHandler::new(move |_, _| {
                        destroyed.store(true, Ordering::Release);
                        if active.load(Ordering::Acquire) {
                            let _ = PostThreadMessageW(
                                thread,
                                CLOSED,
                                WPARAM(identity as usize),
                                LPARAM(0),
                            );
                        }
                        Ok(())
                    }))?);
                #[cfg(test)]
                if let Some(fault) = fault.as_mut() {
                    fault(&capture, 2)?;
                }
                capture.session = Some(capture.pool.CreateCaptureSession(&capture.item)?);
                #[cfg(test)]
                if let Some(fault) = fault.as_mut() {
                    fault(&capture, 3)?;
                }
                capture.session.as_ref().unwrap().StartCapture()?;
                #[cfg(test)]
                if let Some(fault) = fault.as_mut() {
                    fault(&capture, 4)?;
                }
                Ok(())
            }
        })();
        if let Err(error) = initialized {
            let original = format!("capture-unavailable:{:#010x}", error.code().0 as u32);
            return match capture.close() {
                Ok(()) => Err(original),
                Err(cleanup) => Err(format!("{cleanup};{original}")),
            };
        }
        Ok(capture)
    }
    fn close(&self) -> Result<(), String> {
        self.callbacks.store(false, Ordering::Release);
        let frame = self
            .frame_event
            .map(|token| self.pool.RemoveFrameArrived(token))
            .unwrap_or(Ok(()));
        let closed = self
            .closed_event
            .map(|token| self.item.RemoveClosed(token))
            .unwrap_or(Ok(()));
        let session = self
            .session
            .as_ref()
            .map(|session| session.Close())
            .unwrap_or(Ok(()));
        let pool = self.pool.Close();
        let failures = [
            ("frame-event", frame),
            ("closed-event", closed),
            ("session", session),
            ("pool", pool),
        ]
        .into_iter()
        .filter_map(|(stage, result)| {
            result
                .err()
                .map(|error| format!("{stage}={:#010x}", error.code().0 as u32))
        })
        .collect::<Vec<_>>();
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!("capture-teardown:{}", failures.join(",")))
        }
    }
    fn pixels(
        &self,
        surface: &windows::Graphics::DirectX::Direct3D11::IDirect3DSurface,
        size: [u32; 2],
    ) -> Result<Arc<[u8]>, String> {
        let result = (|| -> windows::core::Result<Arc<[u8]>> {
            unsafe {
                let access: IDirect3DDxgiInterfaceAccess = surface.cast()?;
                let texture: ID3D11Texture2D = access.GetInterface()?;
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                texture.GetDesc(&mut desc);
                if desc.Width < size[0] || desc.Height < size[1] {
                    return Err(windows::core::Error::from_win32());
                }
                desc.Width = size[0];
                desc.Height = size[1];
                desc.Usage = D3D11_USAGE_STAGING;
                desc.BindFlags = 0;
                desc.MiscFlags = 0;
                desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                let mut staging = None;
                self.device
                    .CreateTexture2D(&desc, None, Some(&mut staging))?;
                let staging = staging.ok_or_else(windows::core::Error::from_win32)?;
                let region = D3D11_BOX {
                    left: 0,
                    top: 0,
                    front: 0,
                    right: size[0],
                    bottom: size[1],
                    back: 1,
                };
                self.context.CopySubresourceRegion(
                    &staging,
                    0,
                    0,
                    0,
                    0,
                    &texture,
                    0,
                    Some(&region),
                );
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                self.context
                    .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
                let result = pack(mapped.pData.cast(), mapped.RowPitch as usize, size);
                self.context.Unmap(&staging, 0);
                result.map_err(|_| windows::core::Error::from_win32())
            }
        })();
        result.map_err(|_| "capture-buffer".into())
    }
}
unsafe fn pack(data: *const u8, stride: usize, [w, h]: [u32; 2]) -> Result<Arc<[u8]>, String> {
    let bytes = u64::from(w)
        .checked_mul(u64::from(h))
        .and_then(|n| n.checked_mul(4))
        .filter(|n| *n <= super::ocr::PIXEL_CAP as u64)
        .ok_or("capture-buffer")?;
    let row = (w as usize).checked_mul(4).ok_or("capture-buffer")?;
    if data.is_null()
        || stride < row
        || w == 0
        || h == 0
        || stride.checked_mul(h as usize).is_none()
    {
        return Err("capture-buffer".into());
    }
    let mut pixels = Vec::with_capacity(bytes as usize);
    for y in 0..h as usize {
        pixels.extend_from_slice(unsafe { std::slice::from_raw_parts(data.add(y * stride), row) });
    }
    Ok(pixels.into())
}

fn associated(
    root: &IUIAutomationElement,
    pin: &Pin,
    budget: &AxBudget<'_>,
) -> windows::core::Result<bool> {
    unsafe {
        Ok(budget.read(|| root.CurrentProcessId())? == pin.pid as i32
            && budget.read(|| root.CurrentNativeWindowHandle())? == pin.hwnd)
    }
}
fn sensitive(password: bool, metadata: &str) -> bool {
    let metadata = metadata.to_ascii_lowercase();
    password
        || [
            "password",
            "passwd",
            "secret",
            "token",
            "creditcard",
            "cardnumber",
            "securitycode",
            "ssn",
            "credential",
            "privatekey",
            "cvv",
            "cvc",
        ]
        .iter()
        .any(|key| metadata.contains(key))
}
struct AxBudget<'a> {
    stop: &'a AtomicBool,
    started: Instant,
}
impl AxBudget<'_> {
    fn read<T>(&self, call: impl FnOnce() -> windows::core::Result<T>) -> windows::core::Result<T> {
        self.check()?;
        let value = call()?;
        self.check()?;
        Ok(value)
    }
    fn check(&self) -> windows::core::Result<()> {
        if self.stop.load(Ordering::Acquire) || self.started.elapsed() >= AX_BUDGET {
            return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                0x80004004u32 as i32,
            )));
        }
        Ok(())
    }
}
fn ax(pin: &Pin, placement: Placement, stop: &AtomicBool) -> Result<Vec<Line>, String> {
    let result = (|| -> windows::core::Result<Vec<Line>> {
        unsafe {
            let automation: IUIAutomation2 =
                CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)?;
            automation.SetConnectionTimeout(AX_WAIT_MS)?;
            automation.SetTransactionTimeout(AX_WAIT_MS)?;
            let budget = AxBudget {
                stop,
                started: Instant::now(),
            };
            let root = budget.read(|| automation.ElementFromHandle(pin.hwnd))?;
            if !associated(&root, pin, &budget)? || pin.check().ok() != Some(placement) {
                return Err(windows::core::Error::from_win32());
            }
            let walker = budget.read(|| automation.ControlViewWalker())?;
            let mut nodes = vec![root.clone()];
            let mut lines = vec![];
            let mut bytes = 0;
            let mut visited = 0;
            while let Some(node) = nodes.pop() {
                budget.check()?;
                if visited == AX_NODES {
                    return Err(windows::core::Error::from_win32());
                }
                visited += 1;
                if node != root {
                    if let Ok(sibling) = budget.read(|| walker.GetNextSiblingElement(&node)) {
                        nodes.push(sibling);
                    }
                }
                let password = budget.read(|| node.CurrentIsPassword())?.as_bool();
                let id = budget.read(|| node.CurrentAutomationId())?;
                let class = budget.read(|| node.CurrentClassName())?;
                if id.len() > 4096 || class.len() > 4096 {
                    return Err(windows::core::Error::from_win32());
                }
                let metadata = format!("{id} {class}");
                if sensitive(password, &metadata) {
                    continue;
                }
                if budget.read(|| node.CurrentProcessId())? != pin.pid as i32 {
                    continue;
                }
                let rect = budget.read(|| node.CurrentBoundingRectangle())?;
                let bbox = [
                    f64::from(rect.left - placement.bounds[0]),
                    f64::from(rect.top - placement.bounds[1]),
                    f64::from(rect.right - rect.left),
                    f64::from(rect.bottom - rect.top),
                ];
                let role = budget.read(|| node.CurrentControlType())?;
                if [
                    UIA_TextControlTypeId,
                    UIA_EditControlTypeId,
                    UIA_ButtonControlTypeId,
                    UIA_DocumentControlTypeId,
                ]
                .contains(&role)
                {
                    let name = budget.read(|| node.CurrentName())?;
                    if name.len() > AX_TEXT / 3 {
                        return Err(windows::core::Error::from_win32());
                    }
                    let text = name.to_string();
                    if !text.is_empty() && !sensitive(false, &text) {
                        bytes += text.len();
                        if bytes > AX_TEXT {
                            return Err(windows::core::Error::from_win32());
                        }
                        if let Some(bbox) = super::geometry::intersect(
                            bbox,
                            [
                                0.0,
                                0.0,
                                placement.bounds[2] as f64,
                                placement.bounds[3] as f64,
                            ],
                        ) {
                            lines.push(Line {
                                bbox,
                                text,
                                conf: None,
                            });
                        }
                    }
                }
                if let Ok(child) = budget.read(|| walker.GetFirstChildElement(&node)) {
                    nodes.push(child);
                }
            }
            if !associated(&root, pin, &budget)? || pin.check().ok() != Some(placement) {
                return Err(windows::core::Error::from_win32());
            }
            Ok(lines)
        }
    })();
    result.map_err(|_| "ax-unavailable".into())
}

fn run(
    lens: &Arc<Lens>,
    stop: &AtomicBool,
    owner: &AtomicU64,
    ordinal: &AtomicU32,
    cancellation: &Cancellation,
    runtime: &tokio::runtime::Handle,
    ready: &mut Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
) -> Result<(), String> {
    let _apartment = Apartment::new()?;
    let _dpi = DpiContext::physical()?;
    run_capture(lens, stop, owner, ordinal, cancellation, runtime, ready)
}
fn run_capture(
    lens: &Arc<Lens>,
    stop: &AtomicBool,
    owner: &AtomicU64,
    ordinal: &AtomicU32,
    cancellation: &Cancellation,
    runtime: &tokio::runtime::Handle,
    ready: &mut Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
) -> Result<(), String> {
    // Create/pump the native queue and install destruction observation before
    // selecting or pinning a HWND. PID/process creation alone cannot distinguish
    // same-process HWND recycling. Out-of-context events are still asynchronous;
    // observing none never upgrades the strict capture-time proof gate.
    let mut message = MSG::default();
    unsafe {
        let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
    }
    let mut hooks = hooks()?;
    let result = run_observed_capture(lens, stop, owner, ordinal, cancellation, runtime, ready);
    match hooks.close() {
        Ok(()) => result,
        Err(cleanup) => Err(match result {
            Ok(()) => cleanup,
            Err(original) => format!("{cleanup};{original}"),
        }),
    }
}
fn run_observed_capture(
    lens: &Arc<Lens>,
    stop: &AtomicBool,
    owner: &AtomicU64,
    ordinal: &AtomicU32,
    cancellation: &Cancellation,
    runtime: &tokio::runtime::Handle,
    ready: &mut Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
) -> Result<(), String> {
    let hwnd = unsafe { GetForegroundWindow() };
    let pin = Pin::new(hwnd)?;
    let placement = pin.check()?;
    let size = [placement.bounds[2] as u32, placement.bounds[3] as u32];
    if u64::from(size[0]) * u64::from(size[1]) * 4 > super::ocr::PIXEL_CAP as u64 {
        return Err("too-large".into());
    }
    let identity = ordinal
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_add(1))
        .map_err(|_| "source-limit")?;
    let (target, display_bounds) = pin.target(placement, identity)?;
    let thread = unsafe { GetCurrentThreadId() };
    let _ = drain_events(hwnd, identity)?;
    let token = GeometryToken {
        placement,
        size,
        since: qpc_time()?,
    };
    // This preparation has no approved temporal geometry association. Refuse
    // before starting native recording, including an unobservable HWND reuse.
    // Owned-window tests exercise WGC resources independently of that admission.
    let _ = token.geometry()?;
    let capture = Capture::new(hwnd, size, thread, identity)?;
    let mut lease: Option<CaptureLease> = None;
    let mut last_ax = Instant::now() - Duration::from_secs(1);
    let mut ax_available = false;
    let result = (|| -> Result<(), String> {
        loop {
            if stop.load(Ordering::Acquire)
                || cancellation.is_cancelled()
                || lens.request_generation() != owner.load(Ordering::Acquire)
            {
                return Ok(());
            }
            if capture.closed.load(Ordering::Acquire) {
                return Err("window-destroyed".into());
            }
            let frame = drain_events(hwnd, identity)?;
            let before = pin.check()?;
            if before != placement {
                return Err("geometry-changed".into());
            }
            if frame {
                while let Ok(sample) = capture.pool.TryGetNextFrame() {
                    let result = (|| -> Result<(), String> {
                        let content = sample.ContentSize().map_err(|_| "capture-unavailable")?;
                        if content.Width <= 0 || content.Height <= 0 {
                            return Err("geometry-unavailable".into());
                        }
                        let sample_size = [content.Width as u32, content.Height as u32];
                        let timestamp = sample
                            .SystemRelativeTime()
                            .map_err(|_| "clock-unavailable")?
                            .Duration;
                        if !token.accepts(timestamp, sample_size, before, pin.check()?) {
                            return Err("geometry-changed".into());
                        }
                        let _ = drain_events(hwnd, identity)?;
                        let geometry = token.geometry()?;
                        let surface = sample.Surface().map_err(|_| "capture-buffer")?;
                        let pixels = capture.pixels(&surface, sample_size)?;
                        if stop.load(Ordering::Acquire)
                            || cancellation.is_cancelled()
                            || lens.request_generation() != owner.load(Ordering::Acquire)
                        {
                            return Ok(());
                        }
                        if capture.closed.load(Ordering::Acquire) {
                            return Err("window-destroyed".into());
                        }
                        if !token.accepts(timestamp, sample_size, before, pin.check()?) {
                            return Err("geometry-changed".into());
                        }
                        if lease.is_none() {
                            let generation = runtime.block_on(lens.backend_status(
                                owner.load(Ordering::Acquire),
                                true,
                                false,
                                SCORE,
                                None,
                            ))?;
                            owner.store(generation, Ordering::Release);
                            let accepted = lens
                                .accept_target(
                                    generation,
                                    target.clone(),
                                    geometry,
                                    size,
                                    display_bounds,
                                )
                                .ok_or("cancelled")?;
                            owner.store(accepted.generation, Ordering::Release);
                            lease = Some(accepted);
                        }
                        let current = lease.as_ref().ok_or("cancelled")?;
                        let _ = lens.publish_frame(current, pixels, size, geometry);
                        if let Some(ready) = ready.take() {
                            let _ = ready.send(Ok(()));
                        }
                        Ok(())
                    })();
                    let _ = sample.Close();
                    result?;
                }
            }
            if let Some(current) = lease.as_ref() {
                if last_ax.elapsed() >= Duration::from_secs(1) {
                    last_ax = Instant::now();
                    let lines = ax(&pin, placement, stop);
                    if stop.load(Ordering::Acquire)
                        || cancellation.is_cancelled()
                        || lens.request_generation() != owner.load(Ordering::Acquire)
                    {
                        return Ok(());
                    }
                    if pin.check()? != placement || capture.closed.load(Ordering::Acquire) {
                        return Err("geometry-changed".into());
                    }
                    let _ = drain_events(hwnd, identity)?;
                    // Never leave a prior tree behind after association fails.
                    let accepted = if ax_available != lines.is_ok() {
                        let geometry = token.geometry()?;
                        let generation = runtime.block_on(lens.backend_status(
                            current.generation,
                            true,
                            lines.is_ok(),
                            SCORE,
                            None,
                        ))?;
                        owner.store(generation, Ordering::Release);
                        let accepted = lens
                            .accept_target(
                                generation,
                                target.clone(),
                                geometry,
                                size,
                                display_bounds,
                            )
                            .ok_or("cancelled")?;
                        owner.store(accepted.generation, Ordering::Release);
                        ax_available = lines.is_ok();
                        accepted
                    } else {
                        current.clone()
                    };
                    if let Ok(lines) = lines {
                        let _ = lens.publish_ax(&accepted, lines);
                    }
                    lease = Some(accepted);
                }
            }
            std::thread::park_timeout(Duration::from_millis(10));
        }
    })();
    stop.store(true, Ordering::Release);
    if let Err(reason) = &result {
        if let Some(next) = lens.invalidate_source(owner.load(Ordering::Acquire), reason) {
            owner.store(next, Ordering::Release);
        }
    }
    capture.close()?;
    result
}

/// Shared overlay pool calls these native hooks on its serialized UI queue.
pub fn exclude_overlay(hwnd: HWND) -> Result<(), String> {
    let mut version = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    if unsafe { RtlGetVersion(&mut version) }.is_err()
        || version.dwBuildNumber < 19041
        || !unsafe { DwmIsCompositionEnabled() }
            .map_err(|_| "overlay-exclusion")?
            .as_bool()
    {
        return Err("overlay-exclusion".into());
    }
    unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) }
        .map_err(|_| "overlay-exclusion")?;
    let mut affinity = 0;
    unsafe { GetWindowDisplayAffinity(hwnd, &mut affinity) }.map_err(|_| "overlay-exclusion")?;
    if affinity != WDA_EXCLUDEFROMCAPTURE.0 {
        return Err("overlay-exclusion".into());
    }
    Ok(())
}
pub fn place_overlay(hwnd: HWND, rect: Rect) -> Result<(), String> {
    if rect
        .iter()
        .any(|v| !v.is_finite() || *v < i32::MIN as f64 || *v > i32::MAX as f64)
        || rect[2] <= 0.0
        || rect[3] <= 0.0
    {
        return Err("bad-rect".into());
    }
    let [x, y, w, h] = rect.map(|v| v.round() as i32);
    if w <= 0 || h <= 0 {
        return Err("bad-rect".into());
    }
    let dpi = DpiContext::physical().map_err(|_| "overlay-position")?;
    let result = unsafe { SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, w, h, SWP_NOACTIVATE) };
    let mut actual = RECT::default();
    let read = unsafe { GetWindowRect(hwnd, &mut actual) };
    drop(dpi);
    result.and(read).map_err(|_| "overlay-position")?;
    if [
        actual.left,
        actual.top,
        actual.right - actual.left,
        actual.bottom - actual.top,
    ] != [x, y, w, h]
    {
        return Err("overlay-position".into());
    }
    exclude_overlay(hwnd)
}
pub fn hide_overlay(hwnd: HWND) -> Result<(), String> {
    unsafe {
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
    if unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return Err("overlay-hide".into());
    }
    Ok(())
}
pub fn show_overlay(hwnd: HWND) -> Result<(), String> {
    exclude_overlay(hwnd)?;
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return Err("overlay-show".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct NativeWindow(HWND);
    impl NativeWindow {
        fn new() -> Self {
            let hwnd = unsafe {
                CreateWindowExW(
                    WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                    windows::core::w!("STATIC"),
                    windows::core::w!("Lens native regression"),
                    WS_POPUP,
                    40,
                    50,
                    80,
                    60,
                    None,
                    None,
                    None,
                    None,
                )
            }
            .unwrap();
            unsafe {
                SetLayeredWindowAttributes(
                    hwnd,
                    windows::Win32::Foundation::COLORREF(0),
                    255,
                    LWA_ALPHA,
                )
            }
            .unwrap();
            Self(hwnd)
        }
    }
    impl Drop for NativeWindow {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyWindow(self.0);
            }
        }
    }
    fn placement() -> Placement {
        Placement {
            bounds: [-1920, 40, 640, 480],
            dpi: 144,
            monitor: 2,
        }
    }
    #[test]
    fn delayed_frames_never_acquire_new_geometry_or_dpi() {
        let p = placement();
        let token = GeometryToken {
            placement: p,
            size: [640, 480],
            since: 500,
        };
        assert!(token.accepts(500, [640, 480], p, p));
        assert!(!token.accepts(499, [640, 480], p, p));
        assert!(!token.accepts(501, [641, 480], p, p));
        let mut moved = p;
        moved.bounds[0] += 1;
        assert!(!token.accepts(501, [640, 480], p, moved));
        let mut dpi = p;
        dpi.dpi = 96;
        assert!(!token.accepts(501, [640, 480], dpi, dpi));
        let replacement = GeometryToken {
            since: 700,
            ..token
        };
        assert!(!replacement.accepts(699, [640, 480], p, p));
        assert_eq!(
            replacement.geometry().unwrap_err(),
            "capture-time-geometry-unavailable"
        );
    }
    #[test]
    fn pixel_copy_omits_row_padding_and_refuses_overflow() {
        let bytes = [1u8, 2, 3, 4, 99, 99, 5, 6, 7, 8, 99, 99];
        assert_eq!(
            &*unsafe { pack(bytes.as_ptr(), 6, [1, 2]) }.unwrap(),
            &[1, 2, 3, 4, 5, 6, 7, 8]
        );
        assert!(unsafe { pack(bytes.as_ptr(), 3, [1, 2]) }.is_err());
        assert!(unsafe { pack(bytes.as_ptr(), 6, [u32::MAX, u32::MAX]) }.is_err());
    }
    #[test]
    fn sensitive_metadata_is_filtered_before_text_reads() {
        assert!(sensitive(true, "ordinary"));
        assert!(sensitive(false, "ApiToken SecretInput"));
        assert!(sensitive(false, "CreditCardNumber"));
        assert!(!sensitive(false, "DocumentBody TextBlock"));
    }
    #[test]
    fn invalid_overlay_geometry_cannot_reach_native_placement() {
        assert_eq!(
            place_overlay(HWND::default(), [f64::NAN, 0.0, 20.0, 20.0]),
            Err("bad-rect".into())
        );
        assert_eq!(
            place_overlay(HWND::default(), [0.0, 0.0, 0.0, 20.0]),
            Err("bad-rect".into())
        );
        assert_eq!(
            place_overlay(HWND::default(), [0.0, 0.0, 0.1, 20.0]),
            Err("bad-rect".into())
        );
    }
    #[test]
    fn actual_hwnd_pid_creation_and_destroy_are_independent_identity_gates() {
        let mut window = NativeWindow::new();
        let mut pin = Pin::open(window.0).unwrap();
        pin.identity().unwrap();
        pin.pid ^= 1;
        assert_eq!(pin.identity(), Err("window-destroyed".into()));
        pin.pid ^= 1;
        pin.created ^= 1;
        assert_eq!(pin.identity(), Err("window-destroyed".into()));
        pin.created ^= 1;
        pin.identity().unwrap();
        unsafe { DestroyWindow(window.0) }.unwrap();
        window.0 = HWND::default();
        assert_eq!(pin.identity(), Err("window-destroyed".into()));
    }
    #[test]
    fn initialization_destruction_observation_precedes_pid_creation_admission() {
        let mut message = MSG::default();
        unsafe {
            let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
        }
        let mut observer = hooks().unwrap();
        let window = NativeWindow::new();
        // A delayed destroy notification for a recycled handle must refuse even
        // when the current handle, PID and process creation all match a live HWND.
        unsafe {
            NotifyWinEvent(EVENT_OBJECT_DESTROY, window.0, 0, 0);
        }
        let pin = Pin::open(window.0).unwrap();
        pin.identity().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let rejected = loop {
            if let Err(reason) = drain_events(window.0, u32::MAX) {
                break reason;
            }
            assert!(
                Instant::now() < deadline,
                "native destruction observer did not deliver"
            );
            std::thread::sleep(Duration::from_millis(1));
        };
        assert_eq!(rejected, "window-destroyed");
        pin.identity().unwrap();
        observer.close().unwrap();
    }
    struct WgcWitness {
        pool: Direct3D11CaptureFramePool,
        item: GraphicsCaptureItem,
        session: Option<GraphicsCaptureSession>,
        callbacks: Arc<AtomicBool>,
        closed: Arc<AtomicBool>,
        device: IDirect3DDevice,
    }
    impl WgcWitness {
        fn acquired(capture: &Capture) -> Self {
            let dxgi: IDXGIDevice = capture.device.cast().unwrap();
            let device: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
                .unwrap()
                .cast()
                .unwrap();
            Self {
                pool: capture.pool.clone(),
                item: capture.item.clone(),
                session: capture.session.clone(),
                callbacks: capture.callbacks.clone(),
                closed: capture.closed.clone(),
                device,
            }
        }
        fn assert_native_cleanup(&self, window: &mut NativeWindow) {
            assert!(
                !self.callbacks.load(Ordering::Acquire),
                "callback publication remained enabled"
            );
            // Retain the actual COM resources so dropping Capture cannot conceal
            // an omitted native Close. A still-open pool can recreate, and a
            // still-open session can start on this still-live owned window.
            let recreated = self.pool.Recreate(
                &self.device,
                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                2,
                windows::Graphics::SizeInt32 {
                    Width: 80,
                    Height: 60,
                },
            );
            assert_eq!(
                recreated.unwrap_err().code(),
                windows::Win32::Foundation::RO_E_CLOSED,
                "native frame pool did not prove closed"
            );
            if let Some(session) = &self.session {
                assert!(
                    session.StartCapture().unwrap_err().code()
                        == windows::Win32::Foundation::RO_E_CLOSED,
                    "native capture session did not prove closed"
                );
            }
            let delivered = Arc::new(AtomicBool::new(false));
            let observed = delivered.clone();
            let token = self
                .item
                .Closed(&TypedEventHandler::new(move |_, _| {
                    observed.store(true, Ordering::Release);
                    Ok(())
                }))
                .unwrap();
            unsafe { DestroyWindow(window.0) }.unwrap();
            window.0 = HWND::default();
            let deadline = Instant::now() + Duration::from_secs(2);
            while !delivered.load(Ordering::Acquire) && Instant::now() < deadline {
                let mut message = MSG::default();
                while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
                    unsafe {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            assert!(
                delivered.load(Ordering::Acquire),
                "WGC owned-window Closed control event was not delivered"
            );
            assert!(
                !self.closed.load(Ordering::Acquire),
                "removed native Closed delegate was still subscribed"
            );
            self.item.RemoveClosed(token).unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            while Arc::strong_count(&self.callbacks) > 1 && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(1));
            }
            assert_eq!(
                Arc::strong_count(&self.callbacks),
                1,
                "native event delegates retained callback state after cleanup"
            );
        }
    }
    #[test]
    fn real_wgc_partial_initialization_closes_native_resources_and_removes_events() {
        let _apartment = Apartment::new().unwrap();
        let _dpi = DpiContext::physical().unwrap();
        let mut message = MSG::default();
        unsafe {
            let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
        }
        let thread = unsafe { GetCurrentThreadId() };
        for stage in 1u8..=4 {
            let mut window = NativeWindow::new();
            unsafe {
                let _ = ShowWindow(window.0, SW_SHOWNOACTIVATE);
            }
            let mut witness = None;
            let mut injected = |capture: &Capture, acquired| {
                if acquired == stage {
                    witness = Some(WgcWitness::acquired(capture));
                    return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                        0x80004004u32 as i32,
                    )));
                }
                Ok(())
            };
            let result = Capture::new_inner(
                window.0,
                [80, 60],
                thread,
                u32::from(stage),
                Some(&mut injected),
            );
            let failure = match result {
                Err(reason) => reason,
                Ok(_) => panic!("native initialization fault was not exercised"),
            };
            let witness = witness.unwrap_or_else(|| {
                panic!(
                    "WGC fixture unavailable before stage {stage} on this Windows host: {failure}"
                )
            });
            assert!(
                failure.contains("capture-unavailable:0x80004004"),
                "original native initialization failure was lost: {failure}"
            );
            assert!(
                !native_cleanup_failed(&failure),
                "native cleanup could not be verified: {failure}"
            );
            witness.assert_native_cleanup(&mut window);
        }
        let mut window = NativeWindow::new();
        unsafe {
            let _ = ShowWindow(window.0, SW_SHOWNOACTIVATE);
        }
        let capture = Capture::new(window.0, [80, 60], thread, 5).unwrap_or_else(|reason| {
            panic!("WGC fixture unavailable on this Windows host: {reason}")
        });
        let witness = WgcWitness::acquired(&capture);
        capture.close().unwrap();
        drop(capture);
        witness.assert_native_cleanup(&mut window);
    }
    #[test]
    fn actual_overlay_exclusion_and_position_must_both_prove_or_refuse() {
        let window = NativeWindow::new();
        let mut version = OSVERSIONINFOW {
            dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
            ..Default::default()
        };
        let supported =
            unsafe { RtlGetVersion(&mut version) }.is_ok() && version.dwBuildNumber >= 19041;
        let available = unsafe { DwmIsCompositionEnabled() }.is_ok_and(|enabled| enabled.as_bool());
        if !available || !supported {
            assert_eq!(exclude_overlay(window.0), Err("overlay-exclusion".into()));
            return;
        }
        exclude_overlay(window.0).unwrap();
        place_overlay(window.0, [-23.0, 37.0, 123.0, 81.0]).unwrap();
        let mut actual = RECT::default();
        let old =
            unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        assert!(!old.0.is_null());
        let read = unsafe { GetWindowRect(window.0, &mut actual) };
        unsafe {
            SetThreadDpiAwarenessContext(old);
        }
        read.unwrap();
        assert_eq!(
            [
                actual.left,
                actual.top,
                actual.right - actual.left,
                actual.bottom - actual.top
            ],
            [-23, 37, 123, 81]
        );
        let mut affinity = 0;
        unsafe { GetWindowDisplayAffinity(window.0, &mut affinity) }.unwrap();
        assert_eq!(affinity, WDA_EXCLUDEFROMCAPTURE.0);
        hide_overlay(window.0).unwrap();
        assert!(!unsafe { IsWindowVisible(window.0) }.as_bool());
    }
    #[test]
    fn ax_cancellation_and_total_budget_discard_before_another_provider_call() {
        let stop = AtomicBool::new(true);
        let budget = AxBudget {
            stop: &stop,
            started: Instant::now(),
        };
        let called = AtomicBool::new(false);
        assert!(budget
            .read(|| {
                called.store(true, Ordering::Relaxed);
                Ok(())
            })
            .is_err());
        assert!(!called.load(Ordering::Relaxed));
        stop.store(false, Ordering::Release);
        let budget = AxBudget {
            stop: &stop,
            started: Instant::now() - AX_BUDGET,
        };
        assert!(budget
            .read(|| {
                called.store(true, Ordering::Relaxed);
                Ok(())
            })
            .is_err());
        assert!(!called.load(Ordering::Relaxed));
    }
    #[test]
    fn actual_uia_password_and_hwnd_association_are_read_on_separate_mta_thread() {
        let window = NativeWindow::new();
        let edit = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                windows::core::w!("EDIT"),
                windows::core::w!("private fixture"),
                WS_CHILD | WS_VISIBLE | WINDOW_STYLE(ES_PASSWORD as u32),
                0,
                0,
                60,
                20,
                Some(window.0),
                None,
                None,
                None,
            )
        }
        .unwrap();
        let (child, parent) = (edit.0 as usize, window.0 .0 as usize);
        let read = std::thread::spawn(move || {
            let _apartment = Apartment::new().unwrap();
            let automation: IUIAutomation2 =
                unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }.unwrap();
            unsafe {
                automation.SetConnectionTimeout(AX_WAIT_MS).unwrap();
                automation.SetTransactionTimeout(AX_WAIT_MS).unwrap();
            }
            let child = Pin::open(HWND(child as *mut _)).unwrap();
            child.identity().unwrap();
            let root = unsafe { automation.ElementFromHandle(child.hwnd) }.unwrap();
            let stop = AtomicBool::new(false);
            let budget = AxBudget {
                stop: &stop,
                started: Instant::now(),
            };
            assert!(associated(&root, &child, &budget).unwrap());
            let password = unsafe {
                automation
                    .ElementFromHandle(child.hwnd)
                    .unwrap()
                    .CurrentIsPassword()
            }
            .unwrap()
            .as_bool();
            assert!(password);
            assert!(sensitive(password, "Edit"));
            let parent = Pin::open(HWND(parent as *mut _)).unwrap();
            let budget = AxBudget {
                stop: &stop,
                started: Instant::now(),
            };
            assert!(!associated(&root, &parent, &budget).unwrap());
            child.identity().unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while !read.is_finished() && Instant::now() < deadline {
            let mut message = MSG::default();
            while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
                unsafe {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(
            read.is_finished(),
            "native UIA fixture exceeded its bounded read"
        );
        read.join().unwrap();
    }
    #[tokio::test]
    async fn native_stop_cancels_pending_start_and_waits_for_owned_worker_cleanup() {
        let backend = Backend {
            lens: Weak::new(),
            worker: Mutex::new(None),
            operation: tokio::sync::Mutex::new(()),
            closing: Arc::new(AtomicBool::new(false)),
            ordinal: Arc::new(AtomicU32::new(1)),
        };
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Cancellation::new();
        let cleanup = Arc::new(AtomicBool::new(false));
        let native_stop = stop.clone();
        let native_cleanup = cleanup.clone();
        let thread = std::thread::spawn(move || {
            while !native_stop.load(Ordering::Acquire) {
                std::thread::park_timeout(Duration::from_millis(10));
            }
            native_cleanup.store(true, Ordering::Release);
            Ok(())
        });
        *backend.worker.lock().unwrap() = Some(Worker {
            stop,
            stopped: stopped.clone(),
            generation: Arc::new(AtomicU64::new(1)),
            thread,
        });
        backend.cancel();
        assert!(stopped.is_cancelled());
        backend.stop().await.unwrap();
        assert!(cleanup.load(Ordering::Acquire));
        assert!(backend.worker.lock().unwrap().is_none());
        assert!(!backend.closing.load(Ordering::Acquire));
    }
    #[tokio::test]
    async fn failed_native_cleanup_cannot_ack_stop_or_start_a_replacement() {
        for reason in [
            "observer-teardown",
            "capture-teardown:0x80004005;capture-unavailable:0x80070005",
            "capture-teardown:worker-panic",
        ] {
            let failure = reason.to_owned();
            let backend = Backend {
                lens: Weak::new(),
                worker: Mutex::new(Some(Worker {
                    stop: Arc::new(AtomicBool::new(false)),
                    stopped: Cancellation::new(),
                    generation: Arc::new(AtomicU64::new(1)),
                    thread: std::thread::spawn(move || Err(failure)),
                })),
                operation: tokio::sync::Mutex::new(()),
                closing: Arc::new(AtomicBool::new(false)),
                ordinal: Arc::new(AtomicU32::new(1)),
            };
            assert_eq!(backend.stop().await, Err(reason.into()));
            assert!(backend.closing.load(Ordering::Acquire));
            assert_eq!(
                backend.start(1, Cancellation::new()).await,
                Err("capture-closing".into())
            );
        }
    }
    #[test]
    fn thread_dpi_is_restored_while_capture_unwinds() {
        use windows::Win32::UI::HiDpi::{
            AreDpiAwarenessContextsEqual, GetThreadDpiAwarenessContext,
        };
        let before = unsafe { GetThreadDpiAwarenessContext() };
        let panic = std::panic::catch_unwind(|| {
            let _dpi = DpiContext::physical().unwrap();
            panic!("native capture unwind fixture");
        });
        assert!(panic.is_err());
        assert!(
            unsafe { AreDpiAwarenessContextsEqual(before, GetThreadDpiAwarenessContext()) }
                .as_bool()
        );
    }
}
