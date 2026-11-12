//! Terminal escape stripping for text omp prints for a terminal.
//!
//! omp's builtin slash commands (`/context`, `/usage`) colour their bar charts
//! with SGR sequences. Over RPC those arrive verbatim in `command_output`, and
//! the phone rendered them as literal `\x1b[38;5;243m` noise around the bars.
//! Stripping happens once, daemon-side, so every client gets clean text while
//! the bar glyphs themselves (`█░`) survive untouched.

use std::borrow::Cow;

const ESC: char = '\u{1b}';
const BEL: char = '\u{07}';
/// C1 forms of CSI and ST. omp only emits 7-bit sequences, but a C1 byte in a
/// `&str` is a real char (U+009B), and leaving one in would still garble.
const C1_CSI: char = '\u{9b}';
const C1_ST: char = '\u{9c}';

/// Remove CSI (incl. SGR), OSC/DCS/SOS/PM/APC strings and two-byte escapes,
/// keeping every other character, newlines and tabs included. Text without an
/// escape is returned borrowed.
///
/// Malformed input never eats readable text: a CSI interrupted by a character
/// that cannot belong to it ends before that character, and an unterminated
/// string sequence ends at the next newline rather than swallowing the rest
/// of the output.
pub fn strip(input: &str) -> Cow<'_, str> {
    if !input.contains([ESC, C1_CSI]) {
        return Cow::Borrowed(input);
    }
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            C1_CSI => skip_csi(&mut chars),
            ESC => match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    skip_csi(&mut chars);
                }
                // OSC, DCS, SOS, PM, APC: a string ended by ST (or BEL for OSC).
                Some(']' | 'P' | 'X' | '^' | '_') => {
                    chars.next();
                    skip_string(&mut chars);
                }
                // nF: intermediates, then one final byte.
                Some('\u{20}'..='\u{2f}') => {
                    while chars
                        .next_if(|c| ('\u{20}'..='\u{2f}').contains(c))
                        .is_some()
                    {}
                    chars.next_if(|c| ('\u{30}'..='\u{7e}').contains(c));
                }
                // Fp / Fe / Fs: ESC plus one byte (ESC 7, ESC M, ESC c, ...).
                Some('\u{30}'..='\u{7e}') => {
                    chars.next();
                }
                // A lone ESC: drop it, keep whatever follows.
                _ => {}
            },
            other => out.push(other),
        }
    }
    Cow::Owned(out)
}

/// After `ESC [`: parameters and intermediates (0x20-0x3f), then a final byte
/// (0x40-0x7e). Anything else ends the sequence unconsumed.
fn skip_csi(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    while let Some(&c) = chars.peek() {
        match c {
            '\u{20}'..='\u{3f}' => {
                chars.next();
            }
            '\u{40}'..='\u{7e}' => {
                chars.next();
                return;
            }
            _ => return,
        }
    }
}

/// After a string introducer: everything up to and including BEL, `ESC \` or
/// C1 ST. Stops before a newline so an unterminated string costs one line.
fn skip_string(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    while let Some(&c) = chars.peek() {
        match c {
            '\n' => return,
            BEL | C1_ST => {
                chars.next();
                return;
            }
            ESC => {
                chars.next();
                if chars.next_if_eq(&'\\').is_some() {
                    return;
                }
            }
            _ => {
                chars.next();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::strip;
    use std::borrow::Cow;

    #[test]
    fn plain_text_is_borrowed_unchanged() {
        let text = "Context window: 200000 tokens\n  Free [███░░] 78%";
        assert!(matches!(strip(text), Cow::Borrowed(t) if t == text));
    }

    #[test]
    fn sgr_colours_go_and_bar_glyphs_stay() {
        // Verbatim shape of omp 18.8.6 `/context` output.
        let raw = "  System tools     [\x1b[38;5;243m█░░░\x1b[39m\x1b[1m\x1b[38;5;39m░░\x1b[22m\x1b[39m] 2%  4710 tokens";
        assert_eq!(strip(raw), "  System tools     [█░░░░░] 2%  4710 tokens");
    }

    #[test]
    fn other_csi_sequences_go() {
        assert_eq!(strip("a\x1b[2Kb\x1b[1;5Hc\x1b[?25ld\x1b[>4;1me"), "abcde");
        assert_eq!(strip("x\u{9b}31my"), "xy");
    }

    #[test]
    fn osc_strings_go_with_either_terminator() {
        assert_eq!(strip("\x1b]0;title\x07after"), "after");
        let link = "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ done";
        assert_eq!(strip(link), "link done");
        assert_eq!(strip("\x1bPq#0;2;0;0;0\x1b\\ok"), "ok");
    }

    #[test]
    fn malformed_sequences_keep_readable_text() {
        // An unterminated OSC costs its own line, not the rest of the output.
        assert_eq!(strip("\x1b]0;never ends\nnext line"), "\nnext line");
        // A CSI cut by a newline ends there; the newline survives.
        assert_eq!(strip("a\x1b[31\nb"), "a\nb");
        // Trailing and lone escapes vanish without taking neighbours.
        assert_eq!(strip("end\x1b"), "end");
        assert_eq!(strip("\x1b\x1b[0mz"), "z");
        assert_eq!(strip("a\x1b[31"), "a");
    }

    #[test]
    fn two_byte_escapes_go() {
        assert_eq!(strip("a\x1b(Bb\x1b7c\x1bMd\x1b#8e"), "abcde");
    }

    #[test]
    fn multibyte_text_next_to_escapes_is_intact() {
        // A non-ASCII char directly after ESC / inside a CSI is text, never a
        // sequence byte, so UTF-8 is never split.
        assert_eq!(strip("\x1bé\x1b[1mñ\x1b[0m"), "éñ");
        assert_eq!(strip("\x1b[3€x"), "€x");
        assert_eq!(strip("日本\x1b[32m語\x1b[0m 🙂"), "日本語 🙂");
    }
}
