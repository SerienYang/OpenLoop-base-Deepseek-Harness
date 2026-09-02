use std::{
    ffi::CString,
    fs::{self, File},
    io,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Path, PathBuf},
};

const UPDATE_LOCK_FILE: &str = "openloop-update.lock";

#[derive(Debug)]
pub struct UpdateLease {
    file: File,
}

impl UpdateLease {
    pub fn shared(channel_root: &Path) -> io::Result<Self> {
        Self::acquire(channel_root, libc::LOCK_SH)
    }

    pub fn exclusive(channel_root: &Path) -> io::Result<Self> {
        Self::acquire(channel_root, libc::LOCK_EX)
    }

    pub fn lock_path(channel_root: &Path) -> PathBuf {
        channel_root.join(UPDATE_LOCK_FILE)
    }

    pub fn downgrade(self) -> io::Result<Self> {
        if unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(self)
    }

    fn acquire(channel_root: &Path, operation: libc::c_int) -> io::Result<Self> {
        let root_metadata = fs::symlink_metadata(channel_root)?;
        if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Openloop channel root must be a real directory",
            ));
        }
        let root_path = CString::new(channel_root.as_os_str().as_bytes()).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "channel root contains NUL")
        })?;
        let root_descriptor = unsafe {
            libc::open(
                root_path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if root_descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        let root = unsafe { OwnedFd::from_raw_fd(root_descriptor) };
        let opened_root = descriptor_stat(root.as_raw_fd())?;
        if opened_root.st_dev as u64 != root_metadata.dev()
            || opened_root.st_ino != root_metadata.ino()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Openloop channel root identity changed",
            ));
        }
        let lock_name = CString::new(UPDATE_LOCK_FILE).expect("fixed update lock name");
        let descriptor = unsafe {
            libc::openat(
                root.as_raw_fd(),
                lock_name.as_ptr(),
                libc::O_RDWR | libc::O_CREAT | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o600,
            )
        };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_fd(descriptor) };
        let metadata = descriptor_stat(file.as_raw_fd())?;
        if metadata.st_mode as u32 & libc::S_IFMT as u32 != libc::S_IFREG as u32
            || metadata.st_uid != unsafe { libc::geteuid() }
            || metadata.st_mode as u32 & 0o777 != 0o600
            || metadata.st_nlink != 1
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Openloop channel lease file ownership or permissions are unsafe",
            ));
        }
        set_close_on_exec(file.as_raw_fd())?;
        if unsafe { libc::flock(file.as_raw_fd(), operation | libc::LOCK_NB) } != 0 {
            let source = io::Error::last_os_error();
            return if source.kind() == io::ErrorKind::WouldBlock {
                Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "Openloop runtime or update already holds the channel lease",
                ))
            } else {
                Err(source)
            };
        }
        Ok(Self { file })
    }
}

impl AsRawFd for UpdateLease {
    fn as_raw_fd(&self) -> RawFd {
        self.file.as_raw_fd()
    }
}

impl Drop for UpdateLease {
    fn drop(&mut self) {
        let _ = unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
    }
}

fn descriptor_stat(fd: RawFd) -> io::Result<libc::stat> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(fd, metadata.as_mut_ptr()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { metadata.assume_init() })
}

fn set_close_on_exec(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
