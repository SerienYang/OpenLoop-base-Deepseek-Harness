use std::{
    ffi::{CStr, OsString},
    fs,
    os::fd::RawFd,
    os::unix::{
        ffi::OsStringExt,
        fs::{symlink, MetadataExt, PermissionsExt},
        net::UnixListener,
    },
    panic::{catch_unwind, AssertUnwindSafe},
    path::{Path, PathBuf},
    time::Duration,
};

use openloop_desktop_lib::update::{
    channel::ReleaseChannel,
    cleanup::{
        cleanup_journal_path, load_pending_cleanup, CleanupBoundary, CleanupCompanion,
        CleanupTestHook,
    },
    recovery::{
        CandidateHealth, HealthStatus, PublicationOutcome, RecoveryBoundary, RecoveryState,
        RecoveryTestHook, RecoveryTransaction,
    },
};
use tempfile::tempdir;

struct Healthy;

impl CandidateHealth for Healthy {
    fn await_health(&mut self, _: &Path, _: Duration) -> HealthStatus {
        HealthStatus::Healthy
    }
}

struct Failed;

impl CandidateHealth for Failed {
    fn await_health(&mut self, _: &Path, _: Duration) -> HealthStatus {
        HealthStatus::Failed("injected failure".to_owned())
    }
}

struct CrashAt(CleanupBoundary);

impl CleanupTestHook for CrashAt {
    fn reached(&mut self, boundary: CleanupBoundary) {
        if boundary == self.0 {
            panic!("injected cleanup journal crash");
        }
    }
}

struct ActionAt<F> {
    boundary: CleanupBoundary,
    action: Option<F>,
}

impl<F: FnOnce()> CleanupTestHook for ActionAt<F> {
    fn reached(&mut self, boundary: CleanupBoundary) {
        if boundary == self.boundary {
            self.action.take().expect("cleanup action called once")();
        }
    }
}

struct EntryActionAt<F> {
    boundary: CleanupBoundary,
    name: &'static [u8],
    action: Option<F>,
}

impl<F: FnOnce()> CleanupTestHook for EntryActionAt<F> {
    fn reached(&mut self, _: CleanupBoundary) {}

    fn reached_entry(&mut self, boundary: CleanupBoundary, _: RawFd, name: &CStr) {
        if boundary == self.boundary && name.to_bytes() == self.name {
            self.action
                .take()
                .expect("cleanup entry action called once")();
        }
    }
}

struct CrashAtCommitIntent;

impl RecoveryTestHook for CrashAtCommitIntent {
    fn before(&mut self, boundary: RecoveryBoundary, _: &Path, _: &Path) {
        if boundary == RecoveryBoundary::AfterJournalParentFsync(RecoveryState::CommitIntent) {
            panic!("injected recovery journal crash");
        }
    }
}

#[derive(Default)]
struct RecordingCleanupHook {
    parent_fsync: bool,
}

impl CleanupTestHook for RecordingCleanupHook {
    fn reached(&mut self, boundary: CleanupBoundary) {
        if boundary == CleanupBoundary::BeforeJournalParentFsync {
            self.parent_fsync = true;
        }
    }
}

fn app_bundle(path: &Path, marker: &str) {
    fs::create_dir(path).expect("app bundle");
    fs::write(path.join("marker"), marker).expect("app marker");
}

fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
    let root = tempdir().expect("fixture");
    let channel_root = root.path().join("channel");
    let update_root = root.path().join("Applications");
    let installed = update_root.join("Openloop.app");
    let candidate = update_root.join(".openloop-candidate-first.app");
    fs::create_dir(&channel_root).expect("channel root");
    fs::create_dir(&update_root).expect("update root");
    app_bundle(&installed, "old");
    app_bundle(&candidate, "new");
    (root, channel_root, installed, candidate)
}

fn commit(channel_root: &Path, installed: &Path, candidate: &Path) -> PublicationOutcome {
    let transaction = RecoveryTransaction::open(installed.parent().unwrap(), installed, candidate)
        .expect("transaction");
    let mut cleanup =
        CleanupCompanion::new(channel_root, ReleaseChannel::Test).expect("cleanup companion");
    transaction
        .publish_with_companion(&mut Healthy, &mut cleanup)
        .expect("publication")
}

