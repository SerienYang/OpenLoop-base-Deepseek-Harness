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

const HEALTH_TIMEOUT: Duration = Duration::from_secs(60);

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
    Committed,
    RolledBack(HealthStatus),
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
pub struct RecoveryTransaction {
    root_path: PathBuf,
    root: OwnedFd,
    installed_name: CString,
    candidate_name: CString,
    backup_name: CString,
    staging_name: CString,
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

        let installed_text = installed_name.to_string_lossy();
        let backup_name = CString::new(format!(".{installed_text}.openloop-backup"))
            .expect("validated app names contain no NUL");
        let staging_name = CString::new(format!(".{installed_text}.openloop-staging"))
            .expect("validated app names contain no NUL");

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
        for marker in [&backup_name, &staging_name] {
            match identity_at(root.as_raw_fd(), marker) {
                Ok(_) => {
                    let marker_path = canonical_root.join(OsStr::from_bytes(marker.to_bytes()));
                    return Err(RecoveryError::invalid(format!(
                        "stale update transaction marker exists at {}",
                        marker_path.display()
                    )));
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(source) => {
                    return Err(RecoveryError::io(
                        "inspect update transaction marker",
                        source,
                    ));
                }
            }
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
            backup_name,
            staging_name,
            installed_identity,
            candidate_identity,
        })
    }

    pub fn publish(
        self,
        health: &mut impl CandidateHealth,
    ) -> Result<PublicationOutcome, RecoveryError> {
        self.rename_owned(
            &self.installed_name,
            &self.backup_name,
            self.installed_identity,
            "installed app bundle",
        )
        .map_err(|source| RecoveryError::io("preserve installed app bundle", source))?;
        if let Err(publication_error) = self.rename_owned(
            &self.candidate_name,
            &self.installed_name,
            self.candidate_identity,
            "candidate app bundle",
        ) {
            let restore = self.rename_owned(
                &self.backup_name,
                &self.installed_name,
                self.installed_identity,
                "installed backup",
            );
            return match restore {
                Ok(()) => Err(RecoveryError::io(
                    "publish candidate app bundle",
                    publication_error,
                )),
                Err(restore_error) => Err(RecoveryError::RestoreFailed {
                    restore: restore_error,
                    candidate_republish: None,
                }),
            };
        }

        let installed_path = self.path(&self.installed_name);
        let status = health.await_health(&installed_path, HEALTH_TIMEOUT);
        if status == HealthStatus::Healthy {
            self.remove_owned(
                &self.backup_name,
                self.installed_identity,
                "installed backup",
            )
            .map_err(|source| RecoveryError::io("remove committed backup", source))?;
            return Ok(PublicationOutcome::Committed);
        }

        self.rename_owned(
            &self.installed_name,
            &self.staging_name,
            self.candidate_identity,
            "published candidate",
        )
        .map_err(|source| RecoveryError::io("stage failed candidate", source))?;
        if let Err(restore) = self.rename_owned(
            &self.backup_name,
            &self.installed_name,
            self.installed_identity,
            "installed backup",
        ) {
            let candidate_republish = self
                .rename_owned(
                    &self.staging_name,
                    &self.installed_name,
                    self.candidate_identity,
                    "staged candidate",
                )
                .err();
            return Err(RecoveryError::RestoreFailed {
                restore,
                candidate_republish,
            });
        }
        self.remove_owned(
            &self.staging_name,
            self.candidate_identity,
            "staged candidate",
        )
        .map_err(|source| RecoveryError::io("remove rolled-back candidate", source))?;
        Ok(PublicationOutcome::RolledBack(status))
    }

    fn rename_owned(
        &self,
        from: &CStr,
        to: &CStr,
        expected: FileIdentity,
        label: &str,
    ) -> io::Result<()> {
        self.verify_identity(from, expected, label)?;
        self.rename_unchecked(from, to)?;
        let actual = match identity_at(self.root.as_raw_fd(), to) {
            Ok(actual) if actual == expected => return Ok(()),
            Ok(actual) => actual,
            Err(error) => {
                return Err(identity_error(
                    label,
                    format!("destination inspection failed after rename: {error}"),
                ));
            }
        };
        let recovery = self
            .return_unexpected_entry(to, from, actual)
            .map(|()| "unexpected entry returned to its source path".to_owned())
            .unwrap_or_else(|error| format!("returning unexpected entry failed: {error}"));
        Err(identity_error(
            label,
            format!("destination changed during rename; {recovery}"),
        ))
    }

    fn return_unexpected_entry(
        &self,
        from: &CStr,
        to: &CStr,
        observed: FileIdentity,
    ) -> io::Result<()> {
        self.verify_identity(from, observed, "unexpected renamed entry")?;
        self.rename_unchecked(from, to)?;
        self.verify_identity(to, observed, "returned unexpected entry")
    }

    fn verify_identity(&self, name: &CStr, expected: FileIdentity, label: &str) -> io::Result<()> {
        let actual = identity_at(self.root.as_raw_fd(), name)
            .map_err(|error| identity_error(label, error.to_string()))?;
        if actual != expected {
            return Err(identity_error(label, "filesystem object was replaced"));
        }
        Ok(())
    }

    fn rename_unchecked(&self, from: &CStr, to: &CStr) -> io::Result<()> {
        // SAFETY: both names are validated single path components and the
        // transaction keeps the root descriptor alive for the entire call.
        // RENAME_EXCL prevents a raced, unowned marker from being replaced.
        let result = unsafe {
            libc::renameatx_np(
                self.root.as_raw_fd(),
                from.as_ptr(),
                self.root.as_raw_fd(),
                to.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn path(&self, name: &CStr) -> PathBuf {
        self.root_path.join(OsStr::from_bytes(name.to_bytes()))
    }

    fn remove_owned(&self, name: &CStr, expected: FileIdentity, label: &str) -> io::Result<()> {
        self.verify_identity(name, expected, label)?;
        // SAFETY: removefileat resolves the validated name under the retained
        // root descriptor. A null state requests ordinary recursive removal.
        let result = unsafe {
            removefileat(
                self.root.as_raw_fd(),
                name.as_ptr(),
                std::ptr::null_mut(),
                REMOVEFILE_RECURSIVE,
            )
        };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

type RemoveFileState = *mut libc::c_void;
const REMOVEFILE_RECURSIVE: u32 = 1;

unsafe extern "C" {
    fn removefileat(
        descriptor: libc::c_int,
        path: *const libc::c_char,
        state: RemoveFileState,
        flags: u32,
    ) -> libc::c_int;
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
