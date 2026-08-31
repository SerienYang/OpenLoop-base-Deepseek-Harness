use std::{
    collections::VecDeque,
    process,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Barrier, Mutex,
    },
    thread,
    time::Duration,
};

use openloop_desktop_lib::{
    bridge::{
        protocol::{sign_request, BridgeRequest, BRIDGE_PROTOCOL_VERSION},
        server::{
            AuthenticatedBridgeDispatcher, BridgeDispatchTables, CancellationToken, PeerIdentity,
        },
    },
    launcher::capture_process_identity,
    update::{
        channel::ReleaseChannel,
        coordinator::ensure_update_disk_capacity,
        schedule::{ScheduledUpdateAction, UpdateCheckSchedule},
        state::{
            confirm_and_begin_install, install_update_bridge_handlers, AvailableUpdate, CheckStart,
            UpdateChecker, UpdateFailure, UpdateInstallConfirmation, UpdateInstallObserver,
            UpdateInstallOutcome, UpdateInstallPresentation, UpdateInstallResult, UpdateInstaller,
            UpdatePhase, UpdateRestartRequester, UpdateState, UpdateStateError,
        },
    },
};
use serde_json::{json, Value};
use uuid::Uuid;

#[cfg(target_os = "macos")]
use openloop_desktop_lib::update::state::{
    AppKitUpdateInstallConfirmation, AppKitUpdateInstallConfirmationBackend,
    UpdateConfirmationCancellation, UpdateConfirmationCompletion,
};

const NOW: Duration = Duration::from_secs(1_000_000);
const UPDATE_TTL: Duration = Duration::from_secs(15 * 60);

fn available(state: &UpdateState<&'static str>, now: Duration) -> String {
    assert_eq!(
        state.begin_check(now).expect("begin check"),
        CheckStart::Started
    );
    state
        .finish_check(
            now,
            Some(AvailableUpdate::new(
                "host-only-update",
                "1.2.3",
                ReleaseChannel::Test,
            )),
        )
        .expect("finish check")
        .update_id
        .expect("opaque update id")
}

#[derive(Default)]
struct RecordingConfirmation {
    approved: bool,
    presentations: Mutex<Vec<UpdateInstallPresentation>>,
}

impl RecordingConfirmation {
    fn with_decision(approved: bool) -> Self {
        Self {
            approved,
            presentations: Mutex::new(Vec::new()),
        }
    }
}

impl UpdateInstallConfirmation for RecordingConfirmation {
    fn confirm(
        &self,
        presentation: &UpdateInstallPresentation,
        _cancellation: &CancellationToken,
    ) -> Result<bool, UpdateStateError> {
        self.presentations
            .lock()
            .expect("presentation lock")
            .push(presentation.clone());
        Ok(self.approved)
    }
}

#[cfg(target_os = "macos")]
struct ImmediateAppKitBackend {
    presentations: Mutex<Vec<UpdateInstallPresentation>>,
}

#[cfg(target_os = "macos")]
impl AppKitUpdateInstallConfirmationBackend for ImmediateAppKitBackend {
    fn begin_sheet(
        &self,
        presentation: UpdateInstallPresentation,
        completion: UpdateConfirmationCompletion,
    ) -> Result<UpdateConfirmationCancellation, UpdateStateError> {
        self.presentations
            .lock()
            .expect("AppKit presentation lock")
            .push(presentation);
        completion(Ok(true));
        Ok(Box::new(|| {}))
    }
}

#[cfg(target_os = "macos")]
#[test]
fn appkit_confirmation_delegates_host_derived_presentation_to_native_backend() {
    let backend = Arc::new(ImmediateAppKitBackend {
        presentations: Mutex::new(Vec::new()),
    });
    let confirmation = AppKitUpdateInstallConfirmation::with_backend(backend.clone());
    let presentation = UpdateInstallPresentation {
        version: "4.5.6".to_owned(),
        source: "Openloop signed stable release".to_owned(),
    };

    assert!(confirmation
        .confirm(&presentation, &CancellationToken::default())
        .expect("native confirmation"));
    assert_eq!(
        backend
            .presentations
            .lock()
            .expect("AppKit presentations")
            .as_slice(),
        [presentation]
    );
}

