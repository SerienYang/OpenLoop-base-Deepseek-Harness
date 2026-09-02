use std::{
    ffi::{CStr, CString, OsStr},
    io,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::ffi::OsStrExt,
    },
};

use super::{DirectoryEntryKind, FileBrokerError, FileKind, FileStat};

#[derive(Debug)]
pub(crate) struct RelativeTarget {
    pub(crate) parent: OwnedFd,
    pub(crate) leaf: CString,
}

pub(crate) fn duplicate_descriptor(descriptor: RawFd) -> Result<OwnedFd, FileBrokerError> {
    let duplicated = unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, 0) };
    if duplicated < 0 {
        return Err(FileBrokerError::Io(io::Error::last_os_error()));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(duplicated) })
}

fn path_components(path: &str, allow_root: bool) -> Result<Vec<CString>, FileBrokerError> {
    if allow_root && path == "." {
        return Ok(Vec::new());
    }
    let lower = path.to_ascii_lowercase();
    let encoded_traversal = ["%25", "%2e", "%2f", "%5c"]
        .iter()
        .any(|needle| lower.contains(needle));
    let windows_drive =
        path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic();
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path.as_bytes().contains(&0)
        || windows_drive
        || encoded_traversal
    {
        return Err(FileBrokerError::InvalidPath);
    }
    path.split('/')
        .map(|component| {
            if component.is_empty() || component == "." || component == ".." {
                return Err(FileBrokerError::InvalidPath);
            }
            CString::new(component.as_bytes()).map_err(|_| FileBrokerError::InvalidPath)
        })
        .collect()
}

fn open_error(error: io::Error) -> FileBrokerError {
    match error.raw_os_error() {
        Some(libc::ELOOP | libc::ENOTDIR | libc::ENXIO | libc::EOPNOTSUPP) => {
            FileBrokerError::UnsafeFile
        }
        _ => FileBrokerError::Io(error),
    }
}

fn open_component(
    parent: RawFd,
    component: &CStr,
    directory: bool,
) -> Result<OwnedFd, FileBrokerError> {
    let mut flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
    if directory {
        flags |= libc::O_DIRECTORY;
    }
    let descriptor = unsafe { libc::openat(parent, component.as_ptr(), flags) };
    if descriptor < 0 {
        return Err(open_error(io::Error::last_os_error()));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

pub(crate) fn resolve_parent(root: RawFd, path: &str) -> Result<RelativeTarget, FileBrokerError> {
    let mut components = path_components(path, false)?;
    let leaf = components.pop().ok_or(FileBrokerError::InvalidPath)?;
    let mut parent = duplicate_descriptor(root)?;
    for component in components {
        parent = open_component(parent.as_raw_fd(), &component, true)?;
        inspect_directory_descriptor(parent.as_raw_fd())?;
    }
    Ok(RelativeTarget { parent, leaf })
}

pub(crate) fn open_beneath(root: RawFd, path: &str) -> Result<OwnedFd, FileBrokerError> {
    let components = path_components(path, true)?;
    let mut current = duplicate_descriptor(root)?;
    if components.is_empty() {
        inspect_directory_descriptor(current.as_raw_fd())?;
        return Ok(current);
    }
    let last = components.len() - 1;
    for (index, component) in components.iter().enumerate() {
        current = open_component(current.as_raw_fd(), component, index != last)?;
        if index != last {
            inspect_directory_descriptor(current.as_raw_fd())?;
        }
    }
    inspect_supported_descriptor(current.as_raw_fd())?;
    Ok(current)
}

pub(crate) fn create_regular_at(parent: RawFd, leaf: &CStr) -> Result<OwnedFd, FileBrokerError> {
    let descriptor = unsafe {
        libc::openat(
            parent,
            leaf.as_ptr(),
            libc::O_RDWR
                | libc::O_CREAT
                | libc::O_EXCL
                | libc::O_CLOEXEC
                | libc::O_NOFOLLOW
                | libc::O_NONBLOCK,
            0o600,
        )
    };
    if descriptor < 0 {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::AlreadyExists {
            Err(FileBrokerError::AlreadyExists)
        } else {
            Err(open_error(error))
        };
    }
    let descriptor = unsafe { OwnedFd::from_raw_fd(descriptor) };
    inspect_regular_descriptor(descriptor.as_raw_fd())?;
    Ok(descriptor)
}

pub(crate) fn descriptor_stat(descriptor: RawFd) -> Result<libc::stat, FileBrokerError> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } < 0 {
        return Err(FileBrokerError::Io(io::Error::last_os_error()));
    }
    Ok(unsafe { metadata.assume_init() })
}

