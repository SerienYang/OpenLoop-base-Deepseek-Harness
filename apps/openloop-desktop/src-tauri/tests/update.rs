use std::{
    ffi::CString,
    fs,
    os::unix::{ffi::OsStrExt, fs::symlink},
    panic::{catch_unwind, AssertUnwindSafe},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use openloop_desktop_lib::update::{
    channel::{ReleaseChannel, UpdateChannelConfig, UPDATE_NETWORK_TIMEOUT},
    recovery::{
        recover_interrupted_update, recover_interrupted_update_with_bound_companion,
        recover_interrupted_update_with_companion, update_journal_path, CandidateHealth,
        CommittedPublication, HealthStatus, PublicationCompanion, PublicationOutcome,
        RecoveryBoundary, RecoveryError, RecoveryState, RecoveryTestHook, RecoveryTransaction,
    },
};
use tempfile::tempdir;

const VALID_TAURI_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgRTc2MjBGMTg0MkI0RTgxRgpSV1FmNkxSQ0dBOWk1M21sWWVjTzRJelQ1MVRHUHB2V3VjTlNDaDFDQk0wUVRhTG43M1k3R0ZPMwo=";
const REPOSITORY_TEST_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDg2QzhGMThDMUVFRkUzRUYKUldUdjQrOGVqUEhJaHNKdlgrNVE4REtTYTRENXpzL0VEVi9pb2pmTVJiR2MrRHl3Wnowdy9Lay8K";

#[test]
fn channel_contracts_are_explicit_isolated_and_use_the_actual_repository() {
    let test = UpdateChannelConfig::new(ReleaseChannel::Test, Some(VALID_TAURI_PUBLIC_KEY))
        .expect("valid test updater configuration");
    let stable = UpdateChannelConfig::new(ReleaseChannel::Stable, Some(VALID_TAURI_PUBLIC_KEY))
        .expect("valid stable updater configuration");
    let app_data = Path::new("/Users/example/Library/Application Support/ai.openloop.desktop");

    assert_eq!(test.bundle_identifier(), "ai.openloop.desktop.test");
    assert_eq!(test.manifest_filename(), "latest-test-k1.json");
    assert_eq!(test.data_root_name(), "Openloop-Test");
    assert_eq!(test.data_root(app_data), app_data.join("Openloop-Test"),);
    assert_eq!(
        test.dsh_home(app_data),
        app_data.join("Openloop-Test").join("dsh"),
    );
    assert_eq!(
        test.endpoint().as_str(),
        "https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-rolling/latest-test-k1.json"
    );
    assert_eq!(test.public_key_environment(), "OPENLOOP_UPDATER_PUBLIC_KEY");
    assert_eq!(test.public_key(), VALID_TAURI_PUBLIC_KEY);

    assert_eq!(stable.bundle_identifier(), "ai.openloop.desktop");
    assert_eq!(stable.manifest_filename(), "latest-stable-k1.json");
    assert_eq!(stable.data_root_name(), "Openloop");
    assert_eq!(stable.data_root(app_data), app_data.join("Openloop"));
    assert_eq!(
        stable.dsh_home(app_data),
        app_data.join("Openloop").join("dsh"),
    );
    assert_eq!(
        stable.endpoint().as_str(),
        "https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-stable-rolling/latest-stable-k1.json"
    );
    assert_eq!(
        stable.public_key_environment(),
        "OPENLOOP_STABLE_UPDATER_PUBLIC_KEY"
    );

    for config in [&test, &stable] {
        assert_eq!(config.endpoint().scheme(), "https");
        assert!(!config.endpoint().as_str().contains("deepseek-openloop"));
    }
    assert_ne!(test.bundle_identifier(), stable.bundle_identifier());
    assert_ne!(test.manifest_filename(), stable.manifest_filename());
    assert_ne!(test.data_root_name(), stable.data_root_name());
    assert_ne!(test.dsh_home(app_data), stable.dsh_home(app_data));
    assert_ne!(
        test.public_key_environment(),
        stable.public_key_environment()
    );
}

#[test]
fn updater_builder_config_uses_the_endpoint_and_key_for_each_channel() {
    let test = UpdateChannelConfig::new(ReleaseChannel::Test, Some(VALID_TAURI_PUBLIC_KEY))
        .expect("valid test updater configuration");
    let stable = UpdateChannelConfig::new(ReleaseChannel::Stable, Some(REPOSITORY_TEST_PUBLIC_KEY))
        .expect("valid stable updater configuration");

    let test_builder = test.updater_builder_config();
    assert_eq!(
        test_builder.endpoints(),
        &[test.endpoint().clone()],
        "test updater must request only latest-test-k1.json"
    );
    assert_eq!(test_builder.public_key(), VALID_TAURI_PUBLIC_KEY);
    assert_eq!(test_builder.timeout(), UPDATE_NETWORK_TIMEOUT);

    let stable_builder = stable.updater_builder_config();
    assert_eq!(
        stable_builder.endpoints(),
        &[stable.endpoint().clone()],
        "stable updater must request only latest-stable-k1.json"
    );
    assert_eq!(
        stable_builder.public_key(),
        REPOSITORY_TEST_PUBLIC_KEY,
        "stable updater must use the stable config key, not the test key"
    );
    assert_eq!(stable_builder.timeout(), UPDATE_NETWORK_TIMEOUT);

    assert_ne!(test_builder.endpoints(), stable_builder.endpoints());
    assert_ne!(test_builder.public_key(), stable_builder.public_key());
}

#[test]
fn channel_configuration_fails_closed_without_a_valid_tauri_public_key() {
    for key in [
        None,
        Some(""),
        Some(" \t\n"),
        Some("not-base64"),
        Some("YQ=="),
    ] {
        let error = UpdateChannelConfig::new(ReleaseChannel::Test, key)
            .expect_err("missing, blank, or malformed updater keys must fail");
        assert!(
            error.to_string().contains("OPENLOOP_UPDATER_PUBLIC_KEY"),
            "unexpected error: {error}"
        );
    }
}

#[test]
fn embedded_test_channel_has_the_current_repository_public_key_without_environment_setup() {
    let config = UpdateChannelConfig::embedded(ReleaseChannel::Test)
        .expect("test builds must embed a valid updater key");

    assert_eq!(config.public_key(), REPOSITORY_TEST_PUBLIC_KEY);
}

#[test]
fn release_channel_parsing_accepts_only_test_and_stable() {
    assert_eq!(
        "test".parse::<ReleaseChannel>().expect("test channel"),
        ReleaseChannel::Test
    );
    assert_eq!(
        "stable".parse::<ReleaseChannel>().expect("stable channel"),
        ReleaseChannel::Stable
    );
    for value in ["", "TEST", "preview", "test "] {
        assert!(
            value.parse::<ReleaseChannel>().is_err(),
            "accepted unsupported channel {value:?}"
        );
    }
}

struct HealthProbe<F>(F);

impl<F> CandidateHealth for HealthProbe<F>
where
    F: for<'a> FnMut(&'a Path, Duration) -> HealthStatus,
{
    fn await_health(&mut self, candidate: &Path, timeout: Duration) -> HealthStatus {
        (self.0)(candidate, timeout)
    }
}

