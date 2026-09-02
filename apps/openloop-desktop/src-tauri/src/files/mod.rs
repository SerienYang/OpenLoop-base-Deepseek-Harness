pub mod openat;

use std::{
    collections::HashMap,
    error::Error,
    ffi::{CStr, CString},
    fmt, io,
    os::fd::{AsRawFd, OwnedFd, RawFd},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    bridge::{
        protocol::success_result_fits_bridge_frame,
        server::{BridgeDispatchTables, BridgeHandler, BridgeHandlerError},
    },
    workspaces::{
        grants::{FileIdentity, GrantStatus, GrantStore},
        journal::WorkspaceJournal,
        operations::WorkspaceOperationGate,
        picker::PendingGrantRegistry,
    },
};

use self::openat::{
    checked_regular_version, create_regular_at, descriptor_stat, inspect_directory_descriptor,
    inspect_regular_descriptor, inspect_supported_descriptor, open_beneath, read_at,
    rename_exclusive_at, resolve_parent, stable_regular_identity, stat_at, swap_at,
    sync_descriptor, unlink_at, visit_directory, write_all,
};

pub const MAX_FILE_CHUNK_BYTES: usize = 32 * 1024;
const MAX_ATOMIC_WRITE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_LIST_ENTRIES: usize = 128;
const MAX_OPEN_HANDLES: usize = 64;
const DEFAULT_HANDLE_TTL: Duration = Duration::from_secs(5 * 60);

pub trait FileBrokerHooks: Send + Sync {
    fn before_create(&self, _parent: RawFd, _target: &CStr) {}
    fn after_create(&self, _parent: RawFd, _target: &CStr) {}
    fn before_create_sync(
        &self,
        _parent: RawFd,
        _temporary: &CStr,
        _target: &CStr,
    ) -> Result<(), FileBrokerError> {
        Ok(())
    }
    fn before_atomic_write(&self, _parent: RawFd, _temporary: &CStr) {}
    fn before_atomic_publish(&self, _parent: RawFd, _temporary: &CStr) {}
    fn before_atomic_swap(&self, _parent: RawFd, _temporary: &CStr, _target: &CStr) {}
    fn before_atomic_rollback(&self, _parent: RawFd, _temporary: &CStr, _target: &CStr) {}
}

impl FileBrokerHooks for () {}

#[derive(Debug)]
pub enum FileBrokerError {
    InvalidPath,
    InvalidHandle,
    GrantUnavailable,
    UnsafeFile,
    WrongHandleKind,
    ChunkTooLarge,
    InvalidOffset,
    AlreadyExists,
    VersionConflict,
    Io(io::Error),
}

impl fmt::Display for FileBrokerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => formatter.write_str("Workspace relative path is invalid"),
            Self::InvalidHandle => formatter.write_str("Workspace file handle is invalid"),
            Self::GrantUnavailable => formatter.write_str("Workspace grant is not ready"),
            Self::UnsafeFile => formatter.write_str("Workspace file type or link count is unsafe"),
            Self::WrongHandleKind => {
                formatter.write_str("Workspace file handle has the wrong kind")
            }
            Self::ChunkTooLarge => formatter.write_str("Workspace file chunk exceeds its limit"),
            Self::InvalidOffset => formatter.write_str("Workspace file offset is invalid"),
            Self::AlreadyExists => formatter.write_str("Workspace file already exists"),
            Self::VersionConflict => formatter.write_str("Workspace file version changed"),
            Self::Io(source) => write!(formatter, "Workspace file operation failed: {source}"),
        }
    }
}

