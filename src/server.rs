//! What the phone talks to: the HTTP and WebSocket API, the per-client fan-out
//! hub and its delta encoding, notifications, paired devices, the embedded web
//! app, and the features behind individual endpoints (dictation, git changes).

pub mod asr;
pub mod assets;
pub mod delta;
pub mod device_auth;
pub mod git_changes;
pub mod http;
pub mod push;
pub mod ws;