struct TransactionHook<F>(F);

impl<F> RecoveryTestHook for TransactionHook<F>
where
    F: FnMut(RecoveryBoundary, &Path, &Path),
{
    fn before(&mut self, boundary: RecoveryBoundary, left: &Path, right: &Path) {
        (self.0)(boundary, left, right);
    }
}

#[derive(Default)]
struct RecordingCompanion {
    commits: usize,
    rollbacks: usize,
}

#[derive(Default)]
struct FailCommitCompanion {
    commits: usize,
    rollbacks: usize,
}

#[derive(Default)]
struct FailCommitAndFirstRollbackCompanion {
    commits: usize,
    rollbacks: usize,
}

impl PublicationCompanion for FailCommitCompanion {
    fn commit(&mut self, _: &CommittedPublication) -> Result<(), String> {
        self.commits += 1;
        Err("commit failed before irreversible deletion".to_owned())
    }

    fn rollback(&mut self) -> Result<(), String> {
        self.rollbacks += 1;
        Ok(())
    }
}

impl PublicationCompanion for FailCommitAndFirstRollbackCompanion {
    fn commit(&mut self, _: &CommittedPublication) -> Result<(), String> {
        self.commits += 1;
        Err("commit failed before irreversible deletion".to_owned())
    }

    fn rollback(&mut self) -> Result<(), String> {
        self.rollbacks += 1;
        if self.rollbacks == 1 {
            Err("first rollback attempt failed".to_owned())
        } else {
            Ok(())
        }
    }
}

impl PublicationCompanion for RecordingCompanion {
    fn commit(&mut self, _: &CommittedPublication) -> Result<(), String> {
        self.commits += 1;
        Ok(())
    }

    fn rollback(&mut self) -> Result<(), String> {
        self.rollbacks += 1;
        Ok(())
    }
}

fn app_bundle(path: &Path, marker: &str) {
    fs::create_dir(path).expect("app bundle directory");
    fs::write(path.join("marker"), marker).expect("app bundle marker");
}

fn marker(path: &Path) -> String {
    fs::read_to_string(path.join("marker")).expect("app bundle marker")
}

fn transaction_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let fixture = tempdir().expect("temporary update root");
    let installed = fixture.path().join("Openloop.app");
    let candidate = fixture.path().join("Openloop-candidate.app");
    app_bundle(&installed, "old");
    app_bundle(&candidate, "new");
    (fixture, installed, candidate)
}

fn fifo(path: &Path) {
    let path = CString::new(path.as_os_str().as_bytes()).expect("FIFO path");
    // SAFETY: `path` is a live NUL-terminated filesystem path.
    let result = unsafe { libc::mkfifo(path.as_ptr(), 0o600) };
    assert_eq!(
        result,
        0,
        "create FIFO: {}",
        std::io::Error::last_os_error()
    );
}

#[test]
fn recovery_transaction_commits_a_healthy_candidate_and_preserves_recovery_entries() {
    let (fixture, installed, candidate) = transaction_fixture();
    let installed_during_health = installed.clone();
    let candidate_during_health = candidate.clone();
    let transaction =
        RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
    let mut health = HealthProbe(move |published: &Path, timeout| {
        assert_eq!(
            fs::canonicalize(published).expect("published canonical path"),
            fs::canonicalize(&installed_during_health).expect("installed canonical path"),
        );
        assert_eq!(timeout, Duration::from_secs(60));
        assert_eq!(marker(published), "new");
        assert_eq!(
            marker(&candidate_during_health),
            "old",
            "the first swap must leave a complete old app at the candidate path"
        );
        HealthStatus::Healthy
    });

    let outcome = transaction
        .publish(&mut health)
        .expect("healthy publication");

    let PublicationOutcome::Committed { preserved_backup } = outcome else {
        panic!("healthy candidate must commit");
    };
    assert_eq!(marker(&installed), "new");
    assert_eq!(
        fs::canonicalize(&preserved_backup).expect("canonical preserved backup"),
        fs::canonicalize(&candidate).expect("canonical candidate")
    );
    assert_eq!(marker(&preserved_backup), "old");
    assert_eq!(
        fs::read_dir(fixture.path()).expect("update root").count(),
        2,
        "single-swap commit must leave only installed and candidate apps"
    );
}

#[test]
fn recovery_transaction_rolls_back_timeout_and_reported_failure() {
    for status in [
        HealthStatus::TimedOut,
        HealthStatus::Failed("candidate exited before readiness".into()),
    ] {
        let (fixture, installed, candidate) = transaction_fixture();
        let transaction =
            RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
        let expected = status.clone();
        let mut health = HealthProbe(move |_: &Path, timeout: Duration| {
            assert_eq!(timeout, Duration::from_secs(60));
            expected.clone()
        });

        let outcome = transaction
            .publish(&mut health)
            .expect("failed candidate must restore old bundle");

        let PublicationOutcome::RolledBack {
            status: actual,
            failed_candidate,
        } = outcome
        else {
            panic!("failed candidate must roll back");
        };
        assert_eq!(actual, status);
        assert_eq!(marker(&installed), "old");
        assert_eq!(
            fs::canonicalize(&failed_candidate).expect("canonical failed candidate"),
            fs::canonicalize(&candidate).expect("canonical candidate")
        );
        assert_eq!(marker(&failed_candidate), "new");
        assert_eq!(
            fs::read_dir(fixture.path()).expect("update root").count(),
            2,
            "single-swap rollback must leave only installed and candidate apps"
        );
    }
}