fn mode_kind(mode: libc::mode_t) -> Option<FileKind> {
    match mode & libc::S_IFMT {
        libc::S_IFREG => Some(FileKind::Regular),
        libc::S_IFDIR => Some(FileKind::Directory),
        _ => None,
    }
}

fn directory_entry_kind(metadata: &libc::stat) -> DirectoryEntryKind {
    match metadata.st_mode & libc::S_IFMT {
        libc::S_IFREG if metadata.st_nlink == 1 => DirectoryEntryKind::Regular,
        libc::S_IFDIR => DirectoryEntryKind::Directory,
        libc::S_IFLNK => DirectoryEntryKind::Symlink,
        _ => DirectoryEntryKind::Other,
    }
}

pub fn inspect_regular_descriptor(descriptor: RawFd) -> Result<FileStat, FileBrokerError> {
    let metadata = descriptor_stat(descriptor)?;
    if mode_kind(metadata.st_mode) != Some(FileKind::Regular) || metadata.st_nlink != 1 {
        return Err(FileBrokerError::UnsafeFile);
    }
    Ok(file_stat(&metadata, FileKind::Regular))
}

pub(crate) fn inspect_directory_descriptor(descriptor: RawFd) -> Result<FileStat, FileBrokerError> {
    let metadata = descriptor_stat(descriptor)?;
    if mode_kind(metadata.st_mode) != Some(FileKind::Directory) {
        return Err(FileBrokerError::UnsafeFile);
    }
    Ok(file_stat(&metadata, FileKind::Directory))
}

pub(crate) fn inspect_supported_descriptor(descriptor: RawFd) -> Result<FileStat, FileBrokerError> {
    let metadata = descriptor_stat(descriptor)?;
    let Some(kind) = mode_kind(metadata.st_mode) else {
        return Err(FileBrokerError::UnsafeFile);
    };
    if kind == FileKind::Regular && metadata.st_nlink != 1 {
        return Err(FileBrokerError::UnsafeFile);
    }
    Ok(file_stat(&metadata, kind))
}

pub(crate) fn stat_at(parent: RawFd, leaf: &CStr) -> Result<Option<libc::stat>, FileBrokerError> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            parent,
            leaf.as_ptr(),
            metadata.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } < 0
    {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(FileBrokerError::Io(error));
    }
    Ok(Some(unsafe { metadata.assume_init() }))
}

pub(crate) fn checked_regular_version(metadata: &libc::stat) -> Result<String, FileBrokerError> {
    if mode_kind(metadata.st_mode) != Some(FileKind::Regular) || metadata.st_nlink != 1 {
        return Err(FileBrokerError::UnsafeFile);
    }
    Ok(file_version(metadata))
}

pub(crate) fn stable_regular_identity(metadata: &libc::stat) -> Result<String, FileBrokerError> {
    if mode_kind(metadata.st_mode) != Some(FileKind::Regular) || metadata.st_nlink != 1 {
        return Err(FileBrokerError::UnsafeFile);
    }
    Ok(format!(
        "{:x}:{:x}:{:x}:{:x}:{:x}",
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_size,
        metadata.st_mtime,
        metadata.st_mtime_nsec,
    ))
}

fn file_stat(metadata: &libc::stat, kind: FileKind) -> FileStat {
    FileStat {
        kind,
        size: metadata.st_size.max(0) as u64,
        version: (kind == FileKind::Regular).then(|| file_version(metadata)),
    }
}

pub(crate) fn file_version(metadata: &libc::stat) -> String {
    format!(
        "{:x}:{:x}:{:x}:{:x}:{:x}:{:x}:{:x}",
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_size,
        metadata.st_mtime,
        metadata.st_mtime_nsec,
        metadata.st_ctime,
        metadata.st_ctime_nsec,
    )
}

pub(crate) fn read_at(
    descriptor: RawFd,
    offset: u64,
    maximum: usize,
) -> Result<Vec<u8>, FileBrokerError> {
    let offset = libc::off_t::try_from(offset).map_err(|_| FileBrokerError::InvalidOffset)?;
    let mut bytes = vec![0; maximum];
    let read = unsafe { libc::pread(descriptor, bytes.as_mut_ptr().cast(), maximum, offset) };
    if read < 0 {
        return Err(FileBrokerError::Io(io::Error::last_os_error()));
    }
    bytes.truncate(read as usize);
    Ok(bytes)
}

