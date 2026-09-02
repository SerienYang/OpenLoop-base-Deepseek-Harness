use std::{
    collections::VecDeque,
    fs,
    os::unix::fs::{symlink, MetadataExt, PermissionsExt},
    process,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Barrier, Mutex,
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
        schedule::{
            ScheduledUpdateAction, ScheduledUpdateWorker, UpdateCheckSchedule,
            UpdateCheckTimestampStore, AUTOMATIC_CHECK_INTERVAL, STARTUP_STABILITY_DELAY,
        },
        state::{
            confirm_and_begin_install, install_update_bridge_handlers, AvailableUpdate, CheckStart,
            UpdateChecker, UpdateFailure, UpdateInstallConfirmation, UpdateInstallObserver,
            UpdateInstallOutcome, UpdateInstallPresentation, UpdateInstallResult, UpdateInstaller,
            UpdatePhase, UpdateRestartRequester, UpdateState, UpdateStateError,
            MAX_RELEASE_NOTES_BYTES,
        },
    },
};
use serde_json::{json, Value};
use tempfile::tempdir;
use uuid::Uuid;

#[cfg(target_os = "macos")]
use openloop_desktop_lib::update::state::{
    AppKitUpdateInstallConfirmation, AppKitUpdateInstallConfirmationBackend,
    UpdateConfirmationCancellation, UpdateConfirmationCompletion,
};

const NOW: Duration = Duration::from_secs(1_000_000);
const UPDATE_TTL: Duration = Duration::from_secs(15 * 60);
const WAITER_STRESS_ROUNDS: usize = 100;

fn available(state: &UpdateState<&'static str>, now: Duration) -> String {
    assert!(matches!(
        state.begin_check(now).expect("begin check"),
        CheckStart::Started(_)
    ));
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
    assert!(matches!(
        no_update.begin_check(NOW).expect("begin no-update check"),
        CheckStart::Started(_)
    ));
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
        &|| NOW,
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
            &|| NOW,
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
                    &|| NOW,
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
    let monotonic = Arc::new(Mutex::new(Duration::ZERO));
    let state_clock = monotonic.clone();
    let state = UpdateState::with_capability_clock(
        ReleaseChannel::Test,
        UPDATE_TTL,
        Arc::new(move || *state_clock.lock().expect("monotonic clock")),
    );
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
            &|| NOW + Duration::from_secs(2),
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
            &|| NOW + Duration::from_secs(2),
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
            &|| NOW + Duration::from_secs(2),
            &confirmation,
            &CancellationToken::default(),
        ),
        Err(UpdateStateError::WrongChannel)
    ));
    *monotonic.lock().expect("advance monotonic clock") = UPDATE_TTL + Duration::from_secs(2);
    assert!(matches!(
        confirm_and_begin_install(
            &state,
            &current_id,
            ReleaseChannel::Test,
            &|| NOW + UPDATE_TTL + Duration::from_secs(2),
            &confirmation,
            &CancellationToken::default(),
        ),
        Err(UpdateStateError::ExpiredUpdateId)
    ));
}

