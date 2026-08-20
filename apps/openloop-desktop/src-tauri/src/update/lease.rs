use std::{
    fs::{File, OpenOptions},
    io,
    os::{
        fd::{AsRawFd, RawFd},
        unix::fs::OpenOptionsExt,
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

    fn acquire(channel_root: &Path, operation: libc::c_int) -> io::Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(Self::lock_path(channel_root))?;
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