pub(crate) fn write_all(descriptor: RawFd, bytes: &[u8]) -> Result<(), FileBrokerError> {
    let mut remaining = bytes;
    while !remaining.is_empty() {
        let written =
            unsafe { libc::write(descriptor, remaining.as_ptr().cast(), remaining.len()) };
        if written < 0 {
            return Err(FileBrokerError::Io(io::Error::last_os_error()));
        }
        if written == 0 {
            return Err(FileBrokerError::Io(io::Error::new(
                io::ErrorKind::WriteZero,
                "atomic Workspace write made no progress",
            )));
        }
        remaining = &remaining[written as usize..];
    }
    Ok(())
}

pub(crate) fn sync_descriptor(descriptor: RawFd) -> Result<(), FileBrokerError> {
    if unsafe { libc::fsync(descriptor) } < 0 {
        return Err(FileBrokerError::Io(io::Error::last_os_error()));
    }
    Ok(())
}

pub(crate) fn unlink_at(parent: RawFd, name: &CStr) -> Result<(), FileBrokerError> {
    if unsafe { libc::unlinkat(parent, name.as_ptr(), 0) } < 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::NotFound {
            return Err(FileBrokerError::Io(error));
        }
    }
    Ok(())
}

pub(crate) fn rename_exclusive_at(
    parent: RawFd,
    source: &CStr,
    destination: &CStr,
) -> Result<(), FileBrokerError> {
    if unsafe {
        libc::renameatx_np(
            parent,
            source.as_ptr(),
            parent,
            destination.as_ptr(),
            libc::RENAME_EXCL,
        )
    } < 0
    {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::AlreadyExists {
            Err(FileBrokerError::AlreadyExists)
        } else {
            Err(FileBrokerError::Io(error))
        };
    }
    Ok(())
}

pub(crate) fn swap_at(
    parent: RawFd,
    source: &CStr,
    destination: &CStr,
) -> Result<(), FileBrokerError> {
    if unsafe {
        libc::renameatx_np(
            parent,
            source.as_ptr(),
            parent,
            destination.as_ptr(),
            libc::RENAME_SWAP,
        )
    } < 0
    {
        return Err(FileBrokerError::Io(io::Error::last_os_error()));
    }
    Ok(())
}

pub(crate) struct DirectoryVisit {
    pub(crate) eof: bool,
    pub(crate) visited: usize,
}

pub(crate) fn visit_directory(
    descriptor: RawFd,
    offset: usize,
    maximum: usize,
    mut visitor: impl FnMut(String, DirectoryEntryKind, u64, String) -> Result<bool, FileBrokerError>,
) -> Result<DirectoryVisit, FileBrokerError> {
    let current = c".";
    let reopened = unsafe {
        libc::openat(
            descriptor,
            current.as_ptr(),
            libc::O_RDONLY
                | libc::O_CLOEXEC
                | libc::O_NOFOLLOW
                | libc::O_NONBLOCK
                | libc::O_DIRECTORY,
        )
    };
    if reopened < 0 {
        return Err(open_error(io::Error::last_os_error()));
    }
    let reopened = unsafe { OwnedFd::from_raw_fd(reopened) };
    let directory = unsafe { libc::fdopendir(reopened.as_raw_fd()) };
    if directory.is_null() {
        return Err(FileBrokerError::Io(io::Error::last_os_error()));
    }
    std::mem::forget(reopened);
    let directory = DirectoryStream(directory);
    let mut visited = 0;
    let mut delivered = 0;
    loop {
        unsafe { *libc::__error() = 0 };
        let entry = unsafe { libc::readdir(directory.0) };
        if entry.is_null() {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(0) {
                if visited < offset {
                    return Err(FileBrokerError::InvalidOffset);
                }
                return Ok(DirectoryVisit { eof: true, visited });
            }
            return Err(FileBrokerError::Io(error));
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() == b"." || name.to_bytes() == b".." {
            continue;
        }
        let name = OsStr::from_bytes(name.to_bytes())
            .to_str()
            .ok_or(FileBrokerError::UnsafeFile)?
            .to_owned();
        let child = CString::new(name.as_bytes()).map_err(|_| FileBrokerError::UnsafeFile)?;
        let metadata = stat_at(descriptor, &child)?.ok_or(FileBrokerError::UnsafeFile)?;
        let kind = directory_entry_kind(&metadata);
        let size = metadata.st_size.max(0) as u64;
        let version = file_version(&metadata);
        if visited < offset {
            visited += 1;
            continue;
        }
        if delivered == maximum {
            return Ok(DirectoryVisit {
                eof: false,
                visited,
            });
        }
        if !visitor(name, kind, size, version)? {
            return Ok(DirectoryVisit {
                eof: false,
                visited,
            });
        }
        visited += 1;
        delivered += 1;
    }
}

struct DirectoryStream(*mut libc::DIR);

impl Drop for DirectoryStream {
    fn drop(&mut self) {
        unsafe { libc::closedir(self.0) };
    }
}
