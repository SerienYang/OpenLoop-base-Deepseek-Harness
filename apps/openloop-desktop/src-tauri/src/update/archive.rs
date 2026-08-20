use std::{
    collections::HashSet,
    error::Error,
    ffi::{CStr, CString, OsStr},
    fmt, fs, io,
    io::Cursor,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, PermissionsExt},
        },
    },
    path::{Path, PathBuf},
};

use flate2::read::GzDecoder;
use tar::Archive;
use uuid::Uuid;

#[derive(Debug)]
pub struct StagedCandidate {
    path: PathBuf,
}

impl StagedCandidate {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
    file_type: u32,
}

impl FileIdentity {
    fn from_stat(value: &libc::stat) -> Self {
        Self {
            device: value.st_dev as u64,
            inode: value.st_ino as u64,
            file_type: value.st_mode as u32 & libc::S_IFMT as u32,
        }
    }

    fn from_metadata(value: &fs::Metadata) -> Self {
        Self {
            device: value.dev(),
            inode: value.ino(),
            file_type: value.mode() & libc::S_IFMT as u32,
        }
    }

    fn is_directory(self) -> bool {
        self.file_type == libc::S_IFDIR as u32
    }

    fn is_file(self) -> bool {
        self.file_type == libc::S_IFREG as u32
    }
}

pub fn stage_verified_archive(
    archive_bytes: &[u8],
    installed_app: &Path,
) -> Result<StagedCandidate, ArchiveStageError> {
    let installed_metadata = fs::symlink_metadata(installed_app)
        .map_err(|source| ArchiveStageError::io("inspect installed app", source))?;
    if installed_metadata.file_type().is_symlink() || !installed_metadata.is_dir() {
        return Err(ArchiveStageError::invalid(
            "installed app must be a real directory",
        ));
    }
    if installed_app.extension() != Some(OsStr::new("app")) {
        return Err(ArchiveStageError::invalid(
            "installed app must use the .app extension",
        ));
    }
    let parent_path = installed_app
        .parent()
        .ok_or_else(|| ArchiveStageError::invalid("installed app has no parent"))?;
    let parent_metadata = fs::symlink_metadata(parent_path)
        .map_err(|source| ArchiveStageError::io("inspect app parent", source))?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err(ArchiveStageError::invalid(
            "installed app parent must be a real directory",
        ));
    }
    let parent_path = fs::canonicalize(parent_path)
        .map_err(|source| ArchiveStageError::io("canonicalize app parent", source))?;
    let installed_name = installed_app
        .file_name()
        .ok_or_else(|| ArchiveStageError::invalid("installed app has no file name"))?;
    let parent = open_directory(&parent_path)
        .map_err(|source| ArchiveStageError::io("open app parent", source))?;
    let parent_identity = descriptor_identity(parent.as_raw_fd())
        .map_err(|source| ArchiveStageError::io("inspect opened app parent", source))?;
    if parent_identity != FileIdentity::from_metadata(&parent_metadata) {
        return Err(ArchiveStageError::invalid(
            "app parent identity changed while opening archive staging",
        ));
    }
    let installed_name = CString::new(installed_name.as_bytes())
        .map_err(|_| ArchiveStageError::invalid("installed app name contains NUL"))?;
    let installed_identity = identity_at(parent.as_raw_fd(), &installed_name)
        .map_err(|source| ArchiveStageError::io("inspect installed app entry", source))?;
    if !installed_identity.is_directory()
        || installed_identity != FileIdentity::from_metadata(&installed_metadata)
    {
        return Err(ArchiveStageError::invalid(
            "installed app identity changed before archive staging",
        ));
    }

    reject_preserved_artifacts(&parent_path)?;
    let (candidate_name, candidate_identity) =
        create_unique_directory(parent.as_raw_fd(), ".openloop-candidate-", ".app")
            .map_err(|source| ArchiveStageError::io("create candidate app directory", source))?;
    let candidate = StagedCandidate {
        path: parent_path.join(OsStr::from_bytes(candidate_name.as_bytes())),
    };
    unpack_strict_archive(archive_bytes, &candidate.path)?;
    let observed_identity = identity_at(parent.as_raw_fd(), &candidate_name)
        .map_err(|source| ArchiveStageError::io("inspect staged candidate", source))?;
    if observed_identity != candidate_identity {
        return Err(ArchiveStageError::invalid(
            "candidate app identity changed during extraction",
        ));
    }
    Ok(candidate)
}

fn reject_preserved_artifacts(parent: &Path) -> Result<(), ArchiveStageError> {
    let mut count = 0_usize;
    let entries = fs::read_dir(parent).map_err(|source| {
        ArchiveStageError::io("scan app parent for recovery artifacts", source)
    })?;
    for entry in entries {
        let entry = entry
            .map_err(|source| ArchiveStageError::io("read app parent recovery artifact", source))?;
        let name = entry.file_name();
        let name = name.as_bytes();
        if (name.starts_with(b".openloop-candidate-") && name.ends_with(b".app"))
            || (name.starts_with(b".openloop-update-") && name.ends_with(b".tmp"))
        {
            count += 1;
        }
    }
    if count != 0 {
        return Err(ArchiveStageError::invalid(format!(
            "found {count} preserved update artifact(s); requires recovery cleanup"
        )));
    }
    Ok(())
}

