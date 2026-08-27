#![cfg(target_os = "macos")]

use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    path::Path,
    sync::{Arc, Mutex},
};

use openloop_desktop_lib::{
    credentials::{
        migration::{
            commit_migration, credential_health_plan, journal_path, plan_migration,
            prepare_migration, prepare_migration_with_filesystem,
            prepare_migration_with_transaction_id, rollback_migration, staged_path, Journal,
            MigrationBoundary, MigrationDeleteOutcome, MigrationFilesystem, MigrationHook,
            MigrationOutcome, MigrationRollbackStatus, MigrationState, MigrationStore,
            MigrationStoreError, NoopMigrationHook, PreviousValue, ReadOnlyLegacySource,
            ReferenceState,
        },
        CredentialAccount, KeychainStore, MAX_SECRET_BYTES,
    },
    update::{
        channel::ReleaseChannel,
        recovery::{
            recover_interrupted_update_with_bound_companion, update_journal_path, CandidateHealth,
            HealthStatus, PublicationCompanion, PublicationOutcome, RecoveryTransaction,
        },
    },
};
use std::time::Duration;
use tempfile::tempdir;
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Clone, Default)]
struct MemoryStore {
    values: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
    owners: Arc<Mutex<BTreeMap<String, Uuid>>>,
}

impl MemoryStore {
    fn seeded(entries: &[(&str, &[u8])]) -> Self {
        Self {
            values: Arc::new(Mutex::new(
                entries
                    .iter()
                    .map(|(reference, value)| ((*reference).to_owned(), value.to_vec()))
                    .collect(),
            )),
            owners: Arc::default(),
        }
    }

    fn get(&self, reference: &str) -> Option<Vec<u8>> {
        self.values
            .lock()
            .expect("memory store")
            .get(reference)
            .cloned()
    }

    fn external_set(&self, reference: &str, value: &[u8]) {
        self.values
            .lock()
            .expect("memory store")
            .insert(reference.to_owned(), value.to_vec());
        self.owners.lock().expect("memory owners").remove(reference);
    }

    fn external_set_preserving_owner(&self, reference: &str, value: &[u8]) {
        self.values
            .lock()
            .expect("memory store")
            .insert(reference.to_owned(), value.to_vec());
    }
}

impl MigrationStore for MemoryStore {
    fn resolve(
        &self,
        account: &CredentialAccount,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, MigrationStoreError> {
        Ok(self
            .values
            .lock()
            .expect("memory store")
            .get(account.as_str().trim_start_matches("credential:"))
            .cloned()
            .map(Zeroizing::new))
    }

    fn set_migration_owned(
        &self,
        account: &CredentialAccount,
        secret: &[u8],
        transaction_id: Uuid,
    ) -> Result<(), MigrationStoreError> {
        let reference = account
            .as_str()
            .trim_start_matches("credential:")
            .to_owned();
        self.values
            .lock()
            .expect("memory store")
            .insert(reference.clone(), secret.to_vec());
        self.owners
            .lock()
            .expect("memory owners")
            .insert(reference, transaction_id);
        Ok(())
    }

    fn delete_if_migration_owned(
        &self,
        account: &CredentialAccount,
        expected_secret: &[u8],
        transaction_id: Uuid,
    ) -> Result<MigrationDeleteOutcome, MigrationStoreError> {
        let reference = account.as_str().trim_start_matches("credential:");
        let mut owners = self.owners.lock().expect("memory owners");
        if owners.get(reference) != Some(&transaction_id) {
            return Ok(MigrationDeleteOutcome::NotOwned);
        }
        let mut values = self.values.lock().expect("memory store");
        if values.get(reference).map(Vec::as_slice) != Some(expected_secret) {
            return Ok(MigrationDeleteOutcome::PreservedIndeterminate);
        }
        owners.remove(reference);
        values.remove(reference);
        Ok(MigrationDeleteOutcome::Deleted)
    }
}

#[derive(Default)]
struct RecordingHook {
    boundaries: Vec<MigrationBoundary>,
    crash_at: Option<MigrationBoundary>,
}

impl MigrationHook for RecordingHook {
    fn reached(&mut self, boundary: MigrationBoundary) -> Result<(), MigrationStoreError> {
        self.boundaries.push(boundary.clone());
        if self.crash_at.as_ref() == Some(&boundary) {
            return Err(MigrationStoreError::injected_crash());
        }
        Ok(())
    }
}

fn fixture() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let root = tempdir().expect("fixture root");
    let channel_root = root.path().join("Openloop-Test");
    let dsh_home = channel_root.join("dsh");
    fs::create_dir_all(&dsh_home).expect("channel DSH_HOME");
    (root, channel_root, dsh_home)
}

fn write_legacy(dsh_home: &Path, yaml: &[u8]) {
    let path = dsh_home.join(".credentials.yaml");
    fs::write(&path, yaml).expect("legacy credentials");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .expect("legacy credential permissions");
}

fn read_journal(channel_root: &Path) -> Journal {
    serde_json::from_slice(&fs::read(journal_path(channel_root)).expect("migration journal"))
        .expect("valid migration journal")
}

#[test]
fn migration_records_sorted_redacted_journal_and_waits_for_health_commit() {
    let (_root, channel_root, dsh_home) = fixture();
    write_legacy(
        &dsh_home,
        b"ZETA_TOKEN: zeta-secret\nALPHA_TOKEN: alpha-secret\n",
    );
    let store = MemoryStore::default();
    let mut hook = RecordingHook::default();

    let outcome = prepare_migration(&channel_root, &dsh_home, &store, &mut hook)
        .expect("migration stages legacy credentials");
    let transaction_id = outcome.transaction_id().expect("pending transaction");
    let journal = read_journal(&channel_root);
    let journal_json = serde_json::to_string(&journal).expect("journal JSON");

    assert_eq!(outcome, MigrationOutcome::PendingHealth(transaction_id));
    assert_eq!(journal.state, MigrationState::LegacyStaged);
    assert_eq!(
        journal.references.keys().cloned().collect::<Vec<_>>(),
        vec!["ALPHA_TOKEN", "ZETA_TOKEN"]
    );
    assert!(journal
        .references
        .values()
        .all(|entry| entry.state == ReferenceState::Verified));
    assert!(journal
        .references
        .values()
        .all(|entry| entry.previous == Some(PreviousValue::Absent)));
    assert_eq!(
        journal.transaction_created_refs,
        vec!["ALPHA_TOKEN", "ZETA_TOKEN"]
    );
    assert!(journal.pre_existing_refs.is_empty());
    assert!(!journal_json.contains("alpha-secret"));
    assert!(!journal_json.contains("zeta-secret"));
    assert!(!dsh_home.join(".credentials.yaml").exists());
    assert!(staged_path(&dsh_home, transaction_id).is_file());
    assert_eq!(
        store.get("ALPHA_TOKEN").as_deref(),
        Some(b"alpha-secret".as_slice())
    );

    let retried = prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
        .expect("staged migration is retry-safe");
    assert_eq!(retried, MigrationOutcome::PendingHealth(transaction_id));
    assert!(staged_path(&dsh_home, transaction_id).exists());

    commit_migration(
        &channel_root,
        &dsh_home,
        transaction_id,
        &mut NoopMigrationHook,
    )
    .expect("full health commits migration");
    assert!(!staged_path(&dsh_home, transaction_id).exists());
    assert!(!journal_path(&channel_root).exists());
}