#[test]
fn update_id_ttl_uses_monotonic_time_when_the_wall_clock_moves_backward() {
    let monotonic = Arc::new(Mutex::new(Duration::ZERO));
    let state_clock = monotonic.clone();
    let state = UpdateState::with_capability_clock(
        ReleaseChannel::Test,
        UPDATE_TTL,
        Arc::new(move || *state_clock.lock().expect("monotonic clock")),
    );
    let wall_clock = Arc::new(Mutex::new(NOW));
    let update_id = available(&state, *wall_clock.lock().expect("wall clock at issuance"));
    *wall_clock.lock().expect("wall clock rollback") = NOW - Duration::from_secs(60 * 60);
    *monotonic.lock().expect("monotonic before confirmation") = UPDATE_TTL - Duration::from_secs(1);

    let result = confirm_and_begin_install(
        &state,
        &update_id,
        ReleaseChannel::Test,
        &|| *wall_clock.lock().expect("rolled-back wall clock"),
        &AdvancingConfirmation {
            clock: monotonic.clone(),
            confirmed_at: UPDATE_TTL,
        },
        &CancellationToken::default(),
    );

    assert!(matches!(result, Err(UpdateStateError::ExpiredUpdateId)));
    let status = state
        .snapshot(*wall_clock.lock().expect("wall clock after expiry"))
        .expect("expired update status");
    assert_eq!(status.state, UpdatePhase::Failed);
    assert_eq!(
        status.last_checked_at,
        Some(NOW.as_millis() as u64),
        "the public lastCheckedAt remains the wall-clock epoch"
    );
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
            &|| NOW,
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
            .filter(|outcome| matches!(outcome, CheckStart::Started(_)))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, CheckStart::AlreadyChecking(_)))
            .count(),
        1
    );
    let started = outcomes.iter().find_map(|outcome| match outcome {
        CheckStart::Started(completion) => Some(completion),
        CheckStart::AlreadyChecking(_) => None,
    });
    let waiting = outcomes.iter().find_map(|outcome| match outcome {
        CheckStart::AlreadyChecking(completion) => Some(completion),
        CheckStart::Started(_) => None,
    });
    assert!(Arc::ptr_eq(
        started.expect("started completion"),
        waiting.expect("waiting completion")
    ));
}

#[test]
fn waiting_check_call_observes_the_existing_check_final_status() {
    let state = Arc::new(UpdateState::new(ReleaseChannel::Test, UPDATE_TTL));
    assert!(matches!(
        state.begin_check(NOW).expect("begin independent check"),
        CheckStart::Started(_)
    ));
    let completion = match state.begin_check(NOW).expect("join independent check") {
        CheckStart::AlreadyChecking(completion) => completion,
        CheckStart::Started(_) => panic!("second caller started another check"),
    };
    let waiting_state = state.clone();
    let waiter = thread::spawn(move || {
        waiting_state.wait_for_check(&completion, &CancellationToken::default())
    });

    let expected = state
        .finish_check(
            NOW + Duration::from_secs(1),
            Some(AvailableUpdate::new(
                "shared-update",
                "2.0.0",
                ReleaseChannel::Test,
            )),
        )
        .expect("finish independent check");
    let observed = waiter
        .join()
        .expect("waiting check thread")
        .expect("waiting check result");

    assert_eq!(observed, expected);
}

#[test]
fn waiting_check_call_observes_the_existing_check_failure() {
    let state = Arc::new(UpdateState::<()>::new(ReleaseChannel::Test, UPDATE_TTL));
    assert!(matches!(
        state.begin_check(NOW).expect("begin independent check"),
        CheckStart::Started(_)
    ));
    let completion = match state.begin_check(NOW).expect("join independent check") {
        CheckStart::AlreadyChecking(completion) => completion,
        CheckStart::Started(_) => panic!("second caller started another check"),
    };
    let waiting_state = state.clone();
    let waiter = thread::spawn(move || {
        waiting_state.wait_for_check(&completion, &CancellationToken::default())
    });

    state
        .fail(UpdateFailure::Check)
        .expect("fail independent check");
    let observed = waiter
        .join()
        .expect("waiting check thread")
        .expect("waiting check result");

    assert_eq!(observed.state, UpdatePhase::Failed);
    assert_eq!(observed.message.as_deref(), Some("Update check failed"));
}