fn active_backup(channel_root: &Path, candidate: &Path) -> PathBuf {
    if candidate.exists() {
        return candidate.to_owned();
    }
    journal_isolated_backup(channel_root, candidate)
}

fn journal_isolated_backup(channel_root: &Path, candidate: &Path) -> PathBuf {
    let journal: serde_json::Value = serde_json::from_slice(
        &fs::read(cleanup_journal_path(channel_root, ReleaseChannel::Test))
            .expect("cleanup journal"),
    )
    .expect("cleanup journal JSON");
    let isolated_name: Vec<u8> =
        serde_json::from_value(journal["isolatedName"].clone()).expect("isolated cleanup name");
    candidate
        .parent()
        .expect("backup parent")
        .join(OsString::from_vec(isolated_name))
}

#[test]
fn committed_publication_writes_one_owner_only_channel_scoped_cleanup_journal() {
    let (_root, channel_root, installed, candidate) = fixture();

    assert!(matches!(
        commit(&channel_root, &installed, &candidate),
        PublicationOutcome::Committed { .. }
    ));

    let journal = cleanup_journal_path(&channel_root, ReleaseChannel::Test);
    let metadata = fs::symlink_metadata(&journal).expect("cleanup journal");
    assert!(metadata.is_file());
    assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
    assert_eq!(metadata.nlink(), 1);
    let bytes = fs::read(&journal).expect("cleanup journal bytes");
    assert!(bytes.len() < 64 * 1024);
    let value: serde_json::Value = serde_json::from_slice(&bytes).expect("cleanup JSON");
    assert!(value
        .get("publicationId")
        .and_then(|value| value.as_str())
        .is_some());
    assert!(value.get("updateRootIdentity").is_some());
    assert!(value.get("installed").is_some());
    assert!(value.get("backup").is_some());
    assert_ne!(
        cleanup_journal_path(&channel_root, ReleaseChannel::Test),
        cleanup_journal_path(&channel_root, ReleaseChannel::Stable)
    );
    assert!(
        load_pending_cleanup(&channel_root, ReleaseChannel::Stable)
            .expect("stable cleanup lookup")
            .is_none(),
        "test cleanup intent leaked into stable"
    );
}

#[test]
fn cleanup_journal_rejects_symlinks_hardlinks_unsafe_modes_and_oversized_json() {
    for case in ["symlink", "hardlink", "mode", "oversized"] {
        let (root, channel_root, installed, candidate) = fixture();
        commit(&channel_root, &installed, &candidate);
        let journal = cleanup_journal_path(&channel_root, ReleaseChannel::Test);
        match case {
            "symlink" => {
                let outside = root.path().join("outside-journal");
                fs::write(&outside, fs::read(&journal).expect("journal bytes"))
                    .expect("outside journal");
                fs::remove_file(&journal).expect("remove journal");
                symlink(&outside, &journal).expect("journal symlink");
            }
            "hardlink" => {
                fs::hard_link(&journal, root.path().join("journal-link"))
                    .expect("journal hardlink");
            }
            "mode" => {
                fs::set_permissions(&journal, fs::Permissions::from_mode(0o640))
                    .expect("unsafe journal mode");
            }
            "oversized" => {
                fs::write(&journal, vec![b' '; 64 * 1024 + 1]).expect("oversized journal");
                fs::set_permissions(&journal, fs::Permissions::from_mode(0o600))
                    .expect("restore journal mode");
            }
            _ => unreachable!(),
        }

        assert!(
            load_pending_cleanup(&channel_root, ReleaseChannel::Test).is_err(),
            "{case} cleanup journal was accepted"
        );
        assert!(candidate.exists(), "{case} cleanup deleted the backup");
    }
}

