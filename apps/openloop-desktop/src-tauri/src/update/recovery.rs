use std::{
    error::Error,
    ffi::{CStr, CString, OsStr},
    fmt, fs, io,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Path, PathBuf},
    time::Duration,
};

use uuid::Uuid;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(60);
const MARKER_ATTEMPTS: usize = 16;

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
    BeforeInstalledBackupSwap,
    BeforeCandidatePublishSwap,
    BeforePublishFailureRestoreSwap,
    BeforeHealthRollbackSwap,
}

#[cfg(not(debug_assertions))]
#[derive(Debug, Clone, Copy)]
enum RecoveryBoundary {
    BeforeInstalledBackupSwap,
    BeforeCandidatePublishSwap,
    BeforePublishFailureRestoreSwap,
    BeforeHealthRollbackSwap,
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

#[cfg(debug_assertions)]
struct TestHookAdapter<'a, T>(&'a mut T);

#[cfg(debug_assertions)]
impl<T: RecoveryTestHook> TransactionHook for TestHookAdapter<'_, T> {
    fn before(&mut self, boundary: RecoveryBoundary, left: &Path, right: &Path) {
        self.0.before(boundary, left, right);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
            inode: metadata.st_ino as u64,
            file_type: metadata.st_mode as u32 & libc::S_IFMT as u32,
        }
    }

    fn is_directory(self) -> bool {
        self.file_type == libc::S_IFDIR as u32
    }
}

#[derive(Debug)]
struct OwnedMarker {
    name: CString,
    identity: FileIdentity,
}

