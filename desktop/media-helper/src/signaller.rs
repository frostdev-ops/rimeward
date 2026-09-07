use gst::{glib, prelude::*, subclass::prelude::*};
use gstrswebrtc::signaller::{Signallable, SignallableImpl};
use serde_json::json;
use std::sync::{LazyLock, Mutex};

#[derive(Default)]
pub struct Implementation {
    pending: Mutex<(bool, Vec<String>)>,
}
#[glib::object_subclass]
impl ObjectSubclass for Implementation {
    const NAME: &'static str = "RimewardSignaller";
    type Type = Adapter;
    type ParentType = glib::Object;
    type Interfaces = (Signallable,);
}
impl ObjectImpl for Implementation {
    fn properties() -> &'static [glib::ParamSpec] {
        static PROPS: LazyLock<Vec<glib::ParamSpec>> = LazyLock::new(|| {
            vec![glib::ParamSpecBoolean::builder("manual-sdp-munging")
                .read_only()
                .build()]
        });
        &PROPS
    }
    fn property(&self, _: usize, _: &glib::ParamSpec) -> glib::Value {
        false.to_value()
    }
}
impl SignallableImpl for Implementation {
    fn start(&self) {
        let ids = {
            let mut pending = self.pending.lock().unwrap();
            pending.0 = true;
            std::mem::take(&mut pending.1)
        };
        for id in ids {
            self.obj().connect_viewer(&id);
        }
    }
    fn stop(&self) {
        let mut pending = self.pending.lock().unwrap();
        pending.0 = false;
        pending.1.clear();
    }
    fn send_sdp(&self, session: &str, sdp: &gst_webrtc::WebRTCSessionDescription) {
        match sdp.sdp().as_text() {
            Ok(sdp) => crate::emit(json!({"event":"sdp","session":session,"sdp":sdp})),
            Err(_) => crate::emit(
                json!({"event":"closed","session":session,"reason":"Invalid local SDP"}),
            ),
        }
    }
    fn add_ice(&self, session: &str, candidate: &str, index: u32, mid: Option<String>) {
        crate::emit(
            json!({"event":"ice","session":session,"candidate":candidate,"sdpMLineIndex":index,"sdpMid":mid}),
        );
    }
    fn end_session(&self, session: &str) {
        crate::emit(json!({"event":"closed","session":session,"reason":"Peer disconnected"}));
    }
}
glib::wrapper! { pub struct Adapter(ObjectSubclass<Implementation>) @implements Signallable; }
impl Adapter {
    pub fn new() -> Self {
        glib::Object::new()
    }
    pub fn connect_viewer(&self, session: &str) {
        {
            let mut pending = self.imp().pending.lock().unwrap();
            if !pending.0 {
                pending.1.push(session.into());
                return;
            }
        }
        self.emit_by_name::<()>(
            "session-requested",
            &[
                &session,
                &session,
                &None::<gst_webrtc::WebRTCSessionDescription>,
            ],
        );
    }
    pub fn answer(&self, session: &str, text: &str) -> Result<(), String> {
        if text.len() > 256 * 1024 || !text.contains("a=fingerprint:sha-256 ") {
            return Err("Invalid SDP answer".into());
        }
        let message =
            gst_sdp::SDPMessage::parse_buffer(text.as_bytes()).map_err(|e| e.to_string())?;
        let answer =
            gst_webrtc::WebRTCSessionDescription::new(gst_webrtc::WebRTCSDPType::Answer, message);
        self.emit_by_name::<()>("session-description", &[&session, &answer]);
        Ok(())
    }
    pub fn ice(&self, session: &str, candidate: &str, index: u32) -> Result<(), String> {
        if candidate.len() > 4096 || index > 16 {
            return Err("Invalid ICE candidate".into());
        }
        self.emit_by_name::<()>(
            "handle-ice",
            &[&session, &index, &None::<String>, &candidate],
        );
        Ok(())
    }
    pub fn disconnect_viewer(&self, session: &str) {
        {
            let mut pending = self.imp().pending.lock().unwrap();
            pending.1.retain(|id| id != session);
            if !pending.0 {
                return;
            }
        }
        self.emit_by_name::<bool>("session-ended", &[&session]);
    }
}
