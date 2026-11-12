//! Embedded web app assets. `public/` is compiled into the
//! binary with `include_dir!`, because the old build read it from the
//! author's source checkout, which does not exist on anyone else's machine.
//! A developer can override the embedded copy with a live directory (see
//! [`set_override_dir`]) so UI iteration needs no rebuild.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use axum::body::Bytes;
use include_dir::{Dir, include_dir};

/// The compiled-in web app (`public/` in the crate root).
static PUBLIC: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/public");

/// Developer override: serve from this directory instead of the embedded
/// copy. `OnceLock` so the first write from any thread initialises it;
/// `Mutex` so `read()` (any thread) and `set_override_dir` (startup) cannot
/// race on the Option.
static OVERRIDE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn override_dir() -> Option<PathBuf> {
    OVERRIDE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

/// Serve from this directory instead of the embedded copy (developer
/// override). `None` restores the embedded copy. The daemon calls this once
/// at startup with `cfg.public_dir`; http.rs never touches `public_dir`
/// directly, it reads through [`read`].
pub fn set_override_dir(dir: Option<PathBuf>) {
    *OVERRIDE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = dir;
}

/// Candidate relative paths for a request, in precedence order: the path
/// itself, then `index.html` inside it.
///
/// The second candidate is what lets a nested single-page app live in a
/// subdirectory of the tree: `/app/` and `/app` both resolve to
/// `app/index.html`. Without it the React client could only be served by a
/// separate static server, and the one we had was an unsupervised Node process
/// that was found dead while the APK pointed straight at it.
fn candidates(rel: &str) -> [String; 2] {
    let nested = format!("{}/index.html", rel.trim_end_matches('/'));
    [rel.to_string(), nested]
}

/// Whether `request_path` names a directory that must be redirected to its
/// trailing-slash form before it can be served.
///
/// This is not cosmetic. The embedded client is built with a RELATIVE base so
/// one build works both at `https://…/app/` and at `file:///android_asset/…`.
/// Relative URLs resolve against the document path, so at `/app` the shell
/// asks for `/assets/index-HASH.js` — the ROOT tree, where the legacy client
/// lives — and the page loads a shell whose bundle 404s. At `/app/` the same
/// reference correctly resolves to `/app/assets/…`.
pub fn needs_trailing_slash(request_path: &str) -> bool {
    if request_path.ends_with('/') {
        return false;
    }
    let Some(rel) = normalize(request_path) else {
        return false;
    };
    // Only redirect when the bare path is NOT itself a file: a real file must
    // always win, or "/sw.js" would bounce to "/sw.js/".
    PUBLIC.get_file(&rel).is_none() && PUBLIC.get_file(format!("{rel}/index.html")).is_some()
}

/// Bytes and content-type for an embedded web-app path ("/app/",
/// "/app/sw.js", "/app/assets/index-HASH.js"). Leading slashes are optional.
/// A directory ("/app/") maps to the `index.html` within it. There is no
/// root client anymore: "/" has no file and returns `None` (the daemon
/// redirects it to `/app/` at the router). Returns `None` for missing files
/// and anything that would escape the tree (`..` components).
pub fn lookup(request_path: &str) -> Option<(&'static [u8], &'static str)> {
    let rel = normalize(request_path)?;
    for candidate in candidates(&rel) {
        if let Some(file) = PUBLIC.get_file(&candidate) {
            return Some((file.contents(), content_type(&candidate)));
        }
    }
    None
}

/// Read through the override when one is set; otherwise the embedded bytes.
/// A file missing from the override falls back to the embedded copy, so a
/// developer can iterate on a single file without copying the whole app.
pub fn read(request_path: &str) -> Option<(Bytes, &'static str)> {
    let rel = normalize(request_path)?;
    let dir = override_dir();
    // Resolve each candidate fully (override, then embedded) before trying the
    // next, so an exact file always wins over a directory's index.
    for candidate in candidates(&rel) {
        if let Some(dir) = dir.as_ref()
            && let Some(bytes) = read_from_dir(dir, &candidate)
        {
            return Some((Bytes::from(bytes), content_type(&candidate)));
        }
        if let Some(file) = PUBLIC.get_file(&candidate) {
            return Some((
                Bytes::from_static(file.contents()),
                content_type(&candidate),
            ));
        }
    }
    None
}

/// A content coding the web build stored beside each text asset
/// (`web/vite.config.ts` `precompressOutput`: `<file>.br`, `<file>.gz`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Br,
    Gzip,
}