fn unpack_strict_archive(bytes: &[u8], destination: &Path) -> Result<(), ArchiveStageError> {
    let decoder = GzDecoder::new(Cursor::new(bytes));
    let mut archive = Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|source| ArchiveStageError::io("read signed archive", source))?;
    let destination = open_directory(destination)
        .map_err(|source| ArchiveStageError::io("open candidate app directory", source))?;
    let mut root: Option<Vec<u8>> = None;
    let mut root_directory_seen = false;
    let mut paths = HashSet::new();
    let mut extracted = Vec::new();
    let mut directories = Vec::new();

    for entry in entries {
        let mut entry =
            entry.map_err(|source| ArchiveStageError::io("read archive entry", source))?;
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            let label = if kind.is_symlink() || kind.is_hard_link() {
                "archive links are forbidden"
            } else {
                "archive special file types are forbidden"
            };
            return Err(ArchiveStageError::invalid(label));
        }
        let raw_path = entry.path_bytes().into_owned();
        let components = strict_components(&raw_path)?;
        let first = components
            .first()
            .expect("strict archive paths have at least one component");
        match root.as_ref() {
            Some(expected) if expected != first => {
                return Err(ArchiveStageError::invalid(
                    "archive contains multiple app roots",
                ));
            }
            None => {
                if Path::new(OsStr::from_bytes(first)).extension() != Some(OsStr::new("app")) {
                    return Err(ArchiveStageError::invalid(
                        "archive root must be one .app directory",
                    ));
                }
                root = Some(first.clone());
            }
            _ => {}
        }
        if !paths.insert(components.clone()) {
            return Err(ArchiveStageError::invalid(
                "archive contains a duplicate path",
            ));
        }
        if components.len() == 1 {
            if !kind.is_dir() {
                return Err(ArchiveStageError::invalid(
                    "archive app root must be a directory",
                ));
            }
            root_directory_seen = true;
            let mode = entry
                .header()
                .mode()
                .map_err(|source| ArchiveStageError::io("read archive directory mode", source))?;
            directories.push((Vec::new(), mode));
            continue;
        }
        let stripped = &components[1..];
        let mode = entry
            .header()
            .mode()
            .map_err(|source| ArchiveStageError::io("read archive entry mode", source))?;
        if kind.is_dir() {
            create_directory_path(destination.as_raw_fd(), stripped)
                .map_err(|source| ArchiveStageError::io("create archive directory", source))?;
            directories.push((stripped.to_vec(), mode));
        } else {
            unpack_file_at(destination.as_raw_fd(), stripped, mode, &mut entry)
                .map_err(|source| ArchiveStageError::io("unpack archive file", source))?;
        }
        extracted.push((components_to_path(stripped), kind.is_dir()));
    }

    root.ok_or_else(|| ArchiveStageError::invalid("archive contains no app root"))?;
    if !root_directory_seen {
        return Err(ArchiveStageError::invalid(
            "archive does not contain an explicit app root directory",
        ));
    }
    for (components, mode) in directories.into_iter().rev() {
        let directory = open_directory_path(destination.as_raw_fd(), &components, false)
            .map_err(|source| ArchiveStageError::io("open unpacked archive directory", source))?;
        set_descriptor_mode(directory.as_raw_fd(), mode)
            .map_err(|source| ArchiveStageError::io("set archive directory mode", source))?;
    }
    for (relative, expected_directory) in extracted {
        if !has_expected_type(destination.as_raw_fd(), &relative, expected_directory)
            .map_err(|source| ArchiveStageError::io("inspect unpacked archive entry", source))?
        {
            return Err(ArchiveStageError::invalid(
                "unpacked archive entry has an unexpected file type",
            ));
        }
    }
    Ok(())
}

fn has_expected_type(root: RawFd, path: &Path, expected_directory: bool) -> io::Result<bool> {
    let components = path
        .components()
        .map(|component| component.as_os_str().as_bytes().to_vec())
        .collect::<Vec<_>>();
    let (name, parents) = components
        .split_last()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "archive path is empty"))?;
    let parent = open_directory_path(root, parents, false)?;
    let name = CString::new(name.as_slice())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
    let identity = identity_at(parent.as_raw_fd(), &name)?;
    Ok(if expected_directory {
        identity.is_directory()
    } else {
        identity.is_file()
    })
}

fn strict_components(path: &[u8]) -> Result<Vec<Vec<u8>>, ArchiveStageError> {
    if path.is_empty() || path.starts_with(b"/") {
        return Err(ArchiveStageError::invalid(
            "archive path must be nonempty and relative",
        ));
    }
    let mut raw = path.split(|byte| *byte == b'/').collect::<Vec<_>>();
    if raw.last() == Some(&b"".as_slice()) {
        raw.pop();
    }
    if raw.is_empty()
        || raw.iter().any(|component| {
            component.is_empty()
                || *component == b"."
                || *component == b".."
                || component.contains(&0)
        })
    {
        return Err(ArchiveStageError::invalid(
            "archive path contains a forbidden component",
        ));
    }
    Ok(raw.into_iter().map(<[u8]>::to_vec).collect())
}