#[test]
fn recovery_first_swap_crash_boundary_keeps_both_complete_apps() {
    let (fixture, installed, candidate) = transaction_fixture();
    let transaction =
        RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
    let observed = Arc::new(AtomicBool::new(false));
    let hook_observed = observed.clone();
    let mut hook = TransactionHook(move |boundary, left: &Path, right: &Path| {
        if boundary == RecoveryBoundary::AfterCandidatePublishSwap {
            assert_eq!(
                fs::canonicalize(left).expect("canonical published path"),
                fs::canonicalize(&installed).expect("canonical installed path")
            );
            assert_eq!(
                fs::canonicalize(right).expect("canonical backup path"),
                fs::canonicalize(&candidate).expect("canonical candidate path")
            );
            assert_eq!(marker(left), "new");
            assert_eq!(marker(right), "old");
            hook_observed.store(true, Ordering::SeqCst);
        }
    });
    let mut health = HealthProbe(|_: &Path, _: Duration| HealthStatus::Healthy);

    transaction
        .publish_with_hook(&mut health, &mut hook)
        .expect("single-swap publication");

    assert!(
        observed.load(Ordering::SeqCst),
        "post-swap crash boundary was not observed"
    );
    assert_eq!(
        fs::read_dir(fixture.path()).expect("update root").count(),
        2
    );
}

#[test]
fn crash_after_durable_prepare_without_migration_state_recovers_together() {
    let (fixture, installed, candidate) = transaction_fixture();
    let migration_id = uuid::Uuid::new_v4();
    let transaction =
        RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
    let mut companion = RecordingCompanion::default();
    let mut hook = TransactionHook(|boundary, _: &Path, _: &Path| {
        if boundary == RecoveryBoundary::AfterJournalParentFsync(RecoveryState::Prepared) {
            panic!("injected death after prepared journal fsync");
        }
    });

    let crashed = catch_unwind(AssertUnwindSafe(|| {
        let _ = transaction.prepare_with_hook(Some(migration_id), &mut hook);
    }));
    assert!(crashed.is_err());
    let journal =
        fs::read_to_string(update_journal_path(fixture.path())).expect("durable update journal");
    assert!(journal.contains(&migration_id.to_string()));
    let journal_value: serde_json::Value =
        serde_json::from_str(&journal).expect("update journal JSON");
    assert_eq!(
        journal_value["installedName"],
        serde_json::json!(b"Openloop.app")
    );
    assert_eq!(
        journal_value["candidateName"],
        serde_json::json!(b"Openloop-candidate.app")
    );
    assert!(!journal.contains(&fixture.path().display().to_string()));

    recover_interrupted_update_with_bound_companion(fixture.path(), migration_id, &mut companion)
        .expect("restart recovery");

    assert_eq!(marker(&installed), "old");
    assert_eq!(marker(&candidate), "new");
    assert_eq!(companion.rollbacks, 1);
    assert_eq!(companion.commits, 0);
    assert!(!update_journal_path(fixture.path()).exists());
}

#[test]
fn prepared_transaction_publish_does_not_rewrite_prepared_ownership() {
    let (fixture, installed, candidate) = transaction_fixture();
    let migration_id = uuid::Uuid::new_v4();
    let transaction = RecoveryTransaction::open(fixture.path(), &installed, &candidate)
        .expect("transaction")
        .prepare(Some(migration_id))
        .expect("durable prepared ownership");
    let mut health = HealthProbe(|_: &Path, _: Duration| HealthStatus::Healthy);
    let mut companion = RecordingCompanion::default();
    let mut hook = TransactionHook(|boundary, _: &Path, _: &Path| {
        assert!(
            !matches!(
                boundary,
                RecoveryBoundary::BeforeJournalFileFsync(RecoveryState::Prepared)
                    | RecoveryBoundary::AfterJournalFileFsync(RecoveryState::Prepared)
                    | RecoveryBoundary::BeforeJournalParentFsync(RecoveryState::Prepared)
                    | RecoveryBoundary::AfterJournalParentFsync(RecoveryState::Prepared)
            ),
            "publish rewrote durable prepared ownership"
        );
    });

    let outcome = transaction
        .publish_with_companion_and_hook(&mut health, &mut companion, &mut hook)
        .expect("publish prepared transaction");

    assert!(matches!(outcome, PublicationOutcome::Committed { .. }));
    assert_eq!(companion.commits, 1);
    assert_eq!(companion.rollbacks, 0);
}

#[test]
fn cleanup_only_companion_publish_does_not_require_a_migration_id() {
    let (fixture, installed, candidate) = transaction_fixture();
    let transaction =
        RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
    let mut health = HealthProbe(|_: &Path, _: Duration| HealthStatus::Healthy);
    let mut companion = RecordingCompanion::default();

    let outcome = transaction
        .publish_with_companion(&mut health, &mut companion)
        .expect("cleanup-only companion publication");

    assert!(matches!(outcome, PublicationOutcome::Committed { .. }));
    assert_eq!(companion.commits, 1);
    assert_eq!(companion.rollbacks, 0);
    assert_eq!(marker(&installed), "new");
    assert_eq!(marker(&candidate), "old");
    assert!(!update_journal_path(fixture.path()).exists());

    let (fixture, installed, candidate) = transaction_fixture();
    let transaction = RecoveryTransaction::open(fixture.path(), &installed, &candidate)
        .expect("transaction")
        .prepare(None)
        .expect("plain durable preparation");
    let mut health = HealthProbe(|_: &Path, _: Duration| HealthStatus::Healthy);
    let mut companion = RecordingCompanion::default();

    let outcome = transaction
        .publish_with_companion(&mut health, &mut companion)
        .expect("prepared cleanup-only companion publication");

    assert!(matches!(outcome, PublicationOutcome::Committed { .. }));
    assert_eq!(companion.commits, 1);
    assert_eq!(companion.rollbacks, 0);
    assert_eq!(marker(&installed), "new");
    assert_eq!(marker(&candidate), "old");
    assert!(!update_journal_path(fixture.path()).exists());
}

