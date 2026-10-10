//! Native hooks only. Shared pool owns slot selection, payload/ACK/redelivery,
//! source guards, TTL, request parsing and browser overlay routing.
use super::{
    bridge::Rect,
    linux_x11::{Native, Source},
    request::Cancellation,
    Lens,
};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::sync::{Arc, Mutex, Weak};
use tauri::{AppHandle, WebviewWindow};
use x11rb::protocol::xproto::{
    ChangeWindowAttributesAux, ConfigureWindowAux, ConnectionExt as _, MapState, StackMode,
};

pub struct Overlay {
    app: AppHandle,
    lens: Weak<Lens>,
    source: Mutex<Option<Arc<Source>>>,
    windows: Mutex<Vec<(u32, WebviewWindow)>>,
}
/// Prepared off main before a shared-pool slot is selected. Private native
/// evidence only; never serialized handles or observed text.
pub struct Token {
    native: Native,
    source: Arc<Source>,
    request: Arc<Cancellation>,
}
pub struct Placement {
    token: Arc<Token>,
    xid: u32,
    rect: [i32; 4],
}
impl Overlay {
    pub fn attach(app: &AppHandle, lens: &Arc<Lens>) -> Arc<Self> {
        Arc::new(Self {
            app: app.clone(),
            lens: Arc::downgrade(lens),
            source: Mutex::new(None),
            windows: Mutex::new(Vec::new()),
        })
    }
    /// Main-thread setup extracts private handles; shared pool keeps ownership.
    pub fn register_windows(&self, windows: Vec<WebviewWindow>) -> Result<(), String> {
        if windows.len() != 8 {
            return Err("unavailable".into());
        }
        let ids = windows
            .iter()
            .map(native_id)
            .collect::<Result<Vec<_>, _>>()?;
        if ids.iter().enumerate().any(|(i, id)| ids[..i].contains(id)) {
            return Err("unavailable".into());
        }
        if windows
            .iter()
            .any(|window| window.scale_factor().ok() != Some(1.0))
        {
            return Err("overlay-scale-unproved".into());
        }
        *self.windows.lock().unwrap() = ids.into_iter().zip(windows).collect();
        Ok(())
    }
    pub(super) fn source(&self, source: Arc<Source>, native: &Native) -> bool {
        *self.source.lock().unwrap() = Some(source.clone());
        let windows = self.windows.lock().unwrap().clone();
        if windows.len() != 8 {
            return false;
        }
        // Hidden 1x1 placement/readback establishes actual pool positioning and
        // sibling exclusion before advertising capability. A real show repeats
        // the proof for its requested rectangle; nothing is revealed here.
        let proof = (|| {
            let (send, receive) = std::sync::mpsc::sync_channel(1);
            let ui_windows = windows
                .iter()
                .map(|(_, window)| window.clone())
                .collect::<Vec<_>>();
            self.app
                .run_on_main_thread(move || {
                    let _ = send.send(
                        ui_windows
                            .iter()
                            .all(|window| window.scale_factor().ok() == Some(1.0)),
                    );
                })
                .map_err(unavailable)?;
            if receive
                .recv_timeout(std::time::Duration::from_millis(500))
                .ok()
                != Some(true)
            {
                return Err("overlay-scale-unproved".into());
            }
            native.budget();
            native.verify(&source)?;
            for (id, _) in windows {
                let tree = native
                    .conn
                    .query_tree(id)
                    .map_err(unavailable)?
                    .reply()
                    .map_err(unavailable)?;
                let attributes = native
                    .conn
                    .get_window_attributes(id)
                    .map_err(unavailable)?
                    .reply()
                    .map_err(unavailable)?;
                if !excludes(source.window, id, native.root, tree.parent)
                    || attributes.map_state != MapState::UNMAPPED
                {
                    return Err("unavailable".into());
                }
                native
                    .conn
                    .change_window_attributes(
                        id,
                        &ChangeWindowAttributesAux::new().override_redirect(1),
                    )
                    .map_err(unavailable)?
                    .check()
                    .map_err(unavailable)?;
                native
                    .conn
                    .configure_window(
                        id,
                        &ConfigureWindowAux::new()
                            .x(0)
                            .y(0)
                            .width(1)
                            .height(1)
                            .border_width(0),
                    )
                    .map_err(unavailable)?
                    .check()
                    .map_err(unavailable)?;
                let geometry = native
                    .conn
                    .get_geometry(id)
                    .map_err(unavailable)?
                    .reply()
                    .map_err(unavailable)?;
                let position = native
                    .conn
                    .translate_coordinates(id, native.root, 0, 0)
                    .map_err(unavailable)?
                    .reply()
                    .map_err(unavailable)?;
                let attributes = native
                    .conn
                    .get_window_attributes(id)
                    .map_err(unavailable)?
                    .reply()
                    .map_err(unavailable)?;
                if geometry.root != native.root
                    || geometry.width != 1
                    || geometry.height != 1
                    || geometry.border_width != 0
                    || !position.same_screen
                    || position.dst_x != 0
                    || position.dst_y != 0
                    || !attributes.override_redirect
                    || attributes.map_state != MapState::UNMAPPED
                {
                    return Err("unavailable".into());
                }
            }
            native.verify(&source)
        })();
        proof.is_ok()
    }
    /// No State lock or dispatch: safe inside the shared Stop/source guard.
    pub fn invalidate(&self) {
        if let Some(source) = self.source.lock().unwrap().take() {
            source.cancel.cancel();
        }
    }
    pub(super) fn invalidate_generation(&self, generation: u64) {
        let mut source = self.source.lock().unwrap();
        if source
            .as_ref()
            .is_some_and(|source| source.lease.generation == generation)
        {
            if let Some(source) = source.take() {
                source.cancel.cancel();
            }
        }
    }
    /// Blocking preparation: shared caller runs this off main, then selects a
    /// slot in its serialized source-guarded main transaction.
    pub fn prepare(
        &self,
        generation: u64,
        epoch: u64,
        request: Arc<Cancellation>,
    ) -> Result<Arc<Token>, String> {
        let source = self.source.lock().unwrap().clone().ok_or("unavailable")?;
        if request.is_cancelled()
            || source.lease.generation != generation
            || source.lease.epoch != epoch
            || !self.lens.upgrade().is_some_and(|lens| {
                lens.request_generation() == generation && lens.bridge.epoch() == epoch
            })
        {
            return Err("cancelled".into());
        }
        // This connection never reenters Lens State. The shared guard pins the
        // lease throughout place/reveal; cancellation/native proof additionally
        // refuse a source revoked during preparation.
        let native = Native::connect(source.overlay_control())?;
        native.budget();
        native.verify(&source)?;
        Ok(Arc::new(Token {
            native,
            source,
            request,
        }))
    }
    /// Main thread inside shared OverlaySource.publish. Exact server pixels.
    pub fn place(
        &self,
        window: &WebviewWindow,
        rect: Rect,
        token: &Arc<Token>,
    ) -> Result<Placement, String> {
        let rect = physical(rect)?;
        if window.scale_factor().ok() != Some(1.0) {
            return Err("overlay-scale-unproved".into());
        }
        window.hide().map_err(unavailable)?;
        let xid = native_id(window)?;
        let proof = Placement {
            token: token.clone(),
            xid,
            rect,
        };
        let native = &token.native;
        native.budget();
        check(token)?;
        let tree = native
            .conn
            .query_tree(xid)
            .map_err(unavailable)?
            .reply()
            .map_err(unavailable)?;
        let attributes = native
            .conn
            .get_window_attributes(xid)
            .map_err(unavailable)?
            .reply()
            .map_err(unavailable)?;
        if !excludes(token.source.window, xid, native.root, tree.parent)
            || attributes.map_state != MapState::UNMAPPED
        {
            return Err("overlay-position-exclusion-unproved".into());
        }
        // Only our own hidden overlay is override-redirect. Never reparent or
        // redirect the target or change the user's compositor behavior.
        native
            .conn
            .change_window_attributes(xid, &ChangeWindowAttributesAux::new().override_redirect(1))
            .map_err(unavailable)?
            .check()
            .map_err(unavailable)?;
        native
            .conn
            .configure_window(
                xid,
                &ConfigureWindowAux::new()
                    .x(rect[0])
                    .y(rect[1])
                    .width(rect[2] as u32)
                    .height(rect[3] as u32)
                    .border_width(0)
                    .stack_mode(StackMode::ABOVE),
            )
            .map_err(unavailable)?
            .check()
            .map_err(unavailable)?;
        verify(&proof, false)?;
        Ok(proof)
    }
    /// Main thread under the shared current slot/source guard, after DOM ACK.
    pub fn reveal(&self, window: &WebviewWindow, proof: &Placement) -> Result<(), String> {
        proof.token.native.budget();
        if window.scale_factor().ok() != Some(1.0) {
            return Err("overlay-scale-unproved".into());
        }
        if native_id(window)? != proof.xid {
            return Err("cancelled".into());
        }
        verify(proof, false)?;
        window.show().map_err(unavailable)?;
        let native = &proof.token.native;
        let result = (|| {
            check(&proof.token)?;
            native
                .conn
                .map_window(proof.xid)
                .map_err(unavailable)?
                .check()
                .map_err(unavailable)?;
            native
                .conn
                .configure_window(
                    proof.xid,
                    &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE),
                )
                .map_err(unavailable)?
                .check()
                .map_err(unavailable)?;
            verify(proof, true)
        })();
        if result.is_err() {
            self.hide(window)?;
        }
        result
    }
    /// Shared pool serializes hide with slot invalidation and awaits its main
    /// barrier before acknowledging Stop/clear.
    pub fn hide(&self, window: &WebviewWindow) -> Result<(), String> {
        window.hide().map_err(unavailable)
    }
}
fn check(token: &Token) -> Result<(), String> {
    if token.request.is_cancelled() || token.source.cancel.is_cancelled() {
        return Err("cancelled".into());
    }
    token.native.verify(&token.source)
}
fn verify(proof: &Placement, mapped: bool) -> Result<(), String> {
    let native = &proof.token.native;
    check(&proof.token)?;
    let tree = native
        .conn
        .query_tree(proof.xid)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    let geometry = native
        .conn
        .get_geometry(proof.xid)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    let position = native
        .conn
        .translate_coordinates(proof.xid, native.root, 0, 0)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    let attributes = native
        .conn
        .get_window_attributes(proof.xid)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    let rect = [
        i32::from(position.dst_x),
        i32::from(position.dst_y),
        i32::from(geometry.width),
        i32::from(geometry.height),
    ];
    if !excludes(
        proof.token.source.window,
        proof.xid,
        native.root,
        tree.parent,
    ) || geometry.root != native.root
        || geometry.border_width != 0
        || !position.same_screen
        || !attributes.override_redirect
        || rect != proof.rect
        || (mapped && attributes.map_state != MapState::VIEWABLE)
    {
        return Err("overlay-position-exclusion-unproved".into());
    }
    check(&proof.token)
}
fn native_id(window: &WebviewWindow) -> Result<u32, String> {
    let handle = window.window_handle().map_err(unavailable)?;
    match handle.as_raw() {
        RawWindowHandle::Xlib(handle) => u32::try_from(handle.window)
            .ok()
            .filter(|id| *id != 0)
            .ok_or("unavailable".into()),
        RawWindowHandle::Xcb(handle) => Ok(handle.window.get()),
        _ => Err("unavailable".into()),
    }
}
fn excludes(target: u32, overlay: u32, root: u32, parent: u32) -> bool {
    target != overlay && target != root && overlay != 0 && parent == root
}
pub(super) fn physical(rect: Rect) -> Result<[i32; 4], String> {
    if rect.iter().any(|v| !v.is_finite() || v.fract() != 0.0)
        || rect[0] < f64::from(i16::MIN)
        || rect[0] > f64::from(i16::MAX)
        || rect[1] < f64::from(i16::MIN)
        || rect[1] > f64::from(i16::MAX)
        || rect[2] <= 0.0
        || rect[3] <= 0.0
        || rect[2] > f64::from(u16::MAX)
        || rect[3] > f64::from(u16::MAX)
    {
        return Err("bad-rect".into());
    }
    Ok(rect.map(|v| v as i32))
}
fn unavailable<T: std::fmt::Display>(_: T) -> String {
    "unavailable".into()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_native_pixels_refuse_rounding_or_overflow() {
        assert_eq!(
            physical([-40.0, 3.0, 10.0, 20.0]).unwrap(),
            [-40, 3, 10, 20]
        );
        for rect in [
            [0.5, 0.0, 10.0, 10.0],
            [0.0, 0.0, 0.0, 10.0],
            [0.0, 0.0, 65536.0, 10.0],
            [f64::NAN, 0.0, 10.0, 10.0],
        ] {
            assert!(physical(rect).is_err());
        }
    }
    #[test]
    fn only_a_distinct_root_sibling_is_excluded_from_target_pixmap() {
        assert!(excludes(4, 5, 1, 1));
        assert!(!excludes(4, 4, 1, 1));
        assert!(!excludes(4, 5, 1, 4));
        assert!(!excludes(1, 5, 1, 1));
    }
}
