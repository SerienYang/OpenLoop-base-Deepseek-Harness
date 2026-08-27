use std::{
    error::Error,
    ffi::{CStr, CString, OsStr},
    fmt, fs,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Path, PathBuf},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(60);
const UPDATE_JOURNAL_FILE: &str = ".openloop-update-transaction.json";
const UPDATE_JOURNAL_TEMP: &str = ".openloop-update-transaction.tmp";
const MAX_UPDATE_JOURNAL_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "status", content = "detail")]
pub enum HealthStatus {
    Healthy,
    TimedOut,
    Failed(String),
}

pub trait CandidateHealth {
    fn await_health(&mut self, candidate: &Path, timeout: Duration) -> HealthStatus;
}

pub trait PublicationCompanion {
    fn commit(&mut self) -> Result<(), String>;
    fn rollback(&mut self) -> Result<(), String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PublicationOutcome {
    Committed {
        preserved_backup: PathBuf,
    },
    RolledBack {
        status: HealthStatus,
        failed_candidate: PathBuf,
    },
}

#[cfg(debug_assertions)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryBoundary {
    BeforeJournalFileFsync(RecoveryState),
    AfterJournalFileFsync(RecoveryState),
    BeforeJournalParentFsync(RecoveryState),
    AfterJournalParentFsync(RecoveryState),
    BeforeCandidatePublishSwap,
    AfterCandidatePublishSwap,
    AfterCompanionCommit,
    BeforeHealthRollbackSwap,
    AfterHealthRollbackSwap,
    AfterCompanionRollback,
}

#[cfg(not(debug_assertions))]
#[derive(Debug, Clone, Copy)]
enum RecoveryBoundary {
    BeforeJournalFileFsync(RecoveryState),
    AfterJournalFileFsync(RecoveryState),
    BeforeJournalParentFsync(RecoveryState),
    AfterJournalParentFsync(RecoveryState),
    BeforeCandidatePublishSwap,
    AfterCandidatePublishSwap,
    AfterCompanionCommit,
    BeforeHealthRollbackSwap,
    AfterHealthRollbackSwap,
    AfterCompanionRollback,
}

#[cfg(debug_assertions)]
pub trait RecoveryTestHook {
    fn before(&mut self, boundary: RecoveryBoundary, left: &Path, right: &Path);
}

trait TransactionHook {
    fn before(&mut self, boundary: RecoveryBoundary, left: &Path, right: &Path);
}

struct NoopHook;

impl TransactionHook for NoopHook {
    fn before(&mut self, _: RecoveryBoundary, _: &Path, _: &Path) {}
}

struct NoopCompanion;

impl PublicationCompanion for NoopCompanion {
    fn commit(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn rollback(&mut self) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(debug_assertions)]
struct TestHookAdapter<'a, T>(&'a mut T);