fn components_to_path(components: &[Vec<u8>]) -> PathBuf {
    let mut path = PathBuf::new();
    for component in components {
        path.push(OsStr::from_bytes(component));
    }
    path
}

fn create_directory_path(root: RawFd, components: &[Vec<u8>]) -> io::Result<()> {
    open_directory_path(root, components, true).map(drop)
}

fn open_directory_path(root: RawFd, components: &[Vec<u8>], create: bool) -> io::Result<OwnedFd> {
    // SAFETY: dup returns a new descriptor referring to the same directory.
    let duplicated = unsafe { libc::dup(root) };
    if duplicated < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `duplicated` is a fresh owned descriptor.
    let mut current = unsafe { OwnedFd::from_raw_fd(duplicated) };
    for component in components {
        let component = CString::new(component.as_slice())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
        if create {
            // SAFETY: the path is one validated component beneath `current`.
            if unsafe { libc::mkdirat(current.as_raw_fd(), component.as_ptr(), 0o700) } < 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::AlreadyExists {
                    return Err(error);
                }
            }
        }
        // SAFETY: the path is one validated component and O_NOFOLLOW rejects
        // symlink substitution at every level.
        let descriptor = unsafe {
            libc::openat(
                current.as_raw_fd(),
                component.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `descriptor` is a fresh owned descriptor.
        current = unsafe { OwnedFd::from_raw_fd(descriptor) };
    }
    Ok(current)
}

fn unpack_file_at(
    root: RawFd,
    components: &[Vec<u8>],
    mode: u32,
    entry: &mut impl io::Read,
) -> io::Result<()> {
    let (name, parents) = components
        .split_last()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "archive file has no name"))?;
    let parent = open_directory_path(root, parents, true)?;
    let name = CString::new(name.as_slice())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
    // SAFETY: `name` is one validated component beneath a retained directory
    // descriptor. O_EXCL and O_NOFOLLOW reject collisions and symlinks.
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `descriptor` is a fresh owned file descriptor.
    let mut file = unsafe { fs::File::from_raw_fd(descriptor) };
    io::copy(entry, &mut file)?;
    file.set_permissions(fs::Permissions::from_mode(mode & 0o777))
}

fn set_descriptor_mode(descriptor: RawFd, mode: u32) -> io::Result<()> {
    // SAFETY: `descriptor` is open and fchmod only changes its permission bits.
    if unsafe { libc::fchmod(descriptor, (mode & 0o777) as libc::mode_t) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn open_directory(path: &Path) -> io::Result<OwnedFd> {
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
    // SAFETY: `path` is a live NUL-terminated value. A successful call returns
    // a new descriptor owned by this function.
    let descriptor = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `descriptor` was returned as a new owned fd.
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

fn create_unique_directory(
    parent: RawFd,
    prefix: &str,
    suffix: &str,
) -> io::Result<(CString, FileIdentity)> {
    for _ in 0..16 {
        let name = CString::new(format!("{prefix}{}{suffix}", Uuid::new_v4()))
            .expect("UUID directory names contain no NUL");
        // SAFETY: `name` is a live path component and `parent` is an open
        // directory descriptor. mkdirat is exclusive by definition.
        if unsafe { libc::mkdirat(parent, name.as_ptr(), 0o700) } == 0 {
            let identity = identity_at(parent, &name)?;
            return Ok((name, identity));
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique staging directory",
    ))
}

fn descriptor_identity(descriptor: RawFd) -> io::Result<FileIdentity> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `metadata` points to writable storage and `descriptor` is open.
    if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful fstat initialized the complete value.
    Ok(FileIdentity::from_stat(unsafe { &metadata.assume_init() }))
}

fn identity_at(parent: RawFd, name: &CStr) -> io::Result<FileIdentity> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `metadata` points to writable storage, `name` is NUL-terminated,
    // and `parent` remains an open directory descriptor.
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
    // SAFETY: successful fstatat initialized the complete value.
    Ok(FileIdentity::from_stat(unsafe { &metadata.assume_init() }))
}

#[derive(Debug)]
pub enum ArchiveStageError {
    InvalidArchive(String),
    Io {
        operation: &'static str,
        source: io::Error,
    },
}

impl ArchiveStageError {
    fn invalid(message: impl Into<String>) -> Self {
        Self::InvalidArchive(message.into())
    }

    fn io(operation: &'static str, source: io::Error) -> Self {
        Self::Io { operation, source }
    }
}

impl fmt::Display for ArchiveStageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidArchive(message) => formatter.write_str(message),
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
        }
    }
}

impl Error for ArchiveStageError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidArchive(_) => None,
            Self::Io { source, .. } => Some(source),
        }
    }
}
