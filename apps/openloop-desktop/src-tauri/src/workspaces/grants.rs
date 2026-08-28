use std::{
    collections::HashSet,
    error::Error,
    ffi::{CStr, CString},
    fmt, fs,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, PermissionsExt},
        },
    },
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::update::channel::ReleaseChannel;

const STORE_VERSION: u8 = 1;
const MAX_STORE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GrantStatus {
    Ready,
    NeedsAuthorization,
    Missing,
    PermissionDenied,
    IdentityMismatch,
    Revoking,
    Reauthorizing,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileIdentity {
    pub volume_id: u64,
    pub file_id: u64,
}

impl FileIdentity {
    pub fn from_metadata(metadata: &fs::Metadata) -> Self {
        Self {
            volume_id: metadata.dev(),
            file_id: metadata.ino(),
        }
    }

    fn from_stat(metadata: &libc::stat) -> Self {
        Self {
            volume_id: metadata.st_dev as u64,
            file_id: metadata.st_ino,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGrant {
    pub version: u8,
    pub generation: u64,
    pub operation_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_operation_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_status: Option<GrantStatus>,
    pub workspace_id: String,
    pub canonical_path: PathBuf,
    pub display_path: PathBuf,
    pub identity: FileIdentity,
    pub status: GrantStatus,
    pub authorized_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantSnapshot {
    pub version: u8,
    pub generation: u64,
    pub grants: Vec<WorkspaceGrant>,
}

impl Default for GrantSnapshot {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            generation: 0,
            grants: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub enum WorkspaceGrantError {
    Io(&'static str, io::Error),
    Corrupt(String),
    UnsafePath(String),
    WrongOwnerOrMode(String),
    DuplicateWorkspaceId(String),
    GenerationConflict {
        expected: u64,
        actual: u64,
    },
    StatusConflict {
        expected: GrantStatus,
        actual: GrantStatus,
    },
    MissingWorkspaceGrant(String),
    InvalidPendingGrant,
    LaunchMismatch,
    PromptUnavailable,
    Verification {
        status: GrantStatus,
        message: String,
    },
}

impl WorkspaceGrantError {
    pub fn status(&self) -> Option<GrantStatus> {
        match self {
            Self::Verification { status, .. } => Some(*status),
            _ => None,
        }
    }

    fn io(action: &'static str, source: io::Error) -> Self {
        Self::Io(action, source)
    }

    fn verification(status: GrantStatus, message: impl Into<String>) -> Self {
        Self::Verification {
            status,
            message: message.into(),
        }
    }
}

impl fmt::Display for WorkspaceGrantError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(action, source) => write!(formatter, "{action}: {source}"),
            Self::Corrupt(message)
            | Self::UnsafePath(message)
            | Self::WrongOwnerOrMode(message)
            | Self::DuplicateWorkspaceId(message) => formatter.write_str(message),
            Self::GenerationConflict { expected, actual } => {
                write!(
                    formatter,
                    "generation conflict: expected {expected}, actual {actual}"
                )
            }
            Self::StatusConflict { expected, actual } => {
                write!(
                    formatter,
                    "grant status conflict: expected {expected:?}, actual {actual:?}"
                )
            }
            Self::MissingWorkspaceGrant(workspace_id) => {
                write!(formatter, "Workspace grant {workspace_id:?} does not exist")
            }
            Self::InvalidPendingGrant => formatter.write_str("pending Workspace grant is invalid"),
            Self::LaunchMismatch => {
                formatter.write_str("pending Workspace grant belongs to another launch")
            }
            Self::PromptUnavailable => {
                formatter.write_str("native Workspace prompt is unavailable")
            }
            Self::Verification { message, .. } => formatter.write_str(message),
        }
    }
}

impl Error for WorkspaceGrantError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(_, source) => Some(source),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct GrantStore {
    path: PathBuf,
    root: Arc<OwnedFd>,
    filename: CString,
}

impl GrantStore {
    pub fn open(root: &Path, channel: ReleaseChannel) -> Result<Self, WorkspaceGrantError> {
        Self::open_for_owner(root, channel, unsafe { libc::geteuid() })
    }

    pub fn open_for_owner(
        root: &Path,
        channel: ReleaseChannel,
        expected_uid: u32,
    ) -> Result<Self, WorkspaceGrantError> {
        let root_descriptor = open_private_root_for_owner(root, expected_uid)?;
        let suffix = match channel {
            ReleaseChannel::Test => "test",
            ReleaseChannel::Stable => "stable",
        };
        let filename = CString::new(format!(".openloop-workspace-grants.{suffix}.v1.json"))
            .map_err(|_| WorkspaceGrantError::UnsafePath("invalid grant filename".to_owned()))?;
        let _lock = lock_workspace_root(root_descriptor.as_raw_fd())?;
        Ok(Self {
            path: root.join(filename.to_str().map_err(|_| {
                WorkspaceGrantError::UnsafePath("invalid grant filename".to_owned())
            })?),
            root: Arc::new(root_descriptor),
            filename,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<GrantSnapshot, WorkspaceGrantError> {
        let _lock = lock_workspace_root(self.root.as_raw_fd())?;
        self.load_locked()
    }

    pub fn get(&self, workspace_id: &str) -> Result<Option<WorkspaceGrant>, WorkspaceGrantError> {
        Ok(self
            .load()?
            .grants
            .into_iter()
            .find(|grant| grant.workspace_id == workspace_id))
    }

    fn load_locked(&self) -> Result<GrantSnapshot, WorkspaceGrantError> {
        match read_owner_file_at(self.root.as_raw_fd(), &self.filename, MAX_STORE_BYTES)? {
            Some(bytes) => parse_snapshot(&bytes),
            None => Ok(GrantSnapshot::default()),
        }
    }

    pub fn load_for_launch(&self) -> Result<Vec<LaunchGrant>, WorkspaceGrantError> {
        self.load()?
            .grants
            .into_iter()
            .map(|grant| {
                let persisted_status = grant.status;
                match reopen_verified_grant(&grant) {
                    Ok(verified) => {
                        let (mut grant, descriptor) = verified.into_parts();
                        grant.status = persisted_status;
                        Ok(LaunchGrant {
                            grant,
                            descriptor: Some(descriptor),
                        })
                    }
                    Err(error @ WorkspaceGrantError::Verification { .. }) => {
                        let mut unavailable = grant;
                        unavailable.status =
                            error.status().unwrap_or(GrantStatus::NeedsAuthorization);
                        Ok(LaunchGrant {
                            grant: unavailable,
                            descriptor: None,
                        })
                    }
                    Err(error) => Err(error),
                }
            })
            .collect()
    }

    pub fn commit(
        &self,
        grant: WorkspaceGrant,
        expected_generation: u64,
    ) -> Result<u64, WorkspaceGrantError> {
        let _lock = lock_workspace_root(self.root.as_raw_fd())?;
        let mut snapshot = self.load_locked()?;
        if snapshot.generation != expected_generation {
            return Err(WorkspaceGrantError::GenerationConflict {
                expected: expected_generation,
                actual: snapshot.generation,
            });
        }
        if grant.version != STORE_VERSION {
            return Err(WorkspaceGrantError::Corrupt(
                "Workspace grant version is unsupported".to_owned(),
            ));
        }
        snapshot.generation = snapshot
            .generation
            .checked_add(1)
            .ok_or_else(|| WorkspaceGrantError::Corrupt("grant generation overflow".to_owned()))?;
        let mut replacement = grant;
        replacement.generation = snapshot.generation;
        if let Some(existing) = snapshot
            .grants
            .iter_mut()
            .find(|entry| entry.workspace_id == replacement.workspace_id)
        {
            *existing = replacement;
        } else {
            snapshot.grants.push(replacement);
        }
        snapshot
            .grants
            .sort_by(|left, right| left.workspace_id.cmp(&right.workspace_id));
        atomic_write_json_at(self.root.as_raw_fd(), &self.filename, &snapshot)?;
        Ok(snapshot.generation)
    }

    pub fn update_status(
        &self,
        workspace_id: &str,
        expected_status: GrantStatus,
        next_status: GrantStatus,
        expected_generation: u64,
    ) -> Result<u64, WorkspaceGrantError> {
        let _lock = lock_workspace_root(self.root.as_raw_fd())?;
        let mut snapshot = self.load_locked()?;
        assert_generation(&snapshot, expected_generation)?;
        let grant = snapshot
            .grants
            .iter_mut()
            .find(|grant| grant.workspace_id == workspace_id)
            .ok_or_else(|| WorkspaceGrantError::MissingWorkspaceGrant(workspace_id.to_owned()))?;
        if grant.status != expected_status {
            return Err(WorkspaceGrantError::StatusConflict {
                expected: expected_status,
                actual: grant.status,
            });
        }
        snapshot.generation = next_generation(snapshot.generation)?;
        grant.generation = snapshot.generation;
        grant.status = next_status;
        atomic_write_json_at(self.root.as_raw_fd(), &self.filename, &snapshot)?;
        Ok(snapshot.generation)
    }

    pub fn begin_operation(
        &self,
        workspace_id: &str,
        expected_status: GrantStatus,
        next_status: GrantStatus,
        expected_generation: u64,
        operation_id: Uuid,
    ) -> Result<u64, WorkspaceGrantError> {
        let _lock = lock_workspace_root(self.root.as_raw_fd())?;
        let mut snapshot = self.load_locked()?;
        assert_generation(&snapshot, expected_generation)?;
        let grant = snapshot
            .grants
            .iter_mut()
            .find(|grant| grant.workspace_id == workspace_id)
            .ok_or_else(|| WorkspaceGrantError::MissingWorkspaceGrant(workspace_id.to_owned()))?;
        if grant.status != expected_status {
            return Err(WorkspaceGrantError::StatusConflict {
                expected: expected_status,
                actual: grant.status,
            });
        }
        snapshot.generation = next_generation(snapshot.generation)?;
        grant.generation = snapshot.generation;
        grant.status = next_status;
        grant.previous_operation_id = Some(grant.operation_id);
        grant.previous_status = Some(expected_status);
        grant.operation_id = operation_id;
        atomic_write_json_at(self.root.as_raw_fd(), &self.filename, &snapshot)?;
        Ok(snapshot.generation)
    }

    pub fn rollback_operation(
        &self,
        workspace_id: &str,
        expected_status: GrantStatus,
        expected_generation: u64,
        operation_id: Uuid,
    ) -> Result<u64, WorkspaceGrantError> {
        let _lock = lock_workspace_root(self.root.as_raw_fd())?;
        let mut snapshot = self.load_locked()?;
        assert_generation(&snapshot, expected_generation)?;
        let grant = snapshot
            .grants
            .iter_mut()
            .find(|grant| grant.workspace_id == workspace_id)
            .ok_or_else(|| WorkspaceGrantError::MissingWorkspaceGrant(workspace_id.to_owned()))?;
        if grant.status != expected_status || grant.operation_id != operation_id {
            return Err(WorkspaceGrantError::InvalidPendingGrant);
        }
        let previous_operation_id = grant
            .previous_operation_id
            .take()
            .ok_or(WorkspaceGrantError::InvalidPendingGrant)?;
        let previous_status = grant
            .previous_status
            .take()
            .ok_or(WorkspaceGrantError::InvalidPendingGrant)?;
        snapshot.generation = next_generation(snapshot.generation)?;
        grant.generation = snapshot.generation;
        grant.status = previous_status;
        grant.operation_id = previous_operation_id;
        atomic_write_json_at(self.root.as_raw_fd(), &self.filename, &snapshot)?;
        Ok(snapshot.generation)
    }

    pub fn finish_operation(
        &self,
        workspace_id: &str,
        expected_status: GrantStatus,
        next_status: GrantStatus,
        expected_generation: u64,
        operation_id: Uuid,
    ) -> Result<u64, WorkspaceGrantError> {
        let _lock = lock_workspace_root(self.root.as_raw_fd())?;
        let mut snapshot = self.load_locked()?;
        assert_generation(&snapshot, expected_generation)?;
        let grant = snapshot
            .grants
            .iter_mut()
            .find(|grant| grant.workspace_id == workspace_id)
            .ok_or_else(|| WorkspaceGrantError::MissingWorkspaceGrant(workspace_id.to_owned()))?;
        if grant.status != expected_status || grant.operation_id != operation_id {
            return Err(WorkspaceGrantError::InvalidPendingGrant);
        }
        snapshot.generation = next_generation(snapshot.generation)?;
        grant.generation = snapshot.generation;
        grant.status = next_status;
        grant.previous_operation_id = None;
        grant.previous_status = None;
        atomic_write_json_at(self.root.as_raw_fd(), &self.filename, &snapshot)?;
        Ok(snapshot.generation)
    }

    pub fn delete_operation(
        &self,
        workspace_id: &str,
        expected_status: GrantStatus,
        expected_generation: u64,
        operation_id: Uuid,
    ) -> Result<u64, WorkspaceGrantError> {
        let _lock = lock_workspace_root(self.root.as_raw_fd())?;
        let mut snapshot = self.load_locked()?;
        assert_generation(&snapshot, expected_generation)?;
        let Some(index) = snapshot
            .grants
            .iter()
            .position(|grant| grant.workspace_id == workspace_id)
        else {
            return Err(WorkspaceGrantError::MissingWorkspaceGrant(
                workspace_id.to_owned(),
            ));
        };
        if snapshot.grants[index].operation_id != operation_id {
            return Err(WorkspaceGrantError::InvalidPendingGrant);
        }
        if snapshot.grants[index].status != expected_status {
            return Err(WorkspaceGrantError::StatusConflict {
                expected: expected_status,
                actual: snapshot.grants[index].status,
            });
        }
        snapshot.grants.remove(index);
        snapshot.generation = next_generation(snapshot.generation)?;
        atomic_write_json_at(self.root.as_raw_fd(), &self.filename, &snapshot)?;
        Ok(snapshot.generation)
    }

    pub fn delete(
        &self,
        workspace_id: &str,
        expected_status: GrantStatus,
        expected_generation: u64,
    ) -> Result<u64, WorkspaceGrantError> {
        let _lock = lock_workspace_root(self.root.as_raw_fd())?;
        let mut snapshot = self.load_locked()?;
        assert_generation(&snapshot, expected_generation)?;
        let Some(index) = snapshot
            .grants
            .iter()
            .position(|grant| grant.workspace_id == workspace_id)
        else {
            return Err(WorkspaceGrantError::MissingWorkspaceGrant(
                workspace_id.to_owned(),
            ));
        };
        if snapshot.grants[index].status != expected_status {
            return Err(WorkspaceGrantError::StatusConflict {
                expected: expected_status,
                actual: snapshot.grants[index].status,
            });
        }
        snapshot.grants.remove(index);
        snapshot.generation = next_generation(snapshot.generation)?;
        atomic_write_json_at(self.root.as_raw_fd(), &self.filename, &snapshot)?;
        Ok(snapshot.generation)
    }
}

fn assert_generation(
    snapshot: &GrantSnapshot,
    expected_generation: u64,
) -> Result<(), WorkspaceGrantError> {
    if snapshot.generation != expected_generation {
        return Err(WorkspaceGrantError::GenerationConflict {
            expected: expected_generation,
            actual: snapshot.generation,
        });
    }
    Ok(())
}

fn next_generation(generation: u64) -> Result<u64, WorkspaceGrantError> {
    generation
        .checked_add(1)
        .ok_or_else(|| WorkspaceGrantError::Corrupt("grant generation overflow".to_owned()))
}

fn parse_snapshot(bytes: &[u8]) -> Result<GrantSnapshot, WorkspaceGrantError> {
    let snapshot: GrantSnapshot = serde_json::from_slice(bytes)
        .map_err(|source| WorkspaceGrantError::Corrupt(format!("invalid grant store: {source}")))?;
    if snapshot.version != STORE_VERSION {
        return Err(WorkspaceGrantError::Corrupt(
            "Workspace grant store version is unsupported".to_owned(),
        ));
    }
    let mut ids = HashSet::new();
    for grant in &snapshot.grants {
        if grant.version != STORE_VERSION {
            return Err(WorkspaceGrantError::Corrupt(
                "Workspace grant version is unsupported".to_owned(),
            ));
        }
        if !ids.insert(grant.workspace_id.clone()) {
            return Err(WorkspaceGrantError::DuplicateWorkspaceId(
                grant.workspace_id.clone(),
            ));
        }
        let transitional = matches!(
            grant.status,
            GrantStatus::Revoking | GrantStatus::Reauthorizing
        );
        if grant.previous_operation_id.is_some() != grant.previous_status.is_some()
            || (!transitional && grant.previous_operation_id.is_some())
        {
            return Err(WorkspaceGrantError::Corrupt(
                "Workspace grant operation rollback fields are inconsistent".to_owned(),
            ));
        }
    }
    Ok(snapshot)
}

pub(crate) fn read_owner_file_at(
    root: RawFd,
    name: &CStr,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, WorkspaceGrantError> {
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
        } else if source.raw_os_error() == Some(libc::ELOOP) {
            Err(WorkspaceGrantError::UnsafePath(
                "Workspace state file is a symlink".to_owned(),
            ))
        } else {
            Err(WorkspaceGrantError::io("open Workspace state file", source))
        };
    }
    let mut file = unsafe { fs::File::from_raw_fd(descriptor) };
    let metadata = descriptor_stat(file.as_raw_fd())
        .map_err(|source| WorkspaceGrantError::io("inspect Workspace state file", source))?;
    if metadata.st_mode as u32 & libc::S_IFMT as u32 != libc::S_IFREG as u32 {
        return Err(WorkspaceGrantError::UnsafePath(
            "Workspace state must be a regular file".to_owned(),
        ));
    }
    if metadata.st_uid != unsafe { libc::geteuid() }
        || metadata.st_mode as u32 & 0o077 != 0
        || metadata.st_nlink != 1
    {
        return Err(WorkspaceGrantError::WrongOwnerOrMode(
            "Workspace state must be owner-only and singly linked".to_owned(),
        ));
    }
    if metadata.st_size < 0 || metadata.st_size as u64 > max_bytes {
        return Err(WorkspaceGrantError::Corrupt(
            "Workspace state exceeds its size limit".to_owned(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.st_size as usize);
    file.read_to_end(&mut bytes)
        .map_err(|source| WorkspaceGrantError::io("read Workspace state file", source))?;
    if bytes.len() as u64 > max_bytes {
        return Err(WorkspaceGrantError::Corrupt(
            "Workspace state exceeds its size limit".to_owned(),
        ));
    }
    Ok(Some(bytes))
}

pub(crate) fn open_private_root(root: &Path) -> Result<OwnedFd, WorkspaceGrantError> {
    open_private_root_for_owner(root, unsafe { libc::geteuid() })
}

fn open_private_root_for_owner(
    root: &Path,
    expected_uid: u32,
) -> Result<OwnedFd, WorkspaceGrantError> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|source| WorkspaceGrantError::io("inspect Workspace data root", source))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != expected_uid
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(WorkspaceGrantError::WrongOwnerOrMode(
            "Workspace data root must be an owner-only real directory".to_owned(),
        ));
    }
    let root_path = CString::new(root.as_os_str().as_bytes())
        .map_err(|_| WorkspaceGrantError::UnsafePath("Workspace root contains NUL".to_owned()))?;
    let descriptor = unsafe {
        libc::open(
            root_path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        return Err(WorkspaceGrantError::io(
            "open Workspace data root",
            io::Error::last_os_error(),
        ));
    }
    let descriptor = unsafe { OwnedFd::from_raw_fd(descriptor) };
    let opened = descriptor_stat(descriptor.as_raw_fd())
        .map_err(|source| WorkspaceGrantError::io("inspect opened Workspace root", source))?;
    if FileIdentity::from_stat(&opened) != FileIdentity::from_metadata(&metadata)
        || opened.st_uid != expected_uid
        || opened.st_mode as u32 & 0o077 != 0
    {
        return Err(WorkspaceGrantError::WrongOwnerOrMode(
            "Workspace data root identity changed while opening".to_owned(),
        ));
    }
    Ok(descriptor)
}

pub(crate) fn lock_workspace_root(root: RawFd) -> Result<fs::File, WorkspaceGrantError> {
    let name = c_name(".openloop-workspace.lock")?;
    let descriptor = unsafe {
        libc::openat(
            root,
            name.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(WorkspaceGrantError::io(
            "open Workspace lock",
            io::Error::last_os_error(),
        ));
    }
    let file = unsafe { fs::File::from_raw_fd(descriptor) };
    let metadata = descriptor_stat(file.as_raw_fd())
        .map_err(|source| WorkspaceGrantError::io("inspect Workspace lock", source))?;
    if metadata.st_mode as u32 & libc::S_IFMT as u32 != libc::S_IFREG as u32
        || metadata.st_uid != unsafe { libc::geteuid() }
        || metadata.st_mode as u32 & 0o077 != 0
        || metadata.st_nlink != 1
    {
        return Err(WorkspaceGrantError::WrongOwnerOrMode(
            "Workspace lock must be owner-only and singly linked".to_owned(),
        ));
    }
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } < 0 {
        return Err(WorkspaceGrantError::io(
            "lock Workspace state",
            io::Error::last_os_error(),
        ));
    }
    Ok(file)
}

pub(crate) fn atomic_write_json_at<T: Serialize>(
    root: RawFd,
    destination: &CStr,
    value: &T,
) -> Result<(), WorkspaceGrantError> {
    let temporary = c_name(&format!(".openloop-workspace.{}.tmp", Uuid::new_v4()))?;
    let bytes = serde_json::to_vec(value)
        .map_err(|source| WorkspaceGrantError::Corrupt(source.to_string()))?;
    let descriptor = unsafe {
        libc::openat(
            root,
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(WorkspaceGrantError::io(
            "create Workspace state",
            io::Error::last_os_error(),
        ));
    }
    let mut file = unsafe { fs::File::from_raw_fd(descriptor) };
    let result = (|| {
        file.write_all(&bytes)
            .map_err(|source| WorkspaceGrantError::io("write Workspace state", source))?;
        file.sync_all()
            .map_err(|source| WorkspaceGrantError::io("sync Workspace state", source))?;
        if unsafe { libc::renameat(root, temporary.as_ptr(), root, destination.as_ptr()) } < 0 {
            return Err(WorkspaceGrantError::io(
                "publish Workspace state",
                io::Error::last_os_error(),
            ));
        }
        sync_descriptor(root, "sync Workspace data root")
    })();
    if result.is_err() {
        unsafe {
            libc::unlinkat(root, temporary.as_ptr(), 0);
        }
    }
    result
}

pub(crate) fn remove_file_at(root: RawFd, name: &CStr) -> Result<(), WorkspaceGrantError> {
    if unsafe { libc::unlinkat(root, name.as_ptr(), 0) } < 0 {
        let source = io::Error::last_os_error();
        if source.kind() != io::ErrorKind::NotFound {
            return Err(WorkspaceGrantError::io("remove Workspace state", source));
        }
    }
    sync_descriptor(root, "sync Workspace data root")
}

fn sync_descriptor(descriptor: RawFd, action: &'static str) -> Result<(), WorkspaceGrantError> {
    if unsafe { libc::fsync(descriptor) } < 0 {
        return Err(WorkspaceGrantError::io(action, io::Error::last_os_error()));
    }
    Ok(())
}

pub(crate) fn c_name(value: &str) -> Result<CString, WorkspaceGrantError> {
    if value.is_empty() || value.as_bytes().contains(&b'/') {
        return Err(WorkspaceGrantError::UnsafePath(
            "Workspace state filename is invalid".to_owned(),
        ));
    }
    CString::new(value)
        .map_err(|_| WorkspaceGrantError::UnsafePath("Workspace filename contains NUL".to_owned()))
}

#[derive(Debug)]
pub struct VerifiedGrant {
    grant: WorkspaceGrant,
    _descriptor: OwnedFd,
}

#[derive(Debug)]
pub struct LaunchGrant {
    grant: WorkspaceGrant,
    descriptor: Option<OwnedFd>,
}

impl LaunchGrant {
    pub fn grant(&self) -> &WorkspaceGrant {
        &self.grant
    }

    pub fn is_ready(&self) -> bool {
        self.descriptor.is_some() && self.grant.status == GrantStatus::Ready
    }

    pub fn descriptor(&self) -> Option<&OwnedFd> {
        self.descriptor.as_ref()
    }

    pub(crate) fn into_verified_parts(self) -> Option<(WorkspaceGrant, OwnedFd)> {
        self.descriptor.map(|descriptor| (self.grant, descriptor))
    }
}

impl VerifiedGrant {
    pub fn grant(&self) -> &WorkspaceGrant {
        &self.grant
    }

    pub(crate) fn into_parts(self) -> (WorkspaceGrant, OwnedFd) {
        (self.grant, self._descriptor)
    }
}

pub fn reopen_verified_grant(grant: &WorkspaceGrant) -> Result<VerifiedGrant, WorkspaceGrantError> {
    if !grant.canonical_path.is_absolute() {
        return Err(WorkspaceGrantError::UnsafePath(
            "Workspace canonical path must be absolute".to_owned(),
        ));
    }
    let root_name = CString::new("/")
        .map_err(|_| WorkspaceGrantError::UnsafePath("invalid filesystem root".to_owned()))?;
    let root_fd = unsafe {
        libc::open(
            root_name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if root_fd < 0 {
        return Err(WorkspaceGrantError::io(
            "open filesystem root",
            io::Error::last_os_error(),
        ));
    }
    let mut current = unsafe { OwnedFd::from_raw_fd(root_fd) };
    for component in grant.canonical_path.components() {
        let Component::Normal(name) = component else {
            if matches!(component, Component::RootDir) {
                continue;
            }
            return Err(WorkspaceGrantError::UnsafePath(
                "Workspace path contains a non-normal component".to_owned(),
            ));
        };
        let name = CString::new(name.as_bytes()).map_err(|_| {
            WorkspaceGrantError::UnsafePath("Workspace path contains NUL".to_owned())
        })?;
        let descriptor = unsafe {
            libc::openat(
                current.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if descriptor < 0 {
            let source = io::Error::last_os_error();
            let status = if source.kind() == io::ErrorKind::NotFound {
                GrantStatus::Missing
            } else {
                GrantStatus::PermissionDenied
            };
            return Err(WorkspaceGrantError::verification(
                status,
                format!("cannot reopen Workspace descriptor: {source}"),
            ));
        }
        current = unsafe { OwnedFd::from_raw_fd(descriptor) };
    }
    let metadata = descriptor_stat(current.as_raw_fd())
        .map_err(|source| WorkspaceGrantError::io("inspect Workspace descriptor", source))?;
    if metadata.st_mode as u32 & libc::S_IFMT as u32 != libc::S_IFDIR as u32
        || FileIdentity::from_stat(&metadata) != grant.identity
    {
        return Err(WorkspaceGrantError::verification(
            GrantStatus::IdentityMismatch,
            "Workspace identity changed",
        ));
    }
    if metadata.st_uid != unsafe { libc::geteuid() } || metadata.st_mode as u32 & 0o002 != 0 {
        return Err(WorkspaceGrantError::verification(
            GrantStatus::PermissionDenied,
            "Workspace ownership or permissions are unsafe",
        ));
    }
    let mut verified = grant.clone();
    verified.status = GrantStatus::Ready;
    Ok(VerifiedGrant {
        grant: verified,
        _descriptor: current,
    })
}

fn descriptor_stat(descriptor: libc::c_int) -> io::Result<libc::stat> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { metadata.assume_init() })
}
