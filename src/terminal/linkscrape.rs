//! Scraping a collab link out of terminal output.
//!
//! Shared by the two paths that can obtain one from a desktop omp TUI:
//! `term.rs` (the pty host reads a rolling byte tail) and `adopt.rs` (kitty
//! remote control returns a window's screen text). Both need identical
//! validation, because a mis-sliced secret registers a room that can never
//! decrypt — so the parsing lives in one place.
//!
//! The awkward parts are all real renders observed from omp 17.2.15:
//! quote-wrapped links, links split across visual lines by a narrow terminal,
//! and a second web-deep-link form whose secret runs into following prose.

use std::collections::VecDeque;
use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// The collab link shape the TUI prints after `/collab`:
/// `wss?://host[:port]/r/<room>.<secret>` — the room id is a 22-char base64url
/// token; the secret is 43 (view) or 64 (full) base64url chars, so the printed
/// link is always the full form. Mirrors `parse_collab_link` in collab.rs.
const COLLAB_LINK_PATTERN: &str = r"wss?://[^\s]+?/r/([A-Za-z0-9_-]{10,})\.([A-Za-z0-9_-]{40,})";
/// omp's stable copy-paste contract: the link is rendered inside a hint of
/// the form `omp join "<link>"` — the `collabLinkHint` string shipped in the
/// packaged binary (verified in 17.2.15, and quote-wrapped since then). This
/// is tried FIRST, before the bare-URL regex: the literal `omp join "` prefix
/// and the closing quote anchor the match, and the closing quote proves the
/// link is complete (so a capture ending at the tail end is acceptable here —
/// the mid-secret/stream-open guard only applies to the bare-URL path).
/// Groups: 1 = full link, 2 = room id, 3 = secret.
const COLLAB_HINT_PATTERN: &str =
    r#"omp\s+join\s+"(wss?://[^\s"]+/r/([A-Za-z0-9_-]{10,})\.([A-Za-z0-9_-]{40,}))""#;
