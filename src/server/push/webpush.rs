//! Web Push implemented in-house: RFC 8291 payload encryption in RFC 8188
//! records, VAPID (RFC 8292) authorization and the notification payload.

use std::time::{SystemTime, UNIX_EPOCH};

use aes_gcm::aead::Aead;
use aes_gcm::aead::array::typenum::U12;
use aes_gcm::{Aes128Gcm, Key, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hkdf::Hkdf;
use hkdf::hmac::{Hmac, KeyInit, Mac};
use p256::PublicKey;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{SigningKey, VerifyingKey};
use p256::elliptic_curve::point::AffineCoordinates;
use p256::elliptic_curve::rand_core::{OsRng, RngCore};
use serde_json::{Value, json};
use sha2::Sha256;

/// VAPID `sub` claim. Kept byte-identical to the old client so push services
/// see the same contact they did before.
const VAPID_SUB: &str = "mailto:omp@localhost";
/// VAPID JWT lifetime: 12 hours (web-push's default).
const VAPID_EXPIRY_SECS: u64 = 12 * 60 * 60;
/// RFC 8188 record size. Push is always a single record; rs must exceed
/// plaintext + padding delimiter + tag (RFC 8291 §4), which 4096 always
/// does for our notification payloads.
const RECORD_SIZE: u32 = 4096;
/// Length of the `idlen`/`keyid` fields in the aes128gcm header: the
/// 65-byte uncompressed P-256 point (RFC 8291 §4 mandates this form).
const AS_PUBLIC_LEN: usize = 65;

/// The JSON payload sent to the push service: `{title, body, sessionPath,
/// kind, tag}` plus an OPTIONAL `reqId` (a blocking dialog's id) when one is
/// known. The `tag` (`omp-<kind>-<hash(sessionPath)>`) lets the service
/// worker replace only notifications of the same kind for the same session.
/// Split out of `notify` so the exact wire shape is unit-testable without an
/// HTTP round-trip.
pub(super) fn push_payload(
    title: &str,
    body: &str,
    session_path: &str,
    kind: &str,
    req_id: Option<u64>,
) -> Value {
    let mut payload = json!({
        "title": title,
        "body": body,
        "sessionPath": session_path,
        "kind": kind,
        "tag": format!("omp-{kind}-{:x}", fnv1a(session_path)),
    });
    if let Some(id) = req_id {
        payload["reqId"] = json!(id);
    }
    payload
}

/// FNV-1a hash of a string — a stable, dependency-free fingerprint used to
/// scope push `tag`s per session (`omp-<kind>-<hash>`), so notifications for
/// different sessions or kinds never replace each other in the service worker.
fn fnv1a(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// A fresh VAPID keypair as the on-disk JSON shape (`publicKey`/`privateKey`,
/// base64url-unpadded), for first-run setup only.
///
/// VAPID uses P-256: the public key is the 65-byte uncompressed SEC1 point, the
/// private key the 32-byte scalar — the same encoding the existing key file and
/// every subscribed browser expect.
pub(super) fn generate_vapid_file() -> Result<String, String> {
    let mut rng = OsRng;
    let secret = SigningKey::random(&mut rng);
    let private = URL_SAFE_NO_PAD.encode(secret.to_bytes());
    let public = URL_SAFE_NO_PAD.encode(
        VerifyingKey::from(&secret)
            .to_encoded_point(false)
            .as_bytes(),
    );
    serde_json::to_string_pretty(&json!({ "publicKey": public, "privateKey": private }))
        .map_err(|e| format!("cannot serialise generated vapid keys: {e}"))
}

/// Decode a base64url string, tolerating either padding style. Browsers emit
/// unpadded base64url; nothing we read pads, but stripping `=` keeps the
/// decoder lenient for hand-edited stores.
fn decode_b64url(s: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(s.trim_end_matches('='))
        .map_err(|e| format!("invalid base64url: {e}"))
}

/// Base64url-unpadded encoding, used for every JWT segment and the VAPID key.
pub(super) fn b64url_encode(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(data)
}

/// Parse the stored VAPID private key (a base64url 32-byte scalar).
pub(super) fn parse_vapid_signing_key(private_key_b64: &str) -> Result<SigningKey, String> {
    let bytes = decode_b64url(private_key_b64)?;
    SigningKey::from_slice(&bytes).map_err(|e| format!("invalid vapid private key: {e}"))
}

/// The RFC 6454 origin of a push endpoint URL, used as the VAPID `aud` claim.
///
/// Parsed by hand (no `url` crate in the tree): scheme, then the authority up
/// to the first `/`, `?` or `#`, dropping the scheme's default port — the same
/// result the old web-push crate got from `Url::origin()`.
pub(super) fn origin_of_endpoint(endpoint: &str) -> Option<String> {
    let (scheme, rest) = if let Some(r) = endpoint.strip_prefix("https://") {
        ("https", r)
    } else {
        ("http", endpoint.strip_prefix("http://")?)
    };
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() {
        return None;
    }
    let default_port =
        |port: &str| (scheme == "https" && port == "443") || (scheme == "http" && port == "80");
    let origin = if let Some(close) = authority.find(']') {
        // Bracketed IPv6 literal, optionally followed by ":port".
        let host = &authority[..=close];
        let after = &authority[close + 1..];
        if let Some(port) = after.strip_prefix(':') {
            if default_port(port) {
                format!("{scheme}://{host}")
            } else {
                format!("{scheme}://{host}:{port}")
            }
        } else if after.is_empty() {
            format!("{scheme}://{host}")
        } else {
            return None;
        }
    } else if let Some((host, port)) = authority.rsplit_once(':') {
        if default_port(port) {
            format!("{scheme}://{host}")
        } else {
            format!("{scheme}://{host}:{port}")
        }
    } else {
        format!("{scheme}://{authority}")
    };
    Some(origin)
}

/// Build the `Authorization: vapid t=<jwt>,k=<key>` header (RFC 8292) for a
/// subscription whose origin is already known. The `sub` claim and the
/// 12-hour `exp` match the old web-push client exactly.
pub(super) fn vapid_authorization(vapid_key: &SigningKey, origin: &str) -> Result<String, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("system clock before unix epoch: {e}"))?
        .as_secs();
    let header = b64url_encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let payload_json = serde_json::to_vec(&json!({
        "aud": origin,
        "exp": now + VAPID_EXPIRY_SECS,
        "sub": VAPID_SUB,
    }))
    .map_err(|e| format!("cannot serialise vapid claims: {e}"))?;
    let payload = b64url_encode(&payload_json);
    let signing_input = format!("{header}.{payload}");
    // ES256 = ECDSA over P-256 with SHA-256. JWS requires the signature as the
    // raw 64-byte r||s concatenation, which is exactly what
    // `Signature::to_bytes()` yields (DER is a separate method here). The
    // annotation picks the raw `Signature` impl: `SigningKey` also implements
    // `Signer` for the DER signature type when the `der` feature is on.
    let signature: p256::ecdsa::Signature = vapid_key
        .try_sign(signing_input.as_bytes())
        .map_err(|e| format!("es256 signing failed: {e}"))?;
    let public_point = VerifyingKey::from(vapid_key).to_encoded_point(false);
    Ok(format!(
        "vapid t={header}.{payload}.{},k={}",
        b64url_encode(signature.to_bytes().as_slice()),
        b64url_encode(public_point.as_bytes())
    ))
}

