#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer aborts at webview creation ("Could not create
    // GBM EGL display") when the bundled WebKit meets a host GBM/EGL stack it
    // does not match, e.g. NVIDIA on Wayland (#9). Set before any thread starts;
    // a value the user exported wins.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    rimeward_lib::run()
}