#[test]
fn state_machine_covers_no_update_success_and_rollback_paths() {
    let no_update = UpdateState::<&'static str>::new(ReleaseChannel::Test, UPDATE_TTL);
    assert_eq!(
        no_update.begin_check(NOW).expect("begin no-update check"),
        CheckStart::Started
    );
    assert_eq!(
        no_update
            .finish_check(NOW, None)
            .expect("finish no-update check")
            .state,
        UpdatePhase::UpToDate
    );

    let committed = UpdateState::new(ReleaseChannel::Test, UPDATE_TTL);
    let update_id = available(&committed, NOW);
    let confirmation = RecordingConfirmation::with_decision(true);
    let update = match confirm_and_begin_install(
        &committed,
        &update_id,
        ReleaseChannel::Test,
        NOW,
        &confirmation,
        &CancellationToken::default(),
    )
    .expect("confirm install")
    {
        UpdateInstallOutcome::Confirmed(update) => update,
        UpdateInstallOutcome::Cancelled => panic!("approved update was cancelled"),
    };
    assert_eq!(update, "host-only-update");
    assert_eq!(
        committed.snapshot(NOW).expect("download status").state,
        UpdatePhase::Downloading
    );
    committed
        .mark_download_progress(5, Some(10))
        .expect("download progress");
    assert_eq!(
        committed.snapshot(NOW).expect("progress status").progress,
        Some(50)
    );
    committed.mark_verifying().expect("verifying");
    committed.mark_ready_to_install().expect("ready");
    committed.mark_installing().expect("installing");
    committed.mark_restarting().expect("restarting");
    committed.mark_committed().expect("committed");
    let committed_status = committed.snapshot(NOW).expect("committed status");
    assert_eq!(committed_status.state, UpdatePhase::Committed);
    assert_eq!(committed_status.update_id, None);

    let rolled_back = UpdateState::new(ReleaseChannel::Test, UPDATE_TTL);
    let update_id = available(&rolled_back, NOW);
    assert!(matches!(
        confirm_and_begin_install(
            &rolled_back,
            &update_id,
            ReleaseChannel::Test,
            NOW,
            &confirmation,
            &CancellationToken::default(),
        )
        .expect("confirm rollback fixture"),
        UpdateInstallOutcome::Confirmed(_)
    ));
    rolled_back.mark_verifying().expect("verifying");
    rolled_back.mark_ready_to_install().expect("ready");
    rolled_back.mark_installing().expect("installing");
    rolled_back.mark_restarting().expect("restarting");
    rolled_back.mark_rolled_back().expect("rolled back");
    let rollback_status = rolled_back.snapshot(NOW).expect("rollback status");
    assert_eq!(rollback_status.state, UpdatePhase::RolledBack);
    assert_eq!(rollback_status.update_id, None);
}

#[test]
fn every_active_state_can_fail_with_a_safe_browser_message() {
    let cases = [
        (UpdatePhase::Checking, UpdateFailure::Check),
        (UpdatePhase::Available, UpdateFailure::UnsafeSource),
        (UpdatePhase::Downloading, UpdateFailure::DownloadInterrupted),
        (UpdatePhase::Verifying, UpdateFailure::SignatureVerification),
        (
            UpdatePhase::ReadyToInstall,
            UpdateFailure::InsufficientDiskSpace,
        ),
        (UpdatePhase::Installing, UpdateFailure::Install),
        (UpdatePhase::Restarting, UpdateFailure::Recovery),
    ];
    for (target, failure) in cases {
        let state = UpdateState::new(ReleaseChannel::Test, UPDATE_TTL);
        state.begin_check(NOW).expect("begin check");
        if target != UpdatePhase::Checking {
            let update_id = state
                .finish_check(
                    NOW,
                    Some(AvailableUpdate::new(
                        "host-only-update",
                        "1.2.3",
                        ReleaseChannel::Test,
                    )),
                )
                .expect("available")
                .update_id
                .expect("update id");
            if target != UpdatePhase::Available {
                let confirmed = confirm_and_begin_install(
                    &state,
                    &update_id,
                    ReleaseChannel::Test,
                    NOW,
                    &RecordingConfirmation::with_decision(true),
                    &CancellationToken::default(),
                )
                .expect("confirm");
                assert!(matches!(confirmed, UpdateInstallOutcome::Confirmed(_)));
                if matches!(
                    target,
                    UpdatePhase::Verifying
                        | UpdatePhase::ReadyToInstall
                        | UpdatePhase::Installing
                        | UpdatePhase::Restarting
                ) {
                    state.mark_verifying().expect("verifying");
                }
                if matches!(
                    target,
                    UpdatePhase::ReadyToInstall | UpdatePhase::Installing | UpdatePhase::Restarting
                ) {
                    state.mark_ready_to_install().expect("ready");
                }
                if matches!(target, UpdatePhase::Installing | UpdatePhase::Restarting) {
                    state.mark_installing().expect("installing");
                }
                if target == UpdatePhase::Restarting {
                    state.mark_restarting().expect("restarting");
                }
            }
        }
        state.fail(failure).expect("active state can fail");
        let status = state.snapshot(NOW).expect("failed status");
        assert_eq!(status.state, UpdatePhase::Failed);
        let message = status.message.expect("safe failure message");
        assert!(!message.contains("https://"));
        assert!(!message.contains("signature-value"));
    }
}

