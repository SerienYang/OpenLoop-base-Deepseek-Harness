use std::{
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use super::state::{CheckStart, UpdateChecker, UpdateState};

pub const STARTUP_STABILITY_DELAY: Duration = Duration::from_secs(30);
pub const AUTOMATIC_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduledUpdateAction {
    CheckOnly,
}

#[derive(Debug, Clone)]
pub struct UpdateCheckSchedule {
    started_at: Duration,
    last_check_at: Option<Duration>,
}

impl UpdateCheckSchedule {
    pub fn new(started_at: Duration, last_check_at: Option<Duration>) -> Self {
        Self {
            started_at,
            last_check_at,
        }
    }

    pub fn automatic_action(&mut self, now: Duration) -> Option<ScheduledUpdateAction> {
        let stable = now.saturating_sub(self.started_at) >= STARTUP_STABILITY_DELAY;
        let interval_elapsed = self
            .last_check_at
            .is_none_or(|last| now.saturating_sub(last) >= AUTOMATIC_CHECK_INTERVAL);
        if !stable || !interval_elapsed {
            return None;
        }
        self.last_check_at = Some(now);
        Some(ScheduledUpdateAction::CheckOnly)
    }

    pub fn manual_action(&mut self, now: Duration) -> ScheduledUpdateAction {
        self.last_check_at = Some(now);
        ScheduledUpdateAction::CheckOnly
    }

    pub fn last_check_at(&self) -> Option<Duration> {
        self.last_check_at
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
        let (stop, stopped) = mpsc::channel();
        let started = Instant::now();
        let thread = thread::Builder::new()
            .name("openloop-update-schedule".to_owned())
            .spawn(move || loop {
                match stopped.recv_timeout(Duration::from_secs(1)) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                let action = schedule
                    .lock()
                    .ok()
                    .and_then(|mut schedule| schedule.automatic_action(started.elapsed()));
                if action != Some(ScheduledUpdateAction::CheckOnly) {
                    continue;
                }
                let now = clock();
                match state.begin_check(now) {
                    Ok(CheckStart::Started) => match checker.check() {
                        Ok(update) => {
                            let _ = state.finish_check(clock(), update);
                        }
                        Err(failure) => {
                            let _ = state.fail(failure);
                        }
                    },
                    Ok(CheckStart::AlreadyChecking) | Err(_) => {}
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
        self.stop.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