impl Error for FileBrokerError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(source) => Some(source),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FileKind {
    Regular,
    Directory,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DirectoryEntryKind {
    Regular,
    Directory,
    Symlink,
    Other,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileHandleView {
    pub handle_id: String,
    pub kind: FileKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub kind: FileKind,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub kind: DirectoryEntryKind,
    pub size: u64,
    pub version: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryChunk {
    pub entries: Vec<DirectoryEntry>,
    pub next_offset: usize,
    pub eof: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadChunk {
    pub bytes: Vec<u8>,
    pub next_offset: u64,
    pub eof: bool,
}

#[derive(Clone, Debug, Default)]
pub struct AtomicWriteOptions {
    pub create_if_absent: bool,
    pub expected_version: Option<String>,
}

#[derive(Clone)]
struct GrantBinding {
    workspace_id: String,
    generation: u64,
    identity: FileIdentity,
}

enum HandleValue {
    Open(OwnedFd),
    Atomic(AtomicWriteHandle),
}

struct HandleRecord {
    binding: GrantBinding,
    expires_at: Instant,
    value: HandleValue,
}

#[derive(Default)]
struct HandleTable {
    records: HashMap<Uuid, HandleRecord>,
    reservations: usize,
}

struct HandleReservation<'a> {
    table: &'a Mutex<HandleTable>,
    active: bool,
}

impl HandleReservation<'_> {
    fn activate(
        mut self,
        binding: GrantBinding,
        value: HandleValue,
        stat: FileStat,
        handle_ttl: Duration,
    ) -> Result<FileHandleView, FileBrokerError> {
        let handle_id = Uuid::new_v4();
        let mut table = self
            .table
            .lock()
            .map_err(|_| FileBrokerError::InvalidHandle)?;
        table.reservations -= 1;
        table.records.insert(
            handle_id,
            HandleRecord {
                binding,
                expires_at: Instant::now() + handle_ttl,
                value,
            },
        );
        self.active = false;
        Ok(FileHandleView {
            handle_id: handle_id.to_string(),
            kind: stat.kind,
            version: stat.version,
        })
    }
}

impl Drop for HandleReservation<'_> {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let mut table = match self.table.lock() {
            Ok(table) => table,
            Err(poisoned) => poisoned.into_inner(),
        };
        table.reservations = table.reservations.saturating_sub(1);
    }
}

struct TemporaryCleanup<'a> {
    parent: RawFd,
    temporary: &'a CStr,
    descriptor: RawFd,
    active: bool,
}

impl TemporaryCleanup<'_> {
    fn disarm(&mut self) {
        self.active = false;
    }

    fn verify_ownership(&mut self, descriptor: RawFd) -> Result<(), FileBrokerError> {
        if temporary_inode_identity(self.parent, self.temporary, descriptor)?.is_none() {
            self.disarm();
            return Err(FileBrokerError::UnsafeFile);
        }
        Ok(())
    }
}

impl Drop for TemporaryCleanup<'_> {
    fn drop(&mut self) {
        if self.active
            && temporary_inode_identity(self.parent, self.temporary, self.descriptor)
                .ok()
                .flatten()
                .is_some()
        {
            let _ = unlink_at(self.parent, self.temporary);
        }
    }
}

struct AtomicWriteHandle {
    parent: OwnedFd,
    temporary: CString,
    target: CString,
    file: OwnedFd,
    create_if_absent: bool,
    expected_version: Option<String>,
    initial_version: Option<String>,
    bytes_written: u64,
    temporary_exists: bool,
}

impl Drop for AtomicWriteHandle {
    fn drop(&mut self) {
        let _cleanup = TemporaryCleanup {
            parent: self.parent.as_raw_fd(),
            temporary: &self.temporary,
            descriptor: self.file.as_raw_fd(),
            active: self.temporary_exists,
        };
    }
}

struct ReadyRoot {
    descriptor: OwnedFd,
    binding: GrantBinding,
}

pub struct FileBroker {
    _launch_id: Uuid,
    store: GrantStore,
    journal: WorkspaceJournal,
    grants: Arc<Mutex<PendingGrantRegistry>>,
    operation_gate: Arc<WorkspaceOperationGate>,
    hooks: Arc<dyn FileBrokerHooks>,
    handle_ttl: Duration,
    handles: Mutex<HandleTable>,
}

impl FileBroker {
    pub fn new(
        launch_id: Uuid,
        store: GrantStore,
        journal: WorkspaceJournal,
        grants: Arc<Mutex<PendingGrantRegistry>>,
    ) -> Self {
        Self::with_handle_ttl(launch_id, store, journal, grants, DEFAULT_HANDLE_TTL)
    }

    pub fn with_handle_ttl(
        launch_id: Uuid,
        store: GrantStore,
        journal: WorkspaceJournal,
        grants: Arc<Mutex<PendingGrantRegistry>>,
        handle_ttl: Duration,
    ) -> Self {
        Self::with_handle_ttl_and_hooks(launch_id, store, journal, grants, handle_ttl, Arc::new(()))
    }

    pub fn with_handle_ttl_and_hooks(
        launch_id: Uuid,
        store: GrantStore,
        journal: WorkspaceJournal,
        grants: Arc<Mutex<PendingGrantRegistry>>,
        handle_ttl: Duration,
        hooks: Arc<dyn FileBrokerHooks>,
    ) -> Self {
        let operation_gate = grants
            .lock()
            .expect("Workspace grant registry must be available during broker setup")
            .operation_gate();
        Self {
            _launch_id: launch_id,
            store,
            journal,
            grants,
            operation_gate,
            hooks,
            handle_ttl,
            handles: Mutex::new(HandleTable::default()),
        }
    }