/// Compiled once, lazily. `.ok()` keeps the no-unwrap-outside-main rule even
/// though the literal pattern is always valid.
fn link_regex() -> Option<&'static regex::Regex> {
    static RE: LazyLock<Option<regex::Regex>> =
        LazyLock::new(|| regex::Regex::new(COLLAB_LINK_PATTERN).ok());
    RE.as_ref()
}
/// The anchored `omp join "<link>"` hint matcher, compiled once, lazily.
fn hint_regex() -> Option<&'static regex::Regex> {
    static RE: LazyLock<Option<regex::Regex>> =
        LazyLock::new(|| regex::Regex::new(COLLAB_HINT_PATTERN).ok());
    RE.as_ref()
}
/// A scraped collab link plus the room id extracted for logging — the secret
/// is never logged, only the room id.
pub struct ScrapedLink {
    pub link: String,
    pub room: String,
}
/// ANSI-stripped text for link scraping: the shared stripper
/// ([`crate::omp::ansi::strip`]) plus carriage-return removal, so a link that was
/// re-printed over itself (`…room.\r<rewrite>secret`) still scrapes as one
/// contiguous string. The tail is a rolling byte window that may start
/// mid-character; lossy decoding costs at most that one character.
fn strip_ansi(input: &[u8]) -> String {
    crate::omp::ansi::strip(&String::from_utf8_lossy(input)).replace('\r', "")
}
/// Canonical base64url lengths of the two secret shapes: 64 chars = 48 bytes
/// (full/write link), 43 chars = 32 bytes (view-only link).
const SECRET_SHAPES: [(usize, usize); 2] = [(64, 48), (43, 32)];
/// Validate a captured secret, requiring an EXACT canonical shape.
///
/// Prefix-trimming a longer capture is unsafe in both directions: any 64
/// base64url characters decode to a clean 48 bytes, and the first 43 of a
/// 64-char secret often decode to a plausible 32 bytes. So a fragment of a
/// wrapped secret, or a secret with the next line's prose glued onto it, can
/// masquerade as a valid key of the other shape — and a wrong key registers a
/// link that never decrypts. Requiring the capture to BE a canonical shape
/// means an ambiguous candidate is skipped, and the same output's unambiguous
/// render (the quoted `omp join "…"` form, whose closing quote bounds the
/// secret exactly) is used instead.
fn normalize_secret(secret: &str) -> Option<&str> {
    for (chars, bytes) in SECRET_SHAPES {
        if secret.len() == chars
            && URL_SAFE_NO_PAD
                .decode(secret)
                .map(|d| d.len() == bytes)
                .unwrap_or(false)
        {
            return Some(secret);
        }
    }
    None
}
/// Box-drawing glyphs (U+2500..U+257F) — the TUI frames its output in them, so
/// they surround wrapped link fragments.
fn is_box_glyph(c: char) -> bool {
    ('\u{2500}'..='\u{257f}').contains(&c)
}
/// A whitespace-free, border-free view of the tail.
///
/// This is the load-bearing fix for narrow terminals: a full link is ~105
/// characters, so inside the TUI's box it ALWAYS wraps at 80 columns and the
/// secret arrives split across two visual lines with padding and borders
/// between the halves. A link never contains whitespace or box glyphs, so
/// deleting them rejoins the halves exactly.
fn dewrap(clean: &str) -> String {
    clean
        .chars()
        .filter(|c| !c.is_whitespace() && !is_box_glyph(*c))
        .collect()
}
/// Anchored `omp join "<link>"` copy-paste hint (`collabLinkHint` in the
/// packaged binary) — the closing quote proves the capture is complete, so no
/// stream guard applies. Only matches when the link did NOT wrap; wrapped
/// renders fall through to the de-wrapped pass.
fn match_hint_in(text: &str) -> Option<ScrapedLink> {
    let caps = hint_regex()?.captures(text)?;
    let secret = normalize_secret(caps.get(3)?.as_str())?;
    let url = caps.get(1)?.as_str();
    let dot = url.rfind('.')?;
    Some(ScrapedLink {
        link: format!("{}{}", &url[..=dot], secret),
        room: caps.get(2)?.as_str().to_string(),
    })
}
/// Scan for a bare `ws(s)://…/r/<room>.<secret>` URL, accepting the first
/// candidate whose secret validates. Scanning ALL candidates matters: the TUI
/// prints the link twice (the `omp join` hint and a web deep link), and a
/// greedy capture on one of them can fail while the other is clean.
fn match_link_in(text: &str, stream_open: bool) -> Option<ScrapedLink> {
    let re = link_regex()?;
    for caps in re.captures_iter(text) {
        let m = match caps.get(0) {
            Some(m) => m,
            None => continue,
        };
        // A capture that runs to the very end of a still-open stream may be a
        // half-printed secret. Never trust it: a 48-byte secret cut to 43
        // characters decodes as a plausible 32-byte view key, which would
        // register a WRONG link that can never decrypt.
        if m.end() == text.len() && stream_open {
            continue;
        }
        let (Some(room), Some(raw)) = (caps.get(1), caps.get(2)) else {
            continue;
        };
        let Some(secret) = normalize_secret(raw.as_str()) else {
            continue;
        };
        let url = m.as_str();
        let Some(dot) = url.rfind('.') else { continue };
        return Some(ScrapedLink {
            link: format!("{}{}", &url[..=dot], secret),
            room: room.as_str().to_string(),
        });
    }
    None
}
/// Search the raw output tail for a printed collab link, ANSI-tolerant and
/// wrap-tolerant. The tail is a rolling window, so a link split across reads
/// is still whole by the time its final bytes arrive.
///
/// Three passes, in order of confidence:
/// 1. the anchored `omp join "<link>"` hint on the ANSI-stripped text;
/// 2. any bare URL in that text (older renders, quoted or followed by prose);
/// 3. the same URL scan over a de-wrapped copy — the only pass that survives
///    a link split across visual lines by a narrow terminal.
///
/// Every pass validates the secret as `parse_collab_link` does before the link
/// is reported, so a false positive cannot be registered.
pub fn scrape_link(tail: &VecDeque<u8>, stream_open: bool) -> Option<ScrapedLink> {
    let bytes: Vec<u8> = tail.iter().copied().collect();
    let clean = strip_ansi(&bytes);
    if let Some(found) = match_hint_in(&clean) {
        return Some(found);
    }
    if let Some(found) = match_link_in(&clean, stream_open) {
        return Some(found);
    }
    match_link_in(&dewrap(&clean), stream_open)
}
/// Scrape a link out of ALREADY-DECODED terminal text.
///
/// Used by the kitty adoption path (`adopt.rs`), which reads a window's screen
/// through `kitty @ get-text` instead of a pty stream: same three passes, same
/// secret validation, but the text is complete by definition (a screen grab is
/// not a partial read), so no open-stream guard applies.
pub fn scrape_text(text: &str) -> Option<ScrapedLink> {
    if let Some(found) = match_hint_in(text) {
        return Some(found);
    }
    if let Some(found) = match_link_in(text, false) {
        return Some(found);
    }
    match_link_in(&dewrap(text), false)
}
/// True when the ANSI-stripped tail contains a link-looking `/r/` substring —
/// distinguishes "the trigger never printed a link" from "a link printed but
/// failed validation/scrape", which are different bugs.
pub fn tail_contains_linkish(tail: &VecDeque<u8>) -> bool {
    let bytes: Vec<u8> = tail.iter().copied().collect();
    strip_ansi(&bytes).contains("/r/")
}