impl Encoding {
    /// The `Content-Encoding` token.
    pub fn token(self) -> &'static str {
        match self {
            Encoding::Br => "br",
            Encoding::Gzip => "gzip",
        }
    }

    fn suffix(self) -> &'static str {
        match self {
            Encoding::Br => "br",
            Encoding::Gzip => "gz",
        }
    }
}

/// Precompressed bytes, content-type and coding for an embedded path, when
/// the request's `Accept-Encoding` admits a stored sidecar. Brotli first
/// (~16% smaller than gzip-9 here; browsers only offer it over HTTPS), then
/// gzip. `None` means "serve [`read`]'s identity bytes": no acceptable coding,
/// no sidecar (small or binary files), or a developer override directory,
/// whose live files the embedded sidecars no longer describe.
pub fn read_precompressed(
    request_path: &str,
    accept_encoding: &str,
) -> Option<(Bytes, &'static str, Encoding)> {
    if override_dir().is_some() {
        return None;
    }
    let accepted = accepted_codings(accept_encoding);
    let rel = normalize(request_path)?;
    // Same precedence as `read`: the first candidate that exists decides.
    let candidate = candidates(&rel)
        .into_iter()
        .find(|c| PUBLIC.get_file(c).is_some())?;
    accepted.into_iter().flatten().find_map(|encoding| {
        let file = PUBLIC.get_file(format!("{candidate}.{}", encoding.suffix()))?;
        Some((
            Bytes::from_static(file.contents()),
            content_type(&candidate),
            encoding,
        ))
    })
}

/// The stored codings an `Accept-Encoding` value admits, in preference order.
/// `q=0` refuses a coding; `*` is ignored (no browser sends it alone).
fn accepted_codings(header: &str) -> [Option<Encoding>; 2] {
    let (mut br, mut gzip) = (false, false);
    for item in header.split(',') {
        let mut parts = item.split(';');
        let name = parts.next().unwrap_or("").trim();
        let refused = parts.any(|param| {
            let param = param.trim();
            param
                .strip_prefix("q=")
                .or_else(|| param.strip_prefix("Q="))
                .and_then(|q| q.trim().parse::<f32>().ok())
                .is_some_and(|q| q <= 0.0)
        });
        if refused {
            continue;
        }
        if name.eq_ignore_ascii_case("br") {
            br = true;
        } else if name.eq_ignore_ascii_case("gzip") {
            gzip = true;
        }
    }
    [br.then_some(Encoding::Br), gzip.then_some(Encoding::Gzip)]
}

/// MIME type for an embedded asset, by extension.
fn content_type(rel: &str) -> &'static str {
    let ext = Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" => "text/html",
        "js" => "text/javascript",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "css" => "text/css",
        "map" => "application/json",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        _ => "application/octet-stream",
    }
}

/// Release identity and compatibility metadata stamped by the canonical build.
pub const RELEASE_ID: &str = env!("OMP_PULSE_RELEASE_ID");
/// Protocol metadata read from the repository-root `protocol-version.json` by
/// `build.rs`. Compile-time `u32` constants, one source, no runtime parsing.
pub const PROTOCOL_VERSION: u32 = protocol_value(env!("OMP_PULSE_PROTOCOL_VERSION"));
pub const MIN_CLIENT_PROTOCOL_VERSION: u32 =
    protocol_value(env!("OMP_PULSE_MIN_CLIENT_PROTOCOL_VERSION"));
pub const CAPABILITIES: &[&str] = &[
    "commandReceipts",
    "receipt-session-binding-v1",
    "deviceAuth",
    "activityEvidence",
    "offlineRecovery",
    "deepLinks",
    "notifications",
    "bubbles",
    "explicitUpdates",
];

/// Immutable release identity shared by the web client, daemon, and native shell.
pub fn build_id() -> &'static str {
    RELEASE_ID
}

/// Read one validated protocol number injected by `build.rs`. The value is a
/// decimal literal there, so the checks only guard a future reader that emits
/// something else.
const fn protocol_value(value: &str) -> u32 {
    let bytes = value.as_bytes();
    let mut index = 0;
    let mut number = 0u32;
    while index < bytes.len() {
        let byte = bytes[index];
        assert!(byte.is_ascii_digit(), "protocol metadata must be decimal");
        number = number * 10 + (byte - b'0') as u32;
        index += 1;
    }
    assert!(number > 0, "protocol metadata must be positive");
    number
}