#[test]
fn delayed_waiter_observes_its_original_completed_check_after_a_new_check_finishes() {
    for _ in 0..WAITER_STRESS_ROUNDS {
        let state = UpdateState::new(ReleaseChannel::Test, UPDATE_TTL);
        assert!(matches!(
            state.begin_check(NOW).expect("begin check A"),
            CheckStart::Started(_)
        ));
        let completion_a = match state.begin_check(NOW).expect("join check A") {
            CheckStart::AlreadyChecking(completion) => completion,
            CheckStart::Started(_) => panic!("check B did not join check A"),
        };
        let expected = state
            .finish_check(
                NOW + Duration::from_secs(1),
                Some(AvailableUpdate::new(
                    "update-a",
                    "2.0.0",
                    ReleaseChannel::Test,
                )),
            )
            .expect("finish check A");

        assert!(matches!(
            state
                .begin_check(NOW + Duration::from_secs(2))
                .expect("begin check C"),
            CheckStart::Started(_)
        ));
        state
            .finish_check(
                NOW + Duration::from_secs(3),
                Some(AvailableUpdate::new(
                    "update-c",
                    "3.0.0",
                    ReleaseChannel::Test,
                )),
            )
            .expect("finish check C");

        let observed = state
            .wait_for_check(&completion_a, &CancellationToken::default())
            .expect("wait for check A");
        assert_eq!(observed, expected);
    }
}

#[test]
fn delayed_waiter_observes_its_original_failed_check_after_a_new_check_finishes() {
    for _ in 0..WAITER_STRESS_ROUNDS {
        let state = UpdateState::<()>::new(ReleaseChannel::Test, UPDATE_TTL);
        assert!(matches!(
            state.begin_check(NOW).expect("begin check A"),
            CheckStart::Started(_)
        ));
        let completion_a = match state.begin_check(NOW).expect("join check A") {
            CheckStart::AlreadyChecking(completion) => completion,
            CheckStart::Started(_) => panic!("check B did not join check A"),
        };
        state.fail(UpdateFailure::Check).expect("fail check A");
        let expected = state.snapshot(NOW).expect("failed check A status");

        assert!(matches!(
            state
                .begin_check(NOW + Duration::from_secs(1))
                .expect("begin check C"),
            CheckStart::Started(_)
        ));
        state
            .finish_check(NOW + Duration::from_secs(2), None)
            .expect("finish check C");

        let observed = state
            .wait_for_check(&completion_a, &CancellationToken::default())
            .expect("wait for check A");
        assert_eq!(observed, expected);
    }
}

#[test]
fn waiting_check_call_exits_when_cancelled() {
    for _ in 0..WAITER_STRESS_ROUNDS {
        let state = Arc::new(UpdateState::<()>::new(ReleaseChannel::Test, UPDATE_TTL));
        assert!(matches!(
            state.begin_check(NOW).expect("begin independent check"),
            CheckStart::Started(_)
        ));
        let completion = match state.begin_check(NOW).expect("join independent check") {
            CheckStart::AlreadyChecking(completion) => completion,
            CheckStart::Started(_) => panic!("second caller started another check"),
        };
        let cancellation = CancellationToken::default();
        let waiting_cancellation = cancellation.clone();
        let waiter =
            thread::spawn(move || state.wait_for_check(&completion, &waiting_cancellation));

        cancellation.cancel();

        assert!(matches!(
            waiter.join().expect("waiting check thread"),
            Err(UpdateStateError::Cancelled)
        ));
    }
}

#[test]
fn schedule_waits_for_stability_throttles_automatic_checks_and_never_installs() {
    let mut schedule = UpdateCheckSchedule::new(None);
    assert_eq!(
        schedule.automatic_action(Duration::from_secs(29), NOW),
        None
    );
    assert_eq!(
        schedule.automatic_action(Duration::from_secs(30), NOW),
        Some(ScheduledUpdateAction::CheckOnly)
    );
    assert_eq!(
        schedule.automatic_action(
            Duration::from_secs(60 * 60 * 23),
            NOW + Duration::from_secs(60 * 60 * 23)
        ),
        None
    );
    assert_eq!(
        schedule.automatic_action(
            Duration::from_secs(24 * 60 * 60 + 30),
            NOW + Duration::from_secs(24 * 60 * 60)
        ),
        Some(ScheduledUpdateAction::CheckOnly)
    );

    let mut manual = UpdateCheckSchedule::new(Some(Duration::from_secs(100)));
    assert_eq!(
        manual.manual_action(Duration::from_secs(101)),
        ScheduledUpdateAction::CheckOnly
    );
    assert_eq!(
        manual.automatic_action(Duration::from_secs(130), Duration::from_secs(130)),
        None
    );
}

