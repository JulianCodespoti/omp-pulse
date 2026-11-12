//! Driving omp processes: the daemon's own RPC children, the collab guest and
//! self-hosted relay, the desktop extension's event bridge and control channel,
//! native collab discovery, and the dialogs and titles they produce.

pub mod ansi;
pub mod autotitle;
pub mod bridge;
pub mod child;
pub mod collab;
pub mod desktop_control;
pub mod native_collab;
pub mod ui_dialog;
pub mod ui_feedback;
