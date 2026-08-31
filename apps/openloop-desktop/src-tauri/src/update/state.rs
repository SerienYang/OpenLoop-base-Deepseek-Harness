use std::{
    collections::VecDeque,
    error::Error,
    fmt,
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::bridge::server::{
    BridgeDispatchTables, BridgeHandler, BridgeHandlerError, CancellationToken,
};

use super::channel::ReleaseChannel;

const MAX_STALE_UPDATE_IDS: usize = 32;
pub const MAX_RELEASE_NOTES_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum UpdatePhase {
    Idle,
    Checking,
    UpToDate,
    Available,
    Failed,
    Downloading,
    Verifying,
    ReadyToInstall,
    Installing,
    Restarting,
    Committed,
    RolledBack,
}

impl UpdatePhase {
    fn is_active(self) -> bool {
        matches!(
            self,
            Self::Checking
                | Self::Available
                | Self::Downloading
                | Self::Verifying
                | Self::ReadyToInstall
                | Self::Installing
                | Self::Restarting
        )
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub state: UpdatePhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<u64>,
}

impl Default for UpdateStatus {
    fn default() -> Self {
        Self {
            state: UpdatePhase::Idle,
            update_id: None,
            version: None,
            release_notes: None,
            message: None,
            progress: None,
            last_checked_at: None,
        }
    }
}

pub struct AvailableUpdate<T> {
    value: T,
    version: String,
    channel: ReleaseChannel,
    release_notes: Option<String>,
}

impl<T> AvailableUpdate<T> {
    pub fn new(value: T, version: impl Into<String>, channel: ReleaseChannel) -> Self {
        Self {
            value,
            version: version.into(),
            channel,
            release_notes: None,
        }
    }

    pub fn with_release_notes(mut self, release_notes: impl Into<String>) -> Self {
        self.release_notes = Some(truncate_release_notes(release_notes.into()));
        self
    }

    pub fn with_optional_release_notes(mut self, release_notes: Option<String>) -> Self {
        self.release_notes = release_notes.map(truncate_release_notes);
        self
    }
}

struct PendingUpdate<T> {
    update_id: String,
    version: String,
    channel: ReleaseChannel,
    expires_at: Duration,
    value: T,
}

struct UpdateStateInner<T> {
    status: UpdateStatus,
    pending: Option<PendingUpdate<T>>,
    stale_ids: VecDeque<String>,
    install_reserved: bool,
}

pub struct UpdateState<T> {
    channel: ReleaseChannel,
    update_ttl: Duration,
    inner: Arc<(Mutex<UpdateStateInner<T>>, Condvar)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckStart {
    Started,
    AlreadyChecking,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateFailure {
    Check,
    UnsafeSource,
    SignatureVerification,
    DownloadInterrupted,
    InsufficientDiskSpace,
    Install,
    Recovery,
}

impl UpdateFailure {
    fn message(self) -> &'static str {
        match self {
            Self::Check => "Update check failed",
            Self::UnsafeSource => "Update source was rejected",
            Self::SignatureVerification => "Update signature verification failed",
            Self::DownloadInterrupted => "Update download was interrupted",
            Self::InsufficientDiskSpace => "Insufficient disk space for update",
            Self::Install => "Update installation failed",
            Self::Recovery => "Update recovery failed",
        }
    }
}

pub struct UpdateInstallReservation<T> {
    pending: PendingUpdate<T>,
}

#[derive(Debug)]
pub enum UpdateInstallOutcome<T> {
    Confirmed(T),
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateInstallPresentation {
    pub version: String,
    pub source: String,
}

pub trait UpdateInstallConfirmation: Send + Sync {
    fn confirm(
        &self,
        presentation: &UpdateInstallPresentation,
        cancellation: &CancellationToken,
    ) -> Result<bool, UpdateStateError>;
}

pub trait UpdateChecker<T>: Send + Sync {
    fn check(&self) -> Result<Option<AvailableUpdate<T>>, UpdateFailure>;
}

pub trait UpdateInstallObserver: Send + Sync {
    fn download_progress(
        &self,
        downloaded: u64,
        total: Option<u64>,
    ) -> Result<(), UpdateStateError>;
    fn verifying(&self) -> Result<(), UpdateStateError>;
    fn ready_to_install(&self) -> Result<(), UpdateStateError>;
    fn installing(&self) -> Result<(), UpdateStateError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateInstallResult {
    Committed,
    RolledBack,
}

pub trait UpdateInstaller<T>: Send + Sync {
    fn install(
        &self,
        update: T,
        observer: &dyn UpdateInstallObserver,
    ) -> Result<UpdateInstallResult, UpdateFailure>;
}

pub trait UpdateRestartRequester: Send + Sync {
    fn request_restart(&self);
}

impl<T> UpdateState<T> {
    pub fn new(channel: ReleaseChannel, update_ttl: Duration) -> Self {
        Self {
            channel,
            update_ttl,
            inner: Arc::new((
                Mutex::new(UpdateStateInner {
                    status: UpdateStatus::default(),
                    pending: None,
                    stale_ids: VecDeque::new(),
                    install_reserved: false,
                }),
                Condvar::new(),
            )),
        }
    }

    pub fn begin_check(&self, _now: Duration) -> Result<CheckStart, UpdateStateError> {
        let mut inner = self.lock()?;
        if inner.status.state == UpdatePhase::Checking {
            return Ok(CheckStart::AlreadyChecking);
        }
        if matches!(
            inner.status.state,
            UpdatePhase::Downloading
                | UpdatePhase::Verifying
                | UpdatePhase::ReadyToInstall
                | UpdatePhase::Installing
                | UpdatePhase::Restarting
        ) || inner.install_reserved
        {
            return Err(UpdateStateError::Busy);
        }
        retire_pending(&mut inner);
        inner.status = UpdateStatus {
            state: UpdatePhase::Checking,
            last_checked_at: inner.status.last_checked_at,
            ..UpdateStatus::default()
        };
        Ok(CheckStart::Started)
    }

    pub fn finish_check(
        &self,
        now: Duration,
        update: Option<AvailableUpdate<T>>,
    ) -> Result<UpdateStatus, UpdateStateError> {
        let result = (|| {
            let mut inner = self.lock()?;
            require_phase(inner.status.state, UpdatePhase::Checking)?;
            let checked_at = milliseconds(now);
            match update {
                Some(update) => {
                    if update.channel != self.channel {
                        inner.status =
                            failed_status(Some(checked_at), UpdateFailure::UnsafeSource.message());
                        return Err(UpdateStateError::WrongChannel);
                    }
                    if update.version.trim().is_empty() {
                        inner.status =
                            failed_status(Some(checked_at), UpdateFailure::UnsafeSource.message());
                        return Err(UpdateStateError::InvalidUpdate);
                    }
                    let update_id = Uuid::new_v4().to_string();
                    inner.status = UpdateStatus {
                        state: UpdatePhase::Available,
                        update_id: Some(update_id.clone()),
                        version: Some(update.version.clone()),
                        release_notes: update.release_notes,
                        message: None,
                        progress: None,
                        last_checked_at: Some(checked_at),
                    };
                    inner.pending = Some(PendingUpdate {
                        update_id,
                        version: update.version,
                        channel: update.channel,
                        expires_at: now.saturating_add(self.update_ttl),
                        value: update.value,
                    });
                }
                None => {
                    inner.status = UpdateStatus {
                        state: UpdatePhase::UpToDate,
                        last_checked_at: Some(checked_at),
                        ..UpdateStatus::default()
                    };
                }
            }
            Ok(inner.status.clone())
        })();
        self.inner.1.notify_all();
        result
    }

    pub fn wait_for_check(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<UpdateStatus, UpdateStateError>
    where
        T: Send + 'static,
    {
        let state = Arc::downgrade(&self.inner);
        let _subscription = cancellation.subscribe(move || {
            let Some(state) = state.upgrade() else {
                return;
            };
            let Ok(_guard) = state.0.lock() else {
                return;
            };
            state.1.notify_all();
        });
        let mut inner = self.lock()?;
        while inner.status.state == UpdatePhase::Checking {
            if cancellation.is_cancelled() {
                return Err(UpdateStateError::Cancelled);
            }
            inner = self
                .inner
                .1
                .wait(inner)
                .map_err(|_| UpdateStateError::Unavailable)?;
        }
        if cancellation.is_cancelled() {
            return Err(UpdateStateError::Cancelled);
        }
        Ok(inner.status.clone())
    }

    pub fn snapshot(&self, now: Duration) -> Result<UpdateStatus, UpdateStateError> {
        let mut inner = self.lock()?;
        expire_pending(&mut inner, now);
        Ok(inner.status.clone())
    }

    pub fn reserve_install(
        &self,
        update_id: &str,
        channel: ReleaseChannel,
        now: Duration,
    ) -> Result<UpdateInstallReservation<T>, UpdateStateError> {
        let mut inner = self.lock()?;
        if inner.install_reserved {
            return Err(UpdateStateError::Busy);
        }
        if inner.stale_ids.iter().any(|stale| stale == update_id) {
            return Err(UpdateStateError::StaleUpdateId);
        }
        let Some(pending) = inner.pending.as_ref() else {
            return Err(UpdateStateError::UnknownUpdateId);
        };
        if pending.update_id != update_id {
            return Err(UpdateStateError::UnknownUpdateId);
        }
        if now >= pending.expires_at {
            retire_pending(&mut inner);
            inner.status = failed_status(
                inner.status.last_checked_at,
                "Update offer expired; check again",
            );
            return Err(UpdateStateError::ExpiredUpdateId);
        }
        if channel != self.channel || pending.channel != channel {
            return Err(UpdateStateError::WrongChannel);
        }
        require_phase(inner.status.state, UpdatePhase::Available)?;
        inner.install_reserved = true;
        Ok(UpdateInstallReservation {
            pending: inner.pending.take().expect("validated pending update"),
        })
    }

    pub fn cancel_install(
        &self,
        reservation: UpdateInstallReservation<T>,
    ) -> Result<(), UpdateStateError> {
        let mut inner = self.lock()?;
        if !inner.install_reserved || inner.pending.is_some() {
            return Err(UpdateStateError::InvalidTransition);
        }
        inner.status.state = UpdatePhase::Available;
        inner.status.update_id = Some(reservation.pending.update_id.clone());
        inner.status.version = Some(reservation.pending.version.clone());
        inner.status.progress = None;
        inner.pending = Some(reservation.pending);
        inner.install_reserved = false;
        Ok(())
    }

    pub fn complete_install_confirmation(
        &self,
        reservation: UpdateInstallReservation<T>,
        now: Duration,
        confirmed: bool,
    ) -> Result<UpdateInstallOutcome<T>, UpdateStateError> {
        let mut inner = self.lock()?;
        if !inner.install_reserved || inner.pending.is_some() {
            return Err(UpdateStateError::InvalidTransition);
        }
        require_phase(inner.status.state, UpdatePhase::Available)?;
        if now >= reservation.pending.expires_at {
            retire_update_id(&mut inner, reservation.pending.update_id);
            inner.install_reserved = false;
            inner.status = failed_status(
                inner.status.last_checked_at,
                "Update offer expired; check again",
            );
            return Err(UpdateStateError::ExpiredUpdateId);
        }
        if !confirmed {
            inner.status.update_id = Some(reservation.pending.update_id.clone());
            inner.status.version = Some(reservation.pending.version.clone());
            inner.status.progress = None;
            inner.pending = Some(reservation.pending);
            inner.install_reserved = false;
            return Ok(UpdateInstallOutcome::Cancelled);
        }
        inner.install_reserved = false;
        inner.status.state = UpdatePhase::Downloading;
        inner.status.progress = Some(0);
        Ok(UpdateInstallOutcome::Confirmed(reservation.pending.value))
    }

    pub fn mark_download_progress(
        &self,
        downloaded: u64,
        total: Option<u64>,
    ) -> Result<(), UpdateStateError> {
        let mut inner = self.lock()?;
        require_phase(inner.status.state, UpdatePhase::Downloading)?;
        inner.status.progress = total
            .filter(|total| *total > 0)
            .map(|total| {
                downloaded
                    .saturating_mul(100)
                    .checked_div(total)
                    .unwrap_or(100)
            })
            .map(|progress| progress.min(100) as u8);
        Ok(())
    }

    pub fn mark_verifying(&self) -> Result<(), UpdateStateError> {
        self.transition(UpdatePhase::Downloading, UpdatePhase::Verifying)
    }

    pub fn mark_ready_to_install(&self) -> Result<(), UpdateStateError> {
        self.transition(UpdatePhase::Verifying, UpdatePhase::ReadyToInstall)
    }

    pub fn mark_installing(&self) -> Result<(), UpdateStateError> {
        self.transition(UpdatePhase::ReadyToInstall, UpdatePhase::Installing)
    }

    pub fn mark_restarting(&self) -> Result<(), UpdateStateError> {
        self.transition(UpdatePhase::Installing, UpdatePhase::Restarting)
    }

    pub fn mark_committed(&self) -> Result<(), UpdateStateError> {
        self.terminal_transition(UpdatePhase::Committed)
    }

    pub fn mark_rolled_back(&self) -> Result<(), UpdateStateError> {
        self.terminal_transition(UpdatePhase::RolledBack)
    }

    pub fn fail(&self, failure: UpdateFailure) -> Result<(), UpdateStateError> {
        let result = (|| {
            let mut inner = self.lock()?;
            if !inner.status.state.is_active() {
                return Err(UpdateStateError::InvalidTransition);
            }
            retire_pending(&mut inner);
            inner.install_reserved = false;
            inner.status = failed_status(inner.status.last_checked_at, failure.message());
            Ok(())
        })();
        self.inner.1.notify_all();
        result
    }

    fn transition(&self, expected: UpdatePhase, next: UpdatePhase) -> Result<(), UpdateStateError> {
        let mut inner = self.lock()?;
        require_phase(inner.status.state, expected)?;
        inner.status.state = next;
        inner.status.progress = None;
        Ok(())
    }

    fn terminal_transition(&self, next: UpdatePhase) -> Result<(), UpdateStateError> {
        let mut inner = self.lock()?;
        require_phase(inner.status.state, UpdatePhase::Restarting)?;
        inner.status.state = next;
        inner.status.update_id = None;
        inner.status.progress = None;
        Ok(())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, UpdateStateInner<T>>, UpdateStateError> {
        self.inner
            .0
            .lock()
            .map_err(|_| UpdateStateError::Unavailable)
    }
}

struct StateInstallObserver<T> {
    state: Arc<UpdateState<T>>,
}

impl<T: Send> UpdateInstallObserver for StateInstallObserver<T> {
    fn download_progress(
        &self,
        downloaded: u64,
        total: Option<u64>,
    ) -> Result<(), UpdateStateError> {
        self.state.mark_download_progress(downloaded, total)
    }

    fn verifying(&self) -> Result<(), UpdateStateError> {
        self.state.mark_verifying()
    }

    fn ready_to_install(&self) -> Result<(), UpdateStateError> {
        self.state.mark_ready_to_install()
    }

    fn installing(&self) -> Result<(), UpdateStateError> {
        self.state.mark_installing()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallUpdateInput {
    update_id: String,
}

#[allow(clippy::too_many_arguments)]
pub fn install_update_bridge_handlers<T: Send + 'static>(
    tables: &mut BridgeDispatchTables,
    state: Arc<UpdateState<T>>,
    channel: ReleaseChannel,
    checker: Arc<dyn UpdateChecker<T>>,
    installer: Arc<dyn UpdateInstaller<T>>,
    confirmation: Arc<dyn UpdateInstallConfirmation>,
    restart: Arc<dyn UpdateRestartRequester>,
    clock: Arc<dyn Fn() -> Duration + Send + Sync>,
) -> Result<(), String> {
    let status_state = state.clone();
    let status_clock = clock.clone();
    let status: BridgeHandler = Arc::new(move |payload, _cancellation| {
        if !payload.is_null() {
            return Err(BridgeHandlerError::invalid_request());
        }
        serde_json::to_value(
            status_state
                .snapshot(status_clock())
                .map_err(|_| BridgeHandlerError::update_failure())?,
        )
        .map_err(|_| BridgeHandlerError::update_failure())
    });
    tables
        .set_browser_handler("getUpdateStatus", status)
        .map_err(|error| error.to_string())?;

    let check_state = state.clone();
    let check_clock = clock.clone();
    let check: BridgeHandler = Arc::new(move |payload, cancellation| {
        if !payload.is_null() {
            return Err(BridgeHandlerError::invalid_request());
        }
        if cancellation.is_cancelled() {
            return Err(BridgeHandlerError::invalid_request());
        }
        let now = check_clock();
        match check_state
            .begin_check(now)
            .map_err(|_| BridgeHandlerError::update_failure())?
        {
            CheckStart::AlreadyChecking => {
                return serde_json::to_value(check_state.wait_for_check(&cancellation).map_err(
                    |error| match error {
                        UpdateStateError::Cancelled => BridgeHandlerError::invalid_request(),
                        _ => BridgeHandlerError::update_failure(),
                    },
                )?)
                .map_err(|_| BridgeHandlerError::update_failure());
            }
            CheckStart::Started => {}
        }
        let checked = checker.check();
        let result = match checked {
            Ok(update) => check_state.finish_check(check_clock(), update),
            Err(failure) => {
                check_state
                    .fail(failure)
                    .map_err(|_| BridgeHandlerError::update_failure())?;
                check_state.snapshot(check_clock())
            }
        }
        .map_err(|_| BridgeHandlerError::update_failure())?;
        serde_json::to_value(result).map_err(|_| BridgeHandlerError::update_failure())
    });
    tables
        .set_browser_handler("checkForUpdate", check)
        .map_err(|error| error.to_string())?;

    let install_state = state;
    let install_clock = clock;
    let install: BridgeHandler = Arc::new(move |payload, cancellation| {
        let input: InstallUpdateInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        if input.update_id.trim().is_empty() {
            return Err(BridgeHandlerError::invalid_request());
        }
        let update = match confirm_and_begin_install(
            &install_state,
            &input.update_id,
            channel,
            install_clock.as_ref(),
            confirmation.as_ref(),
            &cancellation,
        )
        .map_err(|_| BridgeHandlerError::update_failure())?
        {
            UpdateInstallOutcome::Cancelled => {
                return Ok(Value::String("cancelled".to_owned()));
            }
            UpdateInstallOutcome::Confirmed(update) => update,
        };
        let observer = StateInstallObserver {
            state: install_state.clone(),
        };
        let outcome = match installer.install(update, &observer) {
            Ok(outcome) => outcome,
            Err(failure) => {
                install_state
                    .fail(failure)
                    .map_err(|_| BridgeHandlerError::update_failure())?;
                return Err(BridgeHandlerError::update_failure());
            }
        };
        install_state
            .mark_restarting()
            .map_err(|_| BridgeHandlerError::update_failure())?;
        match outcome {
            UpdateInstallResult::Committed => {
                restart.request_restart();
                install_state
                    .mark_committed()
                    .map_err(|_| BridgeHandlerError::update_failure())?;
                Ok(Value::String("restarting".to_owned()))
            }
            UpdateInstallResult::RolledBack => {
                install_state
                    .mark_rolled_back()
                    .map_err(|_| BridgeHandlerError::update_failure())?;
                Err(BridgeHandlerError::update_failure())
            }
        }
    });
    tables
        .set_browser_handler("installUpdateAndRestart", install)
        .map_err(|error| error.to_string())
}

pub fn confirm_and_begin_install<T>(
    state: &UpdateState<T>,
    update_id: &str,
    channel: ReleaseChannel,
    clock: &dyn Fn() -> Duration,
    confirmation: &dyn UpdateInstallConfirmation,
    cancellation: &CancellationToken,
) -> Result<UpdateInstallOutcome<T>, UpdateStateError> {
    let reservation = state.reserve_install(update_id, channel, clock())?;
    let presentation = UpdateInstallPresentation {
        version: reservation.pending.version.clone(),
        source: signed_source(channel).to_owned(),
    };
    if cancellation.is_cancelled() {
        state.cancel_install(reservation)?;
        return Ok(UpdateInstallOutcome::Cancelled);
    }
    let confirmed = match confirmation.confirm(&presentation, cancellation) {
        Ok(confirmed) => confirmed,
        Err(error) => {
            state.cancel_install(reservation)?;
            return Err(error);
        }
    };
    state.complete_install_confirmation(
        reservation,
        clock(),
        confirmed && !cancellation.is_cancelled(),
    )
}

fn signed_source(channel: ReleaseChannel) -> &'static str {
    match channel {
        ReleaseChannel::Test => "Openloop signed test release",
        ReleaseChannel::Stable => "Openloop signed stable release",
    }
}

fn milliseconds(value: Duration) -> u64 {
    value.as_millis().min(u128::from(u64::MAX)) as u64
}

fn truncate_release_notes(mut release_notes: String) -> String {
    if release_notes.len() <= MAX_RELEASE_NOTES_BYTES {
        return release_notes;
    }
    let mut boundary = MAX_RELEASE_NOTES_BYTES;
    while !release_notes.is_char_boundary(boundary) {
        boundary -= 1;
    }
    release_notes.truncate(boundary);
    release_notes
}

fn require_phase(actual: UpdatePhase, expected: UpdatePhase) -> Result<(), UpdateStateError> {
    if actual == expected {
        Ok(())
    } else {
        Err(UpdateStateError::InvalidTransition)
    }
}

fn failed_status(last_checked_at: Option<u64>, message: &str) -> UpdateStatus {
    UpdateStatus {
        state: UpdatePhase::Failed,
        message: Some(message.to_owned()),
        last_checked_at,
        ..UpdateStatus::default()
    }
}

fn expire_pending<T>(inner: &mut UpdateStateInner<T>, now: Duration) {
    if inner
        .pending
        .as_ref()
        .is_some_and(|pending| now >= pending.expires_at)
    {
        retire_pending(inner);
        inner.status = failed_status(
            inner.status.last_checked_at,
            "Update offer expired; check again",
        );
    }
}

fn retire_pending<T>(inner: &mut UpdateStateInner<T>) {
    if let Some(pending) = inner.pending.take() {
        retire_update_id(inner, pending.update_id);
    }
}

fn retire_update_id<T>(inner: &mut UpdateStateInner<T>, update_id: String) {
    inner.stale_ids.push_back(update_id);
    while inner.stale_ids.len() > MAX_STALE_UPDATE_IDS {
        inner.stale_ids.pop_front();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateStateError {
    Busy,
    Cancelled,
    UnknownUpdateId,
    StaleUpdateId,
    ExpiredUpdateId,
    WrongChannel,
    InvalidUpdate,
    InvalidTransition,
    PromptUnavailable,
    Unavailable,
}

impl fmt::Display for UpdateStateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Busy => "an update operation is already active",
            Self::Cancelled => "update operation was cancelled",
            Self::UnknownUpdateId => "update id is unknown",
            Self::StaleUpdateId => "update id is stale",
            Self::ExpiredUpdateId => "update id has expired",
            Self::WrongChannel => "update belongs to a different release channel",
            Self::InvalidUpdate => "checked update metadata is invalid",
            Self::InvalidTransition => "update state transition is invalid",
            Self::PromptUnavailable => "native update confirmation is unavailable",
            Self::Unavailable => "update state is unavailable",
        })
    }
}

impl Error for UpdateStateError {}

#[cfg(target_os = "macos")]
mod appkit {
    use std::{
        ptr,
        sync::{
            atomic::{AtomicPtr, Ordering},
            mpsc, Arc, Mutex,
        },
    };

    use block2::RcBlock;
    use objc2_app_kit::{
        NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSModalResponseCancel, NSWindow,
    };
    use objc2_foundation::{MainThreadMarker, NSString, NSThread};
    use tauri::{AppHandle, Manager};

    use super::{
        CancellationToken, UpdateInstallConfirmation, UpdateInstallPresentation, UpdateStateError,
    };

    const MAIN_WINDOW_LABEL: &str = "main";

    pub type UpdateConfirmationCompletion =
        Box<dyn FnOnce(Result<bool, UpdateStateError>) + Send + 'static>;
    pub type UpdateConfirmationCancellation = Box<dyn FnOnce() + Send + 'static>;

    pub trait AppKitUpdateInstallConfirmationBackend: Send + Sync {
        fn begin_sheet(
            &self,
            presentation: UpdateInstallPresentation,
            completion: UpdateConfirmationCompletion,
        ) -> Result<UpdateConfirmationCancellation, UpdateStateError>;
    }

    #[derive(Clone)]
    pub struct AppKitUpdateInstallConfirmation {
        backend: Arc<dyn AppKitUpdateInstallConfirmationBackend>,
    }

    impl AppKitUpdateInstallConfirmation {
        pub fn new(app: AppHandle) -> Self {
            Self::with_backend(Arc::new(Objc2AppKitUpdateInstallConfirmationBackend {
                app,
            }))
        }

        pub fn with_backend(backend: Arc<dyn AppKitUpdateInstallConfirmationBackend>) -> Self {
            Self { backend }
        }
    }

    impl UpdateInstallConfirmation for AppKitUpdateInstallConfirmation {
        fn confirm(
            &self,
            presentation: &UpdateInstallPresentation,
            cancellation: &CancellationToken,
        ) -> Result<bool, UpdateStateError> {
            if cancellation.is_cancelled() {
                return Ok(false);
            }
            let (sender, receiver) = mpsc::sync_channel(1);
            let cancel_sheet = self.backend.begin_sheet(
                presentation.clone(),
                Box::new(move |result| {
                    let _ = sender.send(result);
                }),
            )?;
            let _cancellation = cancellation.subscribe(cancel_sheet);
            receiver
                .recv()
                .map_err(|_| UpdateStateError::PromptUnavailable)?
        }
    }

    struct Objc2AppKitUpdateInstallConfirmationBackend {
        app: AppHandle,
    }

    impl AppKitUpdateInstallConfirmationBackend for Objc2AppKitUpdateInstallConfirmationBackend {
        fn begin_sheet(
            &self,
            presentation: UpdateInstallPresentation,
            completion: UpdateConfirmationCompletion,
        ) -> Result<UpdateConfirmationCancellation, UpdateStateError> {
            if NSThread::isMainThread_class() {
                return Err(UpdateStateError::PromptUnavailable);
            }
            let window = self
                .app
                .get_webview_window(MAIN_WINDOW_LABEL)
                .ok_or(UpdateStateError::PromptUnavailable)?;
            let scheduled_window = window.clone();
            let session = Arc::new(NativeUpdateConfirmationSession::new(completion));
            let scheduled_session = session.clone();
            if window
                .run_on_main_thread(move || {
                    if begin_update_sheet(
                        &scheduled_window,
                        &presentation,
                        scheduled_session.clone(),
                    )
                    .is_err()
                    {
                        complete_update_sheet(
                            &scheduled_session,
                            Err(UpdateStateError::PromptUnavailable),
                        );
                    }
                })
                .is_err()
            {
                complete_update_sheet(&session, Err(UpdateStateError::PromptUnavailable));
                return Err(UpdateStateError::PromptUnavailable);
            }
            let app = self.app.clone();
            let session = Arc::downgrade(&session);
            Ok(Box::new(move || {
                let Some(session) = session.upgrade() else {
                    return;
                };
                let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
                    complete_update_sheet(&session, Ok(false));
                    return;
                };
                let scheduled_window = window.clone();
                let scheduled_session = session.clone();
                if window
                    .run_on_main_thread(move || {
                        cancel_update_sheet(&scheduled_window, &scheduled_session);
                    })
                    .is_err()
                {
                    complete_update_sheet(&session, Ok(false));
                }
            }))
        }
    }

    struct NativeUpdateConfirmationSession {
        completion: Mutex<Option<UpdateConfirmationCompletion>>,
        sheet: AtomicPtr<NSWindow>,
    }

    impl NativeUpdateConfirmationSession {
        fn new(completion: UpdateConfirmationCompletion) -> Self {
            Self {
                completion: Mutex::new(Some(completion)),
                sheet: AtomicPtr::new(ptr::null_mut()),
            }
        }

        fn is_pending(&self) -> bool {
            match self.completion.lock() {
                Ok(completion) => completion.is_some(),
                Err(poisoned) => poisoned.into_inner().is_some(),
            }
        }
    }

    fn complete_update_sheet(
        session: &NativeUpdateConfirmationSession,
        result: Result<bool, UpdateStateError>,
    ) {
        let callback = match session.completion.lock() {
            Ok(mut callback) => callback.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        if let Some(callback) = callback {
            callback(result);
        }
    }

    fn begin_update_sheet(
        window: &tauri::WebviewWindow,
        presentation: &UpdateInstallPresentation,
        session: Arc<NativeUpdateConfirmationSession>,
    ) -> Result<(), UpdateStateError> {
        if !session.is_pending() {
            return Ok(());
        }
        let Some(mtm) = MainThreadMarker::new() else {
            return Err(UpdateStateError::PromptUnavailable);
        };
        let parent = parent_ns_window(window)?;
        let alert = NSAlert::new(mtm);
        alert.setAlertStyle(NSAlertStyle::Informational);
        alert.setMessageText(&NSString::from_str(&format!(
            "Install Openloop {}?",
            presentation.version
        )));
        alert.setInformativeText(&NSString::from_str(&format!(
            "Openloop verified this update from {}. The app will restart after installation.",
            presentation.source
        )));
        alert.addButtonWithTitle(&NSString::from_str("Install and Restart"));
        alert.addButtonWithTitle(&NSString::from_str("Cancel"));
        let retained_alert = alert.clone();
        let sheet = alert.window();
        session
            .sheet
            .store((&*sheet as *const NSWindow).cast_mut(), Ordering::Release);
        let completion_session = session.clone();
        let completion = RcBlock::new(move |response| {
            completion_session
                .sheet
                .store(ptr::null_mut(), Ordering::Release);
            complete_update_sheet(
                &completion_session,
                Ok(response == NSAlertFirstButtonReturn),
            );
            drop(retained_alert.clone());
        });
        parent.beginSheet_completionHandler(&sheet, Some(&completion));
        Ok(())
    }

    fn cancel_update_sheet(
        window: &tauri::WebviewWindow,
        session: &NativeUpdateConfirmationSession,
    ) {
        debug_assert!(NSThread::isMainThread_class());
        if !session.is_pending() {
            return;
        }
        let sheet = session.sheet.swap(ptr::null_mut(), Ordering::AcqRel);
        if !sheet.is_null() {
            if let Ok(parent) = parent_ns_window(window) {
                // SAFETY: the pointer belongs to the retained NSAlert and all
                // access is serialized on the AppKit main thread.
                parent.endSheet_returnCode(unsafe { &*sheet }, NSModalResponseCancel);
            }
        }
        complete_update_sheet(session, Ok(false));
    }

    fn parent_ns_window(window: &tauri::WebviewWindow) -> Result<&NSWindow, UpdateStateError> {
        debug_assert!(NSThread::isMainThread_class());
        let pointer = window
            .ns_window()
            .map_err(|_| UpdateStateError::PromptUnavailable)?;
        if pointer.is_null() {
            return Err(UpdateStateError::PromptUnavailable);
        }
        // SAFETY: Tauri owns this NSWindow for the life of the WebviewWindow.
        Ok(unsafe { &*pointer.cast::<NSWindow>() })
    }
}

#[cfg(target_os = "macos")]
pub use appkit::{
    AppKitUpdateInstallConfirmation, AppKitUpdateInstallConfirmationBackend,
    UpdateConfirmationCancellation, UpdateConfirmationCompletion,
};