#[test]
fn persisted_check_timestamp_throttles_a_new_process_after_startup_stability() {
    let root = tempdir().expect("timestamp root");
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700))
        .expect("private timestamp root");
    let first =
        UpdateCheckTimestampStore::open(root.path(), ReleaseChannel::Test).expect("first store");
    first.record(NOW).expect("persist first check");
    drop(first);

    let restarted =
        UpdateCheckTimestampStore::open(root.path(), ReleaseChannel::Test).expect("reopened store");
    let mut schedule = UpdateCheckSchedule::new(restarted.load());

    assert_eq!(
        schedule.automatic_action(
            STARTUP_STABILITY_DELAY,
            NOW + AUTOMATIC_CHECK_INTERVAL - Duration::from_secs(1)
        ),
        None
    );
    assert_eq!(
        schedule.automatic_action(STARTUP_STABILITY_DELAY, NOW + AUTOMATIC_CHECK_INTERVAL),
        Some(ScheduledUpdateAction::CheckOnly)
    );
}

#[test]
fn future_persisted_timestamp_is_due_after_startup_stability() {
    let future = NOW + AUTOMATIC_CHECK_INTERVAL + Duration::from_secs(60);
    let mut schedule = UpdateCheckSchedule::new(Some(future));

    assert_eq!(
        schedule.automatic_action(STARTUP_STABILITY_DELAY - Duration::from_secs(1), NOW),
        None
    );
    assert_eq!(
        schedule.automatic_action(STARTUP_STABILITY_DELAY, NOW),
        Some(ScheduledUpdateAction::CheckOnly)
    );
    assert_eq!(
        schedule.automatic_action(
            STARTUP_STABILITY_DELAY + Duration::from_secs(1),
            NOW + Duration::from_secs(1),
        ),
        None,
        "the one recovery check must refresh the in-memory timestamp"
    );
}

#[test]
fn scheduled_worker_drop_does_not_wait_for_a_hung_checker() {
    let (started_tx, started_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let (finished_tx, finished_rx) = mpsc::sync_channel(1);
    let checker = Arc::new(HangingChecker {
        started: started_tx,
        release: Mutex::new(release_rx),
        finished: finished_tx,
    });
    let worker = ScheduledUpdateWorker::start_for_test(
        Arc::new(Mutex::new(UpdateCheckSchedule::new(None))),
        Arc::new(UpdateState::new(ReleaseChannel::Test, UPDATE_TTL)),
        checker,
        Arc::new(|| NOW),
        Duration::from_millis(1),
        STARTUP_STABILITY_DELAY,
    )
    .expect("start scheduled worker");
    started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("checker started");

    let (dropped_tx, dropped_rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        drop(worker);
        dropped_tx.send(()).expect("report worker drop");
    });
    let dropped = dropped_rx.recv_timeout(Duration::from_millis(250));

    release_tx.send(()).expect("release checker");
    finished_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("checker finished");
    assert!(
        dropped.is_ok(),
        "worker Drop waited for a checker that was blocked on network I/O"
    );
}

