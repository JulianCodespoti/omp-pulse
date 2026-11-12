//! Loopback-direct requests: a client on this machine talking straight to the
//! daemon gets identity bodies and no raw-deflate socket frames.

use super::*;
use crate::server::ws::ClientCaps;
use axum::{
    http::{HeaderMap, header},
    middleware,
    response::Response,
};

/// True when the daemon binds the loopback interface only. The default bind is
/// 127.0.0.1; a tailnet/LAN IP or 0.0.0.0 is not loopback-only. The accepted
/// set mirrors the one omp's relay-link builder permits for plain ws://
/// (localhost, 127.0.0.1, ::1, [::1] — see main.rs), so a loopback answer
/// here means the phone cannot reach this daemon without a tunnel.
pub(super) fn bind_is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "::1" | "[::1]" | "localhost")
}

/// The host part of a `Host` header value: `127.0.0.1:7681` → `127.0.0.1`,
/// `[::1]:7681` → `[::1]`, `localhost` → `localhost`.
fn host_name(host: &str) -> &str {
    if let Some(end) = host.strip_prefix('[').and_then(|rest| rest.find(']')) {
        return &host[..end + 2];
    }
    host.rsplit_once(':').map_or(host, |(name, _)| name)
}

/// True when a request came straight from this machine: its `Host` names a
/// loopback address and no proxy forwarded it. Such a client is the phone's
/// own WebView talking to its own daemon over loopback, where bytes cost
/// nothing and compression is pure CPU on both ends. Measured in a phone's
/// proot guest (2026-10-14): the 420 KB main JS chunk took 2 ms identity and 33 ms
/// gzip; a 258 KB history page 21–64 ms identity and 71–114 ms gzip.
///
/// A reverse proxy (`tailscale serve`, nginx) also connects from loopback, so
/// the peer address cannot decide this: a proxied request carries the public
/// host and a forwarding header, and keeps its compression. A remote client
/// that forges `Host: 127.0.0.1` only switches its own compression off.
fn is_local_direct(headers: &HeaderMap) -> bool {
    const FORWARDED: [&str; 3] = ["forwarded", "x-forwarded-for", "x-forwarded-host"];
    if FORWARDED.iter().any(|name| headers.contains_key(*name)) {
        return false;
    }
    headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|host| bind_is_loopback(host_name(host)))
}

/// Local-direct requests are served identity bodies: dropping
/// `Accept-Encoding` before the per-route `CompressionLayer`s see the request
/// is what turns compression off for them (see [`is_local_direct`]).
pub(super) async fn identity_for_local_direct(
    mut req: axum::extract::Request,
    next: middleware::Next,
) -> Response {
    if is_local_direct(req.headers()) {
        req.headers_mut().remove(header::ACCEPT_ENCODING);
    }
    next.run(req).await
}

/// The client's advertised socket capabilities, minus raw-deflate frames for a
/// local-direct client: on loopback the deflate (daemon) and the async
/// `DecompressionStream` (WebView) are CPU spent to save bytes that are free.
pub(super) fn socket_caps(raw: Option<&str>, headers: &HeaderMap) -> ClientCaps {
    let mut caps = parse_caps(raw);
    if is_local_direct(headers) {
        caps.deflate = false;
    }
    caps
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_is_loopback_only_for_loopback_hosts() {
        // The default bind is 127.0.0.1; the accepted set mirrors what omp's
        // relay-link builder allows for plain ws:// (see main.rs).
        assert!(bind_is_loopback("127.0.0.1"));
        assert!(bind_is_loopback("::1"));
        assert!(bind_is_loopback("[::1]"));
        assert!(bind_is_loopback("localhost"));
        assert!(!bind_is_loopback("0.0.0.0"));
        assert!(!bind_is_loopback("::"));
        assert!(!bind_is_loopback("100.64.0.1"));
        assert!(!bind_is_loopback(""));
    }

    fn host_headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(*name, value.parse().unwrap());
        }
        headers
    }

    #[test]
    fn host_name_strips_port() {
        assert_eq!(host_name("127.0.0.1:7681"), "127.0.0.1");
        assert_eq!(host_name("[::1]:7681"), "[::1]");
        assert_eq!(host_name("[::1]"), "[::1]");
        assert_eq!(host_name("localhost"), "localhost");
        assert_eq!(
            host_name("phone.tail1234.ts.net:443"),
            "phone.tail1234.ts.net"
        );
    }

    #[test]
    fn local_direct_needs_loopback_host_and_no_proxy() {
        assert!(is_local_direct(&host_headers(&[(
            "host",
            "127.0.0.1:7681"
        )])));
        assert!(is_local_direct(&host_headers(&[(
            "host",
            "localhost:7681"
        )])));
        assert!(is_local_direct(&host_headers(&[("host", "[::1]:7681")])));
        // No Host at all (HTTP/1.0, test clients): keep compression.
        assert!(!is_local_direct(&HeaderMap::new()));
        // A phone on the tailnet or LAN.
        assert!(!is_local_direct(&host_headers(&[(
            "host",
            "100.64.0.1:7681"
        )])));
        assert!(!is_local_direct(&host_headers(&[(
            "host",
            "laptop.tail1234.ts.net"
        )])));
        // A reverse proxy on this machine that keeps the loopback Host still
        // names a remote client in its forwarding header.
        for proxy in ["x-forwarded-for", "forwarded", "x-forwarded-host"] {
            assert!(
                !is_local_direct(&host_headers(&[
                    ("host", "127.0.0.1:7681"),
                    (proxy, "100.64.0.9")
                ])),
                "{proxy}"
            );
        }
    }

    #[test]
    fn socket_caps_drop_deflate_only_for_local_direct() {
        let local = host_headers(&[("host", "127.0.0.1:7681")]);
        let caps = socket_caps(Some("delta,defl,bundle"), &local);
        assert!(caps.delta && !caps.deflate && caps.bundle);
        let remote = host_headers(&[("host", "100.64.0.1:7681")]);
        let caps = socket_caps(Some("delta,defl,bundle"), &remote);
        assert!(caps.delta && caps.deflate && caps.bundle);
    }

    /// The layer order is the behaviour: the identity middleware must run
    /// before a route's CompressionLayer reads `Accept-Encoding`. Exercised
    /// through a real socket so `Host` arrives exactly as a client sends it.
    #[tokio::test]
    async fn local_direct_responses_are_not_compressed() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let body = "x".repeat(4096);
        let app: Router = Router::new()
            .route(
                "/a",
                get(move || async move { body }).layer(CompressionLayer::new()),
            )
            .layer(middleware::from_fn(identity_for_local_direct));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let fetch = move |extra: &'static str| async move {
            let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
            let request = format!(
                "GET /a HTTP/1.1\r\n{extra}Accept-Encoding: gzip\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut raw = Vec::new();
            stream.read_to_end(&mut raw).await.unwrap();
            let text = String::from_utf8_lossy(&raw).to_ascii_lowercase();
            let head = text.split("\r\n\r\n").next().unwrap_or("").to_string();
            head.contains("content-encoding: gzip")
        };
        assert!(!fetch("Host: 127.0.0.1:7681\r\n").await, "loopback WebView");
        assert!(fetch("Host: 100.64.0.1:7681\r\n").await, "tailnet phone");
        assert!(
            fetch("Host: 127.0.0.1:7681\r\nX-Forwarded-For: 100.64.0.9\r\n").await,
            "proxied phone"
        );
        server.abort();
    }
}
