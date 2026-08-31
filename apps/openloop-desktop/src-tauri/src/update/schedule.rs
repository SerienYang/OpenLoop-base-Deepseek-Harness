use std::{
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub use super::schedule_store::UpdateCheckTimestampStore;
use super::state::{CheckStart, UpdateChecker, UpdateState};

pub const STARTUP_STABILITY_DELAY: Duration = Duration::from_secs(30);
pub const AUTOMATIC_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const WORKER_POLL_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduledUpdateAction {
    CheckOnly,
}

#[derive(Debug, Clone)]
pub struct UpdateCheckSchedule {
    last_check_at: Option<Duration>,
}

impl UpdateCheckSchedule {
    pub fn new(last_check_at: Option<Duration>) -> Self {
        Self { last_check_at }
    }

    pub fn automatic_action(
        &mut self,
        uptime: Duration,
        wall_clock: Duration,
    ) -> Option<ScheduledUpdateAction> {
        let stable = uptime >= STARTUP_STABILITY_DELAY;
        let interval_elapsed = self.last_check_at.is_none_or(|last| {
            wall_clock < last
                || wall_clock
                    .checked_sub(last)
                    .is_some_and(|elapsed| elapsed >= AUTOMATIC_CHECK_INTERVAL)
        });
        if !stable || !interval_elapsed {
            return None;
        }
        self.last_check_at = Some(wall_clock);
        Some(ScheduledUpdateAction::CheckOnly)
    }

    pub fn manual_action(&mut self, now: Duration) -> ScheduledUpdateAction {
        self.last_check_at = Some(now);
        ScheduledUpdateAction::CheckOnly
    }
}

pub struct ScheduledUpdateWorker {
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl ScheduledUpdateWorker {
    pub fn start<T: Send + 'static>(
        schedule: Arc<Mutex<UpdateCheckSchedule>>,
        state: Arc<UpdateState<T>>,
        checker: Arc<dyn UpdateChecker<T>>,
        clock: Arc<dyn Fn() -> Duration + Send + Sync>,
    ) -> Result<Self, String> {
        Self::start_with_timing(
            schedule,
            state,
            checker,
            clock,
            WORKER_POLL_INTERVAL,
            Duration::ZERO,
        )
    }

    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub fn start_for_test<T: Send + 'static>(
        schedule: Arc<Mutex<UpdateCheckSchedule>>,
        state: Arc<UpdateState<T>>,
        checker: Arc<dyn UpdateChecker<T>>,
        clock: Arc<dyn Fn() -> Duration + Send + Sync>,
        poll_interval: Duration,
        initial_uptime: Duration,
    ) -> Result<Self, String> {
        Self::start_with_timing(
            schedule,
            state,
            checker,
            clock,
            poll_interval,
            initial_uptime,
        )
    }

    fn start_with_timing<T: Send + 'static>(
        schedule: Arc<Mutex<UpdateCheckSchedule>>,
        state: Arc<UpdateState<T>>,
        checker: Arc<dyn UpdateChecker<T>>,
        clock: Arc<dyn Fn() -> Duration + Send + Sync>,
        poll_interval: Duration,
        initial_uptime: Duration,
    ) -> Result<Self, String> {
        let (stop, stopped) = mpsc::channel();
        let started = Instant::now();
        let thread = thread::Builder::new()
            .name("openloop-update-schedule".to_owned())
            .spawn(move || loop {
                match stopped.recv_timeout(poll_interval) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                let now = clock();
                let action = schedule.lock().ok().and_then(|mut schedule| {
                    schedule.automatic_action(initial_uptime.saturating_add(started.elapsed()), now)
                });
                if action != Some(ScheduledUpdateAction::CheckOnly) {
                    continue;
                }
                match state.begin_check(now) {
                    Ok(CheckStart::Started(_)) => {
                        let check_state = state.clone();
                        let failure_state = state.clone();
                        let check_checker = checker.clone();
                        let check_clock = clock.clone();
                        if thread::Builder::new()
                            .name("openloop-update-check".to_owned())
                            .spawn(move || match check_checker.check() {
                                Ok(update) => {
                                    let _ = check_state.finish_check(check_clock(), update);
                                }
                                Err(failure) => {
                                    let _ = check_state.fail(failure);
                                }
                            })
                            .is_err()
                        {
                            let _ = failure_state.fail(super::state::UpdateFailure::Check);
                        }
                    }
                    Ok(CheckStart::AlreadyChecking(_)) | Err(_) => {}
                }
            })
            .map_err(|error| format!("start update schedule failed: {error}"))?;
        Ok(Self {
            stop: Some(stop),
            thread: Some(thread),
        })
    }
}

impl Drop for ScheduledUpdateWorker {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