#[test]
fn timestamp_store_ignores_corrupt_or_unsafe_records_without_following_symlinks() {
    let root = tempdir().expect("timestamp root");
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700))
        .expect("private timestamp root");
    let store = UpdateCheckTimestampStore::open(root.path(), ReleaseChannel::Test)
        .expect("timestamp store");
    let path = store.path();

    fs::write(&path, b"{not-json").expect("corrupt timestamp");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("corrupt permissions");
    assert_eq!(store.load(), None);

    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("wide permissions");
    assert_eq!(store.load(), None);
    assert_eq!(
        store.load_for_owner(unsafe { libc::geteuid() }.wrapping_add(1)),
        None
    );

    fs::remove_file(&path).expect("remove unsafe timestamp");
    fs::create_dir(&path).expect("non-regular timestamp");
    assert_eq!(store.load(), None);
    fs::remove_dir(&path).expect("remove non-regular timestamp");

    let outside = root.path().join("outside");
    fs::write(&outside, b"do-not-touch").expect("outside timestamp");
    symlink(&outside, &path).expect("timestamp symlink");
    assert_eq!(store.load(), None);
    store.record(NOW).expect("replace unsafe entry atomically");
    assert_eq!(
        fs::read_to_string(&outside).expect("outside contents"),
        "do-not-touch"
    );
    let metadata = fs::symlink_metadata(&path).expect("safe replacement metadata");
    assert!(metadata.is_file());
    assert!(!metadata.file_type().is_symlink());
    assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
    assert_eq!(metadata.mode() & 0o077, 0);
}

#[test]
fn manual_check_bypasses_throttle_and_refreshes_the_persisted_wall_clock() {
    let root = tempdir().expect("timestamp root");
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700))
        .expect("private timestamp root");
    let store = UpdateCheckTimestampStore::open(root.path(), ReleaseChannel::Stable)
        .expect("timestamp store");
    store.record(NOW).expect("persist old check");
    let manual_at = NOW + Duration::from_secs(60);
    let mut schedule = UpdateCheckSchedule::new(store.load());

    assert_eq!(
        schedule.manual_action(manual_at),
        ScheduledUpdateAction::CheckOnly
    );
    store.record(manual_at).expect("persist manual check");

    let restarted = UpdateCheckTimestampStore::open(root.path(), ReleaseChannel::Stable)
        .expect("reopened stable store");
    assert_eq!(restarted.load(), Some(manual_at));
    assert_eq!(
        schedule.automatic_action(
            STARTUP_STABILITY_DELAY,
            manual_at + AUTOMATIC_CHECK_INTERVAL - Duration::from_secs(1)
        ),
        None
    );
}

#[test]
fn timestamp_records_are_channel_scoped() {
    let root = tempdir().expect("timestamp root");
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700))
        .expect("private timestamp root");
    let test =
        UpdateCheckTimestampStore::open(root.path(), ReleaseChannel::Test).expect("test store");
    let stable =
        UpdateCheckTimestampStore::open(root.path(), ReleaseChannel::Stable).expect("stable store");

    test.record(NOW).expect("test timestamp");
    stable
        .record(NOW + Duration::from_secs(1))
        .expect("stable timestamp");

    assert_ne!(test.path(), stable.path());
    assert_eq!(test.load(), Some(NOW));
    assert_eq!(stable.load(), Some(NOW + Duration::from_secs(1)));
}

#[test]
fn release_notes_are_safely_truncated_and_preserved_with_available_updates() {
    let state = UpdateState::new(ReleaseChannel::Test, UPDATE_TTL);
    state.begin_check(NOW).expect("begin check");
    let notes = format!("{}é-tail", "n".repeat(MAX_RELEASE_NOTES_BYTES - 1));
    let status = state
        .finish_check(
            NOW,
            Some(
                AvailableUpdate::new("host-update", "5.6.7", ReleaseChannel::Test)
                    .with_release_notes(notes),
            ),
        )
        .expect("available update");

    let release_notes = status.release_notes.expect("release notes");
    assert!(release_notes.len() <= MAX_RELEASE_NOTES_BYTES);
    assert!(release_notes.starts_with('n'));
    assert!(!release_notes.contains("tail"));
}

struct FixedChecker;