#[test]
fn plain_publish_rejects_a_prepared_migration_transaction() {
    let (fixture, installed, candidate) = transaction_fixture();
    let transaction = RecoveryTransaction::open(fixture.path(), &installed, &candidate)
        .expect("transaction")
        .prepare(Some(uuid::Uuid::new_v4()))
        .expect("migration-bound preparation");
    let health_called = Arc::new(AtomicBool::new(false));
    let observed = health_called.clone();
    let mut health = HealthProbe(move |_: &Path, _: Duration| {
        observed.store(true, Ordering::SeqCst);
        HealthStatus::Healthy
    });

    let error = transaction
        .publish(&mut health)
        .expect_err("migration-bound publication requires a companion");

    assert!(error.to_string().contains("migration"));
    assert!(!health_called.load(Ordering::SeqCst));
    assert_eq!(marker(&installed), "old");
    assert_eq!(marker(&candidate), "new");
    assert!(update_journal_path(fixture.path()).exists());
}

#[test]
fn plain_recovery_rejects_a_migration_bound_journal_without_consuming_it() {
    let (fixture, installed, candidate) = transaction_fixture();
    let migration_id = uuid::Uuid::new_v4();
    RecoveryTransaction::open(fixture.path(), &installed, &candidate)
        .expect("transaction")
        .prepare(Some(migration_id))
        .expect("migration-bound preparation");

    let error = recover_interrupted_update(fixture.path())
        .expect_err("plain recovery cannot consume a migration-bound journal");

    assert!(error.to_string().contains("migration"));
    assert_eq!(marker(&installed), "old");
    assert_eq!(marker(&candidate), "new");
    let journal =
        fs::read_to_string(update_journal_path(fixture.path())).expect("preserved update journal");
    assert!(journal.contains(&migration_id.to_string()));
}

#[test]
fn unbound_companion_recovery_rejects_a_migration_bound_journal() {
    let (fixture, installed, candidate) = transaction_fixture();
    let migration_id = uuid::Uuid::new_v4();
    RecoveryTransaction::open(fixture.path(), &installed, &candidate)
        .expect("transaction")
        .prepare(Some(migration_id))
        .expect("migration-bound preparation");
    let mut companion = RecordingCompanion::default();

    let error = recover_interrupted_update_with_companion(fixture.path(), &mut companion)
        .expect_err("migration companion recovery must bind the durable id");

    assert!(error.to_string().contains("migration"));
    assert_eq!(companion.commits, 0);
    assert_eq!(companion.rollbacks, 0);
    assert_eq!(marker(&installed), "old");
    assert_eq!(marker(&candidate), "new");
    assert!(update_journal_path(fixture.path()).exists());
}

#[test]
fn cleanup_only_companion_recovers_an_update_journal_without_a_migration_binding() {
    let (fixture, installed, candidate) = transaction_fixture();
    RecoveryTransaction::open(fixture.path(), &installed, &candidate)
        .expect("transaction")
        .prepare(None)
        .expect("plain update preparation");
    let mut companion = RecordingCompanion::default();

    recover_interrupted_update_with_companion(fixture.path(), &mut companion)
        .expect("cleanup-only companion recovery");

    assert_eq!(companion.commits, 0);
    assert_eq!(companion.rollbacks, 1);
    assert_eq!(marker(&installed), "old");
    assert_eq!(marker(&candidate), "new");
    assert!(!update_journal_path(fixture.path()).exists());
}

#[test]
fn update_recovery_rejects_a_companion_bound_to_another_migration() {
    let (fixture, installed, candidate) = transaction_fixture();
    let migration_id = uuid::Uuid::new_v4();
    let transaction =
        RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
    let mut companion = RecordingCompanion::default();
    let mut hook = TransactionHook(|boundary, _: &Path, _: &Path| {
        if boundary == RecoveryBoundary::AfterJournalParentFsync(RecoveryState::Prepared) {
            panic!("injected death");
        }
    });
    assert!(catch_unwind(AssertUnwindSafe(|| {
        let _ = transaction.prepare_with_hook(Some(migration_id), &mut hook);
    }))
    .is_err());

    let error = recover_interrupted_update_with_bound_companion(
        fixture.path(),
        uuid::Uuid::new_v4(),
        &mut companion,
    )
    .expect_err("mismatched migration companion");

    assert!(error.to_string().contains("migration"));
    assert_eq!(companion.commits, 0);
    assert_eq!(companion.rollbacks, 0);
    assert_eq!(marker(&installed), "old");
    assert_eq!(marker(&candidate), "new");
    assert!(update_journal_path(fixture.path()).exists());
}

#[test]
fn death_after_app_swap_restores_app_and_companion_from_durable_journal() {
    let (fixture, installed, candidate) = transaction_fixture();
    let migration_id = uuid::Uuid::new_v4();
    let transaction = RecoveryTransaction::open(fixture.path(), &installed, &candidate)
        .expect("transaction")
        .prepare(Some(migration_id))
        .expect("durable prepared transaction");
    let mut health = HealthProbe(|_: &Path, _: Duration| HealthStatus::Healthy);
    let mut companion = RecordingCompanion::default();
    let mut hook = TransactionHook(|boundary, _: &Path, _: &Path| {
        if boundary == RecoveryBoundary::AfterCandidatePublishSwap {
            panic!("injected death after app swap");
        }
    });

    let crashed = catch_unwind(AssertUnwindSafe(|| {
        let _ = transaction.publish_with_companion_and_hook(&mut health, &mut companion, &mut hook);
    }));
    assert!(crashed.is_err());
    assert_eq!(marker(&installed), "new");
    assert_eq!(marker(&candidate), "old");

    recover_interrupted_update_with_bound_companion(fixture.path(), migration_id, &mut companion)
        .expect("restart recovery");

    assert_eq!(marker(&installed), "old");
    assert_eq!(marker(&candidate), "new");
    assert_eq!(companion.rollbacks, 1);
    assert_eq!(companion.commits, 0);
    assert!(!update_journal_path(fixture.path()).exists());
}