#[test]
fn cleanup_rechecks_journal_link_count_after_startup_load() {
    let (root, channel_root, installed, candidate) = fixture();
    commit(&channel_root, &installed, &candidate);
    let mut pending = load_pending_cleanup(&channel_root, ReleaseChannel::Test)
        .expect("load cleanup")
        .expect("pending cleanup");
    fs::hard_link(
        cleanup_journal_path(&channel_root, ReleaseChannel::Test),
        root.path().join("late-journal-link"),
    )
    .expect("late journal hardlink");

    pending
        .execute()
        .expect_err("late journal hardlink must revoke cleanup authority");

    assert!(candidate.exists());
    assert!(cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists());
}

#[test]
fn cleanup_journal_rejects_a_replaced_update_root() {
    let (root, channel_root, installed, candidate) = fixture();
    commit(&channel_root, &installed, &candidate);
    let update_root = installed.parent().unwrap();
    let displaced = root.path().join("original-applications");
    fs::rename(update_root, &displaced).expect("displace update root");
    fs::create_dir(update_root).expect("replacement update root");
    app_bundle(&installed, "replacement");
    app_bundle(&candidate, "replacement");

    let error = load_pending_cleanup(&channel_root, ReleaseChannel::Test)
        .expect_err("replacement update root must fail");

    assert!(error.to_string().contains("update root"));
    assert!(cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists());
    assert_eq!(
        fs::read_to_string(displaced.join("Openloop.app/marker")).expect("original installed"),
        "new"
    );
}

#[test]
fn cleanup_preserves_non_ascii_component_names_across_recovery_journals() {
    let root = tempdir().expect("fixture");
    let channel_root = root.path().join("channel");
    let update_root = root.path().join("Applications");
    fs::create_dir(&channel_root).expect("channel root");
    fs::create_dir(&update_root).expect("update root");
    let installed = update_root.join(OsString::from_vec(
        "Openloop-\u{6b63}\u{5f0f}.app".as_bytes().to_vec(),
    ));
    let candidate = update_root.join(OsString::from_vec(
        ".openloop-candidate-\u{65e7}\u{7248}.app"
            .as_bytes()
            .to_vec(),
    ));
    app_bundle(&installed, "old");
    app_bundle(&candidate, "new");

    let transaction = RecoveryTransaction::open(&update_root, &installed, &candidate)
        .expect("recovery transaction");
    let mut initial_cleanup =
        CleanupCompanion::new(&channel_root, ReleaseChannel::Test).expect("cleanup companion");
    assert!(catch_unwind(AssertUnwindSafe(|| {
        let _ = transaction.publish_with_companion_and_hook(
            &mut Healthy,
            &mut initial_cleanup,
            &mut CrashAtCommitIntent,
        );
    }))
    .is_err());
    let mut replay =
        CleanupCompanion::new(&channel_root, ReleaseChannel::Test).expect("replay companion");
    openloop_desktop_lib::update::recovery::recover_interrupted_update_with_companion(
        &update_root,
        &mut replay,
    )
    .expect("recover non-ASCII publication");
    let mut pending = load_pending_cleanup(&channel_root, ReleaseChannel::Test)
        .expect("load non-ASCII cleanup")
        .expect("pending non-ASCII cleanup");
    pending.execute().expect("clean non-ASCII backup");

    assert_eq!(
        fs::read_to_string(installed.join("marker")).expect("installed marker"),
        "new"
    );
    assert!(!candidate.exists());
    assert!(!cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists());
}

#[test]
fn cleanup_uses_recovery_owned_identity_instead_of_restating_a_replacement() {
    let (_root, channel_root, installed, candidate) = fixture();
    let displaced = candidate.with_file_name("displaced-old.app");
    let candidate_for_health = candidate.clone();
    let displaced_for_health = displaced.clone();
    let transaction =
        RecoveryTransaction::open(installed.parent().unwrap(), &installed, &candidate)
            .expect("transaction");
    let mut health = move_health(move || {
        fs::rename(&candidate_for_health, &displaced_for_health).expect("displace old backup");
        app_bundle(&candidate_for_health, "replacement");
    });
    let mut cleanup =
        CleanupCompanion::new(&channel_root, ReleaseChannel::Test).expect("cleanup companion");

    transaction
        .publish_with_companion(&mut health, &mut cleanup)
        .expect("commit remains durable");

    let error = load_pending_cleanup(&channel_root, ReleaseChannel::Test)
        .expect_err("replacement identity must reject startup cleanup");
    assert!(error.to_string().contains("backup"));
    assert_eq!(
        fs::read_to_string(candidate.join("marker")).expect("replacement marker"),
        "replacement"
    );
    assert_eq!(
        fs::read_to_string(displaced.join("marker")).expect("old backup marker"),
        "old"
    );
    assert!(cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists());
}

