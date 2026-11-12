//! The laptop's terminals: adopting an omp TUI already running in kitty, tmux or
//! herdr, adopting an already-sharing Tern omp through its native Collab (never
//! typing), scraping its collab link, handing a conversation to a new herdr tab,
//! and herdr's live per-pane agent state.

pub mod adopt;
pub mod handoff;
mod herdr_startup;
pub mod herdr_state;
pub mod linkscrape;