    pub fn open(
        &self,
        workspace_id: &str,
        relative_path: &str,
    ) -> Result<FileHandleView, FileBrokerError> {
        let _lease = self.operation_lease(workspace_id)?;
        let root = self.ready_root(workspace_id, None)?;
        let reservation = self.reserve_handle()?;
        let descriptor = open_beneath(root.descriptor.as_raw_fd(), relative_path)?;
        let stat = inspect_supported_descriptor(descriptor.as_raw_fd())?;
        reservation.activate(
            root.binding,
            HandleValue::Open(descriptor),
            stat,
            self.handle_ttl,
        )
    }

    pub fn create(
        &self,
        workspace_id: &str,
        relative_path: &str,
    ) -> Result<FileHandleView, FileBrokerError> {
        let _lease = self.operation_lease(workspace_id)?;
        let root = self.ready_root(workspace_id, None)?;
        let target = resolve_parent(root.descriptor.as_raw_fd(), relative_path)?;
        if let Some(metadata) = stat_at(target.parent.as_raw_fd(), &target.leaf)? {
            checked_regular_version(&metadata)?;
            return Err(FileBrokerError::AlreadyExists);
        }
        let reservation = self.reserve_handle()?;
        self.hooks
            .before_create(target.parent.as_raw_fd(), &target.leaf);
        let (temporary, descriptor) = self.create_temporary(target.parent.as_raw_fd())?;
        let mut cleanup = TemporaryCleanup {
            parent: target.parent.as_raw_fd(),
            temporary: &temporary,
            descriptor: descriptor.as_raw_fd(),
            active: true,
        };
        self.hooks
            .before_create_sync(target.parent.as_raw_fd(), &temporary, &target.leaf)?;
        cleanup.verify_ownership(descriptor.as_raw_fd())?;
        sync_descriptor(descriptor.as_raw_fd())?;
        cleanup.verify_ownership(descriptor.as_raw_fd())?;
        inspect_regular_descriptor(descriptor.as_raw_fd())?;
        rename_exclusive_at(target.parent.as_raw_fd(), &temporary, &target.leaf)?;
        cleanup.disarm();
        if path_inode_identity(target.parent.as_raw_fd(), &target.leaf)?
            != Some(descriptor_inode_identity(descriptor.as_raw_fd())?)
        {
            return Err(FileBrokerError::UnsafeFile);
        }
        self.hooks
            .after_create(target.parent.as_raw_fd(), &target.leaf);
        sync_descriptor(target.parent.as_raw_fd())?;
        if path_inode_identity(target.parent.as_raw_fd(), &target.leaf)?
            != Some(descriptor_inode_identity(descriptor.as_raw_fd())?)
        {
            return Err(FileBrokerError::UnsafeFile);
        }
        let stat = inspect_regular_descriptor(descriptor.as_raw_fd())?;
        reservation.activate(
            root.binding,
            HandleValue::Open(descriptor),
            stat,
            self.handle_ttl,
        )
    }

    pub fn stat(&self, handle_id: &str) -> Result<FileStat, FileBrokerError> {
        let (id, binding) = self.handle_binding(handle_id)?;
        let _lease = self.operation_lease(&binding.workspace_id)?;
        self.ready_root(&binding.workspace_id, Some(&binding))?;
        self.with_open_handle(id, inspect_supported_descriptor)
    }

    pub fn list(
        &self,
        handle_id: &str,
        offset: usize,
        maximum: usize,
    ) -> Result<DirectoryChunk, FileBrokerError> {
        if maximum == 0 || maximum > MAX_LIST_ENTRIES {
            return Err(FileBrokerError::ChunkTooLarge);
        }
        let (id, binding) = self.handle_binding(handle_id)?;
        let _lease = self.operation_lease(&binding.workspace_id)?;
        self.ready_root(&binding.workspace_id, Some(&binding))?;
        self.with_open_handle(id, |descriptor| {
            inspect_directory_descriptor(descriptor)?;
            let mut entries = Vec::new();
            let visit =
                visit_directory(descriptor, offset, maximum, |name, kind, size, version| {
                    let entry = DirectoryEntry {
                        name,
                        kind,
                        size,
                        version,
                    };
                    let mut candidate = entries.clone();
                    candidate.push(entry.clone());
                    let result = json!({
                        "entries": candidate,
                        "nextOffset": offset.saturating_add(entries.len()).saturating_add(1),
                        "eof": false,
                    });
                    if !success_result_fits_bridge_frame(&result) {
                        return Ok(false);
                    }
                    entries.push(entry);
                    Ok(true)
                })?;
            if entries.is_empty() && !visit.eof && visit.visited == offset {
                return Err(FileBrokerError::ChunkTooLarge);
            }
            Ok(DirectoryChunk {
                entries,
                next_offset: visit.visited,
                eof: visit.eof,
            })
        })
    }