fn move_health(action: impl FnOnce() + Send + 'static) -> impl CandidateHealth {
    struct Probe<F>(Option<F>);
    impl<F: FnOnce()> CandidateHealth for Probe<F> {
        fn await_health(&mut self, _: &Path, _: Duration) -> HealthStatus {
            self.0.take().expect("health called once")();
            HealthStatus::Healthy
        }
    }
    Probe(Some(action))
}

#[test]
fn descriptor_relative_cleanup_removes_nested_content_without_following_symlinks() {
    let (root, channel_root, installed, candidate) = fixture();
    let outside = root.path().join("outside");
    fs::create_dir(&outside).expect("outside directory");
    fs::write(outside.join("keep"), b"external").expect("outside file");
    fs::create_dir_all(installed.join("nested/deeper")).expect("nested old app");
    fs::write(installed.join("nested/deeper/file"), b"old").expect("nested file");
    symlink(&outside, installed.join("nested/external-link")).expect("external symlink");
    commit(&channel_root, &installed, &candidate);

    let mut pending = load_pending_cleanup(&channel_root, ReleaseChannel::Test)
        .expect("load cleanup")
        .expect("pending cleanup");
    pending.execute().expect("execute cleanup");

    assert!(!candidate.exists());
    assert_eq!(
        fs::read_to_string(outside.join("keep")).expect("external target"),
        "external"
    );
    assert!(!cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists());
    assert_eq!(
        fs::read_to_string(installed.join("marker")).expect("installed marker"),
        "new"
    );
}

#[test]
fn cleanup_fails_closed_for_special_files_and_retries_from_the_same_journal() {
    let (_root, channel_root, installed, candidate) = fixture();
    let socket_path = installed.join("unsafe.socket");
    let listener = UnixListener::bind(&socket_path).expect("unix socket");
    commit(&channel_root, &installed, &candidate);
    let mut pending = load_pending_cleanup(&channel_root, ReleaseChannel::Test)
        .expect("load cleanup")
        .expect("pending cleanup");

    let error = pending
        .execute()
        .expect_err("special file must fail closed");

    assert!(error.to_string().contains("special"));
    assert!(!pending.is_acknowledged());
    let isolated_backup = active_backup(&channel_root, &candidate);
    assert!(isolated_backup.exists());
    assert!(cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists());
    drop(listener);
    fs::remove_file(isolated_backup.join("unsafe.socket")).expect("remove unsafe socket");
    pending.execute().expect("retry cleanup");
    assert!(pending.is_acknowledged());
    assert!(!isolated_backup.exists());
    assert!(!cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists());
}

#[test]
fn missing_backup_is_fsynced_and_clears_the_stale_journal() {
    let (_root, channel_root, installed, candidate) = fixture();
    commit(&channel_root, &installed, &candidate);
    fs::remove_dir_all(&candidate).expect("simulate already removed backup");

    let mut pending = load_pending_cleanup(&channel_root, ReleaseChannel::Test)
        .expect("load missing backup cleanup")
        .expect("pending cleanup");
    pending.execute().expect("complete missing backup cleanup");

    assert!(!cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists());
}

#[test]
fn top_level_identity_changes_never_delete_and_keep_the_journal() {
    for case in ["backup-directory", "backup-symlink", "installed"] {
        let (root, channel_root, installed, candidate) = fixture();
        commit(&channel_root, &installed, &candidate);
        let mut pending = load_pending_cleanup(&channel_root, ReleaseChannel::Test)
            .expect("load cleanup")
            .expect("pending cleanup");
        let outside = root.path().join("outside.app");
        app_bundle(&outside, "outside");
        match case {
            "backup-directory" => {
                fs::remove_dir_all(&candidate).expect("remove backup");
                app_bundle(&candidate, "replacement");
            }
            "backup-symlink" => {
                fs::remove_dir_all(&candidate).expect("remove backup");
                symlink(&outside, &candidate).expect("replacement symlink");
            }
            "installed" => {
                fs::remove_dir_all(&installed).expect("remove installed");
                app_bundle(&installed, "replacement");
            }
            _ => unreachable!(),
        }

        pending
            .execute()
            .unwrap_err_or_else(|| panic!("{case} replacement must fail"));
        assert!(outside.exists(), "{case}");
        assert!(cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists());
    }
}