#[test]
fn process_death_at_each_prehealth_journal_boundary_restores_both_transactions() {
    let boundaries = [
        RecoveryBoundary::BeforeJournalFileFsync(RecoveryState::Prepared),
        RecoveryBoundary::AfterJournalFileFsync(RecoveryState::Prepared),
        RecoveryBoundary::BeforeJournalParentFsync(RecoveryState::Prepared),
        RecoveryBoundary::AfterJournalParentFsync(RecoveryState::Prepared),
        RecoveryBoundary::BeforeCandidatePublishSwap,
        RecoveryBoundary::AfterCandidatePublishSwap,
        RecoveryBoundary::BeforeJournalFileFsync(RecoveryState::CandidatePublished),
        RecoveryBoundary::AfterJournalFileFsync(RecoveryState::CandidatePublished),
        RecoveryBoundary::BeforeJournalParentFsync(RecoveryState::CandidatePublished),
        RecoveryBoundary::AfterJournalParentFsync(RecoveryState::CandidatePublished),
    ];

    for crash_boundary in boundaries {
        let (fixture, installed, candidate) = transaction_fixture();
        let transaction =
            RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
        let migration_id = uuid::Uuid::new_v4();
        let mut health = HealthProbe(|_: &Path, _: Duration| HealthStatus::Healthy);
        let mut companion = RecordingCompanion::default();
        let mut hook = TransactionHook(|boundary, _: &Path, _: &Path| {
            if boundary == crash_boundary {
                panic!("injected update process death");
            }
        });

        assert!(catch_unwind(AssertUnwindSafe(|| {
            let transaction = transaction
                .prepare_with_hook(Some(migration_id), &mut hook)
                .expect("durable prepared transaction");
            let _ =
                transaction.publish_with_companion_and_hook(&mut health, &mut companion, &mut hook);
        }))
        .is_err());

        recover_interrupted_update_with_bound_companion(
            fixture.path(),
            migration_id,
            &mut companion,
        )
        .unwrap_or_else(|error| panic!("recover {crash_boundary:?}: {error}"));
        assert_eq!(marker(&installed), "old", "{crash_boundary:?}");
        assert_eq!(marker(&candidate), "new", "{crash_boundary:?}");
        assert_eq!(companion.rollbacks, 1, "{crash_boundary:?}");
        assert_eq!(companion.commits, 0, "{crash_boundary:?}");
    }
}

#[test]
fn process_death_at_each_durable_rollback_boundary_resumes_to_one_authority() {
    let boundaries = [
        RecoveryBoundary::BeforeJournalFileFsync(RecoveryState::RollbackIntent),
        RecoveryBoundary::AfterJournalFileFsync(RecoveryState::RollbackIntent),
        RecoveryBoundary::BeforeJournalParentFsync(RecoveryState::RollbackIntent),
        RecoveryBoundary::AfterJournalParentFsync(RecoveryState::RollbackIntent),
        RecoveryBoundary::BeforeHealthRollbackSwap,
        RecoveryBoundary::AfterHealthRollbackSwap,
        RecoveryBoundary::BeforeJournalFileFsync(RecoveryState::AppRestored),
        RecoveryBoundary::AfterJournalFileFsync(RecoveryState::AppRestored),
        RecoveryBoundary::BeforeJournalParentFsync(RecoveryState::AppRestored),
        RecoveryBoundary::AfterJournalParentFsync(RecoveryState::AppRestored),
        RecoveryBoundary::AfterCompanionRollback,
        RecoveryBoundary::BeforeJournalFileFsync(RecoveryState::CompanionRolledBack),
        RecoveryBoundary::AfterJournalFileFsync(RecoveryState::CompanionRolledBack),
        RecoveryBoundary::BeforeJournalParentFsync(RecoveryState::CompanionRolledBack),
        RecoveryBoundary::AfterJournalParentFsync(RecoveryState::CompanionRolledBack),
    ];

    for crash_boundary in boundaries {
        let (fixture, installed, candidate) = transaction_fixture();
        let migration_id = uuid::Uuid::new_v4();
        let transaction = RecoveryTransaction::open(fixture.path(), &installed, &candidate)
            .expect("transaction")
            .prepare(Some(migration_id))
            .expect("durable prepared transaction");
        let mut health =
            HealthProbe(|_: &Path, _: Duration| HealthStatus::Failed("candidate failed".into()));
        let mut companion = RecordingCompanion::default();
        let mut hook = TransactionHook(|boundary, _: &Path, _: &Path| {
            if boundary == crash_boundary {
                panic!("injected rollback process death");
            }
        });

        assert!(catch_unwind(AssertUnwindSafe(|| {
            let _ =
                transaction.publish_with_companion_and_hook(&mut health, &mut companion, &mut hook);
        }))
        .is_err());

        recover_interrupted_update_with_bound_companion(
            fixture.path(),
            migration_id,
            &mut companion,
        )
        .unwrap_or_else(|error| panic!("recover {crash_boundary:?}: {error}"));
        assert_eq!(marker(&installed), "old", "{crash_boundary:?}");
        assert_eq!(marker(&candidate), "new", "{crash_boundary:?}");
        assert_eq!(companion.commits, 0, "{crash_boundary:?}");
        assert!(
            companion.rollbacks == 1 || companion.rollbacks == 2,
            "{crash_boundary:?}: {:?}",
            companion.rollbacks
        );
        assert!(!update_journal_path(fixture.path()).exists());
    }
}