/// Pull `endpoint`, `keys.p256dh` and `keys.auth` out of a browser
/// `PushSubscription.toJSON()` object — the same three fields the old serde
/// `SubscriptionInfo` deserialized.
pub(super) fn subscription_keys(subscription: &Value) -> Option<(String, String, String)> {
    let endpoint = subscription.get("endpoint")?.as_str()?.to_string();
    let keys = subscription.get("keys")?;
    let p256dh = keys.get("p256dh")?.as_str()?.to_string();
    let auth = keys.get("auth")?.as_str()?.to_string();
    Some((endpoint, p256dh, auth))
}

/// RFC 8188 §2 record padding. Push messages are a single record and the
/// final record may be shorter than `rs`, so only the 0x02 padding delimiter
/// is appended — no zero padding. RFC 8291 §5's example does exactly this
/// (42-octet padded plaintext, unaligned) and receivers strip trailing
/// zeros, so minimal padding is both conformant and interoperable.
fn pad_record(payload: &[u8]) -> Vec<u8> {
    let mut padded = Vec::with_capacity(payload.len() + 1);
    padded.extend_from_slice(payload);
    padded.push(0x02);
    padded
}

/// One-shot HMAC-SHA-256 — the only MAC primitive RFC 8291 needs; its "HKDF"
/// steps are chained single-block HMACs (see §3.4).
fn hmac_sha256(key: &[u8], message: &[u8]) -> Result<[u8; 32], String> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(key).map_err(|e| format!("invalid hmac key length: {e}"))?;
    mac.update(message);
    let output = mac.finalize().into_bytes();
    let mut result = [0u8; 32];
    result.copy_from_slice(&output);
    Ok(result)
}

