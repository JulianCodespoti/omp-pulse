//! Who may write each session and what it is doing: ownership detection
//! (one writer per session file), the canonical owner, turn and activity state,
//! turns cut off by a restart, and durable delivery receipts.

pub mod activity;
pub mod command_ledger;
pub mod guard;
pub mod interrupted;
pub mod owner;
pub mod receipt_proof;
pub mod session_state;
