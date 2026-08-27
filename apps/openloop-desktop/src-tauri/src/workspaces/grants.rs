use std::{
    collections::HashSet,
    error::Error,
    ffi::{CString, OsStr},
    fmt, fs,
    io::{self, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        },
    },
    path::{Component, Path, PathBuf},
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
    InvalidPendingGrant,
    LaunchMismatch,
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
            Self::InvalidPendingGrant => formatter.write_str("pending Workspace grant is invalid"),
            Self::LaunchMismatch => {
                formatter.write_str("pending Workspace grant belongs to another launch")
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
    root: PathBuf,
    path: PathBuf,
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
        validate_private_root_for_owner(root, expected_uid)?;
        let suffix = match channel {
            ReleaseChannel::Test => "test",
            ReleaseChannel::Stable => "stable",
        };
        Ok(Self {
            root: root.to_owned(),
            path: root.join(format!(".openloop-workspace-grants.{suffix}.v1.json")),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<GrantSnapshot, WorkspaceGrantError> {
        read_snapshot(&self.path)
    }

    pub fn load_for_launch(&self) -> Result<Vec<LaunchGrant>, WorkspaceGrantError> {
        self.load()?
            .grants
            .into_iter()
            .map(|grant| match reopen_verified_grant(&grant) {
                Ok(verified) => {
                    let (grant, descriptor) = verified.into_parts();
                    Ok(LaunchGrant {
                        grant,
                        descriptor: Some(descriptor),
                    })
                }
                Err(error @ WorkspaceGrantError::Verification { .. }) => {
                    let mut unavailable = grant;
                    unavailable.status = error.status().unwrap_or(GrantStatus::NeedsAuthorization);
                    Ok(LaunchGrant {
                        grant: unavailable,
                        descriptor: None,
                    })
                }
                Err(error) => Err(error),
            })
            .collect()
    }

    pub fn commit(
        &self,
        grant: WorkspaceGrant,
        expected_generation: u64,
    ) -> Result<u64, WorkspaceGrantError> {
        let mut snapshot = self.load()?;
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
        atomic_write_json(&self.root, &self.path, &snapshot)?;
        Ok(snapshot.generation)
    }
}

fn read_snapshot(path: &Path) -> Result<GrantSnapshot, WorkspaceGrantError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == io::ErrorKind::NotFound => {
            return Ok(GrantSnapshot::default())
        }
        Err(source) => return Err(WorkspaceGrantError::io("inspect grant store", source)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(WorkspaceGrantError::UnsafePath(
            "Workspace grant store must be a regular file".to_owned(),
        ));
    }
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.permissions().mode() & 0o077 != 0 {
        return Err(WorkspaceGrantError::WrongOwnerOrMode(
            "Workspace grant store must be owner-only".to_owned(),
        ));
    }
    if metadata.len() > MAX_STORE_BYTES {
        return Err(WorkspaceGrantError::Corrupt(
            "Workspace grant store exceeds its size limit".to_owned(),
        ));
    }
    let bytes =
        fs::read(path).map_err(|source| WorkspaceGrantError::io("read grant store", source))?;
    let snapshot: GrantSnapshot = serde_json::from_slice(&bytes)
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
    }
    Ok(snapshot)
}

pub(crate) fn validate_private_root(root: &Path) -> Result<(), WorkspaceGrantError> {
    validate_private_root_for_owner(root, unsafe { libc::geteuid() })
}

fn validate_private_root_for_owner(
    root: &Path,
    expected_uid: u32,
) -> Result<(), WorkspaceGrantError> {
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
    Ok(())
}

pub(crate) fn atomic_write_json<T: Serialize>(
    root: &Path,
    destination: &Path,
    value: &T,
) -> Result<(), WorkspaceGrantError> {
    validate_private_root(root)?;
    if let Ok(metadata) = fs::symlink_metadata(destination) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(WorkspaceGrantError::UnsafePath(
                "Workspace state destination is unsafe".to_owned(),
            ));
        }
    }
    let temporary = root.join(format!(
        ".{}.{}.tmp",
        destination
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("workspace-state"),
        Uuid::new_v4()
    ));
    let bytes = serde_json::to_vec(value)
        .map_err(|source| WorkspaceGrantError::Corrupt(source.to_string()))?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|source| WorkspaceGrantError::io("create Workspace state", source))?;
    let result = (|| {
        file.write_all(&bytes)
            .map_err(|source| WorkspaceGrantError::io("write Workspace state", source))?;
        file.sync_all()
            .map_err(|source| WorkspaceGrantError::io("sync Workspace state", source))?;
        fs::rename(&temporary, destination)
            .map_err(|source| WorkspaceGrantError::io("publish Workspace state", source))?;
        let root_file = fs::File::open(root)
            .map_err(|source| WorkspaceGrantError::io("open Workspace data root", source))?;
        root_file
            .sync_all()
            .map_err(|source| WorkspaceGrantError::io("sync Workspace data root", source))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
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
