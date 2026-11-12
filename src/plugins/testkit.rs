//! Test-only fixtures for the plugin modules: a self-cleaning scratch folder and
//! a manifest builder, so the manifest, registry and source tests build their
//! plugin folders the same way. Compiled only under `cfg(test)`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use super::PluginDirs;

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// A unique folder under the system temp dir, removed on drop. Tests must never
/// touch the real config or state directories.
pub(crate) struct Scratch {
    pub root: PathBuf,
}

impl Scratch {
    pub(crate) fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "omp-pulse-plugins-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // Canonicalise once: macOS temp is behind /var -> /private/var and
        // Windows temp is an 8.3 name, and the code under test canonicalises.
        let root = std::fs::canonicalize(&root).unwrap();
        Scratch { root }
    }

    /// Plugin folder and decisions file inside the scratch root. The plugins
    /// folder is deliberately not created, as on a machine that never used plugins.
    pub(crate) fn dirs(&self) -> PluginDirs {
        PluginDirs {
            plugins_dir: self.root.join("plugins"),
            state_file: self.root.join("state").join("plugins.json"),
            omp_bin: None,
        }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// A valid manifest. `client` is written as a TOML literal string so a test can
/// pass backslashes; `extra` goes last, so it may hold root keys and then tables.
pub(crate) fn manifest(id: &str, client: &str, slots: &str, extra: &str) -> String {
    format!(
        "schema = 1\nid = \"{id}\"\nname = \"Test {id}\"\nversion = \"0.1.0\"\nclient = '{client}'\nslots = {slots}\n{extra}"
    )
}

/// A plugin folder with a manifest and `client.js`, created or overwritten.
pub(crate) fn write_plugin(dir: &Path, manifest_text: &str, client_js: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(super::MANIFEST_FILE), manifest_text).unwrap();
    std::fs::write(dir.join("client.js"), client_js).unwrap();
}

/// A default one-slot plugin named `id` inside the scratch plugins folder.
pub(crate) fn install_default(dirs: &PluginDirs, id: &str, extra: &str) -> PathBuf {
    let dir = dirs.plugins_dir.join(id);
    write_plugin(
        &dir,
        &manifest(id, "client.js", r#"["drawer"]"#, extra),
        "export default {}",
    );
    dir
}

/// Approve plugin `id` at its current hash and return that hash.
pub(crate) fn enable(dirs: &PluginDirs, id: &str) -> String {
    let hash = super::get(dirs, id).unwrap().hash;
    super::set_enabled(dirs, id, true, Some(&hash)).unwrap();
    hash
}
