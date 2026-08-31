use std::{
    error::Error,
    ffi::{CStr, CString, OsStr, OsString},
    fmt, fs,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::ffi::{OsStrExt, OsStringExt},
    },
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{
    channel::ReleaseChannel,
    recovery::{CommittedPublication, FileIdentity, PublicationCompanion},
};

const TEST_CLEANUP_JOURNAL_FILE: &str = ".openloop-update-cleanup-test.json";
const TEST_CLEANUP_JOURNAL_TEMP: &str = ".openloop-update-cleanup-test.tmp";
const STABLE_CLEANUP_JOURNAL_FILE: &str = ".openloop-update-cleanup-stable.json";
const STABLE_CLEANUP_JOURNAL_TEMP: &str = ".openloop-update-cleanup-stable.tmp";
const CLEANUP_ISOLATION_PREFIX: &str = ".openloop-cleanup-";
const MAX_CLEANUP_JOURNAL_BYTES: usize = 64 * 1024;

#[cfg(debug_assertions)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupBoundary {
    BeforeJournalFileFsync,
    AfterJournalFileFsync,
    BeforeJournalRename,
    AfterJournalRename,
    BeforeJournalParentFsync,
    AfterJournalParentFsync,
    BeforeBackupIsolation,
    AfterBackupRenameBeforeVerify,
    AfterBackupIsolation,
    BeforeChildIsolation,
    BeforeLeafIsolation,
    BeforeBackupUnlink,
    AfterBackupUnlink,
    BeforeUpdateRootFsync,
    AfterUpdateRootFsync,
    BeforeJournalUnlink,
    AfterJournalUnlink,
    BeforeJournalRemovalParentFsync,
    AfterJournalRemovalParentFsync,
}

#[cfg(not(debug_assertions))]
#[derive(Debug, Clone, Copy)]
enum CleanupBoundary {
    BeforeJournalFileFsync,
    AfterJournalFileFsync,
    BeforeJournalRename,
    AfterJournalRename,
    BeforeJournalParentFsync,
    AfterJournalParentFsync,
    BeforeBackupIsolation,
    AfterBackupRenameBeforeVerify,
    AfterBackupIsolation,
    BeforeChildIsolation,
    BeforeLeafIsolation,
    BeforeBackupUnlink,
    AfterBackupUnlink,
    BeforeUpdateRootFsync,
    AfterUpdateRootFsync,
    BeforeJournalUnlink,
    AfterJournalUnlink,
    BeforeJournalRemovalParentFsync,
    AfterJournalRemovalParentFsync,
}

#[cfg(debug_assertions)]
pub trait CleanupTestHook {
    fn reached(&mut self, boundary: CleanupBoundary);

    fn reached_entry(&mut self, boundary: CleanupBoundary, _: RawFd, _: &CStr) {
        self.reached(boundary);
    }

    fn after_entry_isolation(&mut self, _: RawFd, _: &CStr, _: &CStr) {}

    fn after_entry_delete(&mut self, _: RawFd, _: &CStr, _: &CStr) {}
}

trait CleanupHook {
    fn reached(&mut self, boundary: CleanupBoundary);

    fn reached_entry(&mut self, boundary: CleanupBoundary, _: RawFd, _: &CStr) {
        self.reached(boundary);
    }

    fn after_entry_isolation(&mut self, _: RawFd, _: &CStr, _: &CStr) {}

    fn after_entry_delete(&mut self, _: RawFd, _: &CStr, _: &CStr) {}
}

struct NoopCleanupHook;

impl CleanupHook for NoopCleanupHook {
    fn reached(&mut self, _: CleanupBoundary) {}
}

#[cfg(debug_assertions)]
struct TestCleanupHook<'a>(&'a mut dyn CleanupTestHook);

