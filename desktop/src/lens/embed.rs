//! The `lens-embed` caps.
//!
//! The vectors themselves come from the Swift helper's `embed` op, which runs
//! the MobileCLIP-S0 text tower on Core ML (512 dims, unit-normalised), and
//! the Node gate is what scores them. This module holds only what Rust decides
//! without the model: how big a batch may be.

/// Texts per `lens-embed` call. A gate round embeds the changed lines of one
/// diff; past this the consumer is asking for a corpus, not a candidate set.
pub const MAX_TEXTS: usize = 32;
/// Characters per text. The tokenizer keeps 77 tokens and truncates the rest,
/// so anything longer is measured on a prefix anyway — better to say so.
pub const MAX_CHARS: usize = 1_000;
/// The `lens-embed` caps. The op checks them before it reaches the helper, so
/// an oversized batch is refused without spending a model call.
pub fn check(texts: &[String]) -> Result<(), String> {
    if texts.len() > MAX_TEXTS || texts.iter().any(|text| text.chars().count() > MAX_CHARS) {
        return Err("bad-request".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_caps_are_counted_in_characters_not_bytes() {
        assert_eq!(check(&[]), Ok(()));
        assert_eq!(check(&vec![String::new(); MAX_TEXTS]), Ok(()));
        assert_eq!(
            check(&vec![String::new(); MAX_TEXTS + 1]).err().as_deref(),
            Some("bad-request")
        );
        // 1,000 three-byte characters is a legal text; 1,001 is not.
        assert_eq!(check(&["√".repeat(MAX_CHARS)]), Ok(()));
        assert_eq!(
            check(&["√".repeat(MAX_CHARS + 1)]).err().as_deref(),
            Some("bad-request")
        );
    }
}
