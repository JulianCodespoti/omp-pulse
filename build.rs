//! Rebuild triggers for the assets embedded into the binary.
//!
//! `src/server/assets.rs` embeds the whole `public/` tree with
//! `include_dir!("$CARGO_MANIFEST_DIR/public")`. That macro reads the directory
//! at compile time, but cargo tracks only files it can see through the module
//! graph — it has no idea `public/` is an input. Without the directive below,
//! changing or adding a file under `public/` does NOT trigger a rebuild, and
//! the binary keeps serving whatever was embedded the last time some unrelated
//! `.rs` file happened to change.
//!
//! That bit for real: a freshly built `public/app-release.apk` returned 404
//! while the months-old `app-debug.apk` still served, because no Rust source
//! had changed and cargo skipped the compile entirely.
//!
//! INVARIANT: any directory embedded at compile time must be declared here.

use std::path::Path;

fn main() {
    // include_dir! reads the tree at compile time; cargo does not recurse into
    // it without explicit directives.
    println!("cargo:rerun-if-changed=public");
    watch_tree(Path::new("public"));
    println!("cargo:rerun-if-changed=extensions");
    watch_tree(Path::new("extensions"));
    println!("cargo:rerun-if-env-changed=OMP_PULSE_RELEASE_ID");
    println!("cargo:rerun-if-changed=protocol-version.json");
    // Fail loudly when the web client has not been built.
    //
    // `include_dir!` happily embeds a `public/` that has no `app/` in it, and
    // the result is a daemon that answers 404 for /app/ — the phone's actual
    // URL. That is a silent break: the build is green, the daemon starts, and
    // only the phone notices. The whole class of "embedded assets are quietly
    // stale" already cost real time once (a fresh APK 404'd while a months-old
    // one still downloaded), so it gets an error rather than a comment.
    if !Path::new("public/app/index.html").exists() {
        panic!(
            "public/app/index.html is missing — the web client has not been built.\n\
             The daemon embeds public/ at COMPILE time, so building now would produce \
             a binary that 404s /app/ on the phone while looking healthy.\n\
             Run ./scripts/pulse-deploy.sh (or, web only:\n\
             cd web && npx vite build --base=./ --outDir ../public/app --emptyOutDir --sourcemap false)"
        );
    }
    // The identity belongs to the release unit that produced these assets.
    // Recomputing it here used a different hash than the deploy script, so an
    // ordinary cargo invocation after deployment silently changed the daemon's
    // identity while embedding the exact same web client.
    let release_id = std::fs::read_to_string("public/app/release-id")
        .expect("public/app/release-id is missing; rebuild the web client with scripts/deploy/pulse-deploy.sh --no-restart");
    let release_id = release_id.trim();
    assert!(
        !release_id.is_empty()
            && release_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')),
        "invalid embedded release identity"
    );
    if let Ok(requested) = std::env::var("OMP_PULSE_RELEASE_ID") {
        assert_eq!(
            requested.trim(),
            release_id,
            "daemon and embedded client identities differ; run the canonical deploy pipeline"
        );
    }
    println!("cargo:rustc-env=OMP_PULSE_RELEASE_ID={release_id}");

    // Protocol numbers come from one file, `protocol-version.json`, shared with
    // Gradle, the deploy manifest and the web build. They are emitted as
    // compile-time constants so `src/server/assets.rs` keeps plain `u32` values and a
    // malformed file fails the build instead of shipping a mismatched client.
    let (protocol_version, min_client_protocol_version) = read_protocol_metadata();
    println!("cargo:rustc-env=OMP_PULSE_PROTOCOL_VERSION={protocol_version}");
    println!("cargo:rustc-env=OMP_PULSE_MIN_CLIENT_PROTOCOL_VERSION={min_client_protocol_version}");
}

fn watch_tree(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        println!("cargo:rerun-if-changed={}", path.display());
        if path.is_dir() {
            watch_tree(&path);
        }
    }
}

/// Read `protocol-version.json` and check the shape the runtime depends on.
///
/// The file is the single authority for the protocol numbers, so every reader
/// (this script, Gradle, the deploy manifest, Vite) validates it the same way:
/// exactly two positive integers, and a minimum no greater than the version it
/// accepts. A build that reads it wrong must stop here, not ship a daemon that
/// reports a protocol no client can speak.
fn read_protocol_metadata() -> (u32, u32) {
    let raw = std::fs::read_to_string("protocol-version.json")
        .expect("protocol-version.json is missing; it is the single source for protocol numbers");
    let value: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|error| panic!("protocol-version.json is not valid JSON: {error}"));
    let object = value
        .as_object()
        .unwrap_or_else(|| panic!("protocol-version.json must be a JSON object"));
    assert!(
        object.len() == 2
            && object.contains_key("protocolVersion")
            && object.contains_key("minClientProtocolVersion"),
        "protocol-version.json must contain exactly protocolVersion and minClientProtocolVersion"
    );
    let read = |key: &str| -> u32 {
        let number = object
            .get(key)
            .unwrap_or_else(|| panic!("protocol-version.json is missing {key}"))
            .as_u64()
            .unwrap_or_else(|| panic!("{key} in protocol-version.json must be a positive integer"));
        u32::try_from(number)
            .unwrap_or_else(|_| panic!("{key} in protocol-version.json does not fit in u32"))
    };
    let protocol_version = read("protocolVersion");
    let min_client_protocol_version = read("minClientProtocolVersion");
    assert!(protocol_version > 0, "protocolVersion must be positive");
    assert!(
        min_client_protocol_version > 0,
        "minClientProtocolVersion must be positive"
    );
    assert!(
        min_client_protocol_version <= protocol_version,
        "minClientProtocolVersion must not exceed protocolVersion"
    );
    (protocol_version, min_client_protocol_version)
}