#[test]
fn process_death_after_companion_commit_recovers_forward_idempotently() {
    let (fixture, installed, candidate) = transaction_fixture();
    let migration_id = uuid::Uuid::new_v4();
    let transaction = RecoveryTransaction::open(fixture.path(), &installed, &candidate)
        .expect("transaction")
        .prepare(Some(migration_id))
        .expect("durable prepared transaction");
    let mut health = HealthProbe(|_: &Path, _: Duration| HealthStatus::Healthy);
    let mut companion = RecordingCompanion::default();
    let mut hook = TransactionHook(|boundary, _: &Path, _: &Path| {
        if boundary == RecoveryBoundary::AfterCompanionCommit {
            panic!("injected death after companion commit");
        }
    });

    assert!(catch_unwind(AssertUnwindSafe(|| {
        let _ = transaction.publish_with_companion_and_hook(&mut health, &mut companion, &mut hook);
    }))
    .is_err());
    assert_eq!(companion.commits, 1);

    recover_interrupted_update_with_bound_companion(fixture.path(), migration_id, &mut companion)
        .expect("forward recovery");

    assert_eq!(marker(&installed), "new");
    assert_eq!(marker(&candidate), "old");
    assert_eq!(companion.commits, 2);
    assert_eq!(companion.rollbacks, 0);
    assert!(!update_journal_path(fixture.path()).exists());
}

#[test]
fn restart_commit_failure_preserves_commit_intent_for_forward_retry() {
    let (fixture, installed, candidate) = transaction_fixture();
    let migration_id = uuid::Uuid::new_v4();
    let transaction = RecoveryTransaction::open(fixture.path(), &installed, &candidate)
        .expect("transaction")
        .prepare(Some(migration_id))
        .expect("durable prepared transaction");
    let mut health = HealthProbe(|_: &Path, _: Duration| HealthStatus::Healthy);
    let mut initial_companion = RecordingCompanion::default();
    let mut hook = TransactionHook(|boundary, _: &Path, _: &Path| {
        if boundary == RecoveryBoundary::AfterJournalParentFsync(RecoveryState::CommitIntent) {
            panic!("injected death before companion commit");
        }
    });
    assert!(catch_unwind(AssertUnwindSafe(|| {
        let _ = transaction.publish_with_companion_and_hook(
            &mut health,
            &mut initial_companion,
            &mut hook,
        );
    }))
    .is_err());

    let mut recovery_companion = FailCommitCompanion::default();
    let error = recover_interrupted_update_with_bound_companion(
        fixture.path(),
        migration_id,
        &mut recovery_companion,
    )
    .expect_err("failed commit must remain retryable");

    assert!(matches!(error, RecoveryError::CompanionCommit));
    assert_eq!(marker(&installed), "new");
    assert_eq!(marker(&candidate), "old");
    assert_eq!(recovery_companion.commits, 1);
    assert_eq!(recovery_companion.rollbacks, 0);
    assert!(update_journal_path(fixture.path()).exists());

    let mut retry = RecordingCompanion::default();
    recover_interrupted_update_with_bound_companion(fixture.path(), migration_id, &mut retry)
        .expect("forward retry");
    assert_eq!(retry.commits, 1);
    assert_eq!(retry.rollbacks, 0);
    assert!(!update_journal_path(fixture.path()).exists());
}

#[test]
fn repeated_commit_failure_keeps_the_same_forward_recovery_authority() {
    let (fixture, installed, candidate) = transaction_fixture();
    let migration_id = uuid::Uuid::new_v4();
    let transaction = RecoveryTransaction::open(fixture.path(), &installed, &candidate)
        .expect("transaction")
        .prepare(Some(migration_id))
        .expect("durable prepared transaction");
    let mut health = HealthProbe(|_: &Path, _: Duration| HealthStatus::Healthy);
    let mut initial_companion = RecordingCompanion::default();
    let mut hook = TransactionHook(|boundary, _: &Path, _: &Path| {
        if boundary == RecoveryBoundary::AfterJournalParentFsync(RecoveryState::CommitIntent) {
            panic!("injected death before companion commit");
        }
    });
    assert!(catch_unwind(AssertUnwindSafe(|| {
        let _ = transaction.publish_with_companion_and_hook(
            &mut health,
            &mut initial_companion,
            &mut hook,
        );
    }))
    .is_err());

    let mut recovery_companion = FailCommitAndFirstRollbackCompanion::default();
    let first = recover_interrupted_update_with_bound_companion(
        fixture.path(),
        migration_id,
        &mut recovery_companion,
    )
    .expect_err("first companion commit fails");
    assert!(matches!(first, RecoveryError::CompanionCommit));
    assert_eq!(marker(&installed), "new");
    assert_eq!(marker(&candidate), "old");
    assert!(update_journal_path(fixture.path()).exists());

    let second = recover_interrupted_update_with_bound_companion(
        fixture.path(),
        migration_id,
        &mut recovery_companion,
    )
    .expect_err("second companion commit also fails");

    assert!(matches!(second, RecoveryError::CompanionCommit));
    assert_eq!(marker(&installed), "new");
    assert_eq!(marker(&candidate), "old");
    assert_eq!(recovery_companion.commits, 2);
    assert_eq!(recovery_companion.rollbacks, 0);
    assert!(update_journal_path(fixture.path()).exists());
}

#[test]
fn recovery_publish_postverify_race_safely_restores_the_old_app() {
    let (fixture, installed, candidate) = transaction_fixture();
    let displaced = fixture.path().join("Displaced-published.app");
    let transaction =
        RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
    let mut hook = TransactionHook(|boundary, published: &Path, _: &Path| {
        if boundary == RecoveryBoundary::AfterCandidatePublishSwap {
            fs::rename(published, &displaced).expect("displace published candidate");
            app_bundle(published, "replacement");
        }
    });
    let health_called = Arc::new(AtomicBool::new(false));
    let observed = health_called.clone();
    let mut health = HealthProbe(move |_: &Path, _: Duration| {
        observed.store(true, Ordering::SeqCst);
        HealthStatus::Healthy
    });

    transaction
        .publish_with_hook(&mut health, &mut hook)
        .expect_err("post-swap replacement must fail postverification");

    assert!(!health_called.load(Ordering::SeqCst));
    assert_eq!(marker(&installed), "old");
    assert_eq!(marker(&candidate), "replacement");
    assert_eq!(marker(&displaced), "new");
}