impl UpdateChecker<&'static str> for FixedChecker {
    fn check(&self) -> Result<Option<AvailableUpdate<&'static str>>, UpdateFailure> {
        Ok(Some(
            AvailableUpdate::new(
                "raw-update-object-with-signature-and-url",
                "3.4.5",
                ReleaseChannel::Test,
            )
            .with_release_notes("Signed release notes"),
        ))
    }
}

struct CountingChecker(AtomicUsize);

impl UpdateChecker<&'static str> for CountingChecker {
    fn check(&self) -> Result<Option<AvailableUpdate<&'static str>>, UpdateFailure> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(None)
    }
}

struct HangingChecker {
    started: mpsc::SyncSender<()>,
    release: Mutex<mpsc::Receiver<()>>,
    finished: mpsc::SyncSender<()>,
}

impl UpdateChecker<&'static str> for HangingChecker {
    fn check(&self) -> Result<Option<AvailableUpdate<&'static str>>, UpdateFailure> {
        self.started.send(()).expect("report checker start");
        self.release
            .lock()
            .expect("checker release lock")
            .recv()
            .expect("checker release");
        self.finished.send(()).expect("report checker finish");
        Ok(None)
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

struct RollingBackInstaller;

impl UpdateInstaller<&'static str> for RollingBackInstaller {
    fn install(
        &self,
        _update: &'static str,
        observer: &dyn UpdateInstallObserver,
    ) -> Result<UpdateInstallResult, UpdateFailure> {
        observer
            .download_progress(1, Some(1))
            .map_err(|_| UpdateFailure::Install)?;
        observer.verifying().map_err(|_| UpdateFailure::Install)?;
        observer
            .ready_to_install()
            .map_err(|_| UpdateFailure::Install)?;
        observer.installing().map_err(|_| UpdateFailure::Install)?;
        Ok(UpdateInstallResult::RolledBack)
    }
}

struct CountingInstaller(AtomicUsize);

impl UpdateInstaller<&'static str> for CountingInstaller {
    fn install(
        &self,
        _update: &'static str,
        _observer: &dyn UpdateInstallObserver,
    ) -> Result<UpdateInstallResult, UpdateFailure> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(UpdateInstallResult::Committed)
    }
}

struct AdvancingConfirmation {
    clock: Arc<Mutex<Duration>>,
    confirmed_at: Duration,
}

