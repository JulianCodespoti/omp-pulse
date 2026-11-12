//! Plugins: user-supplied folders (a manifest and one client script) that the
//! daemon discovers, hashes, approves and serves, and whose declared host
//! commands ("sources" read on demand, "actions" run on a tap) it executes. The
//! web client runs each enabled script in a sandbox and draws the declarative
//! views it returns.
//!
//! `manifest` validates `pulse-plugin.toml` (slots, permissions, claims,
//! options, sources, actions) and hashes the plugin; `registry` finds plugin
//! folders and links, derives each one's status from the stored decision, and
//! switches plugins on and off and stores their option values; `sources` runs a
//! plugin's declared commands with a cache, a timeout and a daemon-wide
//! concurrency limit; `actions` runs a declared action with a validated
//! argument; `skill` installs the omp skill and `/pulse-plugin` command that
//! teach an agent to write a plugin. A plugin is served and run only while it
//! is enabled AND unchanged since it was approved.

mod actions;
mod manifest;
mod registry;
pub mod skill;
mod sources;
#[cfg(test)]
mod testkit;

pub use actions::run_action;
pub use manifest::{KNOWN_SLOTS, MANIFEST_FILE};
pub use registry::{
    ActionInfo, OptionInfo, PluginDirs, PluginError, PluginInfo, PluginStatus, SourceInfo, check,
    client_script, get, link, list, set_enabled, set_options, unlink,
};
pub use sources::{SourceReading, read_source};