#[test]
fn candidate_health_plan_is_value_free_and_strictly_bound_to_the_pending_journal() {
    let (_root, channel_root, dsh_home) = fixture();
    write_legacy(
        &dsh_home,
        b"ZETA_TOKEN: zeta-secret\nALPHA_TOKEN: alpha-secret\n",
    );
    let outcome = prepare_migration(
        &channel_root,
        &dsh_home,
        &MemoryStore::default(),
        &mut NoopMigrationHook,
    )
    .expect("pending migration");
    let transaction_id = outcome.transaction_id().expect("transaction");

    let plan = credential_health_plan(&channel_root, &dsh_home, Some(transaction_id))
        .expect("candidate health plan");
    assert_eq!(plan.migration_transaction_id, Some(transaction_id));
    assert_eq!(plan.references, vec!["ALPHA_TOKEN", "ZETA_TOKEN"]);
    let serialized = serde_json::to_string(&plan).expect("serialize plan");
    assert!(!serialized.contains("alpha-secret"));
    assert!(!serialized.contains("zeta-secret"));

    assert!(
        credential_health_plan(&channel_root, &dsh_home, Some(Uuid::new_v4())).is_err(),
        "mismatched transaction identity produced a plan"
    );
    assert!(
        credential_health_plan(&channel_root, &dsh_home, None).is_err(),
        "pending migration produced an empty no-migration plan"
    );

    let (_empty_root, empty_channel_root, empty_dsh_home) = fixture();
    let empty = credential_health_plan(&empty_channel_root, &empty_dsh_home, None)
        .expect("explicit no-migration plan");
    assert_eq!(empty.migration_transaction_id, None);
    assert!(empty.references.is_empty());
}

#[test]
fn migration_observes_every_keychain_and_durable_journal_boundary() {
    let (_root, channel_root, dsh_home) = fixture();
    write_legacy(&dsh_home, b"FIRST_TOKEN: first\nSECOND_TOKEN: second\n");
    let store = MemoryStore::default();
    let mut hook = RecordingHook::default();

    prepare_migration(&channel_root, &dsh_home, &store, &mut hook).expect("migration");

    for reference in ["FIRST_TOKEN", "SECOND_TOKEN"] {
        assert!(hook
            .boundaries
            .contains(&MigrationBoundary::BeforeKeychainWrite {
                reference: reference.to_owned(),
            }));
        assert!(hook
            .boundaries
            .contains(&MigrationBoundary::AfterKeychainWrite {
                reference: reference.to_owned(),
            }));
    }
    for state in [
        MigrationState::Discovered,
        MigrationState::WritingKeychain,
        MigrationState::KeychainVerified,
        MigrationState::LegacyStaged,
    ] {
        assert!(
            hook.boundaries.iter().any(|boundary| matches!(
                boundary,
                MigrationBoundary::AfterJournalParentFsync {
                    state: observed,
                    ..
                } if *observed == state
            )),
            "missing durable top-state transition {state:?}: {:?}",
            hook.boundaries
        );
    }
    for state in [
        ReferenceState::Planned,
        ReferenceState::Written,
        ReferenceState::Verified,
    ] {
        assert!(
            hook.boundaries.iter().any(|boundary| matches!(
                boundary,
                MigrationBoundary::AfterJournalParentFsync {
                    reference_state: Some(observed),
                    ..
                } if *observed == state
            )),
            "missing durable reference transition {state:?}"
        );
    }
}

#[test]
fn process_death_before_and_after_each_write_or_fsync_is_recoverable() {
    let (_root, baseline_channel, baseline_dsh) = fixture();
    write_legacy(&baseline_dsh, b"FIRST_TOKEN: first\nSECOND_TOKEN: second\n");
    let mut recorder = RecordingHook::default();
    prepare_migration(
        &baseline_channel,
        &baseline_dsh,
        &MemoryStore::default(),
        &mut recorder,
    )
    .expect("record migration boundaries");
    let crash_boundaries = recorder
        .boundaries
        .into_iter()
        .filter(|boundary| {
            matches!(
                boundary,
                MigrationBoundary::BeforeKeychainWrite { .. }
                    | MigrationBoundary::AfterKeychainWrite { .. }
                    | MigrationBoundary::BeforeJournalFileFsync { .. }
                    | MigrationBoundary::AfterJournalFileFsync { .. }
                    | MigrationBoundary::BeforeJournalParentFsync { .. }
                    | MigrationBoundary::AfterJournalParentFsync { .. }
            )
        })
        .collect::<Vec<_>>();
    assert!(!crash_boundaries.is_empty());

    for boundary in crash_boundaries {
        let (_root, channel_root, dsh_home) = fixture();
        write_legacy(&dsh_home, b"FIRST_TOKEN: first\nSECOND_TOKEN: second\n");
        let store = MemoryStore::default();
        let mut crash = RecordingHook {
            boundaries: Vec::new(),
            crash_at: Some(boundary.clone()),
        };

        let error = prepare_migration(&channel_root, &dsh_home, &store, &mut crash)
            .expect_err("injected process death");
        assert!(
            error.is_injected_crash(),
            "unexpected error at {boundary:?}: {error}"
        );

        let recovered = prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
            .unwrap_or_else(|error| panic!("recover {boundary:?}: {error}"));
        let transaction_id = recovered.transaction_id().expect("recovered transaction");
        rollback_migration(
            &channel_root,
            &dsh_home,
            transaction_id,
            &store,
            &mut NoopMigrationHook,
        )
        .unwrap_or_else(|error| panic!("rollback {boundary:?}: {error}"));

        assert!(dsh_home.join(".credentials.yaml").is_file());
        assert!(!journal_path(&channel_root).exists());
        assert_eq!(store.get("FIRST_TOKEN"), None);
        assert_eq!(store.get("SECOND_TOKEN"), None);
    }
}

