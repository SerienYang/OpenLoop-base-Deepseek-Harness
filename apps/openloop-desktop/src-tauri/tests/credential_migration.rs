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
            commit_migration, journal_path, prepare_migration, prepare_migration_with_filesystem,
            rollback_migration, staged_path, Journal, MigrationBoundary, MigrationFilesystem,
            MigrationHook, MigrationOutcome, MigrationState, MigrationStore, MigrationStoreError,
            NoopMigrationHook, PreviousValue, ReferenceState,
        },
        CredentialAccount, KeychainStore, MAX_SECRET_BYTES,
    },
    update::{
        channel::ReleaseChannel,
        recovery::{
            CandidateHealth, HealthStatus, PublicationCompanion, PublicationOutcome,
            RecoveryTransaction,
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

    fn set(&self, account: &CredentialAccount, secret: &[u8]) -> Result<(), MigrationStoreError> {
        self.values.lock().expect("memory store").insert(
            account
                .as_str()
                .trim_start_matches("credential:")
                .to_owned(),
            secret.to_vec(),
        );
        Ok(())
    }

    fn delete(&self, account: &CredentialAccount) -> Result<(), MigrationStoreError> {
        self.values
            .lock()
            .expect("memory store")
            .remove(account.as_str().trim_start_matches("credential:"));
        Ok(())
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
        assert!(commit_migration(&channel_root, &dsh_home, transaction_id, &mut crash,).is_err());
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

    fn set(&self, account: &CredentialAccount, secret: &[u8]) -> Result<(), MigrationStoreError> {
        self.inner.set(account, secret)?;
        let mut fail = self.fail_once.lock().expect("write failure state");
        if !*fail {
            *fail = true;
            return Err(MigrationStoreError::unavailable());
        }
        Ok(())
    }

    fn delete(&self, account: &CredentialAccount) -> Result<(), MigrationStoreError> {
        self.inner.delete(account)
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

struct ReplacingFilesystem {
    source: std::path::PathBuf,
    replaced: bool,
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
fn real_test_channel_keychain_migration_is_isolated_and_cleanup_safe() {
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

    rollback_migration(
        &channel_root,
        &dsh_home,
        transaction_id,
        &store,
        &mut NoopMigrationHook,
    )
    .expect("real Keychain rollback");
    assert!(store
        .resolve_optional(&account)
        .expect("post rollback")
        .is_none());
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

struct MigrationCompanion<'a> {
    channel_root: &'a Path,
    dsh_home: &'a Path,
    transaction_id: Uuid,
    store: &'a MemoryStore,
}

impl PublicationCompanion for MigrationCompanion<'_> {
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
        .map_err(|error| error.to_string())
    }
}

fn app_bundle(path: &Path, marker: &str) {
    fs::create_dir(path).expect("app bundle");
    fs::write(path.join("marker"), marker).expect("app marker");
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
            .expect("update recovery transaction");
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