impl UpdateInstallConfirmation for AdvancingConfirmation {
    fn confirm(
        &self,
        _presentation: &UpdateInstallPresentation,
        _cancellation: &CancellationToken,
    ) -> Result<bool, UpdateStateError> {
        *self.clock.lock().expect("fake clock") = self.confirmed_at;
        Ok(true)
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
    assert_eq!(checked["releaseNotes"], "Signed release notes");
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

#[test]
fn bridge_check_waits_for_an_existing_host_check_without_starting_another() {
    let state = Arc::new(UpdateState::new(ReleaseChannel::Test, UPDATE_TTL));
    assert!(matches!(
        state.begin_check(NOW).expect("begin independent check"),
        CheckStart::Started(_)
    ));
    let checker = Arc::new(CountingChecker(AtomicUsize::new(0)));
    let mut tables = BridgeDispatchTables::unavailable();
    install_update_bridge_handlers(
        &mut tables,
        state.clone(),
        ReleaseChannel::Test,
        checker.clone(),
        Arc::new(CompletingInstaller),
        Arc::new(RecordingConfirmation::with_decision(true)),
        Arc::new(RecordingRestart::default()),
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
    let waiting_dispatcher = dispatcher.clone();
    let waiting_secret = secret.clone();
    let (result_tx, result_rx) = mpsc::channel();
    let waiter = thread::spawn(move || {
        let response = dispatch(
            &waiting_dispatcher,
            launch_id,
            &waiting_secret,
            101,
            "checkForUpdate",
            Value::Null,
        );
        result_tx.send(response).expect("send bridge response");
    });

    assert!(matches!(
        result_rx.recv_timeout(Duration::from_secs(2)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    let expected = state
        .finish_check(
            NOW + Duration::from_secs(1),
            Some(AvailableUpdate::new(
                "shared-update",
                "8.0.0",
                ReleaseChannel::Test,
            )),
        )
        .expect("finish independent check");
    let response = result_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("waiting bridge response");
    waiter.join().expect("waiting bridge thread");

    assert!(response.ok);
    assert_eq!(
        response.result,
        Some(serde_json::to_value(expected).expect("expected status"))
    );
    assert_eq!(checker.0.load(Ordering::SeqCst), 0);
}

#[test]
fn bridge_install_reports_an_error_while_preserving_rolled_back_host_state() {
    let state = Arc::new(UpdateState::new(ReleaseChannel::Test, UPDATE_TTL));
    let restart = Arc::new(RecordingRestart::default());
    let mut tables = BridgeDispatchTables::unavailable();
    install_update_bridge_handlers(
        &mut tables,
        state.clone(),
        ReleaseChannel::Test,
        Arc::new(FixedChecker),
        Arc::new(RollingBackInstaller),
        Arc::new(RecordingConfirmation::with_decision(true)),
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
    let checked = dispatch(
        &dispatcher,
        launch_id,
        &secret,
        201,
        "checkForUpdate",
        Value::Null,
    );
    let update_id = checked.result.expect("available status")["updateId"]
        .as_str()
        .expect("opaque update id")
        .to_owned();

    let installed = dispatch(
        &dispatcher,
        launch_id,
        &secret,
        202,
        "installUpdateAndRestart",
        json!({ "updateId": update_id }),
    );

    assert!(!installed.ok);
    assert_eq!(
        installed.error.expect("rollback bridge error").code,
        "update_failure"
    );
    assert_eq!(
        state.snapshot(NOW).expect("rolled back status").state,
        UpdatePhase::RolledBack
    );
    assert_eq!(restart.0.load(Ordering::SeqCst), 0);
}

#[test]
fn bridge_rejects_an_update_that_expires_while_confirmation_is_open() {
    let monotonic = Arc::new(Mutex::new(Duration::ZERO));
    let state_clock = monotonic.clone();
    let state = Arc::new(UpdateState::with_capability_clock(
        ReleaseChannel::Test,
        UPDATE_TTL,
        Arc::new(move || *state_clock.lock().expect("monotonic clock")),
    ));
    let install_count = Arc::new(CountingInstaller(AtomicUsize::new(0)));
    let mut tables = BridgeDispatchTables::unavailable();
    install_update_bridge_handlers(
        &mut tables,
        state.clone(),
        ReleaseChannel::Test,
        Arc::new(FixedChecker),
        install_count.clone(),
        Arc::new(AdvancingConfirmation {
            clock: monotonic,
            confirmed_at: UPDATE_TTL,
        }),
        Arc::new(RecordingRestart::default()),
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
    let checked = dispatch(
        &dispatcher,
        launch_id,
        &secret,
        301,
        "checkForUpdate",
        Value::Null,
    );
    let update_id = checked.result.expect("available status")["updateId"]
        .as_str()
        .expect("opaque update id")
        .to_owned();

    let expired = dispatch(
        &dispatcher,
        launch_id,
        &secret,
        302,
        "installUpdateAndRestart",
        json!({ "updateId": update_id }),
    );

    assert!(!expired.ok);
    assert_eq!(install_count.0.load(Ordering::SeqCst), 0);
    let status = state
        .snapshot(NOW + UPDATE_TTL)
        .expect("expired update status");
    assert_eq!(status.state, UpdatePhase::Failed);
    assert_eq!(
        status.message.as_deref(),
        Some("Update offer expired; check again")
    );

    let reused = dispatch(
        &dispatcher,
        launch_id,
        &secret,
        303,
        "installUpdateAndRestart",
        json!({ "updateId": update_id }),
    );
    assert!(!reused.ok);
    assert_eq!(install_count.0.load(Ordering::SeqCst), 0);
}