#[test]
fn process_death_during_committed_journal_fsync_finishes_without_reconstructing_plaintext() {
    let (_root, baseline_channel, baseline_dsh) = fixture();
    write_legacy(&baseline_dsh, b"TOKEN: secret\n");
    let store = MemoryStore::default();
    let outcome = prepare_migration(
        &baseline_channel,
        &baseline_dsh,
        &store,
        &mut NoopMigrationHook,
    )
    .expect("baseline migration");
    let transaction_id = outcome.transaction_id().expect("transaction");
    let mut recorder = RecordingHook::default();
    commit_migration(
        &baseline_channel,
        &baseline_dsh,
        transaction_id,
        &mut recorder,
    )
    .expect("record commit boundaries");
    let boundaries = recorder
        .boundaries
        .into_iter()
        .filter(|boundary| {
            matches!(
                boundary,
                MigrationBoundary::BeforeJournalFileFsync {
                    state: MigrationState::Committed,
                    ..
                } | MigrationBoundary::AfterJournalFileFsync {
                    state: MigrationState::Committed,
                    ..
                } | MigrationBoundary::BeforeJournalParentFsync {
                    state: MigrationState::Committed,
                    ..
                } | MigrationBoundary::AfterJournalParentFsync {
                    state: MigrationState::Committed,
                    ..
                }
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(boundaries.len(), 4);

    for boundary in boundaries {
        let (_root, channel_root, dsh_home) = fixture();
        write_legacy(&dsh_home, b"TOKEN: secret\n");
        let store = MemoryStore::default();
        let outcome = prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
            .expect("migration");
        let transaction_id = outcome.transaction_id().expect("transaction");
        let mut crash = RecordingHook {
            boundaries: Vec::new(),
            crash_at: Some(boundary),
        };
        commit_migration(&channel_root, &dsh_home, transaction_id, &mut crash)
            .expect("irreversible commit failures recover forward");
        assert!(!dsh_home.join(".credentials.yaml").exists());
        assert!(!staged_path(&dsh_home, transaction_id).exists());

        assert_eq!(
            prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook,)
                .expect("finish commit recovery"),
            MigrationOutcome::NotNeeded
        );
        assert!(!journal_path(&channel_root).exists());
        assert_eq!(store.get("TOKEN").as_deref(), Some(b"secret".as_slice()));
    }
}

#[test]
fn failure_before_staged_delete_remains_fully_rollbackable() {
    let (_root, channel_root, dsh_home) = fixture();
    write_legacy(&dsh_home, b"TOKEN: secret\n");
    let store = MemoryStore::default();
    let outcome = prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
        .expect("migration");
    let transaction_id = outcome.transaction_id().expect("transaction");
    let mut crash = RecordingHook {
        boundaries: Vec::new(),
        crash_at: Some(MigrationBoundary::BeforeStagedDelete),
    };

    assert!(commit_migration(&channel_root, &dsh_home, transaction_id, &mut crash).is_err());
    rollback_migration(
        &channel_root,
        &dsh_home,
        transaction_id,
        &store,
        &mut NoopMigrationHook,
    )
    .expect("rollback before irreversible deletion");

    assert!(dsh_home.join(".credentials.yaml").is_file());
    assert!(!staged_path(&dsh_home, transaction_id).exists());
    assert_eq!(store.get("TOKEN"), None);
}

#[test]
fn process_death_after_staged_delete_recovers_forward_without_legacy_plaintext() {
    let (_root, channel_root, dsh_home) = fixture();
    write_legacy(&dsh_home, b"TOKEN: secret\n");
    let store = MemoryStore::default();
    let outcome = prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
        .expect("migration");
    let transaction_id = outcome.transaction_id().expect("transaction");
    let mut crash = RecordingHook {
        boundaries: Vec::new(),
        crash_at: Some(MigrationBoundary::AfterStagedDelete),
    };

    let _ = commit_migration(&channel_root, &dsh_home, transaction_id, &mut crash);
    assert_eq!(
        prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
            .expect("forward recovery after staged deletion"),
        MigrationOutcome::NotNeeded
    );

    assert!(!dsh_home.join(".credentials.yaml").exists());
    assert!(!staged_path(&dsh_home, transaction_id).exists());
    assert_eq!(store.get("TOKEN").as_deref(), Some(b"secret".as_slice()));
}

#[test]
fn process_death_at_every_commit_boundary_resumes_forward_idempotently() {
    let (_root, baseline_channel, baseline_dsh) = fixture();
    write_legacy(&baseline_dsh, b"TOKEN: secret\n");
    let baseline_store = MemoryStore::default();
    let baseline = prepare_migration(
        &baseline_channel,
        &baseline_dsh,
        &baseline_store,
        &mut NoopMigrationHook,
    )
    .expect("baseline migration");
    let baseline_transaction = baseline.transaction_id().expect("baseline transaction");
    let mut recorder = RecordingHook::default();
    commit_migration(
        &baseline_channel,
        &baseline_dsh,
        baseline_transaction,
        &mut recorder,
    )
    .expect("record commit boundaries");
    let crash_boundaries = recorder.boundaries;
    assert!(crash_boundaries.contains(&MigrationBoundary::BeforeStagedDelete));
    assert!(crash_boundaries.contains(&MigrationBoundary::AfterStagedDelete));
    assert!(crash_boundaries.contains(&MigrationBoundary::BeforeStagedDeleteParentFsync));
    assert!(crash_boundaries.contains(&MigrationBoundary::AfterStagedDeleteParentFsync));

    for boundary in crash_boundaries {
        let (_root, channel_root, dsh_home) = fixture();
        write_legacy(&dsh_home, b"TOKEN: secret\n");
        let store = MemoryStore::default();
        let outcome = prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
            .expect("migration");
        let transaction_id = outcome.transaction_id().expect("transaction");
        let mut crash = RecordingHook {
            boundaries: Vec::new(),
            crash_at: Some(boundary.clone()),
        };

        let _ = commit_migration(&channel_root, &dsh_home, transaction_id, &mut crash);
        let resumed = prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
            .unwrap_or_else(|error| panic!("prepare after {boundary:?}: {error}"));
        if resumed == MigrationOutcome::PendingHealth(transaction_id) {
            commit_migration(
                &channel_root,
                &dsh_home,
                transaction_id,
                &mut NoopMigrationHook,
            )
            .unwrap_or_else(|error| panic!("resume commit after {boundary:?}: {error}"));
        }
        commit_migration(
            &channel_root,
            &dsh_home,
            transaction_id,
            &mut NoopMigrationHook,
        )
        .unwrap_or_else(|error| panic!("idempotent commit after {boundary:?}: {error}"));

        assert!(!dsh_home.join(".credentials.yaml").exists(), "{boundary:?}");
        assert!(
            !staged_path(&dsh_home, transaction_id).exists(),
            "{boundary:?}"
        );
        assert!(!journal_path(&channel_root).exists(), "{boundary:?}");
        assert_eq!(
            store.get("TOKEN").as_deref(),
            Some(b"secret".as_slice()),
            "{boundary:?}"
        );
    }
}

#[test]
fn commit_exposes_every_durable_and_irreversible_boundary() {
    let (_root, channel_root, dsh_home) = fixture();
    write_legacy(&dsh_home, b"TOKEN: secret\n");
    let store = MemoryStore::default();
    let outcome = prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
        .expect("migration");
    let transaction_id = outcome.transaction_id().expect("transaction");
    let mut hook = RecordingHook::default();

    commit_migration(&channel_root, &dsh_home, transaction_id, &mut hook).expect("commit");

    for boundary in [
        MigrationBoundary::BeforeJournalFileFsync {
            generation: 7,
            state: MigrationState::CommitPrepared,
            reference_state: None,
        },
        MigrationBoundary::AfterJournalFileFsync {
            generation: 7,
            state: MigrationState::CommitPrepared,
            reference_state: None,
        },
        MigrationBoundary::BeforeJournalParentFsync {
            generation: 7,
            state: MigrationState::CommitPrepared,
            reference_state: None,
        },
        MigrationBoundary::AfterJournalParentFsync {
            generation: 7,
            state: MigrationState::CommitPrepared,
            reference_state: None,
        },
        MigrationBoundary::BeforeStagedDelete,
        MigrationBoundary::AfterStagedDelete,
        MigrationBoundary::BeforeStagedDeleteParentFsync,
        MigrationBoundary::AfterStagedDeleteParentFsync,
    ] {
        assert!(hook.boundaries.contains(&boundary), "missing {boundary:?}");
    }
}

#[test]
fn rollback_with_an_already_deleted_staged_file_completes_committed() {
    let (_root, channel_root, dsh_home) = fixture();
    write_legacy(&dsh_home, b"TOKEN: secret\n");
    let store = MemoryStore::default();
    let outcome = prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
        .expect("migration");
    let transaction_id = outcome.transaction_id().expect("transaction");
    fs::remove_file(staged_path(&dsh_home, transaction_id)).expect("simulate committed deletion");

    rollback_migration(
        &channel_root,
        &dsh_home,
        transaction_id,
        &store,
        &mut NoopMigrationHook,
    )
    .expect("deleted staging means committed");

    assert!(!dsh_home.join(".credentials.yaml").exists());
    assert!(!journal_path(&channel_root).exists());
    assert_eq!(store.get("TOKEN").as_deref(), Some(b"secret".as_slice()));
}

#[derive(Clone, Default)]
struct WriteThenFailStore {
    inner: MemoryStore,
    fail_once: Arc<Mutex<bool>>,
}

impl MigrationStore for WriteThenFailStore {
    fn resolve(
        &self,
        account: &CredentialAccount,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, MigrationStoreError> {
        self.inner.resolve(account)
    }

    fn set_migration_owned(
        &self,
        account: &CredentialAccount,
        secret: &[u8],
        transaction_id: Uuid,
    ) -> Result<(), MigrationStoreError> {
        self.inner
            .set_migration_owned(account, secret, transaction_id)?;
        let mut fail = self.fail_once.lock().expect("write failure state");
        if !*fail {
            *fail = true;
            return Err(MigrationStoreError::unavailable());
        }
        Ok(())
    }

    fn delete_if_migration_owned(
        &self,
        account: &CredentialAccount,
        expected_secret: &[u8],
        transaction_id: Uuid,
    ) -> Result<MigrationDeleteOutcome, MigrationStoreError> {
        self.inner
            .delete_if_migration_owned(account, expected_secret, transaction_id)
    }
}

#[test]
fn partial_keychain_write_is_removed_before_retry() {
    let (_root, channel_root, dsh_home) = fixture();
    write_legacy(&dsh_home, b"TOKEN: secret\n");
    let store = WriteThenFailStore::default();

    assert!(prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook,).is_err());
    assert_eq!(
        store.inner.get("TOKEN").as_deref(),
        Some(b"secret".as_slice())
    );

    let outcome = prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
        .expect("partial write recovery retries");
    let transaction_id = outcome.transaction_id().expect("transaction");
    rollback_migration(
        &channel_root,
        &dsh_home,
        transaction_id,
        &store,
        &mut NoopMigrationHook,
    )
    .expect("first rollback");
    rollback_migration(
        &channel_root,
        &dsh_home,
        transaction_id,
        &store,
        &mut NoopMigrationHook,
    )
    .expect("idempotent second rollback");
    assert_eq!(store.inner.get("TOKEN"), None);
}

#[test]
fn read_only_fallback_reads_the_authoritative_legacy_file_on_every_resolve() {
    let (_root, channel_root, dsh_home) = fixture();
    write_legacy(&dsh_home, b"TOKEN: legacy-authority\n");
    let source =
        ReadOnlyLegacySource::new(&channel_root, &dsh_home).expect("read-only legacy source");
    let account = CredentialAccount::new("TOKEN").expect("account");

    assert_eq!(
        source
            .resolve(&account)
            .expect("first legacy resolve")
            .expect("first legacy value")
            .as_slice(),
        b"legacy-authority"
    );

    write_legacy(&dsh_home, b"TOKEN: rotated-legacy\n");
    assert_eq!(
        source
            .resolve(&account)
            .expect("second legacy resolve")
            .expect("second legacy value")
            .as_slice(),
        b"rotated-legacy"
    );
    assert!(source
        .resolve(&CredentialAccount::new("MISSING").expect("missing account"))
        .expect("missing legacy resolve")
        .is_none());
}

#[test]
fn read_only_fallback_uses_intact_legacy_authority_despite_a_malformed_journal() {
    let (_root, channel_root, dsh_home) = fixture();
    write_legacy(&dsh_home, b"TOKEN: legacy-authority\n");
    fs::write(journal_path(&channel_root), b"{not-json").expect("malformed journal");
    fs::set_permissions(
        journal_path(&channel_root),
        fs::Permissions::from_mode(0o600),
    )
    .expect("journal permissions");
    let source =
        ReadOnlyLegacySource::new(&channel_root, &dsh_home).expect("read-only legacy source");
    let account = CredentialAccount::new("TOKEN").expect("account");

    assert_eq!(
        source
            .resolve(&account)
            .expect("legacy resolve")
            .expect("legacy value")
            .as_slice(),
        b"legacy-authority"
    );
}

struct ReplacingFilesystem {
    source: std::path::PathBuf,
    replaced: bool,
}

struct InPlaceModifyingFilesystem {
    source: std::path::PathBuf,
}

struct FailingBeforeStageFilesystem;

impl MigrationFilesystem for FailingBeforeStageFilesystem {
    fn expected_owner(&self) -> u32 {
        unsafe { libc::geteuid() }
    }

    fn before_source_stage(&mut self) -> Result<(), MigrationStoreError> {
        Err(MigrationStoreError::injected_crash())
    }
}

#[test]
fn source_stage_precheck_failure_rolls_back_owned_keys_without_moving_legacy() {
    let (_root, channel_root, dsh_home) = fixture();
    write_legacy(&dsh_home, b"TOKEN: original\n");
    let store = MemoryStore::default();

    let error = prepare_migration_with_filesystem(
        &channel_root,
        &dsh_home,
        &store,
        &mut FailingBeforeStageFilesystem,
        &mut NoopMigrationHook,
    )
    .expect_err("source stage precheck failure");

    assert!(error.is_injected_crash());
    assert_eq!(
        fs::read_to_string(dsh_home.join(".credentials.yaml")).expect("authoritative legacy file"),
        "TOKEN: original\n"
    );
    assert_eq!(store.get("TOKEN"), None);
    assert!(!journal_path(&channel_root).exists());
}

impl MigrationFilesystem for InPlaceModifyingFilesystem {
    fn expected_owner(&self) -> u32 {
        unsafe { libc::geteuid() }
    }

    fn before_source_stage(&mut self) -> Result<(), MigrationStoreError> {
        fs::write(&self.source, b"TOKEN: modified-in-place\n").expect("modify source in place");
        Ok(())
    }
}

#[test]
fn in_place_source_modification_before_stage_aborts_without_moving_authority() {
    let (_root, channel_root, dsh_home) = fixture();
    write_legacy(&dsh_home, b"TOKEN: original\n");
    let store = MemoryStore::default();
    let mut filesystem = InPlaceModifyingFilesystem {
        source: dsh_home.join(".credentials.yaml"),
    };

    let error = prepare_migration_with_filesystem(
        &channel_root,
        &dsh_home,
        &store,
        &mut filesystem,
        &mut NoopMigrationHook,
    )
    .expect_err("in-place source modification");

    assert!(error.to_string().contains("identity changed"));
    assert_eq!(
        fs::read_to_string(dsh_home.join(".credentials.yaml")).expect("authoritative legacy file"),
        "TOKEN: modified-in-place\n"
    );
    assert!(fs::read_dir(&dsh_home)
        .expect("DSH_HOME")
        .all(|entry| !entry
            .expect("directory entry")
            .file_name()
            .to_string_lossy()
            .starts_with(".credentials-migration-")));
    assert_eq!(store.get("TOKEN"), None);
    assert!(!journal_path(&channel_root).exists());
}

impl MigrationFilesystem for ReplacingFilesystem {
    fn expected_owner(&self) -> u32 {
        unsafe { libc::geteuid() }
    }

    fn before_source_revalidation(&mut self) -> Result<(), MigrationStoreError> {
        if !self.replaced {
            let displaced = self.source.with_extension("displaced");
            fs::rename(&self.source, displaced).expect("displace source");
            fs::write(&self.source, b"TOKEN: replacement\n").expect("replacement source");
            fs::set_permissions(&self.source, fs::Permissions::from_mode(0o600))
                .expect("replacement permissions");
            self.replaced = true;
        }
        Ok(())
    }
}

#[test]
fn source_replacement_aborts_and_removes_only_the_transaction_value() {
    let (_root, channel_root, dsh_home) = fixture();
    write_legacy(&dsh_home, b"TOKEN: original\n");
    let store = MemoryStore::default();
    let mut filesystem = ReplacingFilesystem {
        source: dsh_home.join(".credentials.yaml"),
        replaced: false,
    };

    let error = prepare_migration_with_filesystem(
        &channel_root,
        &dsh_home,
        &store,
        &mut filesystem,
        &mut NoopMigrationHook,
    )
    .expect_err("replacement");

    assert!(error.to_string().contains("identity changed"));
    assert_eq!(store.get("TOKEN"), None);
    assert_eq!(
        fs::read_to_string(dsh_home.join(".credentials.yaml")).expect("replacement source"),
        "TOKEN: replacement\n"
    );
    assert!(!journal_path(&channel_root).exists());
}

struct WrongOwnerFilesystem;

impl MigrationFilesystem for WrongOwnerFilesystem {
    fn expected_owner(&self) -> u32 {
        unsafe { libc::geteuid() }.wrapping_add(1)
    }
}

#[test]
fn injected_filesystem_owner_policy_rejects_the_source_without_reading_values() {
    let (_root, channel_root, dsh_home) = fixture();
    write_legacy(&dsh_home, b"TOKEN: owner-secret\n");

    let error = prepare_migration_with_filesystem(
        &channel_root,
        &dsh_home,
        &MemoryStore::default(),
        &mut WrongOwnerFilesystem,
        &mut NoopMigrationHook,
    )
    .expect_err("wrong source owner");

    assert!(error.to_string().contains("ownership"));
    assert!(!error.to_string().contains("owner-secret"));
    assert!(!journal_path(&channel_root).exists());
}

#[test]
fn preexisting_and_external_keychain_values_are_never_overwritten_or_deleted() {
    let (_root, channel_root, dsh_home) = fixture();
    write_legacy(
        &dsh_home,
        b"PREEXISTING_TOKEN: same\nCREATED_TOKEN: created\n",
    );
    let store = MemoryStore::seeded(&[("PREEXISTING_TOKEN", b"same")]);

    let outcome = prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
        .expect("matching pre-existing value");
    let transaction_id = outcome.transaction_id().expect("transaction");
    let journal = read_journal(&channel_root);
    assert_eq!(journal.pre_existing_refs, vec!["PREEXISTING_TOKEN"]);
    assert_eq!(journal.transaction_created_refs, vec!["CREATED_TOKEN"]);

    store.external_set("CREATED_TOKEN", b"external-change");
    rollback_migration(
        &channel_root,
        &dsh_home,
        transaction_id,
        &store,
        &mut NoopMigrationHook,
    )
    .expect("conditional rollback");

    assert_eq!(
        store.get("PREEXISTING_TOKEN").as_deref(),
        Some(b"same".as_slice())
    );
    assert_eq!(
        store.get("CREATED_TOKEN").as_deref(),
        Some(b"external-change".as_slice())
    );

    write_legacy(&dsh_home, b"PREEXISTING_TOKEN: legacy\n");
    let conflict = prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
        .expect_err("different pre-existing value must abort");
    assert!(conflict.to_string().contains("conflict"));
    assert!(!conflict.to_string().contains("legacy"));
    assert_eq!(
        store.get("PREEXISTING_TOKEN").as_deref(),
        Some(b"same".as_slice())
    );
}

#[derive(Clone, Default)]
struct ReplaceBetweenResolveAndDeleteStore {
    inner: MemoryStore,
    replace_on_resolve: Arc<Mutex<bool>>,
}

impl MigrationStore for ReplaceBetweenResolveAndDeleteStore {
    fn resolve(
        &self,
        account: &CredentialAccount,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, MigrationStoreError> {
        self.inner.resolve(account)
    }

    fn set_migration_owned(
        &self,
        account: &CredentialAccount,
        secret: &[u8],
        transaction_id: Uuid,
    ) -> Result<(), MigrationStoreError> {
        self.inner
            .set_migration_owned(account, secret, transaction_id)
    }

    fn delete_if_migration_owned(
        &self,
        account: &CredentialAccount,
        expected_secret: &[u8],
        transaction_id: Uuid,
    ) -> Result<MigrationDeleteOutcome, MigrationStoreError> {
        let mut replace = self.replace_on_resolve.lock().expect("replacement gate");
        if *replace {
            self.inner.external_set("TOKEN", b"external-replacement");
            *replace = false;
        }
        self.inner
            .delete_if_migration_owned(account, expected_secret, transaction_id)
    }
}

#[test]
fn rollback_never_deletes_a_replacement_racing_between_ownership_check_and_delete() {
    let (_root, channel_root, dsh_home) = fixture();
    write_legacy(&dsh_home, b"TOKEN: secret\n");
    let store = ReplaceBetweenResolveAndDeleteStore::default();
    let outcome = prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
        .expect("migration");
    let transaction_id = outcome.transaction_id().expect("transaction");
    *store.replace_on_resolve.lock().expect("replacement gate") = true;

    rollback_migration(
        &channel_root,
        &dsh_home,
        transaction_id,
        &store,
        &mut NoopMigrationHook,
    )
    .expect("fail-preserving rollback");

    assert_eq!(
        store.inner.get("TOKEN").as_deref(),
        Some(b"external-replacement".as_slice())
    );
}

#[test]
fn rollback_preserves_a_replacement_that_retains_the_migration_marker() {
    let (_root, channel_root, dsh_home) = fixture();
    write_legacy(&dsh_home, b"TOKEN: migration-secret\n");
    let store = MemoryStore::default();
    let outcome = prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
        .expect("migration");
    let transaction_id = outcome.transaction_id().expect("transaction");
    store.external_set_preserving_owner("TOKEN", b"external-replacement");

    let rollback = rollback_migration(
        &channel_root,
        &dsh_home,
        transaction_id,
        &store,
        &mut NoopMigrationHook,
    )
    .expect("replacement with retained marker must be preserved");

    assert_eq!(rollback, MigrationRollbackStatus::PreservedConflict);
    assert_eq!(
        store.get("TOKEN").as_deref(),
        Some(b"external-replacement".as_slice())
    );
    assert!(dsh_home.join(".credentials.yaml").is_file());
    assert!(journal_path(&channel_root).is_file());
}

#[test]
fn strict_yaml_rejects_duplicates_malformed_nodes_aliases_tags_and_oversized_secrets() {
    let cases = [
        ("duplicate", b"TOKEN: first\nTOKEN: second\n".as_slice()),
        ("sequence", b"TOKEN:\n  - value\n".as_slice()),
        ("number", b"TOKEN: 123\n".as_slice()),
        (
            "alias",
            b"TOKEN: &secret value\nOTHER: *secret\n".as_slice(),
        ),
        ("tag", b"TOKEN: !secret value\n".as_slice()),
        ("malformed", b"TOKEN: [unterminated\n".as_slice()),
        ("bad reference", b"not-valid: value\n".as_slice()),
        ("empty", b"TOKEN: \"\"\n".as_slice()),
    ];
    for (label, yaml) in cases {
        let (_root, channel_root, dsh_home) = fixture();
        write_legacy(&dsh_home, yaml);
        let error = prepare_migration(
            &channel_root,
            &dsh_home,
            &MemoryStore::default(),
            &mut NoopMigrationHook,
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("legacy credential"),
            "{label}: {error}"
        );
        assert!(dsh_home.join(".credentials.yaml").exists(), "{label}");
    }

    let (_root, channel_root, dsh_home) = fixture();
    let oversized = format!("TOKEN: {}\n", "x".repeat(MAX_SECRET_BYTES + 1));
    write_legacy(&dsh_home, oversized.as_bytes());
    assert!(prepare_migration(
        &channel_root,
        &dsh_home,
        &MemoryStore::default(),
        &mut NoopMigrationHook,
    )
    .is_err());
}

#[test]
fn source_requires_regular_owner_only_stable_identity() {
    let (_root, channel_root, dsh_home) = fixture();
    let source = dsh_home.join(".credentials.yaml");

    fs::create_dir(&source).expect("directory source");
    assert!(prepare_migration(
        &channel_root,
        &dsh_home,
        &MemoryStore::default(),
        &mut NoopMigrationHook,
    )
    .is_err());
    fs::remove_dir(&source).expect("remove directory source");

    let outside = dsh_home
        .parent()
        .expect("channel root")
        .join("outside.yaml");
    fs::write(&outside, b"TOKEN: value\n").expect("outside source");
    symlink(&outside, &source).expect("symlink source");
    assert!(prepare_migration(
        &channel_root,
        &dsh_home,
        &MemoryStore::default(),
        &mut NoopMigrationHook,
    )
    .is_err());
    fs::remove_file(&source).expect("remove symlink source");

    write_legacy(&dsh_home, b"TOKEN: value\n");
    fs::set_permissions(&source, fs::Permissions::from_mode(0o640))
        .expect("unsafe source permissions");
    assert!(prepare_migration(
        &channel_root,
        &dsh_home,
        &MemoryStore::default(),
        &mut NoopMigrationHook,
    )
    .is_err());
}

#[test]
fn real_keychain_rollback_preserves_an_indeterminate_canonical_item() {
    let (_root, channel_root, dsh_home) = fixture();
    let reference = format!(
        "OPENLOOP_MIGRATION_TEST_{}_{}",
        process_id(),
        Uuid::new_v4().simple()
    );
    let yaml = format!("{reference}: integration-secret\n");
    write_legacy(&dsh_home, yaml.as_bytes());
    let store = KeychainStore::new(ReleaseChannel::Test);
    let account = CredentialAccount::new(&reference).expect("test account");
    store.delete(&account).expect("pre-test cleanup");

    let outcome = prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
        .expect("real Keychain migration");
    let transaction_id = outcome.transaction_id().expect("transaction");
    assert_eq!(
        store
            .resolve(&account)
            .expect("resolve migrated")
            .as_slice(),
        b"integration-secret"
    );

    let rollback = rollback_migration(
        &channel_root,
        &dsh_home,
        transaction_id,
        &store,
        &mut NoopMigrationHook,
    )
    .expect("real Keychain rollback must preserve indeterminate ownership");
    assert_eq!(rollback, MigrationRollbackStatus::PreservedConflict);
    assert_eq!(
        store
            .resolve(&account)
            .expect("preserved Keychain item")
            .as_slice(),
        b"integration-secret"
    );
    assert!(dsh_home.join(".credentials.yaml").is_file());
    assert!(journal_path(&channel_root).is_file());
    store.delete(&account).expect("explicit post-test cleanup");
    rollback_migration(
        &channel_root,
        &dsh_home,
        transaction_id,
        &store,
        &mut NoopMigrationHook,
    )
    .expect("rollback after explicit Keychain cleanup");
    assert!(dsh_home.join(".credentials.yaml").is_file());
    assert!(!journal_path(&channel_root).exists());
    assert!(store
        .resolve_optional(&account)
        .expect("post-retry Keychain state")
        .is_none());
}

#[test]
fn real_keychain_user_replacement_clears_migration_ownership_before_rollback() {
    let (_root, channel_root, dsh_home) = fixture();
    let reference = format!(
        "OPENLOOP_MIGRATION_REPLACE_TEST_{}_{}",
        process_id(),
        Uuid::new_v4().simple()
    );
    write_legacy(
        &dsh_home,
        format!("{reference}: migration-secret\n").as_bytes(),
    );
    let store = KeychainStore::new(ReleaseChannel::Test);
    let account = CredentialAccount::new(&reference).expect("test account");
    store.delete(&account).expect("pre-test cleanup");

    let outcome = prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
        .expect("real Keychain migration");
    let transaction_id = outcome.transaction_id().expect("transaction");
    store
        .set(&account, b"user-replacement")
        .expect("user replacement");

    rollback_migration(
        &channel_root,
        &dsh_home,
        transaction_id,
        &store,
        &mut NoopMigrationHook,
    )
    .expect("ownership-aware rollback");

    assert_eq!(
        store
            .resolve(&account)
            .expect("user replacement remains")
            .as_slice(),
        b"user-replacement"
    );
    store.delete(&account).expect("post-test cleanup");
}

struct KeychainItemCleanup {
    store: KeychainStore,
    account: CredentialAccount,
}

impl Drop for KeychainItemCleanup {
    fn drop(&mut self) {
        let _ = self.store.delete(&self.account);
    }
}

#[test]
fn preserved_real_keychain_rollback_finishes_update_recovery_in_read_only_mode() {
    let (root, channel_root, dsh_home) = fixture();
    let reference = format!(
        "OPENLOOP_UPDATE_ROLLBACK_TEST_{}_{}",
        process_id(),
        Uuid::new_v4().simple()
    );
    write_legacy(
        &dsh_home,
        format!("{reference}: externally-visible-secret\n").as_bytes(),
    );
    let store = KeychainStore::new(ReleaseChannel::Test);
    let account = CredentialAccount::new(&reference).expect("test account");
    store.delete(&account).expect("pre-test cleanup");
    let _cleanup = KeychainItemCleanup {
        store,
        account: account.clone(),
    };
    let installed = root.path().join("Openloop.app");
    let candidate = root.path().join("Candidate.app");
    app_bundle(&installed, "old");
    app_bundle(&candidate, "candidate");

    let plan =
        plan_migration(&channel_root, &dsh_home, &mut NoopMigrationHook).expect("migration plan");
    let migration_id = plan.transaction_id().expect("planned migration");
    let transaction = RecoveryTransaction::open(root.path(), &installed, &candidate)
        .expect("update transaction")
        .prepare(Some(migration_id))
        .expect("durable update ownership");
    let migration = prepare_migration_with_transaction_id(
        &channel_root,
        &dsh_home,
        &store,
        migration_id,
        &mut NoopMigrationHook,
    )
    .expect("real Keychain migration");
    assert_eq!(migration, MigrationOutcome::PendingHealth(migration_id));
    let mut health = FixedHealth(HealthStatus::Failed("candidate failed".to_owned()));
    let mut companion = MigrationCompanion {
        channel_root: &channel_root,
        dsh_home: &dsh_home,
        transaction_id: migration_id,
        store: &store,
    };

    let outcome = transaction
        .publish_with_companion(&mut health, &mut companion)
        .expect("preserved Keychain rollback still completes app recovery");

    assert!(matches!(outcome, PublicationOutcome::RolledBack { .. }));
    assert_eq!(
        fs::read_to_string(installed.join("marker")).expect("installed marker"),
        "old"
    );
    assert!(dsh_home.join(".credentials.yaml").is_file());
    assert!(journal_path(&channel_root).is_file());
    assert!(!update_journal_path(root.path()).exists());
    assert_eq!(
        store
            .resolve(&account)
            .expect("preserved external Keychain value")
            .as_slice(),
        b"externally-visible-secret"
    );
    assert_eq!(
        prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
            .expect("subsequent startup uses legacy credentials read-only"),
        MigrationOutcome::ReadOnlyLegacy
    );
}

fn process_id() -> u32 {
    std::process::id()
}

struct FixedHealth(HealthStatus);

impl CandidateHealth for FixedHealth {
    fn await_health(&mut self, _: &Path, _: Duration) -> HealthStatus {
        self.0.clone()
    }
}

struct MigrationCompanion<'a, S> {
    channel_root: &'a Path,
    dsh_home: &'a Path,
    transaction_id: Uuid,
    store: &'a S,
}

impl<S: MigrationStore> PublicationCompanion for MigrationCompanion<'_, S> {
    fn commit(&mut self) -> Result<(), String> {
        commit_migration(
            self.channel_root,
            self.dsh_home,
            self.transaction_id,
            &mut NoopMigrationHook,
        )
        .map_err(|error| error.to_string())
    }

    fn rollback(&mut self) -> Result<(), String> {
        rollback_migration(
            self.channel_root,
            self.dsh_home,
            self.transaction_id,
            self.store,
            &mut NoopMigrationHook,
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    }
}

fn app_bundle(path: &Path, marker: &str) {
    fs::create_dir(path).expect("app bundle");
    fs::write(path.join("marker"), marker).expect("app marker");
}

struct DurableOwnershipHook<'a> {
    update_root: &'a Path,
    migration_id: Uuid,
    observed_first_write: bool,
}

impl MigrationHook for DurableOwnershipHook<'_> {
    fn reached(&mut self, boundary: MigrationBoundary) -> Result<(), MigrationStoreError> {
        if matches!(boundary, MigrationBoundary::BeforeKeychainWrite { .. }) {
            let journal = fs::read_to_string(update_journal_path(self.update_root))
                .expect("durable update journal before Keychain write");
            assert!(journal.contains("\"state\":\"prepared\""));
            assert!(journal.contains(&format!(
                "\"migrationTransactionId\":\"{}\"",
                self.migration_id
            )));
            self.observed_first_write = true;
        }
        Ok(())
    }
}