#[test]
fn top_level_replacement_after_verification_is_preserved_with_the_journal() {
    let (root, channel_root, installed, candidate) = fixture();
    commit(&channel_root, &installed, &candidate);
    let displaced = root.path().join("displaced-backup.app");
    let candidate_for_hook = candidate.clone();
    let displaced_for_hook = displaced.clone();
    let mut hook = ActionAt {
        boundary: CleanupBoundary::BeforeBackupIsolation,
        action: Some(move || {
            fs::rename(&candidate_for_hook, &displaced_for_hook).expect("displace backup");
            app_bundle(&candidate_for_hook, "replacement");
        }),
    };
    let mut pending = load_pending_cleanup(&channel_root, ReleaseChannel::Test)
        .expect("load cleanup")
        .expect("pending cleanup");

    pending
        .execute_with_hook(&mut hook)
        .expect_err("replaced backup must not be deleted");

    assert_eq!(
        fs::read_to_string(candidate.join("marker")).expect("replacement marker"),
        "replacement"
    );
    assert_eq!(
        fs::read_to_string(displaced.join("marker")).expect("displaced backup marker"),
        "old"
    );
    assert!(cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists());
}

#[test]
fn occupied_original_name_preserves_both_entries_after_isolation_mismatch() {
    struct OccupyOriginal {
        candidate: PathBuf,
        displaced: PathBuf,
    }

    impl CleanupTestHook for OccupyOriginal {
        fn reached(&mut self, boundary: CleanupBoundary) {
            match boundary {
                CleanupBoundary::BeforeBackupIsolation => {
                    fs::rename(&self.candidate, &self.displaced).expect("displace backup");
                    app_bundle(&self.candidate, "isolated-replacement");
                }
                CleanupBoundary::AfterBackupRenameBeforeVerify => {
                    app_bundle(&self.candidate, "original-occupant");
                }
                _ => {}
            }
        }
    }

    let (root, channel_root, installed, candidate) = fixture();
    commit(&channel_root, &installed, &candidate);
    let displaced = root.path().join("displaced-backup.app");
    let mut hook = OccupyOriginal {
        candidate: candidate.clone(),
        displaced: displaced.clone(),
    };
    let mut pending = load_pending_cleanup(&channel_root, ReleaseChannel::Test)
        .expect("load cleanup")
        .expect("pending cleanup");

    pending
        .execute_with_hook(&mut hook)
        .expect_err("occupied original name must prevent restoration");

    assert_eq!(
        fs::read_to_string(candidate.join("marker")).expect("original occupant"),
        "original-occupant"
    );
    assert_eq!(
        fs::read_to_string(journal_isolated_backup(&channel_root, &candidate).join("marker"))
            .expect("isolated replacement"),
        "isolated-replacement"
    );
    assert_eq!(
        fs::read_to_string(displaced.join("marker")).expect("displaced backup"),
        "old"
    );
    assert!(cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists());
}