    pub fn read(
        &self,
        handle_id: &str,
        offset: u64,
        maximum: usize,
    ) -> Result<ReadChunk, FileBrokerError> {
        if maximum == 0 || maximum > MAX_FILE_CHUNK_BYTES {
            return Err(FileBrokerError::ChunkTooLarge);
        }
        let (id, binding) = self.handle_binding(handle_id)?;
        let _lease = self.operation_lease(&binding.workspace_id)?;
        self.ready_root(&binding.workspace_id, Some(&binding))?;
        self.with_open_handle(id, |descriptor| {
            let stat = inspect_regular_descriptor(descriptor)?;
            let bytes = read_at(descriptor, offset, maximum)?;
            let next_offset = offset
                .checked_add(bytes.len() as u64)
                .ok_or(FileBrokerError::InvalidOffset)?;
            Ok(ReadChunk {
                eof: next_offset >= stat.size,
                bytes,
                next_offset,
            })
        })
    }

    pub fn begin_atomic_write(
        &self,
        workspace_id: &str,
        relative_path: &str,
        options: AtomicWriteOptions,
    ) -> Result<FileHandleView, FileBrokerError> {
        let _lease = self.operation_lease(workspace_id)?;
        let root = self.ready_root(workspace_id, None)?;
        let target = resolve_parent(root.descriptor.as_raw_fd(), relative_path)?;
        let initial_version = match stat_at(target.parent.as_raw_fd(), &target.leaf)? {
            Some(metadata) => Some(checked_regular_version(&metadata)?),
            None => None,
        };
        if options.create_if_absent {
            if initial_version.is_some() {
                return Err(FileBrokerError::AlreadyExists);
            }
            if options.expected_version.is_some() {
                return Err(FileBrokerError::VersionConflict);
            }
        } else {
            let current = initial_version
                .as_ref()
                .ok_or(FileBrokerError::VersionConflict)?;
            if options
                .expected_version
                .as_ref()
                .is_some_and(|expected| expected != current)
            {
                return Err(FileBrokerError::VersionConflict);
            }
        }

        let reservation = self.reserve_handle()?;
        let (temporary, file) = self.create_temporary(target.parent.as_raw_fd())?;
        let stat = inspect_regular_descriptor(file.as_raw_fd())?;
        reservation.activate(
            root.binding,
            HandleValue::Atomic(AtomicWriteHandle {
                parent: target.parent,
                temporary,
                target: target.leaf,
                file,
                create_if_absent: options.create_if_absent,
                expected_version: options.expected_version,
                initial_version,
                bytes_written: 0,
                temporary_exists: true,
            }),
            stat,
            self.handle_ttl,
        )
    }

    pub fn write_chunk(&self, handle_id: &str, bytes: &[u8]) -> Result<(), FileBrokerError> {
        if bytes.len() > MAX_FILE_CHUNK_BYTES {
            return Err(FileBrokerError::ChunkTooLarge);
        }
        let (id, binding) = self.handle_binding(handle_id)?;
        let _lease = self.operation_lease(&binding.workspace_id)?;
        self.ready_root(&binding.workspace_id, Some(&binding))?;
        let mut handles = self
            .handles
            .lock()
            .map_err(|_| FileBrokerError::InvalidHandle)?;
        let handle = handles
            .records
            .get_mut(&id)
            .ok_or(FileBrokerError::InvalidHandle)?;
        let HandleValue::Atomic(write) = &mut handle.value else {
            return Err(FileBrokerError::WrongHandleKind);
        };
        verify_temporary_ownership(write)?;
        let next_size = write
            .bytes_written
            .checked_add(bytes.len() as u64)
            .ok_or(FileBrokerError::ChunkTooLarge)?;
        if next_size > MAX_ATOMIC_WRITE_BYTES {
            return Err(FileBrokerError::ChunkTooLarge);
        }
        self.hooks
            .before_atomic_write(write.parent.as_raw_fd(), &write.temporary);
        write_all(write.file.as_raw_fd(), bytes)?;
        verify_temporary_ownership(write)?;
        write.bytes_written = next_size;
        Ok(())
    }