#[test]
fn update_ownership_is_durable_before_planned_migration_writes() {
    let (root, channel_root, dsh_home) = fixture();
    write_legacy(&dsh_home, b"TOKEN: migration-secret\n");
    let store = MemoryStore::default();
    let installed = root.path().join("Openloop.app");
    let candidate = root.path().join("Candidate.app");
    app_bundle(&installed, "old");
    app_bundle(&candidate, "candidate");

    let plan =
        plan_migration(&channel_root, &dsh_home, &mut NoopMigrationHook).expect("migration plan");
    let migration_id = plan.transaction_id().expect("planned migration");
    assert_eq!(
        read_journal(&channel_root).state,
        MigrationState::Discovered
    );
    assert_eq!(store.get("TOKEN"), None);
    assert!(dsh_home.join(".credentials.yaml").is_file());

    let transaction = RecoveryTransaction::open(root.path(), &installed, &candidate)
        .expect("update transaction")
        .prepare(Some(migration_id))
        .expect("durable update ownership");
    let update_journal =
        fs::read_to_string(update_journal_path(root.path())).expect("update journal");
    assert!(update_journal.contains(&migration_id.to_string()));
    assert_eq!(store.get("TOKEN"), None);
    assert_eq!(
        read_journal(&channel_root).state,
        MigrationState::Discovered
    );

    let mut migration_hook = DurableOwnershipHook {
        update_root: root.path(),
        migration_id,
        observed_first_write: false,
    };
    let migration = prepare_migration_with_transaction_id(
        &channel_root,
        &dsh_home,
        &store,
        migration_id,
        &mut migration_hook,
    )
    .expect("apply planned migration");
    assert!(migration_hook.observed_first_write);
    assert_eq!(migration, MigrationOutcome::PendingHealth(migration_id));
    assert_eq!(
        store.get("TOKEN").as_deref(),
        Some(b"migration-secret".as_slice())
    );

    let mut health = FixedHealth(HealthStatus::Failed("candidate failed".to_owned()));
    let mut companion = MigrationCompanion {
        channel_root: &channel_root,
        dsh_home: &dsh_home,
        transaction_id: migration_id,
        store: &store,
    };
    let outcome = transaction
        .publish_with_companion(&mut health, &mut companion)
        .expect("rollback update and migration");

    assert!(matches!(outcome, PublicationOutcome::RolledBack { .. }));
    assert_eq!(store.get("TOKEN"), None);
    assert!(dsh_home.join(".credentials.yaml").is_file());
    assert!(!journal_path(&channel_root).exists());
    assert!(!update_journal_path(root.path()).exists());
}