#[test]
fn nested_directory_replacement_after_verification_is_preserved_with_the_journal() {
    let (root, channel_root, installed, candidate) = fixture();
    fs::create_dir_all(installed.join("nested/original")).expect("nested backup directory");
    commit(&channel_root, &installed, &candidate);
    let displaced = root.path().join("displaced-nested");
    let channel_for_hook = channel_root.clone();
    let candidate_for_hook = candidate.clone();
    let displaced_for_hook = displaced.clone();
    let mut hook = EntryActionAt {
        boundary: CleanupBoundary::BeforeChildIsolation,
        name: b"nested",
        action: Some(move || {
            let backup = active_backup(&channel_for_hook, &candidate_for_hook);
            let nested = backup.join("nested");
            fs::rename(&nested, &displaced_for_hook).expect("displace nested directory");
            fs::create_dir(&nested).expect("replacement nested directory");
        }),
    };
    let mut pending = load_pending_cleanup(&channel_root, ReleaseChannel::Test)
        .expect("load cleanup")
        .expect("pending cleanup");

    pending
        .execute_with_hook(&mut hook)
        .expect_err("replaced nested directory must not be deleted");

    assert!(active_backup(&channel_root, &candidate)
        .join("nested")
        .is_dir());
    assert!(displaced.join("original").is_dir());
    assert!(cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists());
}

#[test]
fn leaf_replacement_after_verification_is_preserved_with_the_journal() {
    let (root, channel_root, installed, candidate) = fixture();
    fs::write(installed.join("leaf"), "original").expect("backup leaf");
    commit(&channel_root, &installed, &candidate);
    let displaced = root.path().join("displaced-leaf");
    let channel_for_hook = channel_root.clone();
    let candidate_for_hook = candidate.clone();
    let displaced_for_hook = displaced.clone();
    let mut hook = EntryActionAt {
        boundary: CleanupBoundary::BeforeLeafIsolation,
        name: b"leaf",
        action: Some(move || {
            let backup = active_backup(&channel_for_hook, &candidate_for_hook);
            let leaf = backup.join("leaf");
            fs::rename(&leaf, &displaced_for_hook).expect("displace leaf");
            fs::write(&leaf, "replacement").expect("replacement leaf");
        }),
    };
    let mut pending = load_pending_cleanup(&channel_root, ReleaseChannel::Test)
        .expect("load cleanup")
        .expect("pending cleanup");

    pending
        .execute_with_hook(&mut hook)
        .expect_err("replaced leaf must not be deleted");

    assert_eq!(
        fs::read_to_string(active_backup(&channel_root, &candidate).join("leaf"))
            .expect("replacement leaf"),
        "replacement"
    );
    assert_eq!(
        fs::read_to_string(displaced).expect("displaced leaf"),
        "original"
    );
    assert!(cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists());
}

trait ExpectErrOrElse<T> {
    fn unwrap_err_or_else(self, success: impl FnOnce()) -> T;
}

impl<T, E> ExpectErrOrElse<E> for Result<T, E> {
    fn unwrap_err_or_else(self, success: impl FnOnce()) -> E {
        match self {
            Ok(_) => {
                success();
                unreachable!()
            }
            Err(error) => error,
        }
    }
}

#[test]
fn rollback_and_unjournaled_candidates_are_never_cleanup_authority() {
    let (_root, channel_root, installed, candidate) = fixture();
    let transaction =
        RecoveryTransaction::open(installed.parent().unwrap(), &installed, &candidate)
            .expect("transaction");
    let mut cleanup =
        CleanupCompanion::new(&channel_root, ReleaseChannel::Test).expect("cleanup companion");

    assert!(matches!(
        transaction
            .publish_with_companion(&mut Failed, &mut cleanup)
            .expect("rollback"),
        PublicationOutcome::RolledBack { .. }
    ));
    assert!(!cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists());
    assert!(load_pending_cleanup(&channel_root, ReleaseChannel::Test)
        .expect("load without journal")
        .is_none());
    assert!(
        candidate.exists(),
        "candidate was deleted without a journal"
    );
}

