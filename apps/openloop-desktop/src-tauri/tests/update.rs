use std::{
    ffi::CString,
    fs,
    os::unix::{ffi::OsStrExt, fs::symlink},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use openloop_desktop_lib::update::{
    channel::{ReleaseChannel, UpdateChannelConfig},
    recovery::{
        CandidateHealth, HealthStatus, PublicationOutcome, RecoveryError, RecoveryTransaction,
    },
};
use tempfile::tempdir;

const VALID_TAURI_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgRTc2MjBGMTg0MkI0RTgxRgpSV1FmNkxSQ0dBOWk1M21sWWVjTzRJelQ1MVRHUHB2V3VjTlNDaDFDQk0wUVRhTG43M1k3R0ZPMwo=";
const REPOSITORY_TEST_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEU4OTU2OENBMkZCQUZBODUKUldTRityb3Z5bWlWNkowTThHZC9YZEpBN1kvWDMyaEljcEVZOEw4K2RtR1poQlY1MzJsWjh0aXYK";

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
    assert_ne!(
        test.public_key_environment(),
        stable.public_key_environment()
    );
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
fn recovery_transaction_commits_a_healthy_candidate_and_cleans_markers() {
    let (fixture, installed, candidate) = transaction_fixture();
    let transaction =
        RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
    let mut health = HealthProbe(|published: &Path, timeout| {
        assert_eq!(
            fs::canonicalize(published).expect("published canonical path"),
            fs::canonicalize(&installed).expect("installed canonical path"),
        );
        assert_eq!(timeout, Duration::from_secs(60));
        assert_eq!(marker(published), "new");
        HealthStatus::Healthy
    });

    let outcome = transaction
        .publish(&mut health)
        .expect("healthy publication");

    assert_eq!(outcome, PublicationOutcome::Committed);
    assert_eq!(marker(&installed), "new");
    assert!(!candidate.exists());
    assert!(!fixture
        .path()
        .join(".Openloop.app.openloop-backup")
        .exists());
    assert!(!fixture
        .path()
        .join(".Openloop.app.openloop-staging")
        .exists());
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

        assert_eq!(outcome, PublicationOutcome::RolledBack(status));
        assert_eq!(marker(&installed), "old");
        assert!(!candidate.exists());
        assert!(!fixture
            .path()
            .join(".Openloop.app.openloop-backup")
            .exists());
        assert!(!fixture
            .path()
            .join(".Openloop.app.openloop-staging")
            .exists());
    }
}

#[test]
fn recovery_transaction_surfaces_restore_failure_without_hiding_the_candidate() {
    let (fixture, installed, candidate) = transaction_fixture();
    let backup = fixture.path().join(".Openloop.app.openloop-backup");
    let transaction =
        RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
    let mut health = HealthProbe(move |_: &Path, _: Duration| {
        fs::remove_dir_all(&backup).expect("inject lost backup");
        HealthStatus::Failed("candidate failed".into())
    });

    let error = transaction
        .publish(&mut health)
        .expect_err("lost backup must surface restore failure");

    assert!(matches!(error, RecoveryError::RestoreFailed { .. }));
    assert_eq!(
        marker(&installed),
        "new",
        "candidate must be returned to the installation path when restore is impossible"
    );
    assert!(!fixture
        .path()
        .join(".Openloop.app.openloop-staging")
        .exists());
}

#[test]
fn recovery_transaction_does_not_delete_a_replaced_backup_on_commit() {
    let (fixture, installed, candidate) = transaction_fixture();
    let backup = fixture.path().join(".Openloop.app.openloop-backup");
    let transaction =
        RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
    let replaced_backup = backup.clone();
    let mut health = HealthProbe(move |_: &Path, _: Duration| {
        fs::remove_dir_all(&replaced_backup).expect("remove owned backup");
        app_bundle(&replaced_backup, "replacement");
        HealthStatus::Healthy
    });

    let error = transaction
        .publish(&mut health)
        .expect_err("replacement backup must not be deleted");

    assert!(error.to_string().contains("backup") || error.to_string().contains("identity"));
    assert_eq!(marker(&installed), "new");
    assert_eq!(marker(&backup), "replacement");
}

#[test]
fn recovery_transaction_does_not_restore_a_replaced_backup() {
    let (fixture, installed, candidate) = transaction_fixture();
    let backup = fixture.path().join(".Openloop.app.openloop-backup");
    let transaction =
        RecoveryTransaction::open(fixture.path(), &installed, &candidate).expect("transaction");
    let replaced_backup = backup.clone();
    let mut health = HealthProbe(move |_: &Path, _: Duration| {
        fs::remove_dir_all(&replaced_backup).expect("remove owned backup");
        app_bundle(&replaced_backup, "replacement");
        HealthStatus::Failed("candidate failed".into())
    });

    let error = transaction
        .publish(&mut health)
        .expect_err("replacement backup must not be restored");

    assert!(matches!(error, RecoveryError::RestoreFailed { .. }));
    assert_eq!(marker(&installed), "new");
    assert_eq!(marker(&backup), "replacement");
    assert!(!fixture
        .path()
        .join(".Openloop.app.openloop-staging")
        .exists());
}

#[test]
fn recovery_transaction_rejects_stale_partial_state() {
    for stale_name in [
        ".Openloop.app.openloop-backup",
        ".Openloop.app.openloop-staging",
    ] {
        let (fixture, installed, candidate) = transaction_fixture();
        app_bundle(&fixture.path().join(stale_name), "stale");

        let error = RecoveryTransaction::open(fixture.path(), &installed, &candidate)
            .expect_err("stale transaction marker must be rejected");

        assert!(
            error.to_string().contains("stale"),
            "unexpected stale-state error: {error}"
        );
        assert_eq!(marker(&installed), "old");
        assert_eq!(marker(&candidate), "new");
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
