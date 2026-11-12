//! omp's session files on disk: parsing and paging them, tailing them as they
//! grow, the listing index built from them, and what can be derived from a file
//! alone (branching, model usage).

pub mod branch;
pub mod index;
pub mod jsonl;
pub mod model_usage;
pub mod watcher;