/// Normalize a request path to a relative path inside the tree: strip
/// leading slashes, default "/" to "index.html", reject traversal.
/// `None` on reject. Splits on both separators so a Windows-style backslash
/// cannot smuggle `..` past the guard.
fn normalize(request_path: &str) -> Option<String> {
    let trimmed = request_path
        .trim_start_matches('/')
        .trim_start_matches('\\');
    let rel = if trimmed.is_empty() {
        "index.html"
    } else {
        trimmed
    };
    for comp in rel.split(['/', '\\']) {
        if comp == ".." {
            return None;
        }
    }
    Some(rel.to_string())
}

/// Whether `request_path` is a Vite content-hashed asset (`name-HASH.ext`).
///
/// INVARIANT: Vite's output is `name-HASH.ext` where `HASH` is 8 chars of
/// `[A-Za-z0-9_-]` (base64url). The hash may itself contain `-`/`_`, so the
/// last dash is NOT the separator — we check the suffix ` -[A-Za-z0-9_-]{8}\.ext`
/// instead. A `.map` double-extension (`foo-HASH.js.map`) is handled by
/// stripping the outer `.map` first, so the hash is still before `.js`.
/// Anything that does not positively match is NOT hashed, so it gets `no-cache`
/// — erring toward `no-cache` prevents a stale shell from sticking.
pub fn is_hashed_asset(request_path: &str) -> bool {
    // basename after last slash — "/assets/index-TkH_5bb3.js" -> "index-TkH_5bb3.js"
    let name = request_path.rsplit('/').next().unwrap_or("");
    if name.is_empty() {
        return false;
    }
    // Strip outer `.map` for `*.js.map` / `*.css.map` — the hash is before `.js`,
    // e.g. "abap-BF8NL95m.js.map" -> "abap-BF8NL95m.js".
    let effective = name.strip_suffix(".map").unwrap_or(name);
    let dot = match effective.rfind('.') {
        Some(p) => p,
        None => return false,
    };
    let stem = &effective[..dot];
    if stem.len() < 9 {
        return false;
    }
    let hash = &stem[stem.len() - 8..];
    let sep = &stem[stem.len() - 9..stem.len() - 8];
    if sep != "-" {
        return false;
    }
    // Every hash char must be base64url.
    if !hash
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return false;
    }
    // Require a name before the separator — `stem.len() >= 9` already guarantees
    // at least one char, but be explicit that "-HASH" alone is not an asset.
    !stem[..stem.len() - 9].is_empty()
}