#[test]
fn cleanup_journal_crashes_replay_the_same_intent_idempotently() {
    let boundaries = [
        CleanupBoundary::BeforeJournalFileFsync,
        CleanupBoundary::AfterJournalFileFsync,
        CleanupBoundary::BeforeJournalRename,
        CleanupBoundary::AfterJournalRename,
        CleanupBoundary::BeforeJournalParentFsync,
        CleanupBoundary::AfterJournalParentFsync,
    ];
    for boundary in boundaries {
        let (_root, channel_root, installed, candidate) = fixture();
        let transaction =
            RecoveryTransaction::open(installed.parent().unwrap(), &installed, &candidate)
                .expect("transaction");
        let mut hook = CrashAt(boundary);
        let mut cleanup =
            CleanupCompanion::new_with_hook(&channel_root, ReleaseChannel::Test, &mut hook)
                .expect("cleanup companion");

        assert!(catch_unwind(AssertUnwindSafe(|| {
            let _ = transaction.publish_with_companion(&mut Healthy, &mut cleanup);
        }))
        .is_err());

        let mut replay = CleanupCompanion::new(&channel_root, ReleaseChannel::Test)
            .expect("replay cleanup companion");
        openloop_desktop_lib::update::recovery::recover_interrupted_update_with_companion(
            installed.parent().unwrap(),
            &mut replay,
        )
        .unwrap_or_else(|error| panic!("replay after {boundary:?}: {error}"));
        assert!(
            cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists(),
            "{boundary:?}"
        );
        assert_eq!(
            fs::read_to_string(installed.join("marker")).expect("installed marker"),
            "new",
            "{boundary:?}"
        );
        assert_eq!(
            fs::read_to_string(candidate.join("marker")).expect("backup marker"),
            "old",
            "{boundary:?}"
        );
    }
}

#[test]
fn cleanup_journal_replay_rejects_a_conflicting_publication() {
    let (_root, channel_root, installed, candidate) = fixture();
    commit(&channel_root, &installed, &candidate);
    let second_candidate = installed
        .parent()
        .unwrap()
        .join(".openloop-candidate-conflict.app");
    app_bundle(&second_candidate, "conflict");
    let transaction =
        RecoveryTransaction::open(installed.parent().unwrap(), &installed, &second_candidate)
            .expect("second transaction");
    let mut cleanup =
        CleanupCompanion::new(&channel_root, ReleaseChannel::Test).expect("cleanup companion");

    let error = transaction
        .publish_with_companion(&mut Healthy, &mut cleanup)
        .expect_err("another publication must not replace pending cleanup");

    assert!(error.to_string().contains("companion"));
    assert!(cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists());
}

#[test]
fn same_intent_replay_fsyncs_the_channel_root_before_recovery_commits() {
    let (_root, channel_root, installed, candidate) = fixture();
    let transaction =
        RecoveryTransaction::open(installed.parent().unwrap(), &installed, &candidate)
            .expect("transaction");
    let mut crash = CrashAt(CleanupBoundary::AfterJournalRename);
    let mut initial =
        CleanupCompanion::new_with_hook(&channel_root, ReleaseChannel::Test, &mut crash)
            .expect("cleanup companion");
    assert!(catch_unwind(AssertUnwindSafe(|| {
        let _ = transaction.publish_with_companion(&mut Healthy, &mut initial);
    }))
    .is_err());

    let mut hook = RecordingCleanupHook::default();
    let mut replay =
        CleanupCompanion::new_with_hook(&channel_root, ReleaseChannel::Test, &mut hook)
            .expect("replay companion");
    openloop_desktop_lib::update::recovery::recover_interrupted_update_with_companion(
        installed.parent().unwrap(),
        &mut replay,
    )
    .expect("same intent replay");

    assert!(
        hook.parent_fsync,
        "same cleanup intent replay skipped the channel-root durability barrier"
    );
}

#[test]
fn cleanup_execution_crashes_are_idempotently_recoverable() {
    let boundaries = [
        CleanupBoundary::BeforeBackupUnlink,
        CleanupBoundary::AfterBackupUnlink,
        CleanupBoundary::BeforeUpdateRootFsync,
        CleanupBoundary::AfterUpdateRootFsync,
        CleanupBoundary::BeforeJournalUnlink,
        CleanupBoundary::AfterJournalUnlink,
        CleanupBoundary::BeforeJournalRemovalParentFsync,
        CleanupBoundary::AfterJournalRemovalParentFsync,
    ];
    for boundary in boundaries {
        let (_root, channel_root, installed, candidate) = fixture();
        commit(&channel_root, &installed, &candidate);
        let mut pending = load_pending_cleanup(&channel_root, ReleaseChannel::Test)
            .expect("load cleanup")
            .expect("pending cleanup");
        let mut crash = CrashAt(boundary);

        assert!(catch_unwind(AssertUnwindSafe(|| {
            let _ = pending.execute_with_hook(&mut crash);
        }))
        .is_err());

        if let Some(mut replay) =
            load_pending_cleanup(&channel_root, ReleaseChannel::Test).expect("reload cleanup")
        {
            replay
                .execute()
                .unwrap_or_else(|error| panic!("replay after {boundary:?}: {error}"));
        }
        assert!(!candidate.exists(), "{boundary:?}");
        assert!(
            !cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists(),
            "{boundary:?}"
        );
        assert_eq!(
            fs::read_to_string(installed.join("marker")).expect("installed marker"),
            "new",
            "{boundary:?}"
        );
    }
}