    pub fn commit_atomic_write(&self, handle_id: &str) -> Result<String, FileBrokerError> {
        let id = parse_handle_id(handle_id)?;
        let (_, binding) = self.handle_binding(handle_id)?;
        let _lease = self.operation_lease(&binding.workspace_id)?;
        self.ready_root(&binding.workspace_id, Some(&binding))?;
        let record = self
            .handles
            .lock()
            .map_err(|_| FileBrokerError::InvalidHandle)?
            .records
            .remove(&id)
            .ok_or(FileBrokerError::InvalidHandle)?;
        if Instant::now() >= record.expires_at {
            return Err(FileBrokerError::InvalidHandle);
        }
        let HandleValue::Atomic(mut write) = record.value else {
            return Err(FileBrokerError::WrongHandleKind);
        };
        verify_temporary_ownership(&mut write)?;
        sync_descriptor(write.file.as_raw_fd())?;
        self.hooks
            .before_atomic_publish(write.parent.as_raw_fd(), &write.temporary);
        verify_temporary_ownership(&mut write)?;
        let staged_identity = descriptor_inode_identity(write.file.as_raw_fd())?;

        if write.create_if_absent {
            if stat_at(write.parent.as_raw_fd(), &write.target)?.is_some() {
                return Err(FileBrokerError::AlreadyExists);
            }
            rename_exclusive_at(write.parent.as_raw_fd(), &write.temporary, &write.target)?;
            write.temporary_exists = false;
            if path_inode_identity(write.parent.as_raw_fd(), &write.target)?
                != Some(staged_identity)
            {
                return Err(FileBrokerError::UnsafeFile);
            }
        } else {
            let current_metadata = stat_at(write.parent.as_raw_fd(), &write.target)?
                .ok_or(FileBrokerError::VersionConflict)?;
            let current = checked_regular_version(&current_metadata)?;
            let current_identity = stable_regular_identity(&current_metadata)?;
            if Some(&current) != write.initial_version.as_ref()
                || write
                    .expected_version
                    .as_ref()
                    .is_some_and(|expected| expected != &current)
            {
                return Err(FileBrokerError::VersionConflict);
            }
            self.hooks.before_atomic_swap(
                write.parent.as_raw_fd(),
                &write.temporary,
                &write.target,
            );
            swap_at(write.parent.as_raw_fd(), &write.temporary, &write.target)?;
            let published_identity = path_inode_identity(write.parent.as_raw_fd(), &write.target)?;
            let displaced_metadata = stat_at(write.parent.as_raw_fd(), &write.temporary)?;
            let displaced_identity = displaced_metadata
                .as_ref()
                .map(inode_identity)
                .transpose()?;
            let displaced_version = displaced_metadata
                .as_ref()
                .map(stable_regular_identity)
                .transpose()?;
            if published_identity != Some(staged_identity)
                || displaced_version != Some(current_identity)
            {
                write.temporary_exists = false;
                let rollback_is_safe = published_identity.is_some()
                    && displaced_identity.is_some()
                    && path_inode_identity(write.parent.as_raw_fd(), &write.target)?
                        == published_identity
                    && path_inode_identity(write.parent.as_raw_fd(), &write.temporary)?
                        == displaced_identity;
                if !rollback_is_safe {
                    return Err(if published_identity == Some(staged_identity) {
                        FileBrokerError::VersionConflict
                    } else {
                        FileBrokerError::UnsafeFile
                    });
                }
                self.hooks.before_atomic_rollback(
                    write.parent.as_raw_fd(),
                    &write.temporary,
                    &write.target,
                );
                swap_at(write.parent.as_raw_fd(), &write.temporary, &write.target)?;
                let rollback_succeeded =
                    path_inode_identity(write.parent.as_raw_fd(), &write.target)?
                        == displaced_identity
                        && path_inode_identity(write.parent.as_raw_fd(), &write.temporary)?
                            == published_identity;
                if rollback_succeeded && published_identity == Some(staged_identity) {
                    write.temporary_exists = true;
                }
                return Err(if published_identity == Some(staged_identity) {
                    FileBrokerError::VersionConflict
                } else {
                    FileBrokerError::UnsafeFile
                });
            }
            unlink_at(write.parent.as_raw_fd(), &write.temporary)?;
            write.temporary_exists = false;
        }
        sync_descriptor(write.parent.as_raw_fd())?;
        let metadata =
            stat_at(write.parent.as_raw_fd(), &write.target)?.ok_or(FileBrokerError::Io(
                io::Error::new(io::ErrorKind::NotFound, "committed Workspace file vanished"),
            ))?;
        if inode_identity(&metadata)? != staged_identity {
            return Err(FileBrokerError::UnsafeFile);
        }
        checked_regular_version(&descriptor_stat(write.file.as_raw_fd())?)
    }

    pub fn close(&self, handle_id: &str) -> Result<(), FileBrokerError> {
        let id = parse_handle_id(handle_id)?;
        self.handles
            .lock()
            .map_err(|_| FileBrokerError::InvalidHandle)?
            .records
            .remove(&id)
            .ok_or(FileBrokerError::InvalidHandle)?;
        Ok(())
    }

