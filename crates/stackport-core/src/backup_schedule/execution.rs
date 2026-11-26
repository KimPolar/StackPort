use crate::Result;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};
use tokio::sync::Notify;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stop {
    Cancelled,
    TimedOut,
}

impl Stop {
    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::Cancelled => "백업 실행을 취소했습니다.",
            Self::TimedOut => "설정한 최대 백업 실행 시간을 초과했습니다.",
        }
    }
}

#[derive(Default)]
pub(crate) struct Execution(Mutex<HashMap<String, Active>>);

struct Active {
    profile_id: String,
    control: RunControl,
}

impl Execution {
    fn active(&self) -> MutexGuard<'_, HashMap<String, Active>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(super) fn start(
        &self,
        profile_id: &str,
        run_id: &str,
        timeout_seconds: u32,
    ) -> Registration<'_> {
        let deadline = (timeout_seconds > 0)
            .then(|| Instant::now() + Duration::from_secs(u64::from(timeout_seconds)));
        let control = RunControl::new(deadline);
        self.active().insert(
            run_id.into(),
            Active {
                profile_id: profile_id.into(),
                control: control.clone(),
            },
        );
        Registration {
            execution: self,
            run_id: run_id.into(),
            control,
        }
    }

    pub(super) fn for_run(&self, profile_id: &str, run_id: &str) -> Option<RunControl> {
        self.active()
            .get(run_id)
            .filter(|run| run.profile_id == profile_id)
            .map(|run| run.control.clone())
    }
}

pub(super) struct Registration<'a> {
    execution: &'a Execution,
    run_id: String,
    pub(super) control: RunControl,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.execution.active().remove(&self.run_id);
    }
}

#[derive(Clone)]
pub(crate) struct RunControl(Arc<RunState>);

struct RunState {
    phase: Mutex<Phase>,
    deadline: Option<Instant>,
    cancelled: Notify,
}

#[derive(Clone, Copy)]
enum Phase {
    Running,
    Stopped(Stop),
    Finishing,
}

impl RunControl {
    fn new(deadline: Option<Instant>) -> Self {
        Self(Arc::new(RunState {
            phase: Mutex::new(Phase::Running),
            deadline,
            cancelled: Notify::new(),
        }))
    }

    // Observe the deadline and any phase change under the same lock.
    fn advance(&self, next: Phase) -> Phase {
        let mut phase = self.0.phase.lock().unwrap_or_else(PoisonError::into_inner);
        if self.0.deadline.is_some_and(|at| Instant::now() >= at)
            && matches!(*phase, Phase::Running)
        {
            *phase = Phase::Stopped(Stop::TimedOut);
        }
        let current = *phase;
        if matches!(current, Phase::Running) {
            *phase = next;
        }
        current
    }

    pub(super) fn can_cancel(&self) -> bool {
        matches!(self.advance(Phase::Running), Phase::Running)
    }

    pub(super) fn request_cancel(&self) -> bool {
        if matches!(
            self.advance(Phase::Stopped(Stop::Cancelled)),
            Phase::Running
        ) {
            self.0.cancelled.notify_one();
            return true;
        }
        false
    }

    pub(crate) fn stopped(&self) -> Option<Stop> {
        match self.advance(Phase::Running) {
            Phase::Stopped(reason) => Some(reason),
            _ => None,
        }
    }

    pub(crate) fn bounded_wait(&self, max: Duration) -> Duration {
        self.0.deadline.map_or(max, |at| {
            // SQLite accepts whole milliseconds. Rounding up keeps a deadline-bound wait from ending early.
            max.min(at.saturating_duration_since(Instant::now()) + Duration::from_millis(1))
        })
    }

    pub(crate) fn check(&self) -> Result<()> {
        match self.stopped() {
            Some(reason) => Err(reason.message().into()),
            None => Ok(()),
        }
    }

    pub(crate) async fn wait_stopped(&self) -> Stop {
        if let Some(reason) = self.stopped() {
            return reason;
        }
        let deadline = async {
            match self.0.deadline {
                Some(at) => tokio::time::sleep_until(at.into()).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            _ = self.0.cancelled.notified() => Stop::Cancelled,
            _ = deadline => match self.stopped() {
                Some(reason) => reason,
                None => std::future::pending().await,
            },
        }
    }

    pub(crate) fn finish(&self) -> Result<()> {
        // Freeze the result immediately before publication or on an earlier failure.
        match self.advance(Phase::Finishing) {
            Phase::Stopped(reason) => Err(reason.message().into()),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_and_publication_are_mutually_exclusive() {
        let cancelled = RunControl::new(None);
        assert!(cancelled.request_cancel());
        assert!(!cancelled.request_cancel());
        assert!(cancelled.finish().is_err());

        let finishing = RunControl::new(None);
        finishing.finish().unwrap();
        assert!(!finishing.request_cancel());
        assert!(finishing.finish().is_ok());
    }

    #[test]
    fn an_expired_deadline_beats_a_late_cancel_or_publication() {
        let expired = RunControl::new(Some(Instant::now()));
        assert!(!expired.request_cancel());
        assert!(expired.finish().is_err());
        assert_eq!(expired.stopped(), Some(Stop::TimedOut));
    }
}
