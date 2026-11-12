use super::*;

#[tokio::test]
async fn over_limit_bodies_get_a_json_413() {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let app = Router::new()
        .route(
            "/prompt",
            post(|body: Option<Json<Value>>| async move {
                json_response(StatusCode::OK, body_value(body))
            })
            .route_layer(middleware::from_fn(json_payload_limit))
            .layer(DefaultBodyLimit::max(MAX_BASE64_JSON_BODY)),
        )
        .route(
            "/text413",
            post(|| async {
                (StatusCode::PAYLOAD_TOO_LARGE, "length limit exceeded").into_response()
            })
            .route_layer(middleware::from_fn(json_payload_limit)),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    async fn send(address: std::net::SocketAddr, path: &str, length: usize, body: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let head = format!(
            "POST {path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n{body}"
        );
        stream.write_all(head.as_bytes()).await.unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).await.unwrap();
        out
    }
    // Several camera photos (well past axum's 2 MiB default) still fit.
    const { assert!(MAX_BASE64_JSON_BODY > 40 * 1024 * 1024) };
    let declared_over = send(address, "/prompt", MAX_BASE64_JSON_BODY + 1, "").await;
    assert!(declared_over.starts_with("HTTP/1.1 413"), "{declared_over}");
    assert!(declared_over.contains("\"code\":\"payload_too_large\""));
    assert!(declared_over.contains(PAYLOAD_TOO_LARGE_COPY));
    let mapped = send(address, "/text413", 2, "{}").await;
    assert!(mapped.starts_with("HTTP/1.1 413"), "{mapped}");
    assert!(mapped.contains("\"code\":\"payload_too_large\""));
    let ok = send(address, "/prompt", 11, "{\"a\":\"bcd\"}").await;
    assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
}

#[tokio::test]
async fn index_route_redirects_to_app() {
    // The legacy root client is gone: "/" must redirect to the React
    // client, never 404 and never serve a shell.
    let res = static_index().await;
    assert_eq!(res.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        res.headers().get("location").and_then(|v| v.to_str().ok()),
        Some("/app/")
    );
}

#[test]
fn cache_control_policy() {
    // Shell and unhashed assets revalidate every load; only Vite's
    // `name-HASH.ext` shape is `immutable`. Anything else is conservatively
    // `no-cache` — a false `immutable` would strand the owner on a stale
    // shell, so we err toward `no-cache`.
    let cases = [
        ("/", "no-cache"),
        ("/index.html", "no-cache"),
        ("/sw.js", "no-cache"),
        ("/manifest.webmanifest", "no-cache"),
        // Unhashed assets — even with extensions that look cacheable — are
        // not immutable (conservative fallback).
        ("/app.js", "no-cache"),
        ("/icon.png", "no-cache"),
        ("/assets/foo.css", "no-cache"),
        // Vite hashed shape: name-HASH.ext where HASH is 8 base64url chars.
        (
            "/assets/index-TkH_5bb3.js",
            "public, max-age=31536000, immutable",
        ),
        (
            "/assets/index-CJ58UX0p.css",
            "public, max-age=31536000, immutable",
        ),
        // .js.map double extension — hash still before .js
        (
            "/assets/index-TkH_5bb3.js.map",
            "public, max-age=31536000, immutable",
        ),
        // Hash may contain '-'/'_' — still 8 chars, still immutable.
        (
            "/assets/zig-apmbPCW-.js",
            "public, max-age=31536000, immutable",
        ),
    ];
    for (path, expect) in cases {
        assert_eq!(
            assets::cache_control(path),
            expect,
            "cache-control for {path}"
        );
    }
}

mod receipt_binding;