#[cfg(debug_assertions)]
impl<T: RecoveryTestHook> TransactionHook for TestHookAdapter<'_, T> {
    fn before(&mut self, boundary: RecoveryBoundary, left: &Path, right: &Path) {
        self.0.before(boundary, left, right);
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RecoveryState {
    Prepared,
    CandidatePublished,
    CommitIntent,
    RollbackIntent,
    AppRestored,
    CompanionRolledBack,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
    file_type: u32,
}

impl FileIdentity {
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            file_type: metadata.mode() & libc::S_IFMT as u32,
        }
    }

    fn from_stat(metadata: &libc::stat) -> Self {
        Self {
            device: metadata.st_dev as u64,
            inode: metadata.st_ino,
            file_type: metadata.st_mode as u32 & libc::S_IFMT as u32,
        }
    }

    fn is_directory(self) -> bool {
        self.file_type == libc::S_IFDIR as u32
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryJournal {
    transaction_id: Uuid,
    installed_name: String,
    candidate_name: String,
    installed_identity: FileIdentity,
    candidate_identity: FileIdentity,
    state: RecoveryState,
    migration_transaction_id: Option<Uuid>,
}

#[derive(Debug)]
pub struct RecoveryTransaction {
    root_path: PathBuf,
    root: OwnedFd,
    installed_name: CString,
    candidate_name: CString,
    installed_identity: FileIdentity,
    candidate_identity: FileIdentity,
    transaction_id: Uuid,
    migration_transaction_id: Option<Uuid>,
}

pub fn update_journal_path(root: &Path) -> PathBuf {
    root.join(UPDATE_JOURNAL_FILE)
}

impl RecoveryTransaction {
    pub fn open(root: &Path, installed: &Path, candidate: &Path) -> Result<Self, RecoveryError> {
        let root_metadata = fs::symlink_metadata(root)
            .map_err(|source| RecoveryError::io("inspect update root", source))?;
        if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
            return Err(RecoveryError::invalid(
                "update root must be a real directory, not a symlink",
            ));
        }
        let canonical_root = fs::canonicalize(root)
            .map_err(|source| RecoveryError::io("canonicalize update root", source))?;
        let installed_name = bundle_name(&canonical_root, installed, "installed")?;
        let candidate_name = bundle_name(&canonical_root, candidate, "candidate")?;
        if installed_name == candidate_name {
            return Err(RecoveryError::invalid(
                "installed and candidate app bundle paths must not overlap",
            ));
        }

        let root_c = CString::new(canonical_root.as_os_str().as_bytes())
            .map_err(|_| RecoveryError::invalid("update root contains a NUL byte"))?;
        // SAFETY: `root_c` is a live NUL-terminated path. A successful call
        // returns a new descriptor owned by this transaction.
        let descriptor = unsafe {
            libc::open(
                root_c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if descriptor < 0 {
            return Err(RecoveryError::io(
                "open update root",
                io::Error::last_os_error(),
            ));
        }
        // SAFETY: `descriptor` was just returned as a new owned fd.
        let root = unsafe { OwnedFd::from_raw_fd(descriptor) };
        let root_identity = descriptor_identity(root.as_raw_fd())
            .map_err(|source| RecoveryError::io("inspect opened update root", source))?;
        if root_identity != FileIdentity::from_metadata(&root_metadata) {
            return Err(RecoveryError::invalid(
                "update root identity changed while opening transaction",
            ));
        }
        let installed_identity =
            bundle_identity_at(root.as_raw_fd(), &installed_name, "installed")?;
        let candidate_identity =
            bundle_identity_at(root.as_raw_fd(), &candidate_name, "candidate")?;
        if installed_identity.device != candidate_identity.device
            || installed_identity.device != root_identity.device
        {
            return Err(RecoveryError::invalid(
                "installed, candidate, and update root must share one filesystem",
            ));
        }

        Ok(Self {
            root_path: canonical_root,
            root,
            installed_name,
            candidate_name,
            installed_identity,
            candidate_identity,
            transaction_id: Uuid::new_v4(),
            migration_transaction_id: None,
        })
    }

    pub fn with_migration_transaction(mut self, transaction_id: Option<Uuid>) -> Self {
        self.migration_transaction_id = transaction_id;
        self
    }

    pub fn publish(
        self,
        health: &mut impl CandidateHealth,
    ) -> Result<PublicationOutcome, RecoveryError> {
        self.publish_inner(health, &mut NoopHook, &mut NoopCompanion)
    }

    pub fn publish_with_companion(
        self,
        health: &mut impl CandidateHealth,
        companion: &mut impl PublicationCompanion,
    ) -> Result<PublicationOutcome, RecoveryError> {
        self.publish_inner(health, &mut NoopHook, companion)
    }

    #[cfg(debug_assertions)]
    pub fn publish_with_hook(
        self,
        health: &mut impl CandidateHealth,
        hook: &mut impl RecoveryTestHook,
    ) -> Result<PublicationOutcome, RecoveryError> {
        self.publish_inner(health, &mut TestHookAdapter(hook), &mut NoopCompanion)
    }

    #[cfg(debug_assertions)]
    pub fn publish_with_companion_and_hook(
        self,
        health: &mut impl CandidateHealth,
        companion: &mut impl PublicationCompanion,
        hook: &mut impl RecoveryTestHook,
    ) -> Result<PublicationOutcome, RecoveryError> {
        self.publish_inner(health, &mut TestHookAdapter(hook), companion)
    }

    fn publish_inner(
        self,
        health: &mut impl CandidateHealth,
        hook: &mut impl TransactionHook,
        companion: &mut impl PublicationCompanion,
    ) -> Result<PublicationOutcome, RecoveryError> {
        self.persist_journal(RecoveryState::Prepared, hook)?;
        if let Err(source) = self.swap_checked(
            &self.installed_name,
            self.installed_identity,
            &self.candidate_name,
            self.candidate_identity,
            "installed app and candidate app",
            RecoveryBoundary::BeforeCandidatePublishSwap,
            RecoveryBoundary::AfterCandidatePublishSwap,
            hook,
        ) {
            return Err(RecoveryError::io("publish candidate app bundle", source));
        }
        self.persist_journal(RecoveryState::CandidatePublished, hook)?;

        let installed_path = self.path(&self.installed_name);
        let mut status = health.await_health(&installed_path, HEALTH_TIMEOUT);
        if status == HealthStatus::Healthy {
            self.persist_journal(RecoveryState::CommitIntent, hook)?;
            match companion.commit() {
                Ok(()) => {
                    hook.before(
                        RecoveryBoundary::AfterCompanionCommit,
                        &self.path(&self.installed_name),
                        &self.path(&self.candidate_name),
                    );
                    self.remove_journal()?;
                    return Ok(PublicationOutcome::Committed {
                        preserved_backup: self.path(&self.candidate_name),
                    });
                }
                Err(_) => {
                    self.persist_journal(RecoveryState::CandidatePublished, hook)?;
                    status =
                        HealthStatus::Failed("candidate companion health commit failed".to_owned());
                }
            }
        }

        self.persist_journal(RecoveryState::RollbackIntent, hook)?;
        if let Err(restore) = self.health_rollback_swap(hook) {
            return Err(RecoveryError::RestoreFailed {
                restore,
                candidate_republish: None,
            });
        }
        self.persist_journal(RecoveryState::AppRestored, hook)?;
        companion
            .rollback()
            .map_err(|_| RecoveryError::CompanionRollback)?;
        hook.before(
            RecoveryBoundary::AfterCompanionRollback,
            &self.path(&self.installed_name),
            &self.path(&self.candidate_name),
        );
        self.persist_journal(RecoveryState::CompanionRolledBack, hook)?;
        self.remove_journal()?;
        Ok(PublicationOutcome::RolledBack {
            status,
            failed_candidate: self.path(&self.candidate_name),
        })
    }

    fn health_rollback_swap(&self, hook: &mut impl TransactionHook) -> io::Result<()> {
        self.verify_identity(
            &self.installed_name,
            self.candidate_identity,
            "published candidate",
        )?;
        self.verify_identity(
            &self.candidate_name,
            self.installed_identity,
            "old app backup",
        )?;
        hook.before(
            RecoveryBoundary::BeforeHealthRollbackSwap,
            &self.path(&self.installed_name),
            &self.path(&self.candidate_name),
        );
        self.atomic_swap(&self.installed_name, &self.candidate_name)?;
        hook.before(
            RecoveryBoundary::AfterHealthRollbackSwap,
            &self.path(&self.installed_name),
            &self.path(&self.candidate_name),
        );
        let installed_observed =
            identity_at(self.root.as_raw_fd(), &self.installed_name).map_err(|error| {
                identity_error(
                    "health rollback installed path",
                    format!(
                        "inspection failed: {error}; preserved entries remain visible at {} and {}",
                        self.path(&self.installed_name).display(),
                        self.path(&self.candidate_name).display()
                    ),
                )
            })?;
        let backup_observed =
            identity_at(self.root.as_raw_fd(), &self.candidate_name).map_err(|error| {
                identity_error(
                    "health rollback backup path",
                    format!(
                        "inspection failed: {error}; preserved entries remain visible at {} and {}",
                        self.path(&self.installed_name).display(),
                        self.path(&self.candidate_name).display()
                    ),
                )
            })?;
        if installed_observed == self.installed_identity
            && backup_observed == self.candidate_identity
        {
            return Ok(());
        }
        if installed_observed == self.installed_identity {
            return Err(identity_error(
                "health rollback",
                format!(
                    "old app was restored but the candidate identity changed; preserved entries remain visible at {} and {}",
                    self.path(&self.installed_name).display(),
                    self.path(&self.candidate_name).display()
                ),
            ));
        }
        let rollback = self.rollback_observed(
            &self.installed_name,
            installed_observed,
            &self.candidate_name,
            backup_observed,
            "failed health rollback",
        );
        Err(identity_error(
            "health rollback",
            match rollback {
                Ok(()) => format!(
                    "filesystem objects changed during swap and were returned; preserved at {} and {}",
                    self.path(&self.installed_name).display(),
                    self.path(&self.candidate_name).display()
                ),
                Err(error) => format!(
                    "filesystem objects changed during swap; returning observed objects failed: {error}; preserved entries remain visible at {} and {}",
                    self.path(&self.installed_name).display(),
                    self.path(&self.candidate_name).display()
                ),
            },
        ))
    }

    #[allow(clippy::too_many_arguments)]
    fn swap_checked(
        &self,
        left: &CStr,
        left_expected: FileIdentity,
        right: &CStr,
        right_expected: FileIdentity,
        label: &str,
        before_boundary: RecoveryBoundary,
        after_boundary: RecoveryBoundary,
        hook: &mut impl TransactionHook,
    ) -> io::Result<()> {
        self.verify_identity(left, left_expected, label)?;
        self.verify_identity(right, right_expected, label)?;
        hook.before(before_boundary, &self.path(left), &self.path(right));
        self.atomic_swap(left, right)?;
        hook.before(after_boundary, &self.path(left), &self.path(right));

        let left_observed = identity_at(self.root.as_raw_fd(), left).map_err(|error| {
            identity_error(
                label,
                format!(
                    "inspect left after swap failed: {error}; preserved entries remain visible at {} and {}",
                    self.path(left).display(),
                    self.path(right).display()
                ),
            )
        })?;
        let right_observed = identity_at(self.root.as_raw_fd(), right).map_err(|error| {
            identity_error(
                label,
                format!(
                    "inspect right after swap failed: {error}; preserved entries remain visible at {} and {}",
                    self.path(left).display(),
                    self.path(right).display()
                ),
            )
        })?;
        if left_observed == right_expected && right_observed == left_expected {
            return Ok(());
        }
        let rollback = self.rollback_observed(left, left_observed, right, right_observed, label);
        Err(identity_error(
            label,
            match rollback {
                Ok(()) => format!(
                    "filesystem objects changed during swap and were returned; preserved at {} and {}",
                    self.path(left).display(),
                    self.path(right).display()
                ),
                Err(error) => format!(
                    "filesystem objects changed during swap; returning observed objects failed: {error}; preserved entries remain visible at {} and {}",
                    self.path(left).display(),
                    self.path(right).display()
                ),
            },
        ))
    }

    fn rollback_observed(
        &self,
        left: &CStr,
        left_observed: FileIdentity,
        right: &CStr,
        right_observed: FileIdentity,
        label: &str,
    ) -> io::Result<()> {
        // macOS exposes no public inode-conditional recursive deletion syscall.
        // On a post-verify anomaly, undo is attempted only while both observed
        // directory-entry identities still match; otherwise every visible
        // object is preserved for later journal/helper-governed cleanup.
        self.verify_identity(left, left_observed, label)?;
        self.verify_identity(right, right_observed, label)?;
        self.atomic_swap(left, right)?;
        self.verify_identity(left, right_observed, label)?;
        self.verify_identity(right, left_observed, label)
    }

    fn atomic_swap(&self, left: &CStr, right: &CStr) -> io::Result<()> {
        // SAFETY: both names are validated single path components under the
        // retained root fd. RENAME_SWAP changes both directory entries in one
        // filesystem operation, so neither name passes through an absent state.
        let result = unsafe {
            libc::renameatx_np(
                self.root.as_raw_fd(),
                left.as_ptr(),
                self.root.as_raw_fd(),
                right.as_ptr(),
                libc::RENAME_SWAP,
            )
        };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn verify_identity(&self, name: &CStr, expected: FileIdentity, label: &str) -> io::Result<()> {
        let actual = identity_at(self.root.as_raw_fd(), name)
            .map_err(|error| identity_error(label, error))?;
        if actual != expected {
            return Err(identity_error(label, "filesystem object was replaced"));
        }
        Ok(())
    }

    fn path(&self, name: &CStr) -> PathBuf {
        self.root_path.join(OsStr::from_bytes(name.to_bytes()))
    }

    fn journal(&self, state: RecoveryState) -> RecoveryJournal {
        RecoveryJournal {
            transaction_id: self.transaction_id,
            installed_name: self.installed_name.to_string_lossy().into_owned(),
            candidate_name: self.candidate_name.to_string_lossy().into_owned(),
            installed_identity: self.installed_identity,
            candidate_identity: self.candidate_identity,
            state,
            migration_transaction_id: self.migration_transaction_id,
        }
    }

    fn persist_journal(
        &self,
        state: RecoveryState,
        hook: &mut impl TransactionHook,
    ) -> Result<(), RecoveryError> {
        let bytes = serde_json::to_vec(&self.journal(state))
            .map_err(|source| RecoveryError::json("serialize update journal", source))?;
        remove_optional_file_at(self.root.as_raw_fd(), UPDATE_JOURNAL_TEMP)?;
        let temp = CString::new(UPDATE_JOURNAL_TEMP).expect("fixed update journal temp name");
        let descriptor = unsafe {
            libc::openat(
                self.root.as_raw_fd(),
                temp.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o600,
            )
        };
        if descriptor < 0 {
            return Err(RecoveryError::io(
                "create update journal temp file",
                io::Error::last_os_error(),
            ));
        }
        let mut file = unsafe { fs::File::from_raw_fd(descriptor) };
        file.write_all(&bytes)
            .map_err(|source| RecoveryError::io("write update journal", source))?;
        hook.before(
            RecoveryBoundary::BeforeJournalFileFsync(state),
            &self.path(&self.installed_name),
            &self.path(&self.candidate_name),
        );
        file.sync_all()
            .map_err(|source| RecoveryError::io("sync update journal", source))?;
        hook.before(
            RecoveryBoundary::AfterJournalFileFsync(state),
            &self.path(&self.installed_name),
            &self.path(&self.candidate_name),
        );
        drop(file);
        rename_entry(
            self.root.as_raw_fd(),
            &temp,
            &CString::new(UPDATE_JOURNAL_FILE).expect("fixed update journal name"),
        )
        .map_err(|source| RecoveryError::io("publish update journal", source))?;
        hook.before(
            RecoveryBoundary::BeforeJournalParentFsync(state),
            &self.path(&self.installed_name),
            &self.path(&self.candidate_name),
        );
        sync_directory(self.root.as_raw_fd())
            .map_err(|source| RecoveryError::io("sync update journal directory", source))?;
        hook.before(
            RecoveryBoundary::AfterJournalParentFsync(state),
            &self.path(&self.installed_name),
            &self.path(&self.candidate_name),
        );
        Ok(())
    }

    fn remove_journal(&self) -> Result<(), RecoveryError> {
        remove_optional_file_at(self.root.as_raw_fd(), UPDATE_JOURNAL_FILE)?;
        remove_optional_file_at(self.root.as_raw_fd(), UPDATE_JOURNAL_TEMP)?;
        sync_directory(self.root.as_raw_fd())
            .map_err(|source| RecoveryError::io("sync update journal removal", source))
    }
}

pub fn pending_update_migration_transaction_id(root: &Path) -> Result<Option<Uuid>, RecoveryError> {
    let (_, descriptor) = open_update_root(root)?;
    Ok(read_recovery_journal(descriptor.as_raw_fd())?
        .and_then(|journal| journal.migration_transaction_id))
}

pub fn recover_interrupted_update(root: &Path) -> Result<(), RecoveryError> {
    recover_interrupted_update_with_companion(root, &mut NoopCompanion)
}

pub fn recover_interrupted_update_with_companion(
    root: &Path,
    companion: &mut impl PublicationCompanion,
) -> Result<(), RecoveryError> {
    recover_interrupted_update_inner(root, None, companion)
}

pub fn recover_interrupted_update_with_bound_companion(
    root: &Path,
    migration_transaction_id: Uuid,
    companion: &mut impl PublicationCompanion,
) -> Result<(), RecoveryError> {
    recover_interrupted_update_inner(root, Some(migration_transaction_id), companion)
}

fn recover_interrupted_update_inner(
    root: &Path,
    expected_migration_transaction_id: Option<Uuid>,
    companion: &mut impl PublicationCompanion,
) -> Result<(), RecoveryError> {
    let (root_path, root_descriptor) = open_update_root(root)?;
    let Some(journal) = read_recovery_journal(root_descriptor.as_raw_fd())? else {
        remove_optional_file_at(root_descriptor.as_raw_fd(), UPDATE_JOURNAL_TEMP)?;
        return Ok(());
    };
    validate_recovery_journal(&journal)?;
    if expected_migration_transaction_id
        .is_some_and(|expected| journal.migration_transaction_id != Some(expected))
    {
        return Err(RecoveryError::invalid(
            "update journal migration transaction identity does not match",
        ));
    }
    let transaction = RecoveryTransaction {
        root_path,
        root: root_descriptor,
        installed_name: CString::new(journal.installed_name.as_bytes())
            .map_err(|_| RecoveryError::invalid("update journal installed name is invalid"))?,
        candidate_name: CString::new(journal.candidate_name.as_bytes())
            .map_err(|_| RecoveryError::invalid("update journal candidate name is invalid"))?,
        installed_identity: journal.installed_identity,
        candidate_identity: journal.candidate_identity,
        transaction_id: journal.transaction_id,
        migration_transaction_id: journal.migration_transaction_id,
    };
    let installed_observed = identity_at(transaction.root.as_raw_fd(), &transaction.installed_name)
        .map_err(|source| RecoveryError::io("inspect recovery installed app", source))?;
    let candidate_observed = identity_at(transaction.root.as_raw_fd(), &transaction.candidate_name)
        .map_err(|source| RecoveryError::io("inspect recovery candidate app", source))?;
    let original = installed_observed == transaction.installed_identity
        && candidate_observed == transaction.candidate_identity;
    let published = installed_observed == transaction.candidate_identity
        && candidate_observed == transaction.installed_identity;

    match journal.state {
        RecoveryState::Prepared | RecoveryState::CandidatePublished => {
            transaction.persist_journal(RecoveryState::RollbackIntent, &mut NoopHook)?;
            if published {
                transaction
                    .health_rollback_swap(&mut NoopHook)
                    .map_err(|source| RecoveryError::io("restore interrupted update", source))?;
            } else if !original {
                return Err(RecoveryError::invalid(
                    "interrupted update app identities are ambiguous",
                ));
            }
            transaction.persist_journal(RecoveryState::AppRestored, &mut NoopHook)?;
            companion
                .rollback()
                .map_err(|_| RecoveryError::CompanionRollback)?;
            transaction.persist_journal(RecoveryState::CompanionRolledBack, &mut NoopHook)?;
        }
        RecoveryState::CommitIntent => {
            if !published {
                return Err(RecoveryError::invalid(
                    "committing update no longer owns the published app identities",
                ));
            }
            if companion.commit().is_err() {
                transaction.persist_journal(RecoveryState::RollbackIntent, &mut NoopHook)?;
                transaction
                    .health_rollback_swap(&mut NoopHook)
                    .map_err(|source| {
                        RecoveryError::io("restore update after companion commit failure", source)
                    })?;
                transaction.persist_journal(RecoveryState::AppRestored, &mut NoopHook)?;
                companion
                    .rollback()
                    .map_err(|_| RecoveryError::CompanionRollback)?;
                transaction.persist_journal(RecoveryState::CompanionRolledBack, &mut NoopHook)?;
            }
        }
        RecoveryState::RollbackIntent => {
            if published {
                transaction
                    .health_rollback_swap(&mut NoopHook)
                    .map_err(|source| RecoveryError::io("resume update rollback", source))?;
            } else if !original {
                return Err(RecoveryError::invalid(
                    "rolling back update no longer owns the app identities",
                ));
            }
            transaction.persist_journal(RecoveryState::AppRestored, &mut NoopHook)?;
            companion
                .rollback()
                .map_err(|_| RecoveryError::CompanionRollback)?;
            transaction.persist_journal(RecoveryState::CompanionRolledBack, &mut NoopHook)?;
        }
        RecoveryState::AppRestored => {
            if !original {
                return Err(RecoveryError::invalid(
                    "restored update no longer owns the app identities",
                ));
            }
            companion
                .rollback()
                .map_err(|_| RecoveryError::CompanionRollback)?;
            transaction.persist_journal(RecoveryState::CompanionRolledBack, &mut NoopHook)?;
        }
        RecoveryState::CompanionRolledBack => {
            if !original {
                return Err(RecoveryError::invalid(
                    "rolled back update no longer owns the app identities",
                ));
            }
        }
    }
    transaction.remove_journal()
}

fn open_update_root(root: &Path) -> Result<(PathBuf, OwnedFd), RecoveryError> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|source| RecoveryError::io("inspect update root", source))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(RecoveryError::invalid(
            "update root must be a real directory, not a symlink",
        ));
    }
    let canonical = fs::canonicalize(root)
        .map_err(|source| RecoveryError::io("canonicalize update root", source))?;
    let root_c = CString::new(canonical.as_os_str().as_bytes())
        .map_err(|_| RecoveryError::invalid("update root contains a NUL byte"))?;
    let descriptor = unsafe {
        libc::open(
            root_c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        return Err(RecoveryError::io(
            "open update root",
            io::Error::last_os_error(),
        ));
    }
    let descriptor = unsafe { OwnedFd::from_raw_fd(descriptor) };
    if descriptor_identity(descriptor.as_raw_fd())
        .map_err(|source| RecoveryError::io("inspect opened update root", source))?
        != FileIdentity::from_metadata(&metadata)
    {
        return Err(RecoveryError::invalid(
            "update root identity changed while opening recovery",
        ));
    }
    Ok((canonical, descriptor))
}

fn read_recovery_journal(root: RawFd) -> Result<Option<RecoveryJournal>, RecoveryError> {
    for name in [UPDATE_JOURNAL_FILE, UPDATE_JOURNAL_TEMP] {
        let name_c = CString::new(name).expect("fixed update journal name");
        let descriptor = unsafe {
            libc::openat(
                root,
                name_c.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if descriptor < 0 {
            let source = io::Error::last_os_error();
            if source.kind() == io::ErrorKind::NotFound {
                continue;
            }
            return Err(RecoveryError::io("open update journal", source));
        }
        let mut file = unsafe { fs::File::from_raw_fd(descriptor) };
        let metadata = descriptor_stat(file.as_raw_fd())
            .map_err(|source| RecoveryError::io("inspect update journal", source))?;
        if metadata.st_mode as u32 & libc::S_IFMT as u32 != libc::S_IFREG as u32
            || metadata.st_mode as u32 & 0o777 != 0o600
            || metadata.st_uid != unsafe { libc::geteuid() }
            || metadata.st_nlink != 1
        {
            return Err(RecoveryError::invalid(
                "update journal ownership or permissions are unsafe",
            ));
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take((MAX_UPDATE_JOURNAL_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|source| RecoveryError::io("read update journal", source))?;
        if bytes.len() > MAX_UPDATE_JOURNAL_BYTES {
            return Err(RecoveryError::invalid("update journal is oversized"));
        }
        let journal = serde_json::from_slice(&bytes)
            .map_err(|source| RecoveryError::json("parse update journal", source))?;
        return Ok(Some(journal));
    }
    Ok(None)
}

fn validate_recovery_journal(journal: &RecoveryJournal) -> Result<(), RecoveryError> {
    for (name, label) in [
        (&journal.installed_name, "installed"),
        (&journal.candidate_name, "candidate"),
    ] {
        let path = Path::new(name);
        if name.is_empty()
            || !matches!(
                path.components().collect::<Vec<_>>().as_slice(),
                [std::path::Component::Normal(_)]
            )
            || path.extension() != Some(OsStr::new("app"))
        {
            return Err(RecoveryError::invalid(format!(
                "update journal {label} name is invalid"
            )));
        }
    }
    if journal.installed_name == journal.candidate_name
        || !journal.installed_identity.is_directory()
        || !journal.candidate_identity.is_directory()
        || journal.installed_identity.device != journal.candidate_identity.device
    {
        return Err(RecoveryError::invalid(
            "update journal app identities are invalid",
        ));
    }
    Ok(())
}

fn rename_entry(root: RawFd, source: &CStr, destination: &CStr) -> io::Result<()> {
    if unsafe { libc::renameat(root, source.as_ptr(), root, destination.as_ptr()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn remove_optional_file_at(root: RawFd, name: &str) -> Result<(), RecoveryError> {
    let name = CString::new(name).expect("fixed update journal name");
    let metadata = match stat_at(root, &name) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(source) => return Err(RecoveryError::io("inspect update journal removal", source)),
    };
    if metadata.st_mode as u32 & libc::S_IFMT as u32 != libc::S_IFREG as u32
        || metadata.st_uid != unsafe { libc::geteuid() }
        || metadata.st_nlink != 1
    {
        return Err(RecoveryError::invalid(
            "update journal removal target is unsafe",
        ));
    }
    if unsafe { libc::unlinkat(root, name.as_ptr(), 0) } < 0 {
        return Err(RecoveryError::io(
            "remove update journal",
            io::Error::last_os_error(),
        ));
    }
    Ok(())
}

fn stat_at(root: RawFd, name: &CStr) -> io::Result<libc::stat> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            root,
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

fn descriptor_stat(descriptor: RawFd) -> io::Result<libc::stat> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { metadata.assume_init() })
}

fn sync_directory(descriptor: RawFd) -> io::Result<()> {
    if unsafe { libc::fsync(descriptor) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn bundle_name(root: &Path, bundle: &Path, label: &str) -> Result<CString, RecoveryError> {
    let canonical_parent = bundle
        .parent()
        .ok_or_else(|| RecoveryError::invalid(format!("{label} app bundle has no parent")))
        .and_then(|parent| {
            fs::canonicalize(parent)
                .map_err(|source| RecoveryError::io("canonicalize app bundle parent", source))
        })?;
    if canonical_parent != root {
        return Err(RecoveryError::invalid(format!(
            "{label} app bundle must be a direct child of the update root"
        )));
    }
    let name = bundle
        .file_name()
        .ok_or_else(|| RecoveryError::invalid(format!("{label} app bundle has no file name")))?;
    if Path::new(name).extension() != Some(OsStr::new("app")) {
        return Err(RecoveryError::invalid(format!(
            "{label} app bundle must use the .app extension"
        )));
    }
    CString::new(name.as_bytes())
        .map_err(|_| RecoveryError::invalid(format!("{label} app bundle name contains NUL")))
}

fn descriptor_identity(descriptor: RawFd) -> io::Result<FileIdentity> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `metadata` points to writable storage and `descriptor` is open.
    if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful fstat initialized the complete stat value.
    Ok(FileIdentity::from_stat(unsafe { &metadata.assume_init() }))
}

fn identity_at(root: RawFd, name: &CStr) -> io::Result<FileIdentity> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `metadata` points to writable storage, `name` is a live
    // NUL-terminated path component, and `root` is an open directory fd.
    if unsafe {
        libc::fstatat(
            root,
            name.as_ptr(),
            metadata.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful fstatat initialized the complete stat value.
    Ok(FileIdentity::from_stat(unsafe { &metadata.assume_init() }))
}

fn bundle_identity_at(
    root: RawFd,
    name: &CStr,
    label: &str,
) -> Result<FileIdentity, RecoveryError> {
    let identity = identity_at(root, name)
        .map_err(|source| RecoveryError::io("inspect app bundle", source))?;
    if !identity.is_directory() {
        return Err(RecoveryError::invalid(format!(
            "{label} app bundle must be a real directory, not a symlink"
        )));
    }
    Ok(identity)
}

fn identity_error(label: &str, detail: impl fmt::Display) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("{label} identity changed: {detail}"),
    )
}

#[derive(Debug)]
pub enum RecoveryError {
    InvalidState(String),
    Io {
        operation: &'static str,
        source: io::Error,
    },
    RestoreFailed {
        restore: io::Error,
        candidate_republish: Option<io::Error>,
    },
    Json {
        operation: &'static str,
        source: serde_json::Error,
    },
    CompanionCommit,
    CompanionRollback,
}

impl RecoveryError {
    fn invalid(message: impl Into<String>) -> Self {
        Self::InvalidState(message.into())
    }

    fn io(operation: &'static str, source: io::Error) -> Self {
        Self::Io { operation, source }
    }

    fn json(operation: &'static str, source: serde_json::Error) -> Self {
        Self::Json { operation, source }
    }
}

impl fmt::Display for RecoveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidState(message) => formatter.write_str(message),
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
            Self::Json { operation, source } => write!(formatter, "{operation} failed: {source}"),
            Self::RestoreFailed {
                restore,
                candidate_republish,
            } => {
                write!(formatter, "restore old app bundle failed: {restore}")?;
                if let Some(republish) = candidate_republish {
                    write!(
                        formatter,
                        "; returning candidate to installation path also failed: {republish}"
                    )?;
                }
                Ok(())
            }
            Self::CompanionCommit => formatter.write_str("candidate companion commit failed"),
            Self::CompanionRollback => formatter.write_str("candidate companion rollback failed"),
        }
    }
}

impl Error for RecoveryError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidState(_) => None,
            Self::Io { source, .. } => Some(source),
            Self::Json { source, .. } => Some(source),
            Self::RestoreFailed { restore, .. } => Some(restore),
            Self::CompanionCommit | Self::CompanionRollback => None,
        }
    }
}