#[test]
fn prepared_update_without_a_migration_journal_recovers_with_real_companion() {
    let (root, channel_root, dsh_home) = fixture();
    let store = MemoryStore::default();
    let installed = root.path().join("Openloop.app");
    let candidate = root.path().join("Candidate.app");
    app_bundle(&installed, "old");
    app_bundle(&candidate, "candidate");
    let migration_id = Uuid::new_v4();
    RecoveryTransaction::open(root.path(), &installed, &candidate)
        .expect("update transaction")
        .prepare(Some(migration_id))
        .expect("durable update ownership");
    assert!(!journal_path(&channel_root).exists());
    let mut companion = MigrationCompanion {
        channel_root: &channel_root,
        dsh_home: &dsh_home,
        transaction_id: migration_id,
        store: &store,
    };

    recover_interrupted_update_with_bound_companion(root.path(), migration_id, &mut companion)
        .expect("recover prepared update without migration journal");

    assert_eq!(
        fs::read_to_string(installed.join("marker")).expect("installed marker"),
        "old"
    );
    assert_eq!(
        fs::read_to_string(candidate.join("marker")).expect("candidate marker"),
        "candidate"
    );
    assert!(!update_journal_path(root.path()).exists());
    assert!(!journal_path(&channel_root).exists());
}

