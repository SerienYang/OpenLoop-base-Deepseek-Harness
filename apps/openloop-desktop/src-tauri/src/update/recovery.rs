use std::{
    error::Error,
    ffi::{CStr, CString, OsStr},
    fmt, fs, io,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Path, PathBuf},
    time::Duration,
};

const HEALTH_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
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

#[derive(Debug)]
pub struct RecoveryTransaction {
    root_path: PathBuf,
    root: OwnedFd,
    installed_name: CString,
    candidate_name: CString,
    backup_name: CString,
    staging_name: CString,
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
        let installed_metadata = real_bundle_metadata(installed, "installed")?;
        let candidate_metadata = real_bundle_metadata(candidate, "candidate")?;
        if installed_metadata.dev() != candidate_metadata.dev()
            || installed_metadata.dev() != root_metadata.dev()
        {
            return Err(RecoveryError::invalid(
                "installed, candidate, and update root must share one filesystem",
            ));
        }

        let installed_text = installed_name.to_string_lossy();
        let backup_name = CString::new(format!(".{installed_text}.openloop-backup"))
            .expect("validated app names contain no NUL");
        let staging_name = CString::new(format!(".{installed_text}.openloop-staging"))
            .expect("validated app names contain no NUL");
        for marker in [&backup_name, &staging_name] {
            let marker_path = canonical_root.join(OsStr::from_bytes(marker.to_bytes()));
            match fs::symlink_metadata(&marker_path) {
                Ok(_) => {
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

        let root_c = CString::new(root.as_os_str().as_bytes())
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

        Ok(Self {
            root_path: canonical_root,
            // SAFETY: `descriptor` was just returned as a new owned fd.
            root: unsafe { OwnedFd::from_raw_fd(descriptor) },
            installed_name,
            candidate_name,
            backup_name,
            staging_name,
        })
    }

    pub fn publish(
        self,
        health: &mut impl CandidateHealth,
    ) -> Result<PublicationOutcome, RecoveryError> {
        self.rename(&self.installed_name, &self.backup_name)
            .map_err(|source| RecoveryError::io("preserve installed app bundle", source))?;
        if let Err(publication_error) = self.rename(&self.candidate_name, &self.installed_name) {
            let restore = self.rename(&self.backup_name, &self.installed_name);
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
            self.remove_bundle(&self.backup_name)
                .map_err(|source| RecoveryError::io("remove committed backup", source))?;
            return Ok(PublicationOutcome::Committed);
        }

        self.rename(&self.installed_name, &self.staging_name)
            .map_err(|source| RecoveryError::io("stage failed candidate", source))?;
        if let Err(restore) = self.rename(&self.backup_name, &self.installed_name) {
            let candidate_republish = self.rename(&self.staging_name, &self.installed_name).err();
            return Err(RecoveryError::RestoreFailed {
                restore,
                candidate_republish,
            });
        }
        self.remove_bundle(&self.staging_name)
            .map_err(|source| RecoveryError::io("remove rolled-back candidate", source))?;
        Ok(PublicationOutcome::RolledBack(status))
    }

    fn rename(&self, from: &CStr, to: &CStr) -> io::Result<()> {
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

    fn remove_bundle(&self, name: &CStr) -> io::Result<()> {
        let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: `metadata` points to writable storage, `name` is a live
        // single component, and the root descriptor remains open.
        let result = unsafe {
            libc::fstatat(
                self.root.as_raw_fd(),
                name.as_ptr(),
                metadata.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful fstatat initialized the complete stat value.
        let metadata = unsafe { metadata.assume_init() };
        if metadata.st_mode & libc::S_IFMT != libc::S_IFDIR {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "transaction cleanup target is not a real app bundle directory",
            ));
        }
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

fn real_bundle_metadata(path: &Path, label: &str) -> Result<fs::Metadata, RecoveryError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|source| RecoveryError::io("inspect app bundle", source))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(RecoveryError::invalid(format!(
            "{label} app bundle must be a real directory, not a symlink"
        )));
    }
    Ok(metadata)
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