#[test]
fn recovery_transaction_surfaces_restore_failure_without_hiding_the_candidate() {
    let (_fixture, installed, candidate) = transaction_fixture();
    let transaction =
        RecoveryTransaction::open(installed.parent().unwrap(), &installed, &candidate)
            .expect("transaction");
    let mut hook = TransactionHook(|boundary, _: &Path, backup: &Path| {
        if boundary == RecoveryBoundary::BeforeHealthRollbackSwap {
            fs::remove_dir_all(backup).expect("inject lost backup");
        }
    });
    let mut health =
        HealthProbe(move |_: &Path, _: Duration| HealthStatus::Failed("candidate failed".into()));

    let error = transaction
        .publish_with_hook(&mut health, &mut hook)
        .expect_err("lost backup must surface restore failure");

    assert!(matches!(error, RecoveryError::RestoreFailed { .. }));
    assert_eq!(
        marker(&installed),
        "new",
        "candidate must be returned to the installation path when restore is impossible"
    );
}

#[test]
fn recovery_transaction_does_not_reuse_or_delete_legacy_fixed_markers() {
    for stale_name in [
        ".Openloop.app.openloop-backup",
        ".Openloop.app.openloop-staging",
    ] {
        let (fixture, installed, candidate) = transaction_fixture();
        app_bundle(&fixture.path().join(stale_name), "stale");

        let transaction = RecoveryTransaction::open(fixture.path(), &installed, &candidate)
            .expect("random transaction names must not reuse a legacy marker");
        let mut health = HealthProbe(|_: &Path, _: Duration| HealthStatus::Healthy);
        transaction.publish(&mut health).expect("publication");

        assert_eq!(marker(&installed), "new");
        assert_eq!(marker(&fixture.path().join(stale_name)), "stale");
    }
}

#[test]
fn recovery_transaction_rejects_unsafe_or_ambiguous_bundle_paths() {
    let fixture = tempdir().expect("temporary update root");
    let root = fixture.path().join("root");
    let outside = fixture.path().join("outside");
    fs::create_dir(&root).expect("root");
    fs::create_dir(&outside).expect("outside");
    let installed = root.join("Openloop.app");
    let candidate = root.join("Candidate.app");
    app_bundle(&installed, "old");
    app_bundle(&candidate, "new");
    let external_candidate = outside.join("External.app");
    app_bundle(&external_candidate, "external");

    assert!(
        RecoveryTransaction::open(&root, &installed, &external_candidate).is_err(),
        "external candidate path escaped the transaction root"
    );
    assert!(
        RecoveryTransaction::open(&root, &installed, &installed).is_err(),
        "overlapping installed and candidate paths were accepted"
    );

    fs::remove_dir_all(&candidate).expect("remove candidate");
    fs::write(&candidate, "not a directory").expect("file candidate");
    assert!(
        RecoveryTransaction::open(&root, &installed, &candidate).is_err(),
        "non-directory app bundle was accepted"
    );

    fs::remove_file(&candidate).expect("remove file candidate");
    symlink(&external_candidate, &candidate).expect("candidate symlink");
    assert!(
        RecoveryTransaction::open(&root, &installed, &candidate).is_err(),
        "symlinked candidate bundle was accepted"
    );

    let root_alias = fixture.path().join("root-alias");
    symlink(&root, &root_alias).expect("root symlink");
    assert!(
        RecoveryTransaction::open(
            &root_alias,
            &root_alias.join("Openloop.app"),
            &root_alias.join("Candidate.app"),
        )
        .is_err(),
        "symlinked transaction root was accepted"
    );
}

#[test]
fn recovery_transaction_rejects_candidate_replacements_after_open() {
    for replacement in ["symlink", "fifo", "different-inode"] {
        let (fixture, installed, candidate) = transaction_fixture();
        let external = fixture.path().join("External.app");
        app_bundle(&external, "external");
        let transaction =
            RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
        fs::remove_dir_all(&candidate).expect("remove original candidate");
        match replacement {
            "symlink" => symlink(&external, &candidate).expect("replacement symlink"),
            "fifo" => fifo(&candidate),
            "different-inode" => app_bundle(&candidate, "replacement"),
            _ => unreachable!(),
        }
        let health_called = Arc::new(AtomicBool::new(false));
        let observed = health_called.clone();
        let mut health = HealthProbe(move |_: &Path, _: Duration| {
            observed.store(true, Ordering::SeqCst);
            HealthStatus::Healthy
        });

        let error = transaction
            .publish(&mut health)
            .expect_err("replaced candidate identity must abort publication");

        assert!(
            error.to_string().contains("candidate")
                || error.to_string().contains("identity")
                || error.to_string().contains("bundle"),
            "unexpected replacement error: {error}"
        );
        assert!(
            !health_called.load(Ordering::SeqCst),
            "health probe ran for {replacement} replacement"
        );
        assert_eq!(marker(&installed), "old");
    }
}

#[test]
fn recovery_transaction_rejects_installed_replacement_after_open() {
    let (fixture, installed, candidate) = transaction_fixture();
    let displaced = fixture.path().join("Displaced.app");
    let transaction =
        RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
    fs::rename(&installed, &displaced).expect("displace original installed bundle");
    app_bundle(&installed, "replacement");
    let health_called = Arc::new(AtomicBool::new(false));
    let observed = health_called.clone();
    let mut health = HealthProbe(move |_: &Path, _: Duration| {
        observed.store(true, Ordering::SeqCst);
        HealthStatus::Healthy
    });

    let error = transaction
        .publish(&mut health)
        .expect_err("replaced installed identity must abort publication");

    assert!(
        error.to_string().contains("installed") || error.to_string().contains("identity"),
        "unexpected replacement error: {error}"
    );
    assert!(!health_called.load(Ordering::SeqCst));
    assert_eq!(marker(&installed), "replacement");
    assert_eq!(marker(&candidate), "new");
    assert_eq!(marker(&displaced), "old");
}