    fn create_temporary(&self, parent: RawFd) -> Result<(CString, OwnedFd), FileBrokerError> {
        for _ in 0..16 {
            let name = CString::new(format!(".openloop-write-{}.tmp", Uuid::new_v4()))
                .map_err(|_| FileBrokerError::UnsafeFile)?;
            match create_regular_at(parent, &name) {
                Ok(file) => return Ok((name, file)),
                Err(FileBrokerError::AlreadyExists) => {}
                Err(error) => return Err(error),
            }
        }
        Err(FileBrokerError::AlreadyExists)
    }

    fn operation_lease(
        &self,
        workspace_id: &str,
    ) -> Result<crate::workspaces::operations::WorkspaceOperationLease, FileBrokerError> {
        self.operation_gate
            .acquire(workspace_id)
            .map_err(|_| FileBrokerError::GrantUnavailable)
    }

    fn ready_root(
        &self,
        workspace_id: &str,
        expected: Option<&GrantBinding>,
    ) -> Result<ReadyRoot, FileBrokerError> {
        if workspace_id.is_empty() {
            return Err(FileBrokerError::GrantUnavailable);
        }
        let grant = self
            .store
            .get(workspace_id)
            .map_err(|_| FileBrokerError::GrantUnavailable)?
            .ok_or(FileBrokerError::GrantUnavailable)?;
        if grant.status != GrantStatus::Ready
            || expected.is_some_and(|binding| {
                binding.workspace_id != workspace_id
                    || binding.generation != grant.generation
                    || binding.identity != grant.identity
            })
        {
            return Err(FileBrokerError::GrantUnavailable);
        }
        if self
            .journal
            .read()
            .map_err(|_| FileBrokerError::GrantUnavailable)?
            .is_some_and(|transaction| transaction.workspace_id.as_deref() == Some(workspace_id))
        {
            return Err(FileBrokerError::GrantUnavailable);
        }
        let descriptor = self
            .grants
            .lock()
            .map_err(|_| FileBrokerError::GrantUnavailable)?
            .duplicate_committed_descriptor(workspace_id)
            .map_err(|_| FileBrokerError::GrantUnavailable)?;
        let metadata = descriptor_stat(descriptor.as_raw_fd())?;
        if metadata.st_mode & libc::S_IFMT != libc::S_IFDIR
            || metadata.st_dev as u64 != grant.identity.volume_id
            || metadata.st_ino != grant.identity.file_id
            || metadata.st_uid != unsafe { libc::geteuid() }
            || metadata.st_mode & 0o002 != 0
        {
            return Err(FileBrokerError::GrantUnavailable);
        }
        Ok(ReadyRoot {
            descriptor,
            binding: GrantBinding {
                workspace_id: workspace_id.to_owned(),
                generation: grant.generation,
                identity: grant.identity,
            },
        })
    }

    fn reserve_handle(&self) -> Result<HandleReservation<'_>, FileBrokerError> {
        let now = Instant::now();
        let mut table = self
            .handles
            .lock()
            .map_err(|_| FileBrokerError::InvalidHandle)?;
        table.records.retain(|_, record| record.expires_at > now);
        if table.records.len() + table.reservations >= MAX_OPEN_HANDLES {
            return Err(FileBrokerError::InvalidHandle);
        }
        table.reservations += 1;
        Ok(HandleReservation {
            table: &self.handles,
            active: true,
        })
    }

    fn handle_binding(&self, handle_id: &str) -> Result<(Uuid, GrantBinding), FileBrokerError> {
        let id = parse_handle_id(handle_id)?;
        let now = Instant::now();
        let mut table = self
            .handles
            .lock()
            .map_err(|_| FileBrokerError::InvalidHandle)?;
        table.records.retain(|_, record| record.expires_at > now);
        let binding = table
            .records
            .get(&id)
            .ok_or(FileBrokerError::InvalidHandle)?
            .binding
            .clone();
        Ok((id, binding))
    }

    fn with_open_handle<T>(
        &self,
        id: Uuid,
        operation: impl FnOnce(RawFd) -> Result<T, FileBrokerError>,
    ) -> Result<T, FileBrokerError> {
        let table = self
            .handles
            .lock()
            .map_err(|_| FileBrokerError::InvalidHandle)?;
        let handle = table
            .records
            .get(&id)
            .ok_or(FileBrokerError::InvalidHandle)?;
        let HandleValue::Open(descriptor) = &handle.value else {
            return Err(FileBrokerError::WrongHandleKind);
        };
        operation(descriptor.as_raw_fd())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct InodeIdentity {
    device: libc::dev_t,
    inode: libc::ino_t,
}

fn raw_regular_inode_identity(metadata: &libc::stat) -> Result<InodeIdentity, FileBrokerError> {
    if metadata.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(FileBrokerError::UnsafeFile);
    }
    Ok(InodeIdentity {
        device: metadata.st_dev,
        inode: metadata.st_ino,
    })
}