#[test]
fn rejects_stale_expired_unknown_and_wrong_channel_update_ids() {
    let state = UpdateState::new(ReleaseChannel::Test, UPDATE_TTL);
    let stale_id = available(&state, NOW);
    state
        .begin_check(NOW + Duration::from_secs(1))
        .expect("replacement check");
    let current_id = state
        .finish_check(
            NOW + Duration::from_secs(1),
            Some(AvailableUpdate::new(
                "replacement",
                "1.2.4",
                ReleaseChannel::Test,
            )),
        )
        .expect("replacement update")
        .update_id
        .expect("replacement id");
    let confirmation = RecordingConfirmation::with_decision(true);

    assert!(matches!(
        confirm_and_begin_install(
            &state,
            &stale_id,
            ReleaseChannel::Test,
            NOW + Duration::from_secs(2),
            &confirmation,
            &CancellationToken::default(),
        ),
        Err(UpdateStateError::StaleUpdateId)
    ));
    assert!(matches!(
        confirm_and_begin_install(
            &state,
            "not-issued-by-host",
            ReleaseChannel::Test,
            NOW + Duration::from_secs(2),
            &confirmation,
            &CancellationToken::default(),
        ),
        Err(UpdateStateError::UnknownUpdateId)
    ));
    assert!(matches!(
        confirm_and_begin_install(
            &state,
            &current_id,
            ReleaseChannel::Stable,
            NOW + Duration::from_secs(2),
            &confirmation,
            &CancellationToken::default(),
        ),
        Err(UpdateStateError::WrongChannel)
    ));
    assert!(matches!(
        confirm_and_begin_install(
            &state,
            &current_id,
            ReleaseChannel::Test,
            NOW + UPDATE_TTL + Duration::from_secs(2),
            &confirmation,
            &CancellationToken::default(),
        ),
        Err(UpdateStateError::ExpiredUpdateId)
    ));
}

#[test]
fn native_confirmation_uses_host_stored_version_and_signed_source_and_can_cancel() {
    let state = UpdateState::new(ReleaseChannel::Stable, UPDATE_TTL);
    state.begin_check(NOW).expect("begin check");
    let update_id = state
        .finish_check(
            NOW,
            Some(AvailableUpdate::new(
                "raw-host-update",
                "7.8.9",
                ReleaseChannel::Stable,
            )),
        )
        .expect("available")
        .update_id
        .expect("id");
    let confirmation = RecordingConfirmation::with_decision(false);

    assert!(matches!(
        confirm_and_begin_install(
            &state,
            &update_id,
            ReleaseChannel::Stable,
            NOW,
            &confirmation,
            &CancellationToken::default(),
        )
        .expect("cancelled confirmation"),
        UpdateInstallOutcome::Cancelled
    ));
    assert_eq!(
        confirmation
            .presentations
            .lock()
            .expect("presentations")
            .as_slice(),
        [UpdateInstallPresentation {
            version: "7.8.9".to_owned(),
            source: "Openloop signed stable release".to_owned(),
        }]
    );
    let status = state.snapshot(NOW).expect("restored available status");
    assert_eq!(status.state, UpdatePhase::Available);
    assert_eq!(status.update_id.as_deref(), Some(update_id.as_str()));
}

