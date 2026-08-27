use std::{
    collections::BTreeMap,
    error::Error,
    ffi::{CStr, CString, OsStr},
    fmt, fs,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Path, PathBuf},
};

use serde::{
    de::{MapAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

use super::{CredentialAccount, KeychainStore, MAX_SECRET_BYTES};

const LEGACY_FILE: &str = ".credentials.yaml";
const JOURNAL_FILE: &str = ".credentials-migration.json";
const MAX_LEGACY_FILE_BYTES: usize = 1024 * 1024;
const MAX_JOURNAL_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MigrationState {
    Discovered,
    WritingKeychain,
    KeychainVerified,
    LegacyStaged,
    CommitPrepared,
    Committed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReferenceState {
    Planned,
    Written,
    Verified,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PreviousValue {
    Absent,
    PreExisting,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceIdentity {
    pub device: u64,
    pub inode: u64,
    pub sha256: [u8; 32],
    pub mode: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferenceJournal {
    pub state: ReferenceState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<PreviousValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Journal {
    pub transaction_id: Uuid,
    pub source: SourceIdentity,
    pub references: BTreeMap<String, ReferenceJournal>,
    pub pre_existing_refs: Vec<String>,
    pub transaction_created_refs: Vec<String>,
    pub state: MigrationState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrationOutcome {
    NotNeeded,
    PendingHealth(Uuid),
    ReadOnlyLegacy,
}

impl MigrationOutcome {
    pub fn transaction_id(&self) -> Option<Uuid> {
        match self {
            Self::PendingHealth(transaction_id) => Some(*transaction_id),
            Self::NotNeeded | Self::ReadOnlyLegacy => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrationPlan {
    NotNeeded,
    Planned(Uuid),
}

impl MigrationPlan {
    pub fn transaction_id(&self) -> Option<Uuid> {
        match self {
            Self::Planned(transaction_id) => Some(*transaction_id),
            Self::NotNeeded => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrationBoundary {
    BeforeKeychainWrite {
        reference: String,
    },
    AfterKeychainWrite {
        reference: String,
    },
    BeforeJournalFileFsync {
        generation: u64,
        state: MigrationState,
        reference_state: Option<ReferenceState>,
    },
    AfterJournalFileFsync {
        generation: u64,
        state: MigrationState,
        reference_state: Option<ReferenceState>,
    },
    BeforeJournalParentFsync {
        generation: u64,
        state: MigrationState,
        reference_state: Option<ReferenceState>,
    },
    AfterJournalParentFsync {
        generation: u64,
        state: MigrationState,
        reference_state: Option<ReferenceState>,
    },
    BeforeStagedDelete,
    AfterStagedDelete,
    BeforeStagedDeleteParentFsync,
    AfterStagedDeleteParentFsync,
}

pub trait MigrationHook {
    fn reached(&mut self, boundary: MigrationBoundary) -> Result<(), MigrationStoreError>;
}

pub struct NoopMigrationHook;

impl MigrationHook for NoopMigrationHook {
    fn reached(&mut self, _: MigrationBoundary) -> Result<(), MigrationStoreError> {
        Ok(())
    }
}

pub trait MigrationFilesystem {
    fn expected_owner(&self) -> u32;

    fn before_source_revalidation(&mut self) -> Result<(), MigrationStoreError> {
        Ok(())
    }

    fn before_source_stage(&mut self) -> Result<(), MigrationStoreError> {
        Ok(())
    }
}

pub struct HostMigrationFilesystem;

impl MigrationFilesystem for HostMigrationFilesystem {
    fn expected_owner(&self) -> u32 {
        unsafe { libc::geteuid() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationStoreError {
    injected_crash: bool,
}

impl MigrationStoreError {
    pub fn unavailable() -> Self {
        Self {
            injected_crash: false,
        }
    }

    pub fn injected_crash() -> Self {
        Self {
            injected_crash: true,
        }
    }
}

impl fmt::Display for MigrationStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(if self.injected_crash {
            "injected migration crash"
        } else {
            "credential store operation failed"
        })
    }
}

impl Error for MigrationStoreError {}

pub trait MigrationStore {
    fn resolve(
        &self,
        account: &CredentialAccount,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, MigrationStoreError>;
    fn set_migration_owned(
        &self,
        account: &CredentialAccount,
        secret: &[u8],
        transaction_id: Uuid,
    ) -> Result<(), MigrationStoreError>;
    fn delete_if_migration_owned(
        &self,
        account: &CredentialAccount,
        expected_secret: &[u8],
        transaction_id: Uuid,
    ) -> Result<MigrationDeleteOutcome, MigrationStoreError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationDeleteOutcome {
    Deleted,
    NotOwned,
    PreservedIndeterminate,
}

impl MigrationStore for KeychainStore {
    fn resolve(
        &self,
        account: &CredentialAccount,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, MigrationStoreError> {
        self.resolve_optional(account)
            .map_err(|_| MigrationStoreError::unavailable())
    }

    fn set_migration_owned(
        &self,
        account: &CredentialAccount,
        secret: &[u8],
        transaction_id: Uuid,
    ) -> Result<(), MigrationStoreError> {
        self.set_migration_owned(account, secret, transaction_id)
            .map_err(|_| MigrationStoreError::unavailable())
    }

    fn delete_if_migration_owned(
        &self,
        account: &CredentialAccount,
        expected_secret: &[u8],
        transaction_id: Uuid,
    ) -> Result<MigrationDeleteOutcome, MigrationStoreError> {
        let current = self
            .resolve_migration_owned(account, transaction_id)
            .map_err(|_| MigrationStoreError::unavailable())?;
        let Some(current) = current else {
            return Ok(MigrationDeleteOutcome::NotOwned);
        };

        // Security.framework cannot bind SecItemDelete to kSecValueData. A
        // read followed by delete would race an external replacement, so the
        // canonical item is preserved for explicit user cleanup.
        if current.as_slice() != expected_secret {
            return Ok(MigrationDeleteOutcome::PreservedIndeterminate);
        }
        Ok(MigrationDeleteOutcome::PreservedIndeterminate)
    }
}

#[derive(Debug)]
pub enum MigrationError {
    Invalid(&'static str),
    Conflict(String),
    Io {
        operation: &'static str,
        source: io::Error,
    },
    Store(MigrationStoreError),
    Json(serde_json::Error),
    Yaml,
}

impl MigrationError {
    fn invalid(message: &'static str) -> Self {
        Self::Invalid(message)
    }

    fn io(operation: &'static str, source: io::Error) -> Self {
        Self::Io { operation, source }
    }

    pub fn is_injected_crash(&self) -> bool {
        matches!(self, Self::Store(error) if error.injected_crash)
    }
}

impl fmt::Display for MigrationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => formatter.write_str(message),
            Self::Conflict(reference) => {
                write!(
                    formatter,
                    "credential migration conflict for reference {reference}"
                )
            }
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
            Self::Store(source) => source.fmt(formatter),
            Self::Json(_) => formatter.write_str("credential migration journal is invalid"),
            Self::Yaml => formatter.write_str("legacy credential YAML is invalid"),
        }
    }
}

impl Error for MigrationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Store(source) => Some(source),
            Self::Json(source) => Some(source),
            Self::Invalid(_) | Self::Conflict(_) | Self::Yaml => None,
        }
    }
}

impl From<MigrationStoreError> for MigrationError {
    fn from(source: MigrationStoreError) -> Self {
        Self::Store(source)
    }
}

struct LegacyDocument {
    identity: SourceIdentity,
    values: BTreeMap<String, Zeroizing<Vec<u8>>>,
}

#[derive(Debug, Clone)]
pub struct ReadOnlyLegacySource {
    channel_root: PathBuf,
    dsh_home: PathBuf,
}

impl ReadOnlyLegacySource {
    pub fn new(channel_root: &Path, dsh_home: &Path) -> Result<Self, MigrationError> {
        SecureRoots::open(
            channel_root,
            dsh_home,
            HostMigrationFilesystem.expected_owner(),
        )?;
        Ok(Self {
            channel_root: channel_root.to_owned(),
            dsh_home: dsh_home.to_owned(),
        })
    }

    pub fn resolve(
        &self,
        account: &CredentialAccount,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, MigrationError> {
        let roots = SecureRoots::open(
            &self.channel_root,
            &self.dsh_home,
            HostMigrationFilesystem.expected_owner(),
        )?;
        let source_exists = roots.entry_exists(roots.dsh.as_raw_fd(), LEGACY_FILE)?;
        if source_exists {
            let document = roots.read_legacy(LEGACY_FILE)?.ok_or_else(|| {
                MigrationError::invalid("legacy credential authority disappeared")
            })?;
            return legacy_value(document, account);
        }
        let journal = roots.read_journal()?;
        let staged = journal
            .as_ref()
            .map(|value| staged_name(value.transaction_id));
        let staged_exists = staged
            .as_deref()
            .map(|name| roots.entry_exists(roots.dsh.as_raw_fd(), name))
            .transpose()?
            .unwrap_or(false);
        let authority = if staged_exists {
            staged
                .as_deref()
                .expect("staged authority name exists with journal")
        } else {
            return Ok(None);
        };
        let document = roots
            .read_legacy(authority)?
            .ok_or_else(|| MigrationError::invalid("legacy credential authority disappeared"))?;
        if let Some(journal) = journal.as_ref() {
            verify_source_identity(&document.identity, &journal.source)?;
        }
        legacy_value(document, account)
    }
}

fn legacy_value(
    mut document: LegacyDocument,
    account: &CredentialAccount,
) -> Result<Option<Zeroizing<Vec<u8>>>, MigrationError> {
    let reference = account
        .as_str()
        .strip_prefix("credential:")
        .ok_or_else(|| MigrationError::invalid("credential account is invalid"))?;
    Ok(document.values.remove(reference))
}

pub fn journal_path(channel_root: &Path) -> PathBuf {
    channel_root.join(JOURNAL_FILE)
}

pub fn staged_path(dsh_home: &Path, transaction_id: Uuid) -> PathBuf {
    dsh_home.join(staged_name(transaction_id))
}

pub fn prepare_migration(
    channel_root: &Path,
    dsh_home: &Path,
    store: &impl MigrationStore,
    hook: &mut impl MigrationHook,
) -> Result<MigrationOutcome, MigrationError> {
    prepare_migration_with_filesystem(
        channel_root,
        dsh_home,
        store,
        &mut HostMigrationFilesystem,
        hook,
    )
}

pub fn plan_migration(
    channel_root: &Path,
    dsh_home: &Path,
    hook: &mut impl MigrationHook,
) -> Result<MigrationPlan, MigrationError> {
    let roots = SecureRoots::open(
        channel_root,
        dsh_home,
        HostMigrationFilesystem.expected_owner(),
    )?;
    if let Some(journal) = roots.read_journal()? {
        if journal.state != MigrationState::Discovered {
            return Err(MigrationError::invalid(
                "credential migration is already in progress",
            ));
        }
        return Ok(MigrationPlan::Planned(journal.transaction_id));
    }
    let Some(document) = roots.read_legacy(LEGACY_FILE)? else {
        return Ok(MigrationPlan::NotNeeded);
    };
    let journal = discovered_journal(&document, Uuid::new_v4());
    roots.persist_journal(&journal, None, hook)?;
    Ok(MigrationPlan::Planned(journal.transaction_id))
}

pub fn prepare_migration_with_transaction_id(
    channel_root: &Path,
    dsh_home: &Path,
    store: &impl MigrationStore,
    transaction_id: Uuid,
    hook: &mut impl MigrationHook,
) -> Result<MigrationOutcome, MigrationError> {
    let roots = SecureRoots::open(
        channel_root,
        dsh_home,
        HostMigrationFilesystem.expected_owner(),
    )?;
    let journal = roots
        .read_journal()?
        .ok_or_else(|| MigrationError::invalid("planned credential migration disappeared"))?;
    if journal.transaction_id != transaction_id {
        return Err(MigrationError::invalid(
            "credential migration transaction identity changed",
        ));
    }
    if journal.state != MigrationState::Discovered {
        return Err(MigrationError::invalid(
            "planned credential migration is no longer pristine",
        ));
    }
    let document = roots
        .read_legacy(LEGACY_FILE)?
        .ok_or_else(|| MigrationError::invalid("legacy credential source disappeared"))?;
    verify_planned_document(&journal, &document)?;
    apply_migration_document(
        &roots,
        document,
        journal,
        store,
        &mut HostMigrationFilesystem,
        hook,
    )
}

pub fn prepare_migration_with_filesystem(
    channel_root: &Path,
    dsh_home: &Path,
    store: &impl MigrationStore,
    filesystem: &mut impl MigrationFilesystem,
    hook: &mut impl MigrationHook,
) -> Result<MigrationOutcome, MigrationError> {
    let roots = SecureRoots::open(channel_root, dsh_home, filesystem.expected_owner())?;
    if let Some(journal) = roots.read_journal()? {
        match journal.state {
            MigrationState::Committed => {
                let staged = staged_name(journal.transaction_id);
                if roots.entry_exists(roots.dsh.as_raw_fd(), &staged)? {
                    roots.remove_dsh_file(&staged)?;
                }
                roots.remove_journal()?;
                return Ok(MigrationOutcome::NotNeeded);
            }
            MigrationState::CommitPrepared => {
                if roots
                    .entry_exists(roots.dsh.as_raw_fd(), &staged_name(journal.transaction_id))?
                {
                    return Ok(MigrationOutcome::PendingHealth(journal.transaction_id));
                }
                finish_committed(&roots, journal, hook)?;
                return Ok(MigrationOutcome::NotNeeded);
            }
            MigrationState::LegacyStaged => {
                if roots
                    .entry_exists(roots.dsh.as_raw_fd(), &staged_name(journal.transaction_id))?
                {
                    return Ok(MigrationOutcome::PendingHealth(journal.transaction_id));
                }
                if roots.entry_exists(roots.dsh.as_raw_fd(), LEGACY_FILE)? {
                    rollback_loaded(&roots, &journal, store)?;
                } else {
                    finish_committed(&roots, journal, hook)?;
                    return Ok(MigrationOutcome::NotNeeded);
                }
            }
            MigrationState::KeychainVerified
                if !roots.entry_exists(roots.dsh.as_raw_fd(), LEGACY_FILE)?
                    && roots.entry_exists(
                        roots.dsh.as_raw_fd(),
                        &staged_name(journal.transaction_id),
                    )? =>
            {
                let mut resumed = journal;
                resumed.state = MigrationState::LegacyStaged;
                roots.persist_journal(&resumed, None, hook)?;
                return Ok(MigrationOutcome::PendingHealth(resumed.transaction_id));
            }
            _ => rollback_loaded(&roots, &journal, store)?,
        }
    }

    let Some(document) = roots.read_legacy(LEGACY_FILE)? else {
        return Ok(MigrationOutcome::NotNeeded);
    };
    migrate_document(&roots, document, store, filesystem, hook)
}

pub fn rollback_migration(
    channel_root: &Path,
    dsh_home: &Path,
    transaction_id: Uuid,
    store: &impl MigrationStore,
    hook: &mut impl MigrationHook,
) -> Result<(), MigrationError> {
    let roots = SecureRoots::open(
        channel_root,
        dsh_home,
        HostMigrationFilesystem.expected_owner(),
    )?;
    let Some(journal) = roots.read_journal()? else {
        return Ok(());
    };
    if journal.transaction_id != transaction_id {
        return Err(MigrationError::invalid(
            "credential migration transaction identity changed",
        ));
    }
    let source_exists = roots.entry_exists(roots.dsh.as_raw_fd(), LEGACY_FILE)?;
    let staged_exists =
        roots.entry_exists(roots.dsh.as_raw_fd(), &staged_name(journal.transaction_id))?;
    if !source_exists
        && !staged_exists
        && matches!(
            journal.state,
            MigrationState::LegacyStaged
                | MigrationState::CommitPrepared
                | MigrationState::Committed
        )
    {
        return finish_committed(&roots, journal, hook);
    }
    rollback_loaded(&roots, &journal, store)
}

pub fn commit_migration(
    channel_root: &Path,
    dsh_home: &Path,
    transaction_id: Uuid,
    hook: &mut impl MigrationHook,
) -> Result<(), MigrationError> {
    let roots = SecureRoots::open(
        channel_root,
        dsh_home,
        HostMigrationFilesystem.expected_owner(),
    )?;
    let Some(journal) = roots.read_journal()? else {
        return Ok(());
    };
    if journal.transaction_id != transaction_id {
        return Err(MigrationError::invalid(
            "credential migration transaction identity changed",
        ));
    }
    if journal.state == MigrationState::Committed {
        roots.remove_journal()?;
        return Ok(());
    }
    if !matches!(
        journal.state,
        MigrationState::LegacyStaged | MigrationState::CommitPrepared
    ) {
        return Err(MigrationError::invalid(
            "credential migration is not ready for health commit",
        ));
    }
    if roots.entry_exists(roots.dsh.as_raw_fd(), LEGACY_FILE)? {
        return Err(MigrationError::invalid(
            "legacy credential authority is still present at commit",
        ));
    }
    let staged = staged_name(transaction_id);
    if roots.entry_exists(roots.dsh.as_raw_fd(), &staged)? {
        let document = roots
            .read_legacy(&staged)?
            .ok_or_else(|| MigrationError::invalid("staged legacy credential file disappeared"))?;
        verify_source_identity(&document.identity, &journal.source)?;
        let mut prepared = journal;
        if prepared.state == MigrationState::LegacyStaged {
            prepared.state = MigrationState::CommitPrepared;
            roots.persist_journal(&prepared, None, hook)?;
        }
        hook.reached(MigrationBoundary::BeforeStagedDelete)?;
        roots.remove_required_file(roots.dsh.as_raw_fd(), &staged)?;
        if hook.reached(MigrationBoundary::AfterStagedDelete).is_err() {
            return Ok(());
        }
        if hook
            .reached(MigrationBoundary::BeforeStagedDeleteParentFsync)
            .is_err()
        {
            return Ok(());
        }
        if sync_directory(roots.dsh.as_raw_fd()).is_err() {
            return Ok(());
        }
        if hook
            .reached(MigrationBoundary::AfterStagedDeleteParentFsync)
            .is_err()
        {
            return Ok(());
        }
        let _ = finish_committed(&roots, prepared, hook);
        return Ok(());
    }
    finish_committed(&roots, journal, hook)
}

fn finish_committed(
    roots: &SecureRoots,
    mut journal: Journal,
    hook: &mut impl MigrationHook,
) -> Result<(), MigrationError> {
    journal.state = MigrationState::Committed;
    roots.persist_journal(&journal, None, hook)?;
    roots.remove_journal()
}

fn migrate_document(
    roots: &SecureRoots,
    document: LegacyDocument,
    store: &impl MigrationStore,
    filesystem: &mut impl MigrationFilesystem,
    hook: &mut impl MigrationHook,
) -> Result<MigrationOutcome, MigrationError> {
    let journal = discovered_journal(&document, Uuid::new_v4());
    roots.persist_journal(&journal, None, hook)?;
    apply_migration_document(roots, document, journal, store, filesystem, hook)
}

fn discovered_journal(document: &LegacyDocument, transaction_id: Uuid) -> Journal {
    Journal {
        transaction_id,
        source: document.identity,
        references: document
            .values
            .keys()
            .map(|reference| {
                (
                    reference.clone(),
                    ReferenceJournal {
                        state: ReferenceState::Planned,
                        previous: None,
                    },
                )
            })
            .collect(),
        pre_existing_refs: Vec::new(),
        transaction_created_refs: Vec::new(),
        state: MigrationState::Discovered,
    }
}

fn verify_planned_document(
    journal: &Journal,
    document: &LegacyDocument,
) -> Result<(), MigrationError> {
    verify_source_identity(&document.identity, &journal.source)?;
    if journal.references.keys().ne(document.values.keys())
        || journal.references.values().any(|reference| {
            reference.state != ReferenceState::Planned || reference.previous.is_some()
        })
        || !journal.pre_existing_refs.is_empty()
        || !journal.transaction_created_refs.is_empty()
    {
        return Err(MigrationError::invalid(
            "planned credential migration no longer matches its legacy source",
        ));
    }
    Ok(())
}

fn apply_migration_document(
    roots: &SecureRoots,
    document: LegacyDocument,
    mut journal: Journal,
    store: &impl MigrationStore,
    filesystem: &mut impl MigrationFilesystem,
    hook: &mut impl MigrationHook,
) -> Result<MigrationOutcome, MigrationError> {
    let transaction_id = journal.transaction_id;
    journal.state = MigrationState::WritingKeychain;
    roots.persist_journal(&journal, None, hook)?;

    for (reference, secret) in &document.values {
        let account = CredentialAccount::new(reference)
            .map_err(|_| MigrationError::invalid("legacy credential reference is invalid"))?;
        match store.resolve(&account)? {
            Some(existing) if existing.as_slice() == secret.as_slice() => {
                insert_sorted_unique(&mut journal.pre_existing_refs, reference);
                journal
                    .references
                    .get_mut(reference)
                    .expect("reference journal exists")
                    .previous = Some(PreviousValue::PreExisting);
                journal
                    .references
                    .get_mut(reference)
                    .expect("reference journal exists")
                    .state = ReferenceState::Verified;
                roots.persist_journal(&journal, Some(reference), hook)?;
            }
            Some(_) => {
                rollback_values(roots, &journal, &document, store)?;
                return Err(MigrationError::Conflict(reference.clone()));
            }
            None => {
                insert_sorted_unique(&mut journal.transaction_created_refs, reference);
                journal
                    .references
                    .get_mut(reference)
                    .expect("reference journal exists")
                    .previous = Some(PreviousValue::Absent);
                journal
                    .references
                    .get_mut(reference)
                    .expect("reference journal exists")
                    .state = ReferenceState::Planned;
                roots.persist_journal(&journal, Some(reference), hook)?;
                hook.reached(MigrationBoundary::BeforeKeychainWrite {
                    reference: reference.clone(),
                })?;
                store.set_migration_owned(&account, secret, transaction_id)?;
                hook.reached(MigrationBoundary::AfterKeychainWrite {
                    reference: reference.clone(),
                })?;
                journal
                    .references
                    .get_mut(reference)
                    .expect("reference journal exists")
                    .state = ReferenceState::Written;
                roots.persist_journal(&journal, Some(reference), hook)?;
                let verified = store
                    .resolve(&account)?
                    .is_some_and(|value| value.as_slice() == secret.as_slice());
                if !verified {
                    return Err(MigrationError::invalid(
                        "credential store verification failed",
                    ));
                }
                journal
                    .references
                    .get_mut(reference)
                    .expect("reference journal exists")
                    .state = ReferenceState::Verified;
                roots.persist_journal(&journal, Some(reference), hook)?;
            }
        }
    }

    journal.state = MigrationState::KeychainVerified;
    roots.persist_journal(&journal, None, hook)?;
    filesystem.before_source_revalidation()?;
    let current = roots
        .read_legacy(LEGACY_FILE)?
        .ok_or_else(|| MigrationError::invalid("legacy credential source disappeared"))?;
    if verify_source_identity(&current.identity, &document.identity).is_err() {
        rollback_values(roots, &journal, &document, store)?;
        return Err(MigrationError::invalid(
            "legacy credential source identity changed",
        ));
    }
    if let Err(error) = filesystem.before_source_stage() {
        rollback_values(roots, &journal, &document, store)?;
        return Err(error.into());
    }
    if let Err(error) = roots.stage_legacy(transaction_id, document.identity) {
        rollback_values(roots, &journal, &document, store)?;
        return Err(error);
    }
    journal.state = MigrationState::LegacyStaged;
    roots.persist_journal(&journal, None, hook)?;
    Ok(MigrationOutcome::PendingHealth(transaction_id))
}

fn rollback_loaded(
    roots: &SecureRoots,
    journal: &Journal,
    store: &impl MigrationStore,
) -> Result<(), MigrationError> {
    let source_exists = roots.entry_exists(roots.dsh.as_raw_fd(), LEGACY_FILE)?;
    let staged_name = staged_name(journal.transaction_id);
    let staged_exists = roots.entry_exists(roots.dsh.as_raw_fd(), &staged_name)?;
    if source_exists && staged_exists {
        return Err(MigrationError::invalid(
            "legacy credential authority is ambiguous",
        ));
    }
    let authority_name = if source_exists {
        LEGACY_FILE
    } else if staged_exists {
        &staged_name
    } else {
        return Err(MigrationError::invalid(
            "legacy credential authority is unavailable",
        ));
    };
    let document = roots
        .read_legacy(authority_name)?
        .ok_or_else(|| MigrationError::invalid("legacy credential authority disappeared"))?;
    verify_source_identity(&document.identity, &journal.source)?;
    if !source_exists {
        roots.restore_staged(journal.transaction_id, journal.source)?;
    }
    rollback_values(roots, journal, &document, store)
}

fn rollback_values(
    roots: &SecureRoots,
    journal: &Journal,
    document: &LegacyDocument,
    store: &impl MigrationStore,
) -> Result<(), MigrationError> {
    for reference in &journal.transaction_created_refs {
        let Some(secret) = document.values.get(reference) else {
            continue;
        };
        let account = CredentialAccount::new(reference)
            .map_err(|_| MigrationError::invalid("migration journal reference is invalid"))?;
        if store.delete_if_migration_owned(&account, secret, journal.transaction_id)?
            == MigrationDeleteOutcome::PreservedIndeterminate
        {
            return Err(MigrationError::Conflict(reference.clone()));
        }
    }
    roots.remove_journal()
}

fn insert_sorted_unique(values: &mut Vec<String>, value: &str) {
    match values.binary_search_by(|candidate| candidate.as_str().cmp(value)) {
        Ok(_) => {}
        Err(index) => values.insert(index, value.to_owned()),
    }
}

fn verify_source_identity(
    actual: &SourceIdentity,
    expected: &SourceIdentity,
) -> Result<(), MigrationError> {
    if actual != expected {
        return Err(MigrationError::invalid(
            "legacy credential source identity changed",
        ));
    }
    Ok(())
}

struct SecureRoots {
    channel: OwnedFd,
    dsh: OwnedFd,
    expected_owner: u32,
}

impl SecureRoots {
    fn open(
        channel_root: &Path,
        dsh_home: &Path,
        expected_owner: u32,
    ) -> Result<Self, MigrationError> {
        if !channel_root.is_absolute()
            || dsh_home != channel_root.join("dsh")
            || channel_root.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::CurDir | std::path::Component::ParentDir
                )
            })
        {
            return Err(MigrationError::invalid(
                "credential migration roots are invalid",
            ));
        }
        let channel_metadata = fs::symlink_metadata(channel_root)
            .map_err(|source| MigrationError::io("inspect channel root", source))?;
        if channel_metadata.file_type().is_symlink() || !channel_metadata.is_dir() {
            return Err(MigrationError::invalid(
                "credential migration channel root must be a real directory",
            ));
        }
        let parent = channel_root.parent().ok_or_else(|| {
            MigrationError::invalid("credential migration channel root has no parent")
        })?;
        let canonical_parent = fs::canonicalize(parent)
            .map_err(|source| MigrationError::io("canonicalize channel root parent", source))?;
        let parent_fd = open_directory_path(&canonical_parent)?;
        let channel_name = c_component(
            channel_root
                .file_name()
                .ok_or_else(|| MigrationError::invalid("channel root has no name"))?,
        )?;
        let channel = open_directory_at(parent_fd.as_raw_fd(), &channel_name)
            .map_err(|source| MigrationError::io("open channel root", source))?;
        verify_descriptor_metadata(channel.as_raw_fd(), &channel_metadata, "channel root")?;
        let dsh_metadata = fs::symlink_metadata(dsh_home)
            .map_err(|source| MigrationError::io("inspect DSH_HOME", source))?;
        if dsh_metadata.file_type().is_symlink() || !dsh_metadata.is_dir() {
            return Err(MigrationError::invalid(
                "credential migration DSH_HOME must be a real directory",
            ));
        }
        let dsh_name = CString::new("dsh").expect("fixed DSH_HOME component");
        let dsh = open_directory_at(channel.as_raw_fd(), &dsh_name)
            .map_err(|source| MigrationError::io("open DSH_HOME", source))?;
        verify_descriptor_metadata(dsh.as_raw_fd(), &dsh_metadata, "DSH_HOME")?;
        Ok(Self {
            channel,
            dsh,
            expected_owner,
        })
    }

    fn read_legacy(&self, name: &str) -> Result<Option<LegacyDocument>, MigrationError> {
        let Some((mut file, metadata)) = open_optional_regular(self.dsh.as_raw_fd(), name)? else {
            return Ok(None);
        };
        let mode = metadata.st_mode as u32 & 0o7777;
        if metadata.st_uid != self.expected_owner || mode & 0o077 != 0 || metadata.st_nlink != 1 {
            return Err(MigrationError::invalid(
                "legacy credential file ownership or permissions are unsafe",
            ));
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take((MAX_LEGACY_FILE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|source| MigrationError::io("read legacy credential file", source))?;
        if bytes.len() > MAX_LEGACY_FILE_BYTES {
            return Err(MigrationError::invalid(
                "legacy credential file is oversized",
            ));
        }
        let after = descriptor_stat(file.as_raw_fd())
            .map_err(|source| MigrationError::io("reinspect legacy credential file", source))?;
        if file_identity(&metadata) != file_identity(&after) {
            return Err(MigrationError::invalid(
                "legacy credential source identity changed",
            ));
        }
        let identity = SourceIdentity {
            device: metadata.st_dev as u64,
            inode: metadata.st_ino,
            sha256: Sha256::digest(&bytes).into(),
            mode,
        };
        let values = parse_legacy_yaml(&bytes)?;
        Ok(Some(LegacyDocument { identity, values }))
    }

    fn read_journal(&self) -> Result<Option<Journal>, MigrationError> {
        let Some((mut file, metadata)) =
            open_optional_regular(self.channel.as_raw_fd(), JOURNAL_FILE)?
        else {
            return Ok(None);
        };
        if metadata.st_uid != self.expected_owner
            || metadata.st_mode as u32 & 0o777 != 0o600
            || metadata.st_nlink != 1
        {
            return Err(MigrationError::invalid(
                "credential migration journal permissions are unsafe",
            ));
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take((MAX_JOURNAL_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|source| MigrationError::io("read credential migration journal", source))?;
        if bytes.len() > MAX_JOURNAL_BYTES {
            return Err(MigrationError::invalid(
                "credential migration journal is oversized",
            ));
        }
        let journal: Journal = serde_json::from_slice(&bytes).map_err(MigrationError::Json)?;
        validate_journal(&journal)?;
        Ok(Some(journal))
    }

    fn persist_journal(
        &self,
        journal: &Journal,
        changed_reference: Option<&str>,
        hook: &mut impl MigrationHook,
    ) -> Result<(), MigrationError> {
        validate_journal(journal)?;
        let bytes = serde_json::to_vec(journal).map_err(MigrationError::Json)?;
        let temp_name = format!(".credentials-migration-{}.tmp", journal.transaction_id);
        self.remove_optional_file(self.channel.as_raw_fd(), &temp_name)?;
        let temp = c_component(OsStr::new(&temp_name))?;
        let descriptor = unsafe {
            libc::openat(
                self.channel.as_raw_fd(),
                temp.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o600,
            )
        };
        if descriptor < 0 {
            return Err(MigrationError::io(
                "create credential migration journal temp file",
                io::Error::last_os_error(),
            ));
        }
        let mut file = unsafe { fs::File::from_raw_fd(descriptor) };
        file.write_all(&bytes)
            .map_err(|source| MigrationError::io("write credential migration journal", source))?;
        let generation = journal_generation(journal);
        let reference_state = changed_reference
            .and_then(|reference| journal.references.get(reference))
            .map(|entry| entry.state);
        hook.reached(MigrationBoundary::BeforeJournalFileFsync {
            generation,
            state: journal.state,
            reference_state,
        })?;
        file.sync_all()
            .map_err(|source| MigrationError::io("sync credential migration journal", source))?;
        hook.reached(MigrationBoundary::AfterJournalFileFsync {
            generation,
            state: journal.state,
            reference_state,
        })?;
        drop(file);
        rename_at(
            self.channel.as_raw_fd(),
            &temp,
            self.channel.as_raw_fd(),
            &CString::new(JOURNAL_FILE).expect("fixed journal name"),
        )
        .map_err(|source| MigrationError::io("publish credential migration journal", source))?;
        hook.reached(MigrationBoundary::BeforeJournalParentFsync {
            generation,
            state: journal.state,
            reference_state,
        })?;
        sync_directory(self.channel.as_raw_fd())
            .map_err(|source| MigrationError::io("sync credential migration directory", source))?;
        hook.reached(MigrationBoundary::AfterJournalParentFsync {
            generation,
            state: journal.state,
            reference_state,
        })?;
        Ok(())
    }

    fn stage_legacy(
        &self,
        transaction_id: Uuid,
        expected: SourceIdentity,
    ) -> Result<(), MigrationError> {
        let source = CString::new(LEGACY_FILE).expect("fixed legacy name");
        let staged = c_component(OsStr::new(&staged_name(transaction_id)))?;
        if self.entry_exists(
            self.dsh.as_raw_fd(),
            staged.to_str().expect("UUID name is UTF-8"),
        )? {
            return Err(MigrationError::invalid(
                "staged legacy credential file already exists",
            ));
        }
        let (mut file, metadata) = open_optional_regular(self.dsh.as_raw_fd(), LEGACY_FILE)?
            .ok_or_else(|| MigrationError::invalid("legacy credential source disappeared"))?;
        let mode = metadata.st_mode as u32 & 0o7777;
        if metadata.st_uid != self.expected_owner || mode & 0o077 != 0 || metadata.st_nlink != 1 {
            return Err(MigrationError::invalid(
                "legacy credential file ownership or permissions are unsafe",
            ));
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take((MAX_LEGACY_FILE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|source| MigrationError::io("revalidate legacy credential file", source))?;
        if bytes.len() > MAX_LEGACY_FILE_BYTES {
            return Err(MigrationError::invalid(
                "legacy credential file is oversized",
            ));
        }
        let descriptor_metadata = descriptor_stat(file.as_raw_fd())
            .map_err(|source| MigrationError::io("reinspect legacy credential file", source))?;
        if file_identity(&metadata) != file_identity(&descriptor_metadata) {
            return Err(MigrationError::invalid(
                "legacy credential source identity changed",
            ));
        }
        verify_source_identity(
            &SourceIdentity {
                device: metadata.st_dev as u64,
                inode: metadata.st_ino,
                sha256: Sha256::digest(&bytes).into(),
                mode,
            },
            &expected,
        )?;
        let actual = stat_at(self.dsh.as_raw_fd(), &source)
            .map_err(|source| MigrationError::io("inspect legacy credential source", source))?;
        verify_entry_identity(&actual, &expected)?;
        rename_at(self.dsh.as_raw_fd(), &source, self.dsh.as_raw_fd(), &staged)
            .map_err(|source| MigrationError::io("stage legacy credential file", source))?;
        sync_directory(self.dsh.as_raw_fd())
            .map_err(|source| MigrationError::io("sync staged legacy credential file", source))
    }

    fn restore_staged(
        &self,
        transaction_id: Uuid,
        expected: SourceIdentity,
    ) -> Result<(), MigrationError> {
        let staged = c_component(OsStr::new(&staged_name(transaction_id)))?;
        let legacy = CString::new(LEGACY_FILE).expect("fixed legacy name");
        if self.entry_exists(self.dsh.as_raw_fd(), LEGACY_FILE)? {
            return Err(MigrationError::invalid(
                "legacy credential source already exists during restore",
            ));
        }
        let actual = stat_at(self.dsh.as_raw_fd(), &staged).map_err(|source| {
            MigrationError::io("inspect staged legacy credential file", source)
        })?;
        verify_entry_identity(&actual, &expected)?;
        rename_at(self.dsh.as_raw_fd(), &staged, self.dsh.as_raw_fd(), &legacy)
            .map_err(|source| MigrationError::io("restore legacy credential file", source))?;
        sync_directory(self.dsh.as_raw_fd())
            .map_err(|source| MigrationError::io("sync restored legacy credential file", source))
    }

    fn remove_dsh_file(&self, name: &str) -> Result<(), MigrationError> {
        self.remove_required_file(self.dsh.as_raw_fd(), name)?;
        sync_directory(self.dsh.as_raw_fd())
            .map_err(|source| MigrationError::io("sync legacy credential directory", source))
    }

    fn remove_journal(&self) -> Result<(), MigrationError> {
        self.remove_optional_file(self.channel.as_raw_fd(), JOURNAL_FILE)?;
        sync_directory(self.channel.as_raw_fd())
            .map_err(|source| MigrationError::io("sync credential migration directory", source))
    }

    fn remove_required_file(&self, parent: RawFd, name: &str) -> Result<(), MigrationError> {
        let name = c_component(OsStr::new(name))?;
        let metadata = stat_at(parent, &name)
            .map_err(|source| MigrationError::io("inspect migration file for removal", source))?;
        if metadata.st_mode as u32 & libc::S_IFMT as u32 != libc::S_IFREG as u32
            || metadata.st_uid != self.expected_owner
            || metadata.st_nlink != 1
        {
            return Err(MigrationError::invalid(
                "credential migration removal target is unsafe",
            ));
        }
        if unsafe { libc::unlinkat(parent, name.as_ptr(), 0) } < 0 {
            return Err(MigrationError::io(
                "remove credential migration file",
                io::Error::last_os_error(),
            ));
        }
        Ok(())
    }

    fn remove_optional_file(&self, parent: RawFd, name: &str) -> Result<(), MigrationError> {
        match self.remove_required_file(parent, name) {
            Ok(()) => Ok(()),
            Err(MigrationError::Io { source, .. }) if source.kind() == io::ErrorKind::NotFound => {
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    fn entry_exists(&self, parent: RawFd, name: &str) -> Result<bool, MigrationError> {
        let name = c_component(OsStr::new(name))?;
        match stat_at(parent, &name) {
            Ok(_) => Ok(true),
            Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(source) => Err(MigrationError::io("inspect migration entry", source)),
        }
    }
}

fn staged_name(transaction_id: Uuid) -> String {
    format!(".credentials-migration-{transaction_id}.yaml")
}

fn validate_journal(journal: &Journal) -> Result<(), MigrationError> {
    if journal.references.is_empty()
        || journal
            .references
            .keys()
            .any(|reference| CredentialAccount::new(reference).is_err())
        || !is_sorted_unique(&journal.pre_existing_refs)
        || !is_sorted_unique(&journal.transaction_created_refs)
        || journal
            .pre_existing_refs
            .iter()
            .any(|reference| !journal.references.contains_key(reference))
        || journal
            .transaction_created_refs
            .iter()
            .any(|reference| !journal.references.contains_key(reference))
        || journal
            .pre_existing_refs
            .iter()
            .any(|reference| journal.transaction_created_refs.contains(reference))
        || journal.pre_existing_refs.iter().any(|reference| {
            journal.references[reference].previous != Some(PreviousValue::PreExisting)
        })
        || journal
            .transaction_created_refs
            .iter()
            .any(|reference| journal.references[reference].previous != Some(PreviousValue::Absent))
        || journal.references.values().any(|entry| {
            entry.state == ReferenceState::Written && entry.previous != Some(PreviousValue::Absent)
        })
        || journal.source.mode & 0o077 != 0
    {
        return Err(MigrationError::invalid(
            "credential migration journal invariants are invalid",
        ));
    }
    Ok(())
}

fn is_sorted_unique(values: &[String]) -> bool {
    values.windows(2).all(|pair| pair[0] < pair[1])
}

fn journal_generation(journal: &Journal) -> u64 {
    let state = match journal.state {
        MigrationState::Discovered => 1,
        MigrationState::WritingKeychain => 2,
        MigrationState::KeychainVerified => 3,
        MigrationState::LegacyStaged => 4,
        MigrationState::CommitPrepared => 5,
        MigrationState::Committed => 6,
    };
    state
        + journal
            .references
            .values()
            .map(|entry| match entry.state {
                ReferenceState::Planned => 0,
                ReferenceState::Written => 1,
                ReferenceState::Verified => 2,
            })
            .sum::<u64>()
}

fn parse_legacy_yaml(bytes: &[u8]) -> Result<BTreeMap<String, Zeroizing<Vec<u8>>>, MigrationError> {
    reject_yaml_indirection(bytes)?;
    let mut documents = serde_yaml::Deserializer::from_slice(bytes);
    let Some(document) = documents.next() else {
        return Err(MigrationError::Yaml);
    };
    let parsed = StrictCredentialMap::deserialize(document).map_err(|_| MigrationError::Yaml)?;
    if documents.next().is_some() || parsed.0.is_empty() {
        return Err(MigrationError::Yaml);
    }
    parsed
        .0
        .into_iter()
        .map(|(reference, value)| {
            CredentialAccount::new(&reference).map_err(|_| MigrationError::Yaml)?;
            let bytes = value.into_bytes();
            if bytes.is_empty() || bytes.len() > MAX_SECRET_BYTES {
                return Err(MigrationError::Yaml);
            }
            Ok((reference, Zeroizing::new(bytes)))
        })
        .collect()
}

fn reject_yaml_indirection(bytes: &[u8]) -> Result<(), MigrationError> {
    let text = std::str::from_utf8(bytes).map_err(|_| MigrationError::Yaml)?;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("---") {
            continue;
        }
        let Some((raw_key, raw_value)) = trimmed.split_once(':') else {
            return Err(MigrationError::Yaml);
        };
        if raw_key.trim() != raw_key
            || CredentialAccount::new(raw_key).is_err()
            || matches!(
                raw_value.trim_start().as_bytes().first(),
                Some(b'&' | b'*' | b'!')
            )
        {
            return Err(MigrationError::Yaml);
        }
    }
    Ok(())
}

struct StrictCredentialMap(BTreeMap<String, String>);

impl<'de> Deserialize<'de> for StrictCredentialMap {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(StrictCredentialVisitor)
    }
}

struct StrictCredentialVisitor;

impl<'de> Visitor<'de> for StrictCredentialVisitor {
    type Value = StrictCredentialMap;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a mapping of unique credential references to string secrets")
    }

    fn visit_map<M>(self, mut access: M) -> Result<Self::Value, M::Error>
    where
        M: MapAccess<'de>,
    {
        let mut values = BTreeMap::new();
        while let Some((reference, value)) = access.next_entry::<String, StrictString>()? {
            if values.insert(reference.clone(), value.0).is_some() {
                return Err(serde::de::Error::custom(format!(
                    "duplicate credential reference {reference}"
                )));
            }
        }
        Ok(StrictCredentialMap(values))
    }
}

struct StrictString(String);

impl<'de> Deserialize<'de> for StrictString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(StrictStringVisitor)
    }
}

struct StrictStringVisitor;

impl Visitor<'_> for StrictStringVisitor {
    type Value = StrictString;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a YAML string scalar")
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        Ok(StrictString(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        Ok(StrictString(value))
    }
}

fn open_directory_path(path: &Path) -> Result<OwnedFd, MigrationError> {
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| MigrationError::invalid("credential migration path contains NUL"))?;
    let descriptor = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        return Err(MigrationError::io(
            "open credential migration directory",
            io::Error::last_os_error(),
        ));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

fn open_directory_at(parent: RawFd, name: &CStr) -> io::Result<OwnedFd> {
    let descriptor = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

fn open_optional_regular(
    parent: RawFd,
    name: &str,
) -> Result<Option<(fs::File, libc::stat)>, MigrationError> {
    let name = c_component(OsStr::new(name))?;
    let descriptor = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        let source = io::Error::last_os_error();
        return if source.kind() == io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(MigrationError::io("open credential migration file", source))
        };
    }
    let file = unsafe { fs::File::from_raw_fd(descriptor) };
    let metadata = descriptor_stat(file.as_raw_fd())
        .map_err(|source| MigrationError::io("inspect credential migration file", source))?;
    if metadata.st_mode as u32 & libc::S_IFMT as u32 != libc::S_IFREG as u32 {
        return Err(MigrationError::invalid(
            "credential migration input must be a regular file",
        ));
    }
    Ok(Some((file, metadata)))
}

fn c_component(value: &OsStr) -> Result<CString, MigrationError> {
    if value.is_empty() || value.as_bytes().contains(&b'/') {
        return Err(MigrationError::invalid(
            "credential migration path component is invalid",
        ));
    }
    CString::new(value.as_bytes())
        .map_err(|_| MigrationError::invalid("credential migration path contains NUL"))
}

fn descriptor_stat(descriptor: RawFd) -> io::Result<libc::stat> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { metadata.assume_init() })
}

fn verify_descriptor_metadata(
    descriptor: RawFd,
    expected: &fs::Metadata,
    label: &'static str,
) -> Result<(), MigrationError> {
    let actual = descriptor_stat(descriptor)
        .map_err(|source| MigrationError::io("inspect opened migration directory", source))?;
    if actual.st_dev as u64 != expected.dev()
        || actual.st_ino != expected.ino()
        || actual.st_mode as u32 & libc::S_IFMT as u32 != libc::S_IFDIR as u32
    {
        return Err(MigrationError::Invalid(label));
    }
    Ok(())
}

fn stat_at(parent: RawFd, name: &CStr) -> io::Result<libc::stat> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            parent,
            name.as_ptr(),
            metadata.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { metadata.assume_init() })
}

fn verify_entry_identity(
    actual: &libc::stat,
    expected: &SourceIdentity,
) -> Result<(), MigrationError> {
    if actual.st_dev as u64 != expected.device
        || actual.st_ino != expected.inode
        || actual.st_mode as u32 & libc::S_IFMT as u32 != libc::S_IFREG as u32
        || actual.st_mode as u32 & 0o7777 != expected.mode
        || actual.st_uid != unsafe { libc::geteuid() }
        || actual.st_nlink != 1
    {
        return Err(MigrationError::invalid(
            "legacy credential source identity changed",
        ));
    }
    Ok(())
}

fn file_identity(metadata: &libc::stat) -> (u64, u64, u32, u64) {
    (
        metadata.st_dev as u64,
        metadata.st_ino,
        metadata.st_mode as u32,
        metadata.st_size as u64,
    )
}

fn rename_at(
    old_parent: RawFd,
    old_name: &CStr,
    new_parent: RawFd,
    new_name: &CStr,
) -> io::Result<()> {
    if unsafe { libc::renameat(old_parent, old_name.as_ptr(), new_parent, new_name.as_ptr()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn sync_directory(descriptor: RawFd) -> io::Result<()> {
    if unsafe { libc::fsync(descriptor) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
