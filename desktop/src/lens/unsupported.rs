//! The lens off macOS. Capture, the accessibility tree, OCR and the overlay
//! are all platform work that has not been done yet — the substitutes are
//! named in the plan's cross-platform table — so this answers the same ops
//! with the truth rather than leaving a consumer to wait for a signal that is
//! never coming.

use serde_json::{json, Value};

/// A stopped lens whose every capability is missing: what a ward renders
/// "unavailable on this platform" from.
fn status() -> Value {
    json!({
        "state": "stopped",
        "reason": "unsupported",
        "capabilities": {
            "capture": false,
            "ax": false,
            "ocr": false,
            "embed": false,
            "triage": false,
            "describe": false,
            "translate": false,
            "overlay": false,
        },
    })
}

/// Route one `desktop` op to a lens this build does not have. `lens-status`
/// is the only op with an answer.
pub async fn desktop_request(
    _app: &tauri::AppHandle,
    op: &str,
    _value: &Value,
    _deadline: Option<i64>,
) -> Result<Value, String> {
    match op {
        "lens-status" => Ok(status()),
        _ => Err("unavailable".into()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_stub_reports_a_stopped_lens_with_no_capabilities() {
        let status = super::status();
        assert_eq!(status["state"], "stopped");
        assert_eq!(status["reason"], "unsupported");
        let capabilities = status["capabilities"].as_object().expect("capabilities");
        assert_eq!(capabilities.len(), 8);
        for (name, value) in capabilities {
            assert_eq!(value, false, "{name}");
        }
    }
}