fn inode_identity(metadata: &libc::stat) -> Result<InodeIdentity, FileBrokerError> {
    checked_regular_version(metadata)?;
    raw_regular_inode_identity(metadata)
}

fn descriptor_inode_identity(descriptor: RawFd) -> Result<InodeIdentity, FileBrokerError> {
    inode_identity(&descriptor_stat(descriptor)?)
}

fn path_inode_identity(
    parent: RawFd,
    path: &CStr,
) -> Result<Option<InodeIdentity>, FileBrokerError> {
    stat_at(parent, path)?
        .map(|metadata| inode_identity(&metadata))
        .transpose()
}

fn verify_temporary_ownership(
    write: &mut AtomicWriteHandle,
) -> Result<InodeIdentity, FileBrokerError> {
    let Some(descriptor_identity) = temporary_inode_identity(
        write.parent.as_raw_fd(),
        &write.temporary,
        write.file.as_raw_fd(),
    )?
    else {
        write.temporary_exists = false;
        return Err(FileBrokerError::UnsafeFile);
    };
    Ok(descriptor_identity)
}

fn temporary_inode_identity(
    parent: RawFd,
    temporary: &CStr,
    descriptor: RawFd,
) -> Result<Option<InodeIdentity>, FileBrokerError> {
    let descriptor_metadata = descriptor_stat(descriptor)?;
    let descriptor_identity = raw_regular_inode_identity(&descriptor_metadata)?;
    let path_identity = stat_at(parent, temporary)?
        .as_ref()
        .map(raw_regular_inode_identity)
        .transpose()?;
    if path_identity != Some(descriptor_identity) {
        return Ok(None);
    }
    inspect_regular_descriptor(descriptor)?;
    Ok(Some(descriptor_identity))
}

