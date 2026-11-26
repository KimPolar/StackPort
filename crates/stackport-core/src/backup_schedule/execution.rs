use crate::Result;
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc, Mutex, MutexGuard, PoisonError,
};
use tokio::sync::Notify;

const RUNNING: u8 = 0;
const CANCELLED: u8 = 1;
const FINISHING: u8 = 2;
pub(super) const CANCELLED_MESSAGE: &str = "백업 실행을 취소했습니다.";

#[derive(Default)]
pub(crate) struct Execution(Mutex<Option<Active>>);

struct Active {
    profile_id: String,
    run_id: String,
    control: RunControl,
}

impl Execution {
    fn active(&self) -> MutexGuard<'_, Option<Active>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(super) fn start(&self, profile_id: &str, run_id: &str) -> Registration<'_> {
        let control = RunControl::default();
        *self.active() = Some(Active {
            profile_id: profile_id.into(),
            run_id: run_id.into(),
            control: control.clone(),
        });
        Registration {
            execution: self,
            control,
        }
    }

    pub(super) fn for_run(&self, profile_id: &str, run_id: &str) -> Option<RunControl> {
        self.active()
            .as_ref()
            .filter(|run| run.profile_id == profile_id && run.run_id == run_id)
            .map(|run| run.control.clone())
    }
}

pub(super) struct Registration<'a> {
    execution: &'a Execution,
    pub(super) control: RunControl,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        // The scheduler holds the workspace lock until the registration is dropped.
        self.execution.active().take();
    }
}

#[derive(Clone, Default)]
pub(crate) struct RunControl(Arc<RunState>);

#[derive(Default)]
struct RunState {
    phase: AtomicU8,
    cancelled: Notify,
}

impl RunControl {
    pub(super) fn can_cancel(&self) -> bool {
        self.0.phase.load(Ordering::Acquire) == RUNNING
    }

    pub(super) fn request_cancel(&self) -> bool {
        if self
            .0
            .phase
            .compare_exchange(RUNNING, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            self.0.cancelled.notify_one();
            return true;
        }
        false
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.0.phase.load(Ordering::Acquire) == CANCELLED
    }

    pub(crate) fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(CANCELLED_MESSAGE.into())
        } else {
            Ok(())
        }
    }

    pub(crate) async fn wait_cancelled(&self) -> &'static str {
        if !self.is_cancelled() {
            self.0.cancelled.notified().await;
        }
        CANCELLED_MESSAGE
    }

    pub(crate) fn finish(&self) -> Result<()> {
        // The same transition protects publication and terminal failures from late cancellation.
        let previous =
            self.0
                .phase
                .compare_exchange(RUNNING, FINISHING, Ordering::AcqRel, Ordering::Acquire);
        if previous == Err(CANCELLED) {
            Err(CANCELLED_MESSAGE.into())
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_and_publication_are_mutually_exclusive() {
        let cancelled = RunControl::default();
        assert!(cancelled.request_cancel());
        assert!(!cancelled.request_cancel());
        assert!(cancelled.finish().is_err());

        let finishing = RunControl::default();
        finishing.finish().unwrap();
        assert!(!finishing.request_cancel());
        assert!(finishing.finish().is_ok());
    }
}