#[derive(Debug)]
pub struct RecoveryTransaction {
    root_path: PathBuf,
    root: OwnedFd,
    installed_name: CString,
    candidate_name: CString,
    installed_identity: FileIdentity,
    candidate_identity: FileIdentity,
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
        })
    }

    pub fn publish(
        self,
        health: &mut impl CandidateHealth,
    ) -> Result<PublicationOutcome, RecoveryError> {
        self.publish_inner(health, &mut NoopHook)
    }

    #[cfg(debug_assertions)]
    pub fn publish_with_hook(
        self,
        health: &mut impl CandidateHealth,
        hook: &mut impl RecoveryTestHook,
    ) -> Result<PublicationOutcome, RecoveryError> {
        self.publish_inner(health, &mut TestHookAdapter(hook))
    }

    fn publish_inner(
        self,
        health: &mut impl CandidateHealth,
        hook: &mut impl TransactionHook,
    ) -> Result<PublicationOutcome, RecoveryError> {
        let marker = self
            .create_marker("backup-placeholder")
            .map_err(|source| RecoveryError::io("create recovery placeholder", source))?;

        if let Err(source) = self.swap_checked(
            &self.installed_name,
            self.installed_identity,
            &marker.name,
            marker.identity,
            "installed app and backup placeholder",
            RecoveryBoundary::BeforeInstalledBackupSwap,
            hook,
        ) {
            return Err(RecoveryError::io("preserve installed app bundle", source));
        }

        if let Err(publication_error) = self.swap_checked(
            &self.candidate_name,
            self.candidate_identity,
            &self.installed_name,
            marker.identity,
            "candidate app and installed placeholder",
            RecoveryBoundary::BeforeCandidatePublishSwap,
            hook,
        ) {
            let restore = self.swap_checked(
                &self.installed_name,
                marker.identity,
                &marker.name,
                self.installed_identity,
                "installed placeholder and old app backup",
                RecoveryBoundary::BeforePublishFailureRestoreSwap,
                hook,
            );
            return match restore {
                Ok(()) => Err(RecoveryError::io(
                    "publish candidate app bundle",
                    publication_error,
                )),
                Err(restore) => Err(RecoveryError::RestoreFailed {
                    restore,
                    candidate_republish: None,
                }),
            };
        }

        let installed_path = self.path(&self.installed_name);
        let status = health.await_health(&installed_path, HEALTH_TIMEOUT);
        if status == HealthStatus::Healthy {
            return Ok(PublicationOutcome::Committed {
                preserved_backup: self.path(&marker.name),
            });
        }

        if let Err(restore) = self.health_rollback_swap(&marker, hook) {
            return Err(RecoveryError::RestoreFailed {
                restore,
                candidate_republish: None,
            });
        }
        Ok(PublicationOutcome::RolledBack {
            status,
            failed_candidate: self.path(&marker.name),
        })
    }

    fn health_rollback_swap(
        &self,
        marker: &OwnedMarker,
        hook: &mut impl TransactionHook,
    ) -> io::Result<()> {
        self.verify_identity(
            &self.installed_name,
            self.candidate_identity,
            "published candidate",
        )?;
        self.verify_identity(&marker.name, self.installed_identity, "old app backup")?;
        hook.before(
            RecoveryBoundary::BeforeHealthRollbackSwap,
            &self.path(&self.installed_name),
            &self.path(&marker.name),
        );
        self.atomic_swap(&self.installed_name, &marker.name)?;
        let installed_observed =
            identity_at(self.root.as_raw_fd(), &self.installed_name).map_err(|error| {
                identity_error(
                    "health rollback installed path",
                    format!(
                        "inspection failed: {error}; preserved entries remain visible at {} and {}",
                        self.path(&self.installed_name).display(),
                        self.path(&marker.name).display()
                    ),
                )
            })?;
        let backup_observed =
            identity_at(self.root.as_raw_fd(), &marker.name).map_err(|error| {
                identity_error(
                    "health rollback backup path",
                    format!(
                        "inspection failed: {error}; preserved entries remain visible at {} and {}",
                        self.path(&self.installed_name).display(),
                        self.path(&marker.name).display()
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
                    self.path(&marker.name).display()
                ),
            ));
        }
        let rollback = self.rollback_observed(
            &self.installed_name,
            installed_observed,
            &marker.name,
            backup_observed,
            "failed health rollback",
        );
        Err(identity_error(
            "health rollback",
            match rollback {
                Ok(()) => format!(
                    "filesystem objects changed during swap and were returned; preserved at {} and {}",
                    self.path(&self.installed_name).display(),
                    self.path(&marker.name).display()
                ),
                Err(error) => format!(
                    "filesystem objects changed during swap; returning observed objects failed: {error}; preserved entries remain visible at {} and {}",
                    self.path(&self.installed_name).display(),
                    self.path(&marker.name).display()
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
        boundary: RecoveryBoundary,
        hook: &mut impl TransactionHook,
    ) -> io::Result<()> {
        self.verify_identity(left, left_expected, label)?;
        self.verify_identity(right, right_expected, label)?;
        hook.before(boundary, &self.path(left), &self.path(right));
        self.atomic_swap(left, right)?;

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

    fn create_marker(&self, label: &str) -> io::Result<OwnedMarker> {
        for _ in 0..MARKER_ATTEMPTS {
            let name = random_name(label);
            // SAFETY: `name` is a live NUL-terminated single path component
            // and the retained root descriptor names the update directory.
            let result =
                unsafe { libc::mkdirat(self.root.as_raw_fd(), name.as_ptr(), libc::S_IRWXU) };
            if result == 0 {
                let identity = identity_at(self.root.as_raw_fd(), &name)?;
                if !identity.is_directory() {
                    return Err(identity_error(label, "created marker is not a directory"));
                }
                return Ok(OwnedMarker { name, identity });
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::AlreadyExists {
                return Err(error);
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not allocate an unpredictable recovery marker",
        ))
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
}

fn random_name(label: &str) -> CString {
    CString::new(format!(".openloop-{label}-{}", Uuid::new_v4()))
        .expect("UUID recovery names contain no NUL")
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
}

impl RecoveryError {
    fn invalid(message: impl Into<String>) -> Self {
        Self::InvalidState(message.into())
    }

    fn io(operation: &'static str, source: io::Error) -> Self {
        Self::Io { operation, source }
    }
}

impl fmt::Display for RecoveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidState(message) => formatter.write_str(message),
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
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
        }
    }
}

impl Error for RecoveryError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidState(_) => None,
            Self::Io { source, .. } => Some(source),
            Self::RestoreFailed { restore, .. } => Some(restore),
        }
    }
}
