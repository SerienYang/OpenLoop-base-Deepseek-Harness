use std::{
    collections::HashSet,
    error::Error,
    ffi::{CStr, CString, OsStr},
    fmt, fs, io,
    io::Cursor,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Path, PathBuf},
};

use flate2::read::GzDecoder;
use tar::Archive;
use uuid::Uuid;

#[derive(Debug)]
pub struct StagedCandidate {
    path: PathBuf,
    parent: OwnedFd,
    name: CString,
    identity: FileIdentity,
    armed: bool,
}

impl StagedCandidate {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for StagedCandidate {
    fn drop(&mut self) {
        if self.armed {
            let _ = remove_owned_directory(self.parent.as_raw_fd(), &self.name, self.identity);
        }
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
}

struct DirectoryGuard {
    path: PathBuf,
    parent: OwnedFd,
    name: CString,
    identity: FileIdentity,
    armed: bool,
}

impl DirectoryGuard {
    fn cleanup(&mut self) -> io::Result<()> {
        remove_owned_directory(self.parent.as_raw_fd(), &self.name, self.identity)?;
        self.armed = false;
        Ok(())
    }
}

impl Drop for DirectoryGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = remove_owned_directory(self.parent.as_raw_fd(), &self.name, self.identity);
        }
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

    let (temporary_name, temporary_identity) =
        create_unique_directory(parent.as_raw_fd(), ".openloop-update-", ".tmp")
            .map_err(|source| ArchiveStageError::io("create archive staging directory", source))?;
    let temporary_path = parent_path.join(OsStr::from_bytes(temporary_name.as_bytes()));
    let mut temporary = DirectoryGuard {
        path: temporary_path,
        parent: parent
            .try_clone()
            .map_err(|source| ArchiveStageError::io("retain app parent", source))?,
        name: temporary_name,
        identity: temporary_identity,
        armed: true,
    };

    let app_root = unpack_strict_archive(archive_bytes, &temporary.path)?;
    let source_relative = temporary
        .name
        .as_bytes()
        .iter()
        .copied()
        .chain(std::iter::once(b'/'))
        .chain(app_root.as_os_str().as_bytes().iter().copied())
        .collect::<Vec<_>>();
    let source_name = CString::new(source_relative)
        .map_err(|_| ArchiveStageError::invalid("archive app root contains NUL"))?;
    let source_identity = identity_at(parent.as_raw_fd(), &source_name)
        .map_err(|source| ArchiveStageError::io("inspect unpacked app root", source))?;
    if !source_identity.is_directory() {
        return Err(ArchiveStageError::invalid(
            "archive app root is not a real directory",
        ));
    }

    let candidate_name = unique_missing_name(parent.as_raw_fd(), ".openloop-candidate-", ".app")
        .map_err(|source| ArchiveStageError::io("reserve candidate app name", source))?;
    rename_exclusive(parent.as_raw_fd(), &source_name, &candidate_name)
        .map_err(|source| ArchiveStageError::io("publish staged candidate", source))?;
    let mut candidate = StagedCandidate {
        path: parent_path.join(OsStr::from_bytes(candidate_name.as_bytes())),
        parent,
        name: candidate_name,
        identity: source_identity,
        armed: true,
    };
    let candidate_identity = identity_at(candidate.parent.as_raw_fd(), &candidate.name)
        .map_err(|source| ArchiveStageError::io("inspect staged candidate", source))?;
    if candidate_identity != source_identity {
        return Err(ArchiveStageError::invalid(
            "candidate app identity changed during publication",
        ));
    }
    if let Err(source) = temporary.cleanup() {
        let cleanup_error = remove_owned_directory(
            candidate.parent.as_raw_fd(),
            &candidate.name,
            candidate.identity,
        );
        if cleanup_error.is_ok() {
            candidate.armed = false;
        }
        return Err(ArchiveStageError::io(
            "remove archive staging directory",
            source,
        ));
    }
    Ok(candidate)
}

fn unpack_strict_archive(bytes: &[u8], destination: &Path) -> Result<PathBuf, ArchiveStageError> {
    let decoder = GzDecoder::new(Cursor::new(bytes));
    let mut archive = Archive::new(decoder);
    archive.set_preserve_permissions(true);
    archive.set_preserve_ownerships(false);
    archive.set_preserve_mtime(true);
    let entries = archive
        .entries()
        .map_err(|source| ArchiveStageError::io("read signed archive", source))?;
    let mut root: Option<Vec<u8>> = None;
    let mut root_directory_seen = false;
    let mut paths = HashSet::new();
    let mut extracted = Vec::new();

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
        }
        let relative = components_to_path(&components);
        let unpacked = entry
            .unpack_in(destination)
            .map_err(|source| ArchiveStageError::io("unpack signed archive", source))?;
        if !unpacked {
            return Err(ArchiveStageError::invalid(
                "archive entry escaped the staging directory",
            ));
        }
        extracted.push((relative, kind.is_dir()));
    }

    let root = root.ok_or_else(|| ArchiveStageError::invalid("archive contains no app root"))?;
    if !root_directory_seen {
        return Err(ArchiveStageError::invalid(
            "archive does not contain an explicit app root directory",
        ));
    }
    for (relative, expected_directory) in extracted {
        let metadata = fs::symlink_metadata(destination.join(&relative))
            .map_err(|source| ArchiveStageError::io("inspect unpacked archive entry", source))?;
        if metadata.file_type().is_symlink()
            || metadata.is_dir() != expected_directory
            || (!expected_directory && !metadata.is_file())
        {
            return Err(ArchiveStageError::invalid(
                "unpacked archive entry has an unexpected file type",
            ));
        }
    }
    Ok(PathBuf::from(OsStr::from_bytes(&root)))
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
        || raw
            .iter()
            .any(|component| component.is_empty() || *component == b"." || *component == b"..")
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

fn unique_missing_name(parent: RawFd, prefix: &str, suffix: &str) -> io::Result<CString> {
    for _ in 0..16 {
        let name = CString::new(format!("{prefix}{}{suffix}", Uuid::new_v4()))
            .expect("UUID candidate names contain no NUL");
        match identity_at(parent, &name) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(name),
            Ok(_) => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique candidate name",
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

fn rename_exclusive(parent: RawFd, from: &CStr, to: &CStr) -> io::Result<()> {
    // SAFETY: both paths are relative to the retained parent descriptor.
    if unsafe {
        libc::renameatx_np(
            parent,
            from.as_ptr(),
            parent,
            to.as_ptr(),
            libc::RENAME_EXCL,
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn remove_owned_directory(parent: RawFd, name: &CStr, expected: FileIdentity) -> io::Result<()> {
    let actual = identity_at(parent, name)?;
    if actual != expected || !actual.is_directory() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "staging cleanup target identity changed",
        ));
    }
    // SAFETY: `name` resolves beneath the retained parent descriptor and its
    // identity was checked immediately before recursive removal.
    if unsafe {
        removefileat(
            parent,
            name.as_ptr(),
            std::ptr::null_mut(),
            REMOVEFILE_RECURSIVE,
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
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