#[test]
fn download_failures_and_disk_shortage_never_expose_sensitive_details() {
    let shortage =
        ensure_update_disk_capacity(1_024, 2_048).expect_err("insufficient disk must fail");
    assert!(shortage.to_string().contains("disk space"));

    for failure in [
        UpdateFailure::UnsafeSource,
        UpdateFailure::SignatureVerification,
        UpdateFailure::DownloadInterrupted,
        UpdateFailure::InsufficientDiskSpace,
    ] {
        let state = UpdateState::new(ReleaseChannel::Test, UPDATE_TTL);
        let _ = available(&state, NOW);
        state.fail(failure).expect("available state can fail");
        let serialized =
            serde_json::to_string(&state.snapshot(NOW).expect("failure")).expect("status JSON");
        assert!(!serialized.contains("github.com"));
        assert!(!serialized.contains("signature-value"));
        assert!(!serialized.contains("Openloop.app.tar.gz"));
    }
}

#[test]
fn concurrent_checks_share_the_existing_check_without_starting_another() {
    let state = Arc::new(UpdateState::<()>::new(ReleaseChannel::Test, UPDATE_TTL));
    let barrier = Arc::new(Barrier::new(3));
    let results = (0..2)
        .map(|_| {
            let state = state.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                state.begin_check(NOW).expect("begin concurrent check")
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let outcomes = results
        .into_iter()
        .map(|thread| thread.join().expect("check thread"))
        .collect::<Vec<_>>();

    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| **outcome == CheckStart::Started)
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| **outcome == CheckStart::AlreadyChecking)
            .count(),
        1
    );
}

#[test]
fn schedule_waits_for_stability_throttles_automatic_checks_and_never_installs() {
    let mut schedule = UpdateCheckSchedule::new(Duration::ZERO, None);
    assert_eq!(schedule.automatic_action(Duration::from_secs(29)), None);
    assert_eq!(
        schedule.automatic_action(Duration::from_secs(30)),
        Some(ScheduledUpdateAction::CheckOnly)
    );
    assert_eq!(
        schedule.automatic_action(Duration::from_secs(60 * 60 * 23)),
        None
    );
    assert_eq!(
        schedule.automatic_action(Duration::from_secs(24 * 60 * 60 + 30)),
        Some(ScheduledUpdateAction::CheckOnly)
    );

    let mut manual = UpdateCheckSchedule::new(Duration::ZERO, Some(Duration::from_secs(100)));
    assert_eq!(
        manual.manual_action(Duration::from_secs(101)),
        ScheduledUpdateAction::CheckOnly
    );
    assert_eq!(manual.automatic_action(Duration::from_secs(130)), None);
}

struct FixedChecker;

impl UpdateChecker<&'static str> for FixedChecker {
    fn check(&self) -> Result<Option<AvailableUpdate<&'static str>>, UpdateFailure> {
        Ok(Some(AvailableUpdate::new(
            "raw-update-object-with-signature-and-url",
            "3.4.5",
            ReleaseChannel::Test,
        )))
    }
}

struct CompletingInstaller;

impl UpdateInstaller<&'static str> for CompletingInstaller {
    fn install(
        &self,
        update: &'static str,
        observer: &dyn UpdateInstallObserver,
    ) -> Result<UpdateInstallResult, UpdateFailure> {
        assert_eq!(update, "raw-update-object-with-signature-and-url");
        observer
            .download_progress(1, Some(2))
            .map_err(|_| UpdateFailure::Install)?;
        observer.verifying().map_err(|_| UpdateFailure::Install)?;
        observer
            .ready_to_install()
            .map_err(|_| UpdateFailure::Install)?;
        observer.installing().map_err(|_| UpdateFailure::Install)?;
        Ok(UpdateInstallResult::Committed)
    }
}

struct SequencedConfirmation {
    decisions: Mutex<VecDeque<bool>>,
    presentations: Mutex<Vec<UpdateInstallPresentation>>,
}

impl UpdateInstallConfirmation for SequencedConfirmation {
    fn confirm(
        &self,
        presentation: &UpdateInstallPresentation,
        _cancellation: &CancellationToken,
    ) -> Result<bool, UpdateStateError> {
        self.presentations
            .lock()
            .expect("confirmation presentations")
            .push(presentation.clone());
        self.decisions
            .lock()
            .expect("confirmation decisions")
            .pop_front()
            .ok_or(UpdateStateError::PromptUnavailable)
    }
}

#[derive(Default)]
struct RecordingRestart(AtomicUsize);