#[test]
fn preserved_keychain_conflict_does_not_block_update_rollback_or_read_only_startup() {
    let (root, channel_root, dsh_home) = fixture();
    write_legacy(&dsh_home, b"TOKEN: migration-secret\n");
    let store = MemoryStore::default();
    let migration = prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
        .expect("candidate migration");
    let transaction_id = migration.transaction_id().expect("transaction");
    store.external_set_preserving_owner("TOKEN", b"external-replacement");

    let installed = root.path().join("Openloop.app");
    let candidate = root.path().join("Candidate.app");
    app_bundle(&installed, "old");
    app_bundle(&candidate, "candidate");
    let transaction = RecoveryTransaction::open(root.path(), &installed, &candidate)
        .expect("update transaction")
        .prepare(Some(transaction_id))
        .expect("durable update ownership");
    let mut health = FixedHealth(HealthStatus::Failed("candidate failed".to_owned()));
    let mut companion = MigrationCompanion {
        channel_root: &channel_root,
        dsh_home: &dsh_home,
        transaction_id,
        store: &store,
    };

    let outcome = transaction
        .publish_with_companion(&mut health, &mut companion)
        .expect("fail-preserving update rollback");

    assert!(matches!(outcome, PublicationOutcome::RolledBack { .. }));
    assert_eq!(
        fs::read_to_string(installed.join("marker")).expect("installed marker"),
        "old"
    );
    assert!(dsh_home.join(".credentials.yaml").is_file());
    assert!(journal_path(&channel_root).is_file());
    assert!(!update_journal_path(root.path()).exists());
    assert_eq!(
        store.get("TOKEN").as_deref(),
        Some(b"external-replacement".as_slice())
    );
    assert_eq!(
        prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook,)
            .expect("read-only startup"),
        MigrationOutcome::ReadOnlyLegacy
    );
}

