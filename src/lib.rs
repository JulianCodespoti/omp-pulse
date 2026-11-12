//! The omp-pulse daemon as a library. `src/bin/omp-pulse/main.rs` wires it into
//! the `omp-pulse` binary.
//!
//! One module per subsystem: `server` (what the phone talks to), `omp` (driving
//! omp processes), `sessions` (session files on disk), `authority` (who may
//! write each session and what it is doing) and `terminal` (the laptop's
//! terminals). Configuration, paths, the CLI definition, service installation,
//! the self-test and the counters are crate-wide and sit at the top level.

pub mod authority;
pub mod cli;
pub mod doctor;
pub mod metrics;
pub mod omp;
pub mod paths;
pub mod plugins;
pub mod server;
pub mod service;
pub mod sessions;
pub mod terminal;
pub mod types;
