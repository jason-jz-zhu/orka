//! Global concurrency cap on `claude` subprocess spawns.
//!
//! Spawning `claude -p` is expensive: Node boot + auth + model load costs
//! 0.5–2s per call before any work begins, and each live process consumes
//! a healthy slice of RAM and CPU. Without a cap, a user who kicks off five
//! canvas nodes + a synthesis + an evolution can end up with seven
//! concurrent claude processes fighting each other.
//!
//! Session-brief generation has its own frontend FIFO (2 concurrent). This
//! module is the backend-side gate used by every other path:
//!   - node_runner (skill runs, continue-chat)
//!   - skill_evolution
//!   - session_synthesis
//!
//! The cap is intentionally generous (3) so interactive flows don't feel
//! locked — but it draws a firm line before things turn pathological.

use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const MAX_CONCURRENT_CLAUDE: usize = 3;

static GATE: std::sync::LazyLock<Arc<Semaphore>> =
    std::sync::LazyLock::new(|| Arc::new(Semaphore::new(MAX_CONCURRENT_CLAUDE)));

/// Acquire a permit to spawn a `claude` subprocess. The permit is held for
/// the full lifetime of the caller (drop it after the process exits).
/// Awaits if `MAX_CONCURRENT_CLAUDE` permits are already in use.
pub async fn acquire() -> OwnedSemaphorePermit {
    GATE.clone()
        .acquire_owned()
        .await
        .expect("claude gate semaphore closed unexpectedly")
}