#[test]
fn candidate_health_failures_restore_app_legacy_file_and_only_created_keys() {
    for component in ["Host", "sidecar", "Bridge", "data-version", "main-WebView"] {
        let (root, channel_root, dsh_home) = fixture();
        write_legacy(
            &dsh_home,
            b"PREEXISTING_TOKEN: same\nCREATED_TOKEN: created\n",
        );
        let store = MemoryStore::seeded(&[("PREEXISTING_TOKEN", b"same")]);
        let migration = prepare_migration(&channel_root, &dsh_home, &store, &mut NoopMigrationHook)
            .expect("candidate migration");
        let transaction_id = migration.transaction_id().expect("transaction");
        let installed = root.path().join("Openloop.app");
        let candidate = root.path().join("Candidate.app");
        app_bundle(&installed, "old");
        app_bundle(&candidate, "candidate");
        let transaction = RecoveryTransaction::open(root.path(), &installed, &candidate)
            .expect("update recovery transaction")
            .prepare(Some(transaction_id))
            .expect("durable migration-bound update transaction");
        let mut health = FixedHealth(HealthStatus::Failed(format!("{component} failed")));
        let mut companion = MigrationCompanion {
            channel_root: &channel_root,
            dsh_home: &dsh_home,
            transaction_id,
            store: &store,
        };

        let outcome = transaction
            .publish_with_companion(&mut health, &mut companion)
            .expect("candidate and migration rollback");

        assert!(matches!(outcome, PublicationOutcome::RolledBack { .. }));
        assert_eq!(
            fs::read_to_string(installed.join("marker")).expect("installed marker"),
            "old"
        );
        assert!(dsh_home.join(".credentials.yaml").is_file());
        assert!(!staged_path(&dsh_home, transaction_id).exists());
        assert_eq!(
            store.get("PREEXISTING_TOKEN").as_deref(),
            Some(b"same".as_slice())
        );
        assert_eq!(store.get("CREATED_TOKEN"), None);
    }
}