fn parse_handle_id(handle_id: &str) -> Result<Uuid, FileBrokerError> {
    Uuid::parse_str(handle_id).map_err(|_| FileBrokerError::InvalidHandle)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenInput {
    workspace_id: String,
    relative_path: String,
    mode: OpenMode,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum OpenMode {
    Read,
    List,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HandleInput {
    handle_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadInput {
    handle_id: String,
    offset: u64,
    max_bytes: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListInput {
    handle_id: String,
    offset: usize,
    max_entries: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BeginAtomicWriteInput {
    workspace_id: String,
    relative_path: String,
    create_if_absent: bool,
    expected_version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteChunkInput {
    handle_id: String,
    bytes: String,
}

pub fn install_file_broker_handlers(
    tables: &mut BridgeDispatchTables,
    broker: Arc<FileBroker>,
) -> Result<(), String> {
    install_handler(
        tables,
        "openWorkspaceFile",
        broker.clone(),
        |broker, payload| {
            let input: OpenInput = serde_json::from_value(payload)
                .map_err(|_| BridgeHandlerError::invalid_request())?;
            let handle = bridge_file(broker.open(&input.workspace_id, &input.relative_path))?;
            let valid_kind = matches!(
                (input.mode, handle.kind),
                (OpenMode::Read, FileKind::Regular) | (OpenMode::List, FileKind::Directory)
            );
            if !valid_kind {
                let _ = broker.close(&handle.handle_id);
                return Err(BridgeHandlerError::file_failure());
            }
            serde_json::to_value(handle).map_err(|_| BridgeHandlerError::file_failure())
        },
    )?;
    install_handler(
        tables,
        "openWorkspaceRoot",
        broker.clone(),
        |broker, payload| {
            let input: WorkspaceInput = serde_json::from_value(payload)
                .map_err(|_| BridgeHandlerError::invalid_request())?;
            serde_json::to_value(bridge_file(broker.open(&input.workspace_id, "."))?)
                .map_err(|_| BridgeHandlerError::file_failure())
        },
    )?;
    install_handler(
        tables,
        "statWorkspaceFile",
        broker.clone(),
        |broker, payload| {
            let input: HandleInput = serde_json::from_value(payload)
                .map_err(|_| BridgeHandlerError::invalid_request())?;
            serde_json::to_value(bridge_file(broker.stat(&input.handle_id))?)
                .map_err(|_| BridgeHandlerError::file_failure())
        },
    )?;
    install_handler(
        tables,
        "listWorkspaceFiles",
        broker.clone(),
        |broker, payload| {
            let input: ListInput = serde_json::from_value(payload)
                .map_err(|_| BridgeHandlerError::invalid_request())?;
            if input.max_entries == 0 || input.max_entries > MAX_LIST_ENTRIES {
                return Err(BridgeHandlerError::invalid_request());
            }
            serde_json::to_value(bridge_file(broker.list(
                &input.handle_id,
                input.offset,
                input.max_entries,
            ))?)
            .map_err(|_| BridgeHandlerError::file_failure())
        },
    )?;
    install_handler(
        tables,
        "readWorkspaceFile",
        broker.clone(),
        |broker, payload| {
            let input: ReadInput = serde_json::from_value(payload)
                .map_err(|_| BridgeHandlerError::invalid_request())?;
            let chunk = bridge_file(broker.read(&input.handle_id, input.offset, input.max_bytes))?;
            Ok(json!({
                "bytes": BASE64.encode(chunk.bytes),
                "nextOffset": chunk.next_offset,
                "eof": chunk.eof,
            }))
        },
    )?;
    install_handler(
        tables,
        "createWorkspaceFile",
        broker.clone(),
        |broker, payload| {
            let input: CreateInput = serde_json::from_value(payload)
                .map_err(|_| BridgeHandlerError::invalid_request())?;
            serde_json::to_value(bridge_file(
                broker.create(&input.workspace_id, &input.relative_path),
            )?)
            .map_err(|_| BridgeHandlerError::file_failure())
        },
    )?;
    install_handler(
        tables,
        "beginWorkspaceAtomicWrite",
        broker.clone(),
        |broker, payload| {
            let input: BeginAtomicWriteInput = serde_json::from_value(payload)
                .map_err(|_| BridgeHandlerError::invalid_request())?;
            serde_json::to_value(bridge_file(broker.begin_atomic_write(
                &input.workspace_id,
                &input.relative_path,
                AtomicWriteOptions {
                    create_if_absent: input.create_if_absent,
                    expected_version: input.expected_version,
                },
            ))?)
            .map_err(|_| BridgeHandlerError::file_failure())
        },
    )?;
    install_handler(
        tables,
        "writeWorkspaceFileChunk",
        broker.clone(),
        |broker, payload| {
            let input: WriteChunkInput = serde_json::from_value(payload)
                .map_err(|_| BridgeHandlerError::invalid_request())?;
            let maximum_encoded = MAX_FILE_CHUNK_BYTES.div_ceil(3) * 4;
            if input.bytes.len() > maximum_encoded {
                return Err(BridgeHandlerError::invalid_request());
            }
            let bytes = BASE64
                .decode(&input.bytes)
                .map_err(|_| BridgeHandlerError::invalid_request())?;
            if bytes.len() > MAX_FILE_CHUNK_BYTES || BASE64.encode(&bytes) != input.bytes {
                return Err(BridgeHandlerError::invalid_request());
            }
            bridge_file(broker.write_chunk(&input.handle_id, &bytes))?;
            Ok(Value::Null)
        },
    )?;
    let commit_broker = broker.clone();
    let commit_handler: BridgeHandler = Arc::new(move |payload, cancellation| {
        let input: HandleInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        if !cancellation.admit_commit() {
            return Err(BridgeHandlerError::invalid_request());
        }
        let version = bridge_file(commit_broker.commit_atomic_write(&input.handle_id))?;
        Ok(json!({ "version": version }))
    });
    tables
        .set_host_handler("commitWorkspaceAtomicWrite", commit_handler)
        .map_err(|error| error.to_string())?;
    install_handler(tables, "closeWorkspaceFile", broker, |broker, payload| {
        let input: HandleInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        bridge_file(broker.close(&input.handle_id))?;
        Ok(Value::Null)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceInput {
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateInput {
    workspace_id: String,
    relative_path: String,
}

fn install_handler(
    tables: &mut BridgeDispatchTables,
    method: &'static str,
    broker: Arc<FileBroker>,
    operation: impl Fn(&FileBroker, Value) -> Result<Value, BridgeHandlerError> + Send + Sync + 'static,
) -> Result<(), String> {
    let handler: BridgeHandler = Arc::new(move |payload, cancellation| {
        if cancellation.is_cancelled() {
            return Err(BridgeHandlerError::invalid_request());
        }
        operation(&broker, payload)
    });
    tables
        .set_host_handler(method, handler)
        .map_err(|error| error.to_string())
}

fn bridge_file<T>(result: Result<T, FileBrokerError>) -> Result<T, BridgeHandlerError> {
    result.map_err(|error| match error {
        FileBrokerError::GrantUnavailable => BridgeHandlerError::file_grant_unavailable(),
        FileBrokerError::Io(source) if source.kind() == io::ErrorKind::NotFound => {
            BridgeHandlerError::file_not_found()
        }
        FileBrokerError::AlreadyExists => BridgeHandlerError::file_already_exists(),
        FileBrokerError::VersionConflict => BridgeHandlerError::file_version_conflict(),
        _ => BridgeHandlerError::file_failure(),
    })
}