#[cfg(debug_assertions)]
impl CleanupHook for TestCleanupHook<'_> {
    fn reached(&mut self, boundary: CleanupBoundary) {
        self.0.reached(boundary);
    }

    fn reached_entry(&mut self, boundary: CleanupBoundary, parent: RawFd, name: &CStr) {
        self.0.reached_entry(boundary, parent, name);
    }

    fn after_entry_isolation(&mut self, parent: RawFd, original: &CStr, isolated: &CStr) {
        self.0.after_entry_isolation(parent, original, isolated);
    }

    fn after_entry_delete(&mut self, parent: RawFd, original: &CStr, isolated: &CStr) {
        self.0.after_entry_delete(parent, original, isolated);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CleanupEntry {
    name: Vec<u8>,
    identity: FileIdentity,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum CleanupEntryType {
    Directory,
    Regular,
    Symlink,
}

impl CleanupEntryType {
    fn from_identity(identity: FileIdentity) -> Result<Self, CleanupError> {
        match identity.file_type {
            value if value == libc::S_IFDIR as u32 => Ok(Self::Directory),
            value if value == libc::S_IFREG as u32 => Ok(Self::Regular),
            value if value == libc::S_IFLNK as u32 => Ok(Self::Symlink),
            _ => Err(CleanupError::invalid(
                "cleanup backup contains a special filesystem entry",
            )),
        }
    }

    fn unlink_flags(self) -> i32 {
        match self {
            Self::Directory => libc::AT_REMOVEDIR,
            Self::Regular | Self::Symlink => 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CleanupPathComponent {
    name: Vec<u8>,
    identity: FileIdentity,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum CleanupIsolatePhase {
    Prepared,
    Deleting,
    Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActiveCleanupIsolate {
    publication_id: Uuid,
    parent_path: Vec<CleanupPathComponent>,
    original_name: Vec<u8>,
    expected_identity: FileIdentity,
    expected_type: CleanupEntryType,
    isolation_name: Vec<u8>,
    phase: CleanupIsolatePhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_isolate: Option<Box<ActiveCleanupIsolate>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CleanupJournal {
    publication_id: Uuid,
    update_root: Vec<u8>,
    update_root_identity: FileIdentity,
    installed: CleanupEntry,
    backup: CleanupEntry,
    isolated_name: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active_isolate: Option<ActiveCleanupIsolate>,
}

impl CleanupJournal {
    fn from_publication(publication: &CommittedPublication) -> Self {
        Self {
            publication_id: publication.publication_id,
            update_root: publication.update_root.as_os_str().as_bytes().to_vec(),
            update_root_identity: publication.update_root_identity,
            installed: CleanupEntry {
                name: publication.installed_name.clone(),
                identity: publication.installed_identity,
            },
            backup: CleanupEntry {
                name: publication.backup_name.clone(),
                identity: publication.backup_identity,
            },
            isolated_name: new_isolation_name(publication.publication_id).into_bytes(),
            active_isolate: None,
        }
    }

    fn same_publication(&self, other: &Self) -> bool {
        self.publication_id == other.publication_id
            && self.update_root == other.update_root
            && self.update_root_identity == other.update_root_identity
            && self.installed == other.installed
            && self.backup == other.backup
    }
}

pub fn cleanup_journal_path(channel_root: &Path, channel: ReleaseChannel) -> PathBuf {
    channel_root.join(journal_names(channel).0)
}

pub struct CleanupCompanion<'a> {
    channel_root: PathBuf,
    channel: ReleaseChannel,
    inner: Option<&'a mut dyn PublicationCompanion>,
    #[cfg(debug_assertions)]
    hook: Option<&'a mut dyn CleanupTestHook>,
}

impl CleanupCompanion<'static> {
    pub fn new(channel_root: &Path, channel: ReleaseChannel) -> Result<Self, CleanupError> {
        validate_channel_root(channel_root)?;
        Ok(Self {
            channel_root: channel_root.to_owned(),
            channel,
            inner: None,
            #[cfg(debug_assertions)]
            hook: None,
        })
    }
}

impl<'a> CleanupCompanion<'a> {
    pub fn with_companion(
        channel_root: &Path,
        channel: ReleaseChannel,
        inner: &'a mut dyn PublicationCompanion,
    ) -> Result<Self, CleanupError> {
        validate_channel_root(channel_root)?;
        Ok(Self {
            channel_root: channel_root.to_owned(),
            channel,
            inner: Some(inner),
            #[cfg(debug_assertions)]
            hook: None,
        })
    }

    #[cfg(debug_assertions)]
    pub fn new_with_hook(
        channel_root: &Path,
        channel: ReleaseChannel,
        hook: &'a mut dyn CleanupTestHook,
    ) -> Result<Self, CleanupError> {
        validate_channel_root(channel_root)?;
        Ok(Self {
            channel_root: channel_root.to_owned(),
            channel,
            inner: None,
            hook: Some(hook),
        })
    }

    fn persist(&mut self, publication: &CommittedPublication) -> Result<(), CleanupError> {
        let journal = CleanupJournal::from_publication(publication);
        #[cfg(debug_assertions)]
        if let Some(hook) = self.hook.as_deref_mut() {
            return persist_cleanup_journal(
                &self.channel_root,
                self.channel,
                &journal,
                &mut TestCleanupHook(hook),
            );
        }
        persist_cleanup_journal(
            &self.channel_root,
            self.channel,
            &journal,
            &mut NoopCleanupHook,
        )
    }
}

impl PublicationCompanion for CleanupCompanion<'_> {
    fn commit(&mut self, publication: &CommittedPublication) -> Result<(), String> {
        if let Some(inner) = self.inner.as_deref_mut() {
            inner.commit(publication)?;
        }
        self.persist(publication).map_err(|error| error.to_string())
    }

    fn rollback(&mut self) -> Result<(), String> {
        match self.inner.as_deref_mut() {
            Some(inner) => inner.rollback(),
            None => Ok(()),
        }
    }
}

#[derive(Debug)]
pub struct PendingCleanup {
    channel_root: OwnedFd,
    update_root: OwnedFd,
    channel: ReleaseChannel,
    journal: CleanupJournal,
    journal_identity: FileIdentity,
    acknowledged: bool,
}

impl PendingCleanup {
    pub fn execute(&mut self) -> Result<(), CleanupError> {
        self.execute_inner(&mut NoopCleanupHook)
    }

    #[cfg(debug_assertions)]
    pub fn execute_with_hook(
        &mut self,
        hook: &mut dyn CleanupTestHook,
    ) -> Result<(), CleanupError> {
        self.execute_inner(&mut TestCleanupHook(hook))
    }

    fn execute_inner(&mut self, hook: &mut impl CleanupHook) -> Result<(), CleanupError> {
        if self.acknowledged {
            return Ok(());
        }
        let (journal_name, _) = journal_names(self.channel);
        verify_journal_security(
            self.channel_root.as_raw_fd(),
            &cstring(journal_name.as_bytes(), "cleanup journal name")?,
            self.journal_identity,
        )?;
        verify_descriptor_identity(
            self.update_root.as_raw_fd(),
            self.journal.update_root_identity,
            "cleanup update root",
        )?;
        let installed = entry_name(&self.journal.installed, "installed")?;
        let backup = entry_name(&self.journal.backup, "backup")?;
        let isolated = journal_isolation_name(&self.journal)?;
        verify_identity(
            self.update_root.as_raw_fd(),
            &installed,
            self.journal.installed.identity,
            "installed app",
        )?;

        let location = backup_location(
            self.update_root.as_raw_fd(),
            &backup,
            &isolated,
            self.journal.backup.identity,
        )?;
        let directory = match location {
            BackupLocation::Original => {
                verify_identity(
                    self.update_root.as_raw_fd(),
                    &installed,
                    self.journal.installed.identity,
                    "installed app before backup isolation",
                )?;
                hook.reached(CleanupBoundary::BeforeBackupIsolation);
                rename_exclusive_at(self.update_root.as_raw_fd(), &backup, &isolated)
                    .map_err(|source| CleanupError::io("isolate cleanup backup", source))?;
                hook.reached(CleanupBoundary::AfterBackupRenameBeforeVerify);
                if let Err(error) = verify_identity(
                    self.update_root.as_raw_fd(),
                    &isolated,
                    self.journal.backup.identity,
                    "isolated cleanup backup",
                ) {
                    restore_isolated_entry(
                        self.update_root.as_raw_fd(),
                        &isolated,
                        &backup,
                        "cleanup backup",
                    )?;
                    return Err(error);
                }
                let directory = open_freshly_isolated_directory(
                    self.update_root.as_raw_fd(),
                    &isolated,
                    &backup,
                    self.journal.backup.identity,
                    "cleanup backup descriptor",
                )?;
                if let Err(error) = verify_identity(
                    self.update_root.as_raw_fd(),
                    &installed,
                    self.journal.installed.identity,
                    "installed app after backup isolation",
                ) {
                    drop(directory);
                    restore_isolated_entry(
                        self.update_root.as_raw_fd(),
                        &isolated,
                        &backup,
                        "cleanup backup",
                    )?;
                    return Err(error);
                }
                sync_directory(self.update_root.as_raw_fd())
                    .map_err(|source| CleanupError::io("sync cleanup backup isolation", source))?;
                hook.reached(CleanupBoundary::AfterBackupIsolation);
                Some(directory)
            }
            BackupLocation::Isolated => {
                let directory = open_directory_at(self.update_root.as_raw_fd(), &isolated)
                    .map_err(|source| CleanupError::io("open isolated cleanup backup", source))?;
                verify_descriptor_identity(
                    directory.as_raw_fd(),
                    self.journal.backup.identity,
                    "cleanup backup descriptor",
                )?;
                Some(directory)
            }
            BackupLocation::Missing => None,
        };

        if let Some(directory) = directory {
            while self.journal.active_isolate.is_some() {
                self.resume_active_isolate(hook)?;
            }
            self.delete_directory_contents(directory.as_raw_fd(), &[], hook)?;
            verify_identity(
                self.update_root.as_raw_fd(),
                &installed,
                self.journal.installed.identity,
                "installed app",
            )?;
            verify_descriptor_identity(
                directory.as_raw_fd(),
                self.journal.backup.identity,
                "cleanup backup descriptor",
            )?;
            verify_identity(
                self.update_root.as_raw_fd(),
                &isolated,
                self.journal.backup.identity,
                "isolated cleanup backup",
            )?;
            hook.reached(CleanupBoundary::BeforeBackupUnlink);
            if unsafe {
                libc::unlinkat(
                    self.update_root.as_raw_fd(),
                    isolated.as_ptr(),
                    libc::AT_REMOVEDIR,
                )
            } < 0
            {
                return Err(CleanupError::io(
                    "remove isolated cleanup backup directory",
                    io::Error::last_os_error(),
                ));
            }
            hook.reached(CleanupBoundary::AfterBackupUnlink);
        }

        hook.reached(CleanupBoundary::BeforeUpdateRootFsync);
        sync_directory(self.update_root.as_raw_fd())
            .map_err(|source| CleanupError::io("sync cleanup update root", source))?;
        hook.reached(CleanupBoundary::AfterUpdateRootFsync);
        match identity_at(self.update_root.as_raw_fd(), &backup) {
            Ok(identity) if identity == self.journal.backup.identity => {
                return Err(CleanupError::invalid(
                    "cleanup backup exists at both original and isolated names",
                ));
            }
            Ok(_) => {
                return Err(CleanupError::invalid(
                    "cleanup backup original name is occupied by a replacement; cleanup journal retained",
                ));
            }
            Err(source) if source.kind() == io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(CleanupError::io("inspect original cleanup backup", source));
            }
        }
        if let Err(error) = remove_cleanup_journal(
            self.channel_root.as_raw_fd(),
            self.channel,
            self.journal_identity,
            &self.journal,
            hook,
        ) {
            let (journal_name, _) = journal_names(self.channel);
            if let Ok(Some((journal, identity))) =
                read_cleanup_journal(self.channel_root.as_raw_fd(), journal_name)
            {
                if journal == self.journal {
                    self.journal_identity = identity;
                }
            }
            return Err(error);
        }
        self.acknowledged = true;
        Ok(())
    }

    pub fn is_acknowledged(&self) -> bool {
        self.acknowledged
    }

    fn persist_journal_update(
        &mut self,
        previous: CleanupJournal,
        hook: &mut impl CleanupHook,
    ) -> Result<(), CleanupError> {
        let desired = self.journal.clone();
        match replace_cleanup_journal_at(
            self.channel_root.as_raw_fd(),
            self.channel,
            self.journal_identity,
            &desired,
            hook,
        ) {
            Ok(identity) => {
                self.journal_identity = identity;
                Ok(())
            }
            Err(error) => {
                self.journal = previous;
                let (journal_name, _) = journal_names(self.channel);
                if let Ok(Some((journal, identity))) =
                    read_cleanup_journal(self.channel_root.as_raw_fd(), journal_name)
                {
                    if journal == desired || journal == self.journal {
                        self.journal = journal;
                        self.journal_identity = identity;
                    }
                }
                Err(error)
            }
        }
    }

    fn delete_directory_contents(
        &mut self,
        directory: RawFd,
        parent_path: &[CleanupPathComponent],
        hook: &mut impl CleanupHook,
    ) -> Result<(), CleanupError> {
        for name in directory_entries(directory)? {
            if name
                .to_bytes()
                .starts_with(CLEANUP_ISOLATION_PREFIX.as_bytes())
            {
                return Err(CleanupError::invalid(
                    "cleanup backup contains an unjournaled isolation entry",
                ));
            }
            let metadata = match stat_at(directory, &name) {
                Ok(metadata) => metadata,
                Err(source) if source.kind() == io::ErrorKind::NotFound => continue,
                Err(source) => return Err(CleanupError::io("inspect cleanup entry", source)),
            };
            let identity = FileIdentity::from_stat(&metadata);
            if identity.device != self.journal.backup.identity.device {
                return Err(CleanupError::invalid(
                    "cleanup backup crosses a filesystem boundary",
                ));
            }
            let expected_type = CleanupEntryType::from_identity(identity)?;
            self.delete_entry(parent_path, &name, identity, expected_type, hook)?;
        }
        Ok(())
    }

    fn delete_entry(
        &mut self,
        parent_path: &[CleanupPathComponent],
        original: &CStr,
        expected_identity: FileIdentity,
        expected_type: CleanupEntryType,
        hook: &mut impl CleanupHook,
    ) -> Result<(), CleanupError> {
        let previous = self.journal.clone();
        let parent_isolate = self.journal.active_isolate.take().map(Box::new);
        self.journal.active_isolate = Some(ActiveCleanupIsolate {
            publication_id: self.journal.publication_id,
            parent_path: parent_path.to_vec(),
            original_name: original.to_bytes().to_vec(),
            expected_identity,
            expected_type,
            isolation_name: new_isolation_name(self.journal.publication_id).into_bytes(),
            phase: CleanupIsolatePhase::Prepared,
            parent_isolate,
        });
        self.persist_journal_update(previous, hook)?;
        self.resume_active_isolate(hook)
    }

    fn resume_active_isolate(&mut self, hook: &mut impl CleanupHook) -> Result<(), CleanupError> {
        let active = self
            .journal
            .active_isolate
            .clone()
            .ok_or_else(|| CleanupError::invalid("cleanup isolate is not active"))?;
        validate_active_isolate(&self.journal, &active)?;
        let parent = self.open_active_parent(&active)?;
        let original = path_component(&active.original_name, "active cleanup original name")?;
        let isolated = cleanup_isolation_name(
            self.journal.publication_id,
            &active.isolation_name,
            "active cleanup isolation name",
        )?;

        if active.phase == CleanupIsolatePhase::Prepared {
            let isolated_identity = optional_identity_at(parent.as_raw_fd(), &isolated)?;
            let original_identity = optional_identity_at(parent.as_raw_fd(), &original)?;
            match isolated_identity {
                Some(identity) if identity == active.expected_identity => {
                    if original_identity == Some(active.expected_identity) {
                        return Err(CleanupError::invalid(
                            "active cleanup isolate exists at both original and isolated names",
                        ));
                    }
                }
                Some(_) => {
                    return Err(CleanupError::invalid(
                        "active cleanup isolate identity changed",
                    ));
                }
                None => {
                    if original_identity != Some(active.expected_identity) {
                        return Err(CleanupError::invalid(
                            "active cleanup isolate source identity changed before rename",
                        ));
                    }
                    let boundary = match active.expected_type {
                        CleanupEntryType::Directory => CleanupBoundary::BeforeChildIsolation,
                        CleanupEntryType::Regular | CleanupEntryType::Symlink => {
                            CleanupBoundary::BeforeLeafIsolation
                        }
                    };
                    hook.reached_entry(boundary, parent.as_raw_fd(), &original);
                    rename_exclusive_at(parent.as_raw_fd(), &original, &isolated)
                        .map_err(|source| CleanupError::io("isolate cleanup entry", source))?;
                    hook.after_entry_isolation(parent.as_raw_fd(), &original, &isolated);
                    if let Err(error) = verify_identity(
                        parent.as_raw_fd(),
                        &isolated,
                        active.expected_identity,
                        "active cleanup isolate",
                    ) {
                        restore_isolated_entry(
                            parent.as_raw_fd(),
                            &isolated,
                            &original,
                            "active cleanup isolate",
                        )?;
                        return Err(error);
                    }
                }
            }
            sync_directory(parent.as_raw_fd())
                .map_err(|source| CleanupError::io("sync cleanup entry isolation", source))?;
            let previous = self.journal.clone();
            self.journal
                .active_isolate
                .as_mut()
                .expect("active isolate retained")
                .phase = CleanupIsolatePhase::Deleting;
            self.persist_journal_update(previous, hook)?;
        }

        let active = self
            .journal
            .active_isolate
            .clone()
            .ok_or_else(|| CleanupError::invalid("cleanup isolate disappeared"))?;
        if active.phase == CleanupIsolatePhase::Deleting {
            let isolated_identity = optional_identity_at(parent.as_raw_fd(), &isolated)?;
            let original_identity = optional_identity_at(parent.as_raw_fd(), &original)?;
            match isolated_identity {
                Some(identity) if identity == active.expected_identity => {
                    if original_identity == Some(active.expected_identity) {
                        return Err(CleanupError::invalid(
                            "active cleanup isolate exists at both original and isolated names",
                        ));
                    }
                    let isolated_directory = if active.expected_type == CleanupEntryType::Directory
                    {
                        let directory =
                            open_directory_at(parent.as_raw_fd(), &isolated).map_err(|source| {
                                CleanupError::io("open active cleanup isolate directory", source)
                            })?;
                        verify_descriptor_identity(
                            directory.as_raw_fd(),
                            active.expected_identity,
                            "active cleanup isolate directory",
                        )?;
                        let mut child_path = active.parent_path.clone();
                        child_path.push(CleanupPathComponent {
                            name: active.isolation_name.clone(),
                            identity: active.expected_identity,
                        });
                        self.delete_directory_contents(directory.as_raw_fd(), &child_path, hook)?;
                        verify_descriptor_identity(
                            directory.as_raw_fd(),
                            active.expected_identity,
                            "active cleanup isolate directory",
                        )?;
                        verify_identity(
                            parent.as_raw_fd(),
                            &isolated,
                            active.expected_identity,
                            "active cleanup isolate directory",
                        )?;
                        Some(directory)
                    } else {
                        None
                    };
                    if unsafe {
                        libc::unlinkat(
                            parent.as_raw_fd(),
                            isolated.as_ptr(),
                            active.expected_type.unlink_flags(),
                        )
                    } < 0
                    {
                        return Err(CleanupError::io(
                            "remove active cleanup isolate",
                            io::Error::last_os_error(),
                        ));
                    }
                    drop(isolated_directory);
                    hook.after_entry_delete(parent.as_raw_fd(), &original, &isolated);
                }
                Some(_) => {
                    return Err(CleanupError::invalid(
                        "active cleanup isolate identity changed",
                    ));
                }
                None if original_identity == Some(active.expected_identity) => {
                    return Err(CleanupError::invalid(
                        "active cleanup isolate source returned after rename",
                    ));
                }
                None => {}
            }
            sync_directory(parent.as_raw_fd())
                .map_err(|source| CleanupError::io("sync cleanup entry removal", source))?;
            let previous = self.journal.clone();
            self.journal
                .active_isolate
                .as_mut()
                .expect("active isolate retained")
                .phase = CleanupIsolatePhase::Deleted;
            self.persist_journal_update(previous, hook)?;
        }

        if optional_identity_at(parent.as_raw_fd(), &isolated)?.is_some() {
            return Err(CleanupError::invalid("deleted cleanup isolate reappeared"));
        }
        match optional_identity_at(parent.as_raw_fd(), &original)? {
            Some(identity) if identity == active.expected_identity => {
                Err(CleanupError::invalid(
                    "active cleanup original identity reappeared after deletion",
                ))
            }
            Some(_) => Err(CleanupError::invalid(
                "active cleanup original name is occupied by a replacement; diagnostic journal retained",
            )),
            None => {
                let previous = self.journal.clone();
                self.journal.active_isolate =
                    active.parent_isolate.map(|parent| *parent);
                self.persist_journal_update(previous, hook)
            }
        }
    }

    fn open_active_parent(&self, active: &ActiveCleanupIsolate) -> Result<OwnedFd, CleanupError> {
        let isolated = journal_isolation_name(&self.journal)?;
        let mut current = open_directory_at(self.update_root.as_raw_fd(), &isolated)
            .map_err(|source| CleanupError::io("open cleanup top quarantine", source))?;
        verify_descriptor_identity(
            current.as_raw_fd(),
            self.journal.backup.identity,
            "cleanup top quarantine",
        )?;
        for component in &active.parent_path {
            let name = path_component(&component.name, "active cleanup parent component")?;
            let child = open_directory_at(current.as_raw_fd(), &name)
                .map_err(|source| CleanupError::io("open active cleanup parent", source))?;
            verify_descriptor_identity(
                child.as_raw_fd(),
                component.identity,
                "active cleanup parent",
            )?;
            verify_identity(
                current.as_raw_fd(),
                &name,
                component.identity,
                "active cleanup parent",
            )?;
            current = child;
        }
        Ok(current)
    }
}

pub fn load_pending_cleanup(
    channel_root: &Path,
    channel: ReleaseChannel,
) -> Result<Option<PendingCleanup>, CleanupError> {
    let channel_root = open_verified_directory(channel_root, "cleanup channel root")?;
    let (journal_name, _) = journal_names(channel);
    let Some((journal, journal_identity)) =
        read_cleanup_journal(channel_root.as_raw_fd(), journal_name)?
    else {
        return Ok(None);
    };
    validate_cleanup_journal(&journal)?;
    let update_root_path = PathBuf::from(OsString::from_vec(journal.update_root.clone()));
    let update_root = open_directory(&update_root_path)
        .map_err(|source| CleanupError::io("open cleanup update root", source))?;
    verify_descriptor_identity(
        update_root.as_raw_fd(),
        journal.update_root_identity,
        "cleanup update root",
    )?;
    let installed = entry_name(&journal.installed, "installed")?;
    verify_identity(
        update_root.as_raw_fd(),
        &installed,
        journal.installed.identity,
        "installed app",
    )?;
    let backup = entry_name(&journal.backup, "backup")?;
    let isolated = journal_isolation_name(&journal)?;
    backup_location(
        update_root.as_raw_fd(),
        &backup,
        &isolated,
        journal.backup.identity,
    )?;
    Ok(Some(PendingCleanup {
        channel_root,
        update_root,
        channel,
        journal,
        journal_identity,
        acknowledged: false,
    }))
}

fn persist_cleanup_journal(
    channel_root_path: &Path,
    channel: ReleaseChannel,
    journal: &CleanupJournal,
    hook: &mut impl CleanupHook,
) -> Result<(), CleanupError> {
    let channel_root = open_verified_directory(channel_root_path, "cleanup channel root")?;
    persist_cleanup_journal_at(channel_root.as_raw_fd(), channel, journal, hook)
}

fn persist_cleanup_journal_at(
    channel_root: RawFd,
    channel: ReleaseChannel,
    journal: &CleanupJournal,
    hook: &mut impl CleanupHook,
) -> Result<(), CleanupError> {
    let (journal_name, temp_name) = journal_names(channel);
    if let Some((existing, _)) = read_cleanup_journal(channel_root, journal_name)? {
        validate_cleanup_journal(&existing)?;
        return if existing.same_publication(journal) {
            remove_optional_regular_file(channel_root, temp_name)?;
            hook.reached(CleanupBoundary::BeforeJournalParentFsync);
            sync_directory(channel_root)
                .map_err(|source| CleanupError::io("sync cleanup journal directory", source))?;
            hook.reached(CleanupBoundary::AfterJournalParentFsync);
            Ok(())
        } else {
            Err(CleanupError::invalid(
                "cleanup journal conflicts with another publication",
            ))
        };
    }
    let temp = write_cleanup_journal_temp(channel_root, temp_name, journal, hook)?;
    hook.reached(CleanupBoundary::BeforeJournalRename);
    let destination = cstring(journal_name.as_bytes(), "cleanup journal name")?;
    if unsafe {
        libc::renameatx_np(
            channel_root,
            temp.as_ptr(),
            channel_root,
            destination.as_ptr(),
            libc::RENAME_EXCL,
        )
    } < 0
    {
        return Err(CleanupError::io(
            "publish cleanup journal",
            io::Error::last_os_error(),
        ));
    }
    hook.reached(CleanupBoundary::AfterJournalRename);
    let Some((published, _)) = read_cleanup_journal(channel_root, journal_name)? else {
        return Err(CleanupError::invalid(
            "published cleanup journal disappeared",
        ));
    };
    if published != *journal {
        return Err(CleanupError::invalid(
            "published cleanup journal identity changed",
        ));
    }
    hook.reached(CleanupBoundary::BeforeJournalParentFsync);
    sync_directory(channel_root)
        .map_err(|source| CleanupError::io("sync cleanup journal directory", source))?;
    hook.reached(CleanupBoundary::AfterJournalParentFsync);
    Ok(())
}

fn replace_cleanup_journal_at(
    channel_root: RawFd,
    channel: ReleaseChannel,
    expected: FileIdentity,
    journal: &CleanupJournal,
    hook: &mut impl CleanupHook,
) -> Result<FileIdentity, CleanupError> {
    let (journal_name, temp_name) = journal_names(channel);
    let destination = cstring(journal_name.as_bytes(), "cleanup journal name")?;
    verify_journal_security(channel_root, &destination, expected)?;
    let temp = write_cleanup_journal_temp(channel_root, temp_name, journal, hook)?;
    verify_journal_security(channel_root, &destination, expected)?;
    hook.reached(CleanupBoundary::BeforeJournalRename);
    if unsafe {
        libc::renameat(
            channel_root,
            temp.as_ptr(),
            channel_root,
            destination.as_ptr(),
        )
    } < 0
    {
        return Err(CleanupError::io(
            "replace cleanup journal",
            io::Error::last_os_error(),
        ));
    }
    hook.reached(CleanupBoundary::AfterJournalRename);
    let Some((published, identity)) = read_cleanup_journal(channel_root, journal_name)? else {
        return Err(CleanupError::invalid(
            "replaced cleanup journal disappeared",
        ));
    };
    if published != *journal {
        return Err(CleanupError::invalid(
            "replaced cleanup journal identity changed",
        ));
    }
    hook.reached(CleanupBoundary::BeforeJournalParentFsync);
    sync_directory(channel_root)
        .map_err(|source| CleanupError::io("sync cleanup journal directory", source))?;
    hook.reached(CleanupBoundary::AfterJournalParentFsync);
    Ok(identity)
}

fn write_cleanup_journal_temp(
    channel_root: RawFd,
    temp_name: &str,
    journal: &CleanupJournal,
    hook: &mut impl CleanupHook,
) -> Result<CString, CleanupError> {
    validate_cleanup_journal(journal)?;
    remove_optional_regular_file(channel_root, temp_name)?;
    let bytes = serde_json::to_vec(journal)
        .map_err(|source| CleanupError::json("serialize cleanup journal", source))?;
    if bytes.len() > MAX_CLEANUP_JOURNAL_BYTES {
        return Err(CleanupError::invalid("cleanup journal is oversized"));
    }
    let temp = cstring(temp_name.as_bytes(), "cleanup journal temp name")?;
    let descriptor = unsafe {
        libc::openat(
            channel_root,
            temp.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(CleanupError::io(
            "create cleanup journal temp file",
            io::Error::last_os_error(),
        ));
    }
    let mut file = unsafe { fs::File::from_raw_fd(descriptor) };
    file.write_all(&bytes)
        .map_err(|source| CleanupError::io("write cleanup journal", source))?;
    hook.reached(CleanupBoundary::BeforeJournalFileFsync);
    file.sync_all()
        .map_err(|source| CleanupError::io("sync cleanup journal", source))?;
    hook.reached(CleanupBoundary::AfterJournalFileFsync);
    drop(file);
    Ok(temp)
}

fn read_cleanup_journal(
    root: RawFd,
    name: &str,
) -> Result<Option<(CleanupJournal, FileIdentity)>, CleanupError> {
    let name = cstring(name.as_bytes(), "cleanup journal name")?;
    let descriptor = unsafe {
        libc::openat(
            root,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
        )
    };
    if descriptor < 0 {
        let source = io::Error::last_os_error();
        return if source.kind() == io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(CleanupError::io("open cleanup journal", source))
        };
    }
    let mut file = unsafe { fs::File::from_raw_fd(descriptor) };
    let metadata = descriptor_stat(file.as_raw_fd())
        .map_err(|source| CleanupError::io("inspect cleanup journal", source))?;
    if file_type(&metadata) != libc::S_IFREG as u32
        || metadata.st_mode as u32 & 0o777 != 0o600
        || metadata.st_uid != unsafe { libc::geteuid() }
        || metadata.st_nlink != 1
    {
        return Err(CleanupError::invalid(
            "cleanup journal ownership or permissions are unsafe",
        ));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take((MAX_CLEANUP_JOURNAL_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|source| CleanupError::io("read cleanup journal", source))?;
    if bytes.len() > MAX_CLEANUP_JOURNAL_BYTES {
        return Err(CleanupError::invalid("cleanup journal is oversized"));
    }
    let journal = serde_json::from_slice(&bytes)
        .map_err(|source| CleanupError::json("parse cleanup journal", source))?;
    Ok(Some((journal, FileIdentity::from_stat(&metadata))))
}

fn validate_cleanup_journal(journal: &CleanupJournal) -> Result<(), CleanupError> {
    let update_root = Path::new(OsStr::from_bytes(&journal.update_root));
    if !update_root.is_absolute()
        || !journal.update_root_identity.is_directory()
        || !journal.installed.identity.is_directory()
        || !journal.backup.identity.is_directory()
        || journal.update_root_identity.device != journal.installed.identity.device
        || journal.update_root_identity.device != journal.backup.identity.device
    {
        return Err(CleanupError::invalid(
            "cleanup journal filesystem identities are invalid",
        ));
    }
    entry_name(&journal.installed, "installed")?;
    entry_name(&journal.backup, "backup")?;
    let isolated = journal_isolation_name(journal)?;
    if journal.installed.name == journal.backup.name
        || isolated.to_bytes() == journal.installed.name
        || isolated.to_bytes() == journal.backup.name
    {
        return Err(CleanupError::invalid("cleanup journal app names overlap"));
    }
    if let Some(active) = journal.active_isolate.as_ref() {
        validate_active_isolate(journal, active)?;
    }
    Ok(())
}

fn validate_active_isolate(
    journal: &CleanupJournal,
    active: &ActiveCleanupIsolate,
) -> Result<(), CleanupError> {
    if active.publication_id != journal.publication_id
        || active.expected_identity.device != journal.update_root_identity.device
        || CleanupEntryType::from_identity(active.expected_identity)? != active.expected_type
    {
        return Err(CleanupError::invalid(
            "active cleanup isolate is not bound to its publication",
        ));
    }
    for component in &active.parent_path {
        path_component(&component.name, "active cleanup parent component")?;
        if !component.identity.is_directory()
            || component.identity.device != journal.update_root_identity.device
        {
            return Err(CleanupError::invalid(
                "active cleanup parent path is invalid",
            ));
        }
    }
    let original = path_component(&active.original_name, "active cleanup original name")?;
    let isolated = cleanup_isolation_name(
        journal.publication_id,
        &active.isolation_name,
        "active cleanup isolation name",
    )?;
    if original.to_bytes() == isolated.to_bytes()
        || original
            .to_bytes()
            .starts_with(CLEANUP_ISOLATION_PREFIX.as_bytes())
    {
        return Err(CleanupError::invalid(
            "active cleanup isolate names overlap",
        ));
    }
    match active.parent_isolate.as_deref() {
        Some(parent) => {
            validate_active_isolate(journal, parent)?;
            let mut expected_parent_path = parent.parent_path.clone();
            expected_parent_path.push(CleanupPathComponent {
                name: parent.isolation_name.clone(),
                identity: parent.expected_identity,
            });
            if parent.expected_type != CleanupEntryType::Directory
                || parent.phase != CleanupIsolatePhase::Deleting
                || active.parent_path != expected_parent_path
            {
                return Err(CleanupError::invalid(
                    "active cleanup isolate parent chain is invalid",
                ));
            }
        }
        None if !active.parent_path.is_empty() => {
            return Err(CleanupError::invalid(
                "active cleanup isolate parent chain is incomplete",
            ));
        }
        None => {}
    }
    Ok(())
}

fn entry_name(entry: &CleanupEntry, label: &str) -> Result<CString, CleanupError> {
    let name = OsStr::from_bytes(&entry.name);
    let path = Path::new(name);
    if entry.name.is_empty()
        || !matches!(
            path.components().collect::<Vec<_>>().as_slice(),
            [std::path::Component::Normal(_)]
        )
        || path.extension() != Some(OsStr::new("app"))
    {
        return Err(CleanupError::invalid(format!(
            "cleanup journal {label} name is invalid"
        )));
    }
    cstring(&entry.name, "cleanup app name")
}

fn path_component(bytes: &[u8], label: &str) -> Result<CString, CleanupError> {
    let path = Path::new(OsStr::from_bytes(bytes));
    if bytes.is_empty()
        || !matches!(
            path.components().collect::<Vec<_>>().as_slice(),
            [std::path::Component::Normal(_)]
        )
    {
        return Err(CleanupError::invalid(format!("{label} is invalid")));
    }
    cstring(bytes, label)
}

fn new_isolation_name(publication_id: Uuid) -> String {
    format!(
        "{CLEANUP_ISOLATION_PREFIX}{publication_id}-{}",
        Uuid::new_v4()
    )
}

fn journal_isolation_name(journal: &CleanupJournal) -> Result<CString, CleanupError> {
    cleanup_isolation_name(
        journal.publication_id,
        &journal.isolated_name,
        "cleanup journal isolation name",
    )
}

fn cleanup_isolation_name(
    publication_id: Uuid,
    bytes: &[u8],
    label: &str,
) -> Result<CString, CleanupError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| CleanupError::invalid(format!("{label} is invalid")))?;
    let prefix = format!("{CLEANUP_ISOLATION_PREFIX}{publication_id}-");
    let Some(uuid) = text.strip_prefix(&prefix) else {
        return Err(CleanupError::invalid(format!(
            "{label} is not bound to its publication"
        )));
    };
    let parsed =
        Uuid::parse_str(uuid).map_err(|_| CleanupError::invalid(format!("{label} is invalid")))?;
    let path = Path::new(OsStr::from_bytes(bytes));
    if parsed.to_string() != uuid
        || !matches!(
            path.components().collect::<Vec<_>>().as_slice(),
            [std::path::Component::Normal(_)]
        )
    {
        return Err(CleanupError::invalid(format!("{label} is invalid")));
    }
    cstring(bytes, label)
}

fn rename_exclusive_at(directory: RawFd, source: &CStr, destination: &CStr) -> io::Result<()> {
    if unsafe {
        libc::renameatx_np(
            directory,
            source.as_ptr(),
            directory,
            destination.as_ptr(),
            libc::RENAME_EXCL,
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BackupLocation {
    Original,
    Isolated,
    Missing,
}

fn backup_location(
    directory: RawFd,
    original: &CStr,
    isolated: &CStr,
    expected: FileIdentity,
) -> Result<BackupLocation, CleanupError> {
    match identity_at(directory, isolated) {
        Ok(actual) if actual == expected && actual.is_directory() => {
            return match identity_at(directory, original) {
                Ok(identity) if identity == expected => Err(CleanupError::invalid(
                    "cleanup backup exists at both original and isolated names",
                )),
                Ok(_) => Err(CleanupError::invalid(
                    "cleanup backup original name is occupied after isolation",
                )),
                Err(source) if source.kind() == io::ErrorKind::NotFound => {
                    Ok(BackupLocation::Isolated)
                }
                Err(source) => Err(CleanupError::io("inspect original cleanup backup", source)),
            };
        }
        Ok(_) => {
            if matches!(
                identity_at(directory, original),
                Err(source) if source.kind() == io::ErrorKind::NotFound
            ) {
                restore_isolated_entry(directory, isolated, original, "cleanup backup")?;
            }
            return Err(CleanupError::invalid(
                "isolated cleanup backup identity changed",
            ));
        }
        Err(source) if source.kind() == io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(CleanupError::io("inspect isolated cleanup backup", source));
        }
    }
    match identity_at(directory, original) {
        Ok(actual) if actual == expected && actual.is_directory() => Ok(BackupLocation::Original),
        Ok(_) => Err(CleanupError::invalid(
            "cleanup backup identity changed before isolation",
        )),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(BackupLocation::Missing),
        Err(source) => Err(CleanupError::io("inspect cleanup backup", source)),
    }
}

fn open_freshly_isolated_directory(
    directory: RawFd,
    isolated: &CStr,
    original: &CStr,
    expected: FileIdentity,
    label: &str,
) -> Result<OwnedFd, CleanupError> {
    let child = match open_directory_at(directory, isolated) {
        Ok(child) => child,
        Err(source) => {
            restore_isolated_entry(directory, isolated, original, label)?;
            return Err(CleanupError::io("open isolated cleanup directory", source));
        }
    };
    if let Err(error) = verify_descriptor_identity(child.as_raw_fd(), expected, label) {
        drop(child);
        restore_isolated_entry(directory, isolated, original, label)?;
        return Err(error);
    }
    Ok(child)
}

fn restore_isolated_entry(
    directory: RawFd,
    isolated: &CStr,
    original: &CStr,
    label: &str,
) -> Result<(), CleanupError> {
    let restoration = rename_exclusive_at(directory, isolated, original);
    sync_directory(directory)
        .map_err(|source| CleanupError::io("sync cleanup entry restoration", source))?;
    match restoration {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {
            Err(CleanupError::invalid(format!(
                "{label} changed during isolation; original name is occupied and isolation was preserved"
            )))
        }
        Err(source) => Err(CleanupError::io("restore isolated cleanup entry", source)),
    }
}

fn directory_entries(directory: RawFd) -> Result<Vec<CString>, CleanupError> {
    let duplicate = unsafe { libc::fcntl(directory, libc::F_DUPFD_CLOEXEC, 0) };
    if duplicate < 0 {
        return Err(CleanupError::io(
            "duplicate cleanup directory descriptor",
            io::Error::last_os_error(),
        ));
    }
    let stream = unsafe { libc::fdopendir(duplicate) };
    if stream.is_null() {
        let source = io::Error::last_os_error();
        unsafe {
            libc::close(duplicate);
        }
        return Err(CleanupError::io("open cleanup directory stream", source));
    }
    struct Stream(*mut libc::DIR);
    impl Drop for Stream {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    let stream = Stream(stream);
    let mut entries = Vec::new();
    loop {
        clear_errno();
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            let source = io::Error::last_os_error();
            if source.raw_os_error().unwrap_or(0) == 0 {
                break;
            }
            return Err(CleanupError::io("read cleanup directory", source));
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() == b"." || name.to_bytes() == b".." {
            continue;
        }
        entries.push(
            CString::new(name.to_bytes())
                .map_err(|_| CleanupError::invalid("cleanup entry name contains NUL"))?,
        );
    }
    Ok(entries)
}

#[cfg(target_os = "macos")]
fn clear_errno() {
    unsafe {
        *libc::__error() = 0;
    }
}

#[cfg(not(target_os = "macos"))]
fn clear_errno() {
    unsafe {
        *libc::__errno_location() = 0;
    }
}

fn remove_cleanup_journal(
    root: RawFd,
    channel: ReleaseChannel,
    expected: FileIdentity,
    journal_value: &CleanupJournal,
    hook: &mut impl CleanupHook,
) -> Result<(), CleanupError> {
    let (journal_name, temp_name) = journal_names(channel);
    remove_optional_regular_file(root, temp_name)?;
    let journal = cstring(journal_name.as_bytes(), "cleanup journal name")?;
    verify_journal_security(root, &journal, expected)?;
    hook.reached(CleanupBoundary::BeforeJournalUnlink);
    if unsafe { libc::unlinkat(root, journal.as_ptr(), 0) } < 0 {
        return Err(CleanupError::io(
            "remove cleanup journal",
            io::Error::last_os_error(),
        ));
    }
    hook.reached(CleanupBoundary::AfterJournalUnlink);
    hook.reached(CleanupBoundary::BeforeJournalRemovalParentFsync);
    if let Err(source) = sync_directory(root) {
        let mut noop = NoopCleanupHook;
        let _ = persist_cleanup_journal_at(root, channel, journal_value, &mut noop);
        return Err(CleanupError::io("sync cleanup journal removal", source));
    }
    hook.reached(CleanupBoundary::AfterJournalRemovalParentFsync);
    Ok(())
}

fn remove_optional_regular_file(root: RawFd, name: &str) -> Result<(), CleanupError> {
    let name = cstring(name.as_bytes(), "cleanup temporary journal name")?;
    let metadata = match stat_at(root, &name) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(source) => return Err(CleanupError::io("inspect cleanup temp file", source)),
    };
    if file_type(&metadata) != libc::S_IFREG as u32
        || metadata.st_uid != unsafe { libc::geteuid() }
        || metadata.st_mode as u32 & 0o777 != 0o600
        || metadata.st_nlink != 1
    {
        return Err(CleanupError::invalid(
            "cleanup temporary journal removal target is unsafe",
        ));
    }
    if unsafe { libc::unlinkat(root, name.as_ptr(), 0) } < 0 {
        return Err(CleanupError::io(
            "remove cleanup temporary journal",
            io::Error::last_os_error(),
        ));
    }
    Ok(())
}

fn validate_channel_root(path: &Path) -> Result<(), CleanupError> {
    open_verified_directory(path, "cleanup channel root").map(|_| ())
}

fn open_verified_directory(path: &Path, label: &'static str) -> Result<OwnedFd, CleanupError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|source| CleanupError::io("inspect directory", source))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CleanupError::invalid(format!(
            "{label} must be a real directory"
        )));
    }
    let descriptor =
        open_directory(path).map_err(|source| CleanupError::io("open directory", source))?;
    let opened = descriptor_stat(descriptor.as_raw_fd())
        .map_err(|source| CleanupError::io("inspect opened directory", source))?;
    if FileIdentity::from_stat(&opened) != FileIdentity::from_metadata(&metadata) {
        return Err(CleanupError::invalid(format!(
            "{label} identity changed while opening"
        )));
    }
    Ok(descriptor)
}

fn open_directory(path: &Path) -> io::Result<OwnedFd> {
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "directory path contains NUL"))?;
    let descriptor = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

fn open_directory_at(root: RawFd, name: &CStr) -> io::Result<OwnedFd> {
    let descriptor = unsafe {
        libc::openat(
            root,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

fn verify_descriptor_identity(
    descriptor: RawFd,
    expected: FileIdentity,
    label: &str,
) -> Result<(), CleanupError> {
    let actual = descriptor_stat(descriptor)
        .map(|metadata| FileIdentity::from_stat(&metadata))
        .map_err(|source| CleanupError::io("inspect cleanup descriptor", source))?;
    if actual != expected {
        return Err(CleanupError::invalid(format!("{label} identity changed")));
    }
    Ok(())
}

fn verify_identity(
    root: RawFd,
    name: &CStr,
    expected: FileIdentity,
    label: &str,
) -> Result<(), CleanupError> {
    let actual = identity_at(root, name)
        .map_err(|source| CleanupError::io("inspect cleanup identity", source))?;
    if actual != expected {
        return Err(CleanupError::invalid(format!("{label} identity changed")));
    }
    Ok(())
}

fn verify_journal_security(
    root: RawFd,
    name: &CStr,
    expected: FileIdentity,
) -> Result<(), CleanupError> {
    let metadata = stat_at(root, name)
        .map_err(|source| CleanupError::io("inspect cleanup journal identity", source))?;
    if FileIdentity::from_stat(&metadata) != expected
        || file_type(&metadata) != libc::S_IFREG as u32
        || metadata.st_uid != unsafe { libc::geteuid() }
        || metadata.st_mode as u32 & 0o777 != 0o600
        || metadata.st_nlink != 1
    {
        return Err(CleanupError::invalid(
            "cleanup journal ownership or permissions changed",
        ));
    }
    Ok(())
}

fn identity_at(root: RawFd, name: &CStr) -> io::Result<FileIdentity> {
    stat_at(root, name).map(|metadata| FileIdentity::from_stat(&metadata))
}

fn optional_identity_at(root: RawFd, name: &CStr) -> Result<Option<FileIdentity>, CleanupError> {
    match identity_at(root, name) {
        Ok(identity) => Ok(Some(identity)),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(CleanupError::io("inspect active cleanup entry", source)),
    }
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

fn file_type(metadata: &libc::stat) -> u32 {
    metadata.st_mode as u32 & libc::S_IFMT as u32
}

fn sync_directory(descriptor: RawFd) -> io::Result<()> {
    if unsafe { libc::fsync(descriptor) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn cstring(bytes: &[u8], label: &str) -> Result<CString, CleanupError> {
    CString::new(bytes).map_err(|_| CleanupError::invalid(format!("{label} contains NUL")))
}

fn journal_names(channel: ReleaseChannel) -> (&'static str, &'static str) {
    match channel {
        ReleaseChannel::Test => (TEST_CLEANUP_JOURNAL_FILE, TEST_CLEANUP_JOURNAL_TEMP),
        ReleaseChannel::Stable => (STABLE_CLEANUP_JOURNAL_FILE, STABLE_CLEANUP_JOURNAL_TEMP),
    }
}

#[derive(Debug)]
pub enum CleanupError {
    InvalidState(String),
    Io {
        operation: &'static str,
        source: io::Error,
    },
    Json {
        operation: &'static str,
        source: serde_json::Error,
    },
}

impl CleanupError {
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

impl fmt::Display for CleanupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidState(message) => formatter.write_str(message),
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
            Self::Json { operation, source } => write!(formatter, "{operation} failed: {source}"),
        }
    }
}

impl Error for CleanupError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidState(_) => None,
            Self::Io { source, .. } => Some(source),
            Self::Json { source, .. } => Some(source),
        }
    }
}