/// Cache-Control for an embedded UI path (web-path form: "/", "/sw.js",
/// "/assets/index-TkH_5bb3.js"). Shell entries that must revalidate every load
/// are `no-cache` so a deploy is picked up; content-hashed Vite assets are
/// `public, max-age=31536000, immutable`. Anything unrecognised is `no-cache`
/// — getting this backwards strands the owner on a stale shell, so we err
/// toward `no-cache`.
pub fn cache_control(request_path: &str) -> &'static str {
    // Shell — must revalidate. Be tolerant of missing leading slash because
    // `lookup`/`read` accept both forms.
    match request_path {
        "/app/"
        | "app/"
        | "/app/index.html"
        | "app/index.html"
        | "/app/sw.js"
        | "app/sw.js"
        | "/app/manifest.webmanifest"
        | "app/manifest.webmanifest" => return "no-cache",
        _ => {}
    }
    if is_hashed_asset(request_path) {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

/// Read a file from the override directory, refusing anything that would
/// escape it. Symlink-safe: both sides are canonicalized and the target must
/// stay under the base.
fn read_from_dir(dir: &Path, rel: &str) -> Option<Vec<u8>> {
    let base = dir.canonicalize().ok()?;
    let target = base.join(rel);
    let real = target.canonicalize().ok()?;
    if real != base && !real.starts_with(&base) {
        return None;
    }
    std::fs::read(&real).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    static OVERRIDE_LOCK: Mutex<()> = Mutex::new(());
    fn lock_override() -> MutexGuard<'static, ()> {
        OVERRIDE_LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    #[test]
    fn capabilities_advertise_complete_receipt_session_binding_v1() {
        assert!(CAPABILITIES.contains(&"commandReceipts"));
        assert!(CAPABILITIES.contains(&"receipt-session-binding-v1"));
        assert_eq!(
            CAPABILITIES
                .iter()
                .filter(|value| **value == "receipt-session-binding-v1")
                .count(),
            1
        );
    }

    #[test]
    fn lookup_serves_index_and_known_types() {
        // The React client is the only shell: root paths ("/", "/sw.js",
        // "/vendor/…") resolve to nothing — "/" redirects to "/app/" at the
        // router.
        assert!(lookup("/").is_none());
        assert!(lookup("").is_none());
        let (bytes, ctype) = lookup("/app/").unwrap();
        assert_eq!(ctype, "text/html");
        let text = String::from_utf8_lossy(bytes);
        assert!(text.contains("<html"), "app shell must embed the real app");
        assert!(bytes.len() > 1000);
        assert_eq!(lookup("/app/sw.js").unwrap().1, "text/javascript");
        // No leading slash is fine (the axum wildcard passes rel without it).
        assert_eq!(lookup("app/sw.js").unwrap().1, "text/javascript");
        assert_eq!(
            lookup("/app/manifest.webmanifest").unwrap().1,
            "application/manifest+json"
        );
        assert_eq!(lookup("/app/icon-192.png").unwrap().1, "image/png");
        assert_eq!(lookup("/app/icon.svg").unwrap().1, "image/svg+xml");
    }

    #[test]
    fn lookup_resolves_a_directory_to_its_index() {
        // The React client is embedded at `public/app/`, and the daemon serves
        // it so the phone has a URL that is up whenever the daemon is. Before
        // this, a nested app needed a separate static server; the one we had
        // was an unsupervised Node process, and it was found dead while the
        // Android APK pointed straight at it.
        for path in ["/app/", "/app"] {
            let (bytes, ctype) = lookup(path).unwrap_or_else(|| panic!("{path} must resolve"));
            assert_eq!(ctype, "text/html", "{path} must be typed as HTML");
            let text = String::from_utf8_lossy(bytes);
            assert!(text.contains("<html"), "{path} must serve the app shell");
        }
        // An exact file still wins over the directory-index fallback.
        assert_eq!(lookup("/app/sw.js").unwrap().1, "text/javascript");
    }

    #[test]
    fn lookup_rejects_traversal_and_missing() {
        assert!(lookup("/../etc/passwd").is_none());
        assert!(lookup("..").is_none());
        assert!(lookup("../../etc/passwd").is_none());
        assert!(lookup("/nope.js").is_none());
        // "" and "/" mean the (removed) root index: both miss now.
        assert!(lookup("").is_none());
        assert!(lookup("/").is_none());
    }

    #[test]
    fn override_dir_takes_precedence_and_falls_back() {
        let _g = lock_override();
        let dir =
            std::env::temp_dir().join(format!("omp-pulse-assets-override-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // The override mirrors the tree: app shell files live under `app/`.
        std::fs::create_dir_all(dir.join("app")).unwrap();
        std::fs::write(dir.join("app").join("sw.js"), b"console.log('dev');").unwrap();

        set_override_dir(Some(dir.clone()));
        let (bytes, ctype) = read("/app/sw.js").unwrap();
        assert_eq!(bytes.as_ref(), &b"console.log('dev');"[..]);
        assert_eq!(ctype, "text/javascript");
        // Missing in the override -> embedded fallback.
        let (bytes, _) = read("/app/icon.svg").unwrap();
        assert!(!bytes.is_empty());
        // Traversal is refused at normalize() before the override is touched.
        assert!(read("/../etc/passwd").is_none());

        set_override_dir(None);
        let (bytes, _) = read("/app/sw.js").unwrap();
        assert_ne!(bytes.as_ref(), &b"console.log('dev');"[..]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn accept_encoding_prefers_brotli_and_honours_refusals() {
        use Encoding::{Br, Gzip};
        // Chrome over HTTPS, and over plain http (no br).
        assert_eq!(
            accepted_codings("gzip, deflate, br, zstd"),
            [Some(Br), Some(Gzip)]
        );
        assert_eq!(accepted_codings("gzip, deflate"), [None, Some(Gzip)]);
        assert_eq!(accepted_codings("BR;q=0.5"), [Some(Br), None]);
        assert_eq!(accepted_codings("br;q=0, gzip"), [None, Some(Gzip)]);
        assert_eq!(accepted_codings("gzip; q=0.0"), [None, None]);
        // Loopback requests reach the handler with the header stripped.
        assert_eq!(accepted_codings(""), [None, None]);
        assert_eq!(accepted_codings("identity, *"), [None, None]);
    }

    #[test]
    fn an_override_dir_is_always_served_identity() {
        let _g = lock_override();
        let dir =
            std::env::temp_dir().join(format!("omp-pulse-assets-precomp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        set_override_dir(Some(dir.clone()));
        // The embedded sidecars describe the embedded file, not the live one.
        assert!(read_precompressed("/app/", "br, gzip").is_none());
        set_override_dir(None);
        assert!(read_precompressed("/nope.js", "br, gzip").is_none());
        assert!(read_precompressed("/../etc/passwd", "gzip").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