impl UpdateRestartRequester for RecordingRestart {
    fn request_restart(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn dispatch(
    dispatcher: &AuthenticatedBridgeDispatcher,
    launch_id: Uuid,
    secret: &[u8],
    sequence: u64,
    method: &str,
    payload: Value,
) -> openloop_desktop_lib::bridge::protocol::BridgeResponse {
    let request = BridgeRequest {
        version: BRIDGE_PROTOCOL_VERSION,
        request_id: format!("update-request-{sequence}"),
        launch_id: launch_id.to_string(),
        method: method.to_owned(),
        payload,
    };
    let mut nonce = [0; 32];
    nonce[..8].copy_from_slice(&sequence.to_be_bytes());
    dispatcher
        .dispatch(
            PeerIdentity {
                uid: unsafe { libc::geteuid() },
                pid: process::id(),
            },
            sign_request(request, nonce, secret).expect("signed update request"),
        )
        .expect("authenticated update response")
}

#[test]
fn bridge_dispatch_exposes_safe_status_and_requires_native_confirmation_before_install() {
    let state = Arc::new(UpdateState::new(ReleaseChannel::Test, UPDATE_TTL));
    let confirmation = Arc::new(SequencedConfirmation {
        decisions: Mutex::new(VecDeque::from([false, true])),
        presentations: Mutex::new(Vec::new()),
    });
    let restart = Arc::new(RecordingRestart::default());
    let mut tables = BridgeDispatchTables::unavailable();
    install_update_bridge_handlers(
        &mut tables,
        state.clone(),
        ReleaseChannel::Test,
        Arc::new(FixedChecker),
        Arc::new(CompletingInstaller),
        confirmation.clone(),
        restart.clone(),
        Arc::new(|| NOW),
    )
    .expect("install update handlers");
    let launch_id = Uuid::new_v4();
    let secret: Vec<u8> = (0..32).collect();
    let executable = std::env::current_exe().expect("test executable");
    let dispatcher = AuthenticatedBridgeDispatcher::new(
        unsafe { libc::geteuid() },
        capture_process_identity(process::id(), &executable).expect("process identity"),
        executable,
        launch_id,
        secret.clone(),
        tables,
    )
    .expect("update dispatcher");

    let idle = dispatch(
        &dispatcher,
        launch_id,
        &secret,
        1,
        "getUpdateStatus",
        Value::Null,
    );
    assert_eq!(idle.result.expect("idle status")["state"], "idle");

    let checked = dispatch(
        &dispatcher,
        launch_id,
        &secret,
        2,
        "checkForUpdate",
        Value::Null,
    );
    assert!(checked.ok);
    let checked = checked.result.expect("available status");
    let update_id = checked["updateId"]
        .as_str()
        .expect("opaque update id")
        .to_owned();
    assert_eq!(checked["state"], "available");
    assert_eq!(checked["version"], "3.4.5");
    let serialized = serde_json::to_string(&checked).expect("checked JSON");
    assert!(!serialized.contains("raw-update-object"));
    assert!(!serialized.contains("github.com"));
    assert!(!serialized.contains("signature"));

    let cancelled = dispatch(
        &dispatcher,
        launch_id,
        &secret,
        3,
        "installUpdateAndRestart",
        json!({ "updateId": update_id }),
    );
    assert_eq!(
        cancelled.result,
        Some(Value::String("cancelled".to_owned()))
    );
    assert_eq!(
        state.snapshot(NOW).expect("available after cancel").state,
        UpdatePhase::Available
    );

    let restarted = dispatch(
        &dispatcher,
        launch_id,
        &secret,
        4,
        "installUpdateAndRestart",
        json!({ "updateId": update_id }),
    );
    assert_eq!(
        restarted.result,
        Some(Value::String("restarting".to_owned()))
    );
    assert_eq!(restart.0.load(Ordering::SeqCst), 1);
    assert_eq!(
        state.snapshot(NOW).expect("committed after restart").state,
        UpdatePhase::Committed
    );
    assert_eq!(
        confirmation
            .presentations
            .lock()
            .expect("presentations")
            .as_slice(),
        [
            UpdateInstallPresentation {
                version: "3.4.5".to_owned(),
                source: "Openloop signed test release".to_owned(),
            },
            UpdateInstallPresentation {
                version: "3.4.5".to_owned(),
                source: "Openloop signed test release".to_owned(),
            },
        ]
    );
}