/// ECDH on P-256 (RFC 8291 §3.1): the x-coordinate of
/// `as_private * ua_public`, as a 32-byte field element.
///
/// Done by hand with p256's `arithmetic` because the `ecdh` feature is not
/// enabled in the frozen Cargo.toml — this replicates what
/// `elliptic_curve::ecdh::diffie_hellman` does internally (scalar multiply,
/// then take the affine x-coordinate), which the RFC vector test proves
/// byte-for-byte.
fn ecdh_shared_secret(as_key: &SigningKey, ua_public: &[u8]) -> Result<[u8; 32], String> {
    let ua_pub = PublicKey::from_sec1_bytes(ua_public)
        .map_err(|e| format!("invalid subscription public key: {e}"))?;
    let shared_projective = p256::AffinePoint::from(ua_pub) * as_key.as_nonzero_scalar().as_ref();
    let shared = p256::AffinePoint::from(&shared_projective);
    let x = shared.x();
    let mut out = [0u8; 32];
    out.copy_from_slice(&x);
    Ok(out)
}

/// Encrypt `payload` with a FIXED application-server key and salt, returning
/// the complete aes128gcm message body: `salt(16) || rs(4, BE, 4096) ||
/// idlen(1, 65) || as_public(65) || ciphertext`.
///
/// Key schedule per RFC 8291 §3.4 — note that the ECDH secret and the auth
/// secret are combined with HKDF-Extract *then* HKDF-Expand (`PRK_key =
/// HMAC(auth_secret, ecdh_secret)`, then `IKM = HMAC(PRK_key, key_info ||
/// 0x01)`); a single HMAC over `key_info` (an earlier draft's formula)
/// produces a different IKM and does not interop with browsers. The GCM
/// additional data is a zero-length sequence (RFC 8188 §2); the header is
/// not authenticated.
fn encrypt_with_keys(
    ua_public: &[u8],
    auth_secret: &[u8],
    payload: &[u8],
    as_key: &SigningKey,
    salt: &[u8; 16],
) -> Result<Vec<u8>, String> {
    let as_public = as_key.verifying_key().to_encoded_point(false);
    let as_public = as_public.as_bytes();

    // RFC 8291 §3.3-3.4: combine ECDH and auth secrets.
    let shared = ecdh_shared_secret(as_key, ua_public)?;
    let prk_key = hmac_sha256(auth_secret, &shared)?;
    let mut key_info = Vec::with_capacity(14 + AS_PUBLIC_LEN * 2);
    key_info.extend_from_slice(b"WebPush: info\x00");
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public);
    key_info.push(0x01); // HKDF-Expand counter for L_key = 32
    let ikm = hmac_sha256(&prk_key, &key_info)?;

    // RFC 8188 §2.2-2.3: CEK and nonce from the salt.
    let hk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    let mut nonce = [0u8; 12];
    hk.expand(b"Content-Encoding: aes128gcm\x00", &mut cek)
        .map_err(|e| format!("cek derivation failed: {e}"))?;
    hk.expand(b"Content-Encoding: nonce\x00", &mut nonce)
        .map_err(|e| format!("nonce derivation failed: {e}"))?;

    let padded = pad_record(payload);
    let key =
        Key::<Aes128Gcm>::try_from(&cek[..]).map_err(|e| format!("invalid aes key length: {e}"))?;
    let nonce_arr =
        Nonce::<U12>::try_from(&nonce[..]).map_err(|e| format!("invalid nonce length: {e}"))?;
    let cipher = Aes128Gcm::new(&key);
    let ciphertext = cipher
        .encrypt(&nonce_arr, padded.as_slice())
        .map_err(|e| format!("aes128gcm encrypt failed: {e}"))?;

    let mut body = Vec::with_capacity(21 + AS_PUBLIC_LEN + ciphertext.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(AS_PUBLIC_LEN as u8);
    body.extend_from_slice(as_public);
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

/// Encrypt `payload` for a subscription whose `p256dh`/`auth` are base64url
/// strings (browser `PushSubscription` keys), returning the complete
/// aes128gcm message body. A fresh ephemeral AS keypair and salt are
/// generated per message (RFC 8291 §2).
pub(super) fn encrypt_payload(p256dh: &str, auth: &str, payload: &[u8]) -> Result<Vec<u8>, String> {
    let ua_public = decode_b64url(p256dh)?;
    let auth_secret = decode_b64url(auth)?;
    if ua_public.len() != AS_PUBLIC_LEN {
        return Err(format!(
            "subscription p256dh must be {AS_PUBLIC_LEN} bytes, got {}",
            ua_public.len()
        ));
    }
    if auth_secret.len() != 16 {
        return Err(format!(
            "subscription auth secret must be 16 bytes, got {}",
            auth_secret.len()
        ));
    }
    let mut rng = OsRng;
    let as_key = SigningKey::random(&mut rng);
    let mut salt = [0u8; 16];
    rng.fill_bytes(&mut salt);
    encrypt_with_keys(&ua_public, &auth_secret, payload, &as_key, &salt)
}

/// Decode a base64url string (test helper).
#[cfg(test)]
fn b64url_decode(s: &str) -> Vec<u8> {
    URL_SAFE_NO_PAD
        .decode(s.trim_end_matches('='))
        .expect("valid base64url in test")
}

/// Receiver side of RFC 8291/8188 — what a browser does: derive the CEK and
/// nonce from the user-agent private key and decrypt the body, stripping the
/// 0x02 padding delimiter. Test-only: the daemon never decrypts.
#[cfg(test)]
fn decrypt_body(
    ua_private: &SigningKey,
    auth_secret: &[u8],
    body: &[u8],
) -> Result<Vec<u8>, String> {
    if body.len() < 21 + AS_PUBLIC_LEN + 16 {
        return Err(format!("body too short: {} bytes", body.len()));
    }
    let salt = &body[..16];
    let _rs = u32::from_be_bytes([body[16], body[17], body[18], body[19]]);
    let idlen = body[20] as usize;
    if idlen != AS_PUBLIC_LEN {
        return Err(format!("unexpected keyid length {idlen}"));
    }
    let as_public = &body[21..21 + idlen];
    let ciphertext = &body[21 + idlen..];

    // Receiver side of ECDH: ua_private * as_public must agree with the
    // sender's as_private * ua_public (asserted by the round-trip test).
    let shared = ecdh_shared_secret(ua_private, as_public)?;
    let ua_public = ua_private.verifying_key().to_encoded_point(false);
    let prk_key = hmac_sha256(auth_secret, &shared)?;
    let mut key_info = Vec::with_capacity(14 + AS_PUBLIC_LEN * 2);
    key_info.extend_from_slice(b"WebPush: info\x00");
    key_info.extend_from_slice(ua_public.as_bytes());
    key_info.extend_from_slice(as_public);
    key_info.push(0x01);
    let ikm = hmac_sha256(&prk_key, &key_info)?;

    let hk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    let mut nonce = [0u8; 12];
    hk.expand(b"Content-Encoding: aes128gcm\x00", &mut cek)
        .map_err(|e| format!("cek derivation failed: {e}"))?;
    hk.expand(b"Content-Encoding: nonce\x00", &mut nonce)
        .map_err(|e| format!("nonce derivation failed: {e}"))?;

    let key =
        Key::<Aes128Gcm>::try_from(&cek[..]).map_err(|e| format!("invalid aes key length: {e}"))?;
    let nonce_arr =
        Nonce::<U12>::try_from(&nonce[..]).map_err(|e| format!("invalid nonce length: {e}"))?;
    let cipher = Aes128Gcm::new(&key);
    let padded = cipher
        .decrypt(&nonce_arr, ciphertext)
        .map_err(|e| format!("decrypt failed: {e}"))?;
    // RFC 8188 §2: the padding delimiter is the last non-zero octet and MUST
    // be 0x02 on the final record; the content precedes it.
    let content_end = padded
        .iter()
        .rposition(|&b| b != 0)
        .ok_or_else(|| "no padding delimiter".to_string())?;
    if padded[content_end] != 0x02 {
        return Err("final record padding delimiter is not 0x02".to_string());
    }
    Ok(padded[..content_end].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::push::{
        KIND_AGENT_END, KIND_CHILD_DIED, KIND_LINK_LOST, KIND_NEEDS_INPUT, KIND_PROMPT_FAILED,
    };
    use p256::ecdsa::Signature;
    use p256::ecdsa::signature::Verifier;

    /// RFC 8291 §5 + Appendix A: every intermediate value and the final body,
    /// asserted byte-for-byte.
    #[test]
    fn rfc8291_vector_reproduces_exactly() {
        let ua_public = b64url_decode(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        );
        let ua_private = b64url_decode("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94");
        let as_private = b64url_decode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");
        let as_public = b64url_decode(
            "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
        );
        let salt: [u8; 16] = b64url_decode("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let auth = b64url_decode("BTBZMqHH6r4Tts7J_aSIgg");
        let plaintext = b"When I grow up, I want to be a watermelon";

        let as_key = SigningKey::from_slice(&as_private).unwrap();
        assert_eq!(
            as_key.verifying_key().to_encoded_point(false).as_bytes(),
            as_public.as_slice(),
            "derived AS public key must match the RFC's"
        );

        // ECDH shared secret (Appendix A: ecdh_secret).
        let ecdh_secret = ecdh_shared_secret(&as_key, &ua_public).unwrap();
        assert_eq!(
            b64url_encode(&ecdh_secret),
            "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs"
        );

        // PRK_key and IKM (Appendix A). RFC 8291 §3.4 combines the ECDH and
        // auth secrets with HKDF-Extract then HKDF-Expand; the single-HMAC
        // formula from an earlier draft yields a different IKM.
        let prk_key = hmac_sha256(&auth, &ecdh_secret).unwrap();
        assert_eq!(
            b64url_encode(&prk_key),
            "Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k"
        );
        let mut key_info = Vec::with_capacity(14 + AS_PUBLIC_LEN * 2);
        key_info.extend_from_slice(b"WebPush: info\x00");
        key_info.extend_from_slice(&ua_public);
        key_info.extend_from_slice(&as_public);
        let mut key_info_counter = key_info.clone();
        key_info_counter.push(0x01);
        let ikm = hmac_sha256(&prk_key, &key_info_counter).unwrap();
        assert_eq!(
            b64url_encode(&ikm),
            "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg"
        );

        // PRK / CEK / NONCE (Appendix A).
        let hk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
        let mut cek = [0u8; 16];
        let mut nonce = [0u8; 12];
        hk.expand(b"Content-Encoding: aes128gcm\x00", &mut cek)
            .unwrap();
        hk.expand(b"Content-Encoding: nonce\x00", &mut nonce)
            .unwrap();
        assert_eq!(b64url_encode(&cek), "oIhVW04MRdy2XN9CiKLxTg");
        assert_eq!(b64url_encode(&nonce), "4h_95klXJ5E_qnoN");

        // The production path with the RFC's fixed ephemeral key and salt must
        // reproduce the §5 body byte-for-byte.
        let body = encrypt_with_keys(&ua_public, &auth, plaintext, &as_key, &salt).unwrap();
        assert_eq!(
            b64url_encode(&body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );

        // The receiver side decrypts the RFC's own body back to the plaintext.
        let ua_key = SigningKey::from_slice(&ua_private).unwrap();
        assert_eq!(decrypt_body(&ua_key, &auth, &body).unwrap(), plaintext);
    }

    /// RFC 8188 framing: salt(16) || rs(4 BE 4096) || idlen(65) || key(65) ||
    /// ciphertext, and the plaintext carries the 0x02 delimiter.
    #[test]
    fn rfc8188_framing() {
        let ua_public = b64url_decode(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        );
        let auth = b"0123456789abcdef"; // 16 bytes
        let payload = b"hello";
        let as_key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let salt = [9u8; 16];

        let padded = pad_record(payload);
        assert_eq!(padded, b"hello\x02", "0x02 delimiter after the content");

        let body = encrypt_with_keys(&ua_public, auth, payload, &as_key, &salt).unwrap();
        assert_eq!(&body[..16], &salt, "salt leads the body");
        assert_eq!(
            u32::from_be_bytes(body[16..20].try_into().unwrap()),
            RECORD_SIZE,
            "rs is 4096, big-endian"
        );
        assert_eq!(body[20], AS_PUBLIC_LEN as u8, "idlen is 65");
        assert_eq!(
            &body[21..21 + AS_PUBLIC_LEN],
            as_key.verifying_key().to_encoded_point(false).as_bytes(),
            "keyid is the 65-byte AS public point"
        );
        assert_eq!(
            body.len(),
            21 + AS_PUBLIC_LEN + padded.len() + 16,
            "single record plus the GCM tag"
        );
    }

    /// Production encryption (random ephemeral key + salt) round-trips through
    /// the receiver side, and any tampering with the body breaks the tag.
    #[test]
    fn round_trip_decrypts_own_ciphertext() {
        let ua_private = SigningKey::from_slice(&[11u8; 32]).unwrap();
        let ua_public = ua_private
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec();
        let auth = b"authsecret123456"; // 16 bytes
        let payload = br#"{"title":"t","body":"b","sessionPath":"/s","kind":"agent_end","tag":"omp-agent_end-abc"}"#;

        let body =
            encrypt_payload(&b64url_encode(&ua_public), &b64url_encode(auth), payload).unwrap();
        assert_eq!(decrypt_body(&ua_private, auth, &body).unwrap(), payload);

        // Flip a byte in the ciphertext: tag check must fail.
        let mut tampered = body.clone();
        tampered[21 + AS_PUBLIC_LEN] ^= 0x01;
        assert!(decrypt_body(&ua_private, auth, &tampered).is_err());
        // Flip a byte in the salt: wrong CEK/nonce, tag check must fail.
        let mut tampered = body;
        tampered[5] ^= 0x01;
        assert!(decrypt_body(&ua_private, auth, &tampered).is_err());
    }

    /// VAPID JWT structure per RFC 8292: three base64url segments, ES256
    /// header, origin `aud`, future `exp` within 24h, raw 64-byte signature.
    #[test]
    fn vapid_jwt_structure() {
        let key = SigningKey::from_slice(&[3u8; 32]).unwrap();
        let endpoint = "https://fcm.example.com/fcm/send/abc123";
        let origin = origin_of_endpoint(endpoint).unwrap();
        let auth = vapid_authorization(&key, &origin).unwrap();

        let rest = auth.strip_prefix("vapid t=").expect("vapid header prefix");
        let (jwt, k) = rest.split_once(",k=").expect("k parameter present");
        let segments: Vec<&str> = jwt.split('.').collect();
        assert_eq!(segments.len(), 3, "JWT has exactly three segments");

        let header: Value = serde_json::from_slice(&b64url_decode(segments[0])).unwrap();
        assert_eq!(header, json!({"typ": "JWT", "alg": "ES256"}));

        let payload: Value = serde_json::from_slice(&b64url_decode(segments[1])).unwrap();
        assert_eq!(payload["aud"], "https://fcm.example.com");
        assert_eq!(payload["sub"], "mailto:omp@localhost");
        let exp = payload["exp"].as_u64().unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert!(exp > now, "exp must be in the future");
        assert!(exp - now <= 24 * 3600, "exp within 24h");

        // The signature is 64 raw bytes (r||s), NOT DER, and verifies.
        let sig_bytes = b64url_decode(segments[2]);
        assert_eq!(sig_bytes.len(), 64);
        let signature = Signature::from_slice(&sig_bytes).unwrap();
        let verifying_key = VerifyingKey::from(&key);
        verifying_key
            .verify(
                format!("{}.{}", segments[0], segments[1]).as_bytes(),
                &signature,
            )
            .expect("JWT signature must verify");

        // k is the base64url uncompressed public point matching the key.
        let k_bytes = b64url_decode(k);
        assert_eq!(k_bytes.len(), AS_PUBLIC_LEN);
        assert_eq!(k_bytes, verifying_key.to_encoded_point(false).as_bytes());
    }

    /// The VAPID `aud` claim is the endpoint origin, with default ports
    /// stripped and non-default ports kept (RFC 6454).
    #[test]
    fn vapid_aud_is_endpoint_origin() {
        let key = SigningKey::from_slice(&[5u8; 32]).unwrap();
        let aud_of = |endpoint: &str| -> String {
            let origin = origin_of_endpoint(endpoint).expect("parseable endpoint");
            let auth = vapid_authorization(&key, &origin).unwrap();
            let jwt = auth
                .strip_prefix("vapid t=")
                .unwrap()
                .split(",k=")
                .next()
                .unwrap();
            let payload: Value =
                serde_json::from_slice(&b64url_decode(jwt.split('.').nth(1).unwrap())).unwrap();
            payload["aud"].as_str().unwrap().to_string()
        };
        assert_eq!(
            aud_of("https://updates.example.com/wpush/v2/xyz"),
            "https://updates.example.com"
        );
        assert_eq!(
            aud_of("https://updates.example.com:443/wpush/v2/xyz"),
            "https://updates.example.com",
            "default https port is stripped"
        );
        assert_eq!(
            aud_of("https://updates.example.com:8443/wpush/v2/xyz"),
            "https://updates.example.com:8443",
            "non-default port is kept"
        );
        assert_eq!(
            aud_of("http://push.example.org/endpoint"),
            "http://push.example.org"
        );
        assert_eq!(
            aud_of("https://[2001:db8::1]:8443/push"),
            "https://[2001:db8::1]:8443"
        );
        assert_eq!(
            aud_of("https://[2001:db8::1]/push"),
            "https://[2001:db8::1]"
        );
        assert!(origin_of_endpoint("not-a-url").is_none());
        assert!(origin_of_endpoint("ftp://host/x").is_none());
    }

    /// The subscription fields the daemon needs survive a browser-shaped JSON
    /// object, and malformed objects are rejected.
    #[test]
    fn subscription_keys_extraction() {
        let sub = json!({
            "endpoint": "https://fcm.example.com/send/x",
            "expirationTime": null,
            "keys": {"p256dh": "BAAA", "auth": "BBBB"}
        });
        let (endpoint, p256dh, auth) = subscription_keys(&sub).unwrap();
        assert_eq!(endpoint, "https://fcm.example.com/send/x");
        assert_eq!(p256dh, "BAAA");
        assert_eq!(auth, "BBBB");

        assert!(subscription_keys(&json!({"endpoint": "https://x/"})).is_none());
        assert!(subscription_keys(&json!({"keys": {"p256dh": "x", "auth": "y"}})).is_none());
        assert!(subscription_keys(&json!({})).is_none());
    }

    /// Contract payload shape: exactly `{title, body, sessionPath, kind, tag}`
    /// plus the OPTIONAL numeric `reqId`, present only when a dialog id is
    /// known, and a per-kind per-session `tag`.
    #[test]
    fn payload_shape_with_and_without_req_id() {
        let p = push_payload("T", "B", "/s/x.jsonl", KIND_NEEDS_INPUT, None);
        assert_eq!(p["title"], "T");
        assert_eq!(p["body"], "B");
        assert_eq!(p["sessionPath"], "/s/x.jsonl");
        assert_eq!(p["kind"], KIND_NEEDS_INPUT);
        assert!(
            p.get("reqId").is_none(),
            "reqId is omitted entirely when unknown"
        );
        let tag = p["tag"].as_str().unwrap();
        assert!(
            tag.starts_with("omp-needs_input-"),
            "tag scopes replacement per kind per session: {tag}"
        );

        let p = push_payload("T", "B", "/s/x.jsonl", KIND_NEEDS_INPUT, Some(42));
        assert_eq!(p["reqId"], 42, "reqId is a JSON number when known");
        assert_eq!(p["kind"], KIND_NEEDS_INPUT);

        // Every contract kind serializes through the same shape.
        for kind in [
            KIND_AGENT_END,
            KIND_PROMPT_FAILED,
            KIND_LINK_LOST,
            KIND_CHILD_DIED,
        ] {
            let p = push_payload("T", "B", "/s/x.jsonl", kind, Some(7));
            assert_eq!(p["kind"], kind);
            assert_eq!(p["reqId"], 7);
            assert!(
                p["tag"]
                    .as_str()
                    .unwrap()
                    .starts_with(&format!("omp-{kind}-"))
            );
        }
    }
}