#[test]
fn crash_after_backup_isolation_replays_the_journaled_artifact() {
    for boundary in [
        CleanupBoundary::AfterBackupRenameBeforeVerify,
        CleanupBoundary::AfterBackupIsolation,
    ] {
        let (_root, channel_root, installed, candidate) = fixture();
        commit(&channel_root, &installed, &candidate);
        let mut pending = load_pending_cleanup(&channel_root, ReleaseChannel::Test)
            .expect("load cleanup")
            .expect("pending cleanup");
        let mut crash = CrashAt(boundary);

        assert!(catch_unwind(AssertUnwindSafe(|| {
            let _ = pending.execute_with_hook(&mut crash);
        }))
        .is_err());

        let isolated = active_backup(&channel_root, &candidate);
        assert!(!candidate.exists(), "{boundary:?}");
        assert!(isolated.exists(), "{boundary:?}");
        assert!(
            cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists(),
            "{boundary:?}"
        );

        load_pending_cleanup(&channel_root, ReleaseChannel::Test)
            .expect("reload isolated cleanup")
            .expect("pending isolated cleanup")
            .execute()
            .unwrap_or_else(|error| panic!("replay isolated cleanup after {boundary:?}: {error}"));

        assert!(!isolated.exists(), "{boundary:?}");
        assert!(
            !cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists(),
            "{boundary:?}"
        );
    }
}

#[test]
fn crash_replay_preserves_an_original_name_conflict_and_the_journal() {
    let (_root, channel_root, installed, candidate) = fixture();
    commit(&channel_root, &installed, &candidate);
    let mut pending = load_pending_cleanup(&channel_root, ReleaseChannel::Test)
        .expect("load cleanup")
        .expect("pending cleanup");
    let mut crash = CrashAt(CleanupBoundary::AfterBackupIsolation);

    assert!(catch_unwind(AssertUnwindSafe(|| {
        let _ = pending.execute_with_hook(&mut crash);
    }))
    .is_err());

    let isolated = journal_isolated_backup(&channel_root, &candidate);
    app_bundle(&candidate, "replacement");

    load_pending_cleanup(&channel_root, ReleaseChannel::Test)
        .expect_err("occupied original backup name must remain a conflict");

    assert_eq!(
        fs::read_to_string(candidate.join("marker")).expect("replacement marker"),
        "replacement"
    );
    assert_eq!(
        fs::read_to_string(isolated.join("marker")).expect("isolated backup marker"),
        "old"
    );
    assert!(cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists());
}

#[test]
fn acknowledged_cleanup_allows_a_second_update_to_commit() {
    let (_root, channel_root, installed, first_candidate) = fixture();
    commit(&channel_root, &installed, &first_candidate);
    load_pending_cleanup(&channel_root, ReleaseChannel::Test)
        .expect("load first cleanup")
        .expect("first pending cleanup")
        .execute()
        .expect("first cleanup");

    let second_candidate = installed
        .parent()
        .unwrap()
        .join(".openloop-candidate-second.app");
    app_bundle(&second_candidate, "newer");
    commit(&channel_root, &installed, &second_candidate);

    assert_eq!(
        fs::read_to_string(installed.join("marker")).expect("second installed marker"),
        "newer"
    );
    assert_eq!(
        fs::read_to_string(second_candidate.join("marker")).expect("second backup marker"),
        "new"
    );
    assert!(cleanup_journal_path(&channel_root, ReleaseChannel::Test).exists());
}