#[test]
fn recovery_swap_rejects_installed_replacement_between_precheck_and_syscall() {
    let (fixture, installed, candidate) = transaction_fixture();
    let displaced = fixture.path().join("Displaced-old.app");
    let transaction =
        RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
    let mut injected = false;
    let mut hook = TransactionHook(|boundary, left: &Path, _: &Path| {
        if boundary == RecoveryBoundary::BeforeCandidatePublishSwap {
            fs::rename(left, &displaced).expect("displace old installed app");
            app_bundle(left, "replacement");
            injected = true;
        }
    });
    let health_called = Arc::new(AtomicBool::new(false));
    let observed = health_called.clone();
    let mut health = HealthProbe(move |_: &Path, _: Duration| {
        observed.store(true, Ordering::SeqCst);
        HealthStatus::Healthy
    });

    transaction
        .publish_with_hook(&mut health, &mut hook)
        .expect_err("raced installed replacement must abort");

    assert!(injected);
    assert!(!health_called.load(Ordering::SeqCst));
    assert_eq!(marker(&installed), "replacement");
    assert_eq!(marker(&candidate), "new");
    assert_eq!(marker(&displaced), "old");
}

#[test]
fn recovery_swap_rejects_candidate_replacement_between_precheck_and_syscall() {
    let (fixture, installed, candidate) = transaction_fixture();
    let displaced = fixture.path().join("Displaced-new.app");
    let transaction =
        RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
    let mut hook = TransactionHook(|boundary, _: &Path, right: &Path| {
        if boundary == RecoveryBoundary::BeforeCandidatePublishSwap {
            fs::rename(right, &displaced).expect("displace candidate app");
            app_bundle(right, "replacement");
        }
    });
    let health_called = Arc::new(AtomicBool::new(false));
    let observed = health_called.clone();
    let mut health = HealthProbe(move |_: &Path, _: Duration| {
        observed.store(true, Ordering::SeqCst);
        HealthStatus::Healthy
    });

    transaction
        .publish_with_hook(&mut health, &mut hook)
        .expect_err("raced candidate replacement must abort");

    assert!(!health_called.load(Ordering::SeqCst));
    assert_eq!(marker(&installed), "old");
    assert_eq!(marker(&candidate), "replacement");
    assert_eq!(marker(&displaced), "new");
}

#[test]
fn recovery_swap_does_not_install_replaced_backup_during_health_rollback() {
    let (fixture, installed, candidate) = transaction_fixture();
    let displaced = fixture.path().join("Displaced-backup.app");
    let transaction =
        RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
    let mut hook = TransactionHook(|boundary, _: &Path, right: &Path| {
        if boundary == RecoveryBoundary::BeforeHealthRollbackSwap {
            fs::rename(right, &displaced).expect("displace old backup");
            app_bundle(right, "replacement");
        }
    });
    let mut health =
        HealthProbe(|_: &Path, _: Duration| HealthStatus::Failed("candidate failed".into()));

    let error = transaction
        .publish_with_hook(&mut health, &mut hook)
        .expect_err("raced backup replacement must not be installed");

    assert!(matches!(error, RecoveryError::RestoreFailed { .. }));
    assert_eq!(marker(&installed), "new");
    assert_eq!(marker(&displaced), "old");
}

#[test]
fn recovery_health_rollback_keeps_old_app_when_failed_candidate_is_replaced_after_swap() {
    let (fixture, installed, candidate) = transaction_fixture();
    let displaced = fixture.path().join("Displaced-failed-candidate.app");
    let transaction =
        RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
    let mut hook = TransactionHook(|boundary, _: &Path, failed: &Path| {
        if boundary == RecoveryBoundary::AfterHealthRollbackSwap {
            fs::rename(failed, &displaced).expect("displace failed candidate");
            app_bundle(failed, "replacement");
        }
    });
    let mut health =
        HealthProbe(|_: &Path, _: Duration| HealthStatus::Failed("candidate failed".into()));

    let error = transaction
        .publish_with_hook(&mut health, &mut hook)
        .expect_err("candidate replacement must be reported");

    assert!(matches!(error, RecoveryError::RestoreFailed { .. }));
    assert!(
        error.to_string().contains(&installed.display().to_string()),
        "post-verify failure did not report the visible installed path: {error}"
    );
    assert!(
        error.to_string().contains("preserved"),
        "post-verify failure did not describe preservation: {error}"
    );
    assert_eq!(marker(&installed), "old");
    assert_eq!(marker(&displaced), "new");
    let replacement = fs::read_dir(fixture.path())
        .expect("fixture entries")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            matches!(
                fs::read_to_string(path.join("marker")).as_deref(),
                Ok("replacement")
            )
        })
        .expect("replacement preserved");
    assert!(replacement.exists());
}

#[test]
fn recovery_commit_preserves_old_app_and_never_deletes_a_placeholder_replacement() {
    let (fixture, installed, candidate) = transaction_fixture();
    let transaction =
        RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
    let candidate_for_health = candidate.clone();
    let mut health = HealthProbe(move |_: &Path, _: Duration| {
        fs::remove_dir_all(&candidate_for_health).expect("replace old candidate backup");
        app_bundle(&candidate_for_health, "replacement");
        HealthStatus::Healthy
    });

    let outcome = transaction
        .publish(&mut health)
        .expect("healthy publication is committed before deferred cleanup");

    assert_eq!(marker(&installed), "new");
    assert_eq!(marker(&candidate), "replacement");
    let PublicationOutcome::Committed { preserved_backup } = outcome else {
        panic!("healthy candidate must commit");
    };
    assert_eq!(
        fs::canonicalize(&preserved_backup).expect("canonical preserved backup"),
        fs::canonicalize(&candidate).expect("canonical candidate")
    );
    assert_eq!(marker(&preserved_backup), "replacement");
}

#[test]
fn update_transaction_sources_never_use_recursive_deletion() {
    let recovery = include_str!("../src/update/recovery.rs");
    let archive = include_str!("../src/update/archive.rs");
    let cleanup = include_str!("../src/update/cleanup.rs");

    for source in [recovery, archive, cleanup] {
        assert!(!source.contains("removefileat"));
        assert!(!source.contains("REMOVEFILE_RECURSIVE"));
        assert!(!source.contains("remove_dir_all"));
    }
}
