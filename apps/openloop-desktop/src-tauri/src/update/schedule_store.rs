use std::{
    error::Error,
    ffi::CString,
    fmt, fs,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, PermissionsExt},
        },
    },
    path::{Path, PathBuf},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::channel::ReleaseChannel;

const RECORD_VERSION: u8 = 1;
const MAX_RECORD_BYTES: u64 = 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckTimestampRecord {
    version: u8,
    channel: String,
    last_check_at_ms: u64,
}

pub struct UpdateCheckTimestampStore {
    root: OwnedFd,
    root_path: PathBuf,
    channel: ReleaseChannel,
    filename: CString,
}

impl UpdateCheckTimestampStore {
    pub fn open(root: &Path, channel: ReleaseChannel) -> Result<Self, TimestampStoreError> {
        let metadata = fs::symlink_metadata(root)
            .map_err(|source| TimestampStoreError::io("inspect update data root", source))?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(TimestampStoreError::Unsafe(
                "update data root must be an owner-only real directory",
            ));
        }
        let root_name = CString::new(root.as_os_str().as_bytes())
            .map_err(|_| TimestampStoreError::Unsafe("update data root contains NUL"))?;
        let descriptor = unsafe {
            libc::open(
                root_name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if descriptor < 0 {
            return Err(TimestampStoreError::io(
                "open update data root",
                io::Error::last_os_error(),
            ));
        }
        let root_descriptor = unsafe { OwnedFd::from_raw_fd(descriptor) };
        let opened = descriptor_stat(root_descriptor.as_raw_fd())
            .map_err(|source| TimestampStoreError::io("inspect opened update data root", source))?;
        if opened.st_dev as u64 != metadata.dev()
            || opened.st_ino != metadata.ino()
            || opened.st_uid != unsafe { libc::geteuid() }
            || opened.st_mode as u32 & 0o077 != 0
        {
            return Err(TimestampStoreError::Unsafe(
                "update data root identity changed while opening",
            ));
        }
        Ok(Self {
            root: root_descriptor,
            root_path: root.to_owned(),
            channel,
            filename: CString::new(format!(
                ".openloop-update-check-{}.json",
                channel_name(channel)
            ))
            .expect("fixed update timestamp filename"),
        })
    }

    pub fn path(&self) -> PathBuf {
        self.root_path.join(
            self.filename
                .to_str()
                .expect("fixed update timestamp filename is UTF-8"),
        )
    }

    pub fn load(&self) -> Option<Duration> {
        self.load_for_owner(unsafe { libc::geteuid() })
    }

    #[doc(hidden)]
    pub fn load_for_owner(&self, expected_owner: u32) -> Option<Duration> {
        self.try_load(expected_owner).ok().flatten()
    }

    pub fn record(&self, checked_at: Duration) -> Result<(), TimestampStoreError> {
        let record = CheckTimestampRecord {
            version: RECORD_VERSION,
            channel: channel_name(self.channel).to_owned(),
            last_check_at_ms: checked_at.as_millis().min(u128::from(u64::MAX)) as u64,
        };
        let bytes = serde_json::to_vec(&record)
            .map_err(|source| TimestampStoreError::Invalid(source.to_string()))?;
        let temporary = CString::new(format!(".openloop-update-check-{}.tmp", Uuid::new_v4()))
            .expect("UUID timestamp filename");
        let descriptor = unsafe {
            libc::openat(
                self.root.as_raw_fd(),
                temporary.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o600,
            )
        };
        if descriptor < 0 {
            return Err(TimestampStoreError::io(
                "create update timestamp",
                io::Error::last_os_error(),
            ));
        }
        let mut file = unsafe { fs::File::from_raw_fd(descriptor) };
        let result = (|| {
            file.write_all(&bytes)
                .map_err(|source| TimestampStoreError::io("write update timestamp", source))?;
            file.sync_all()
                .map_err(|source| TimestampStoreError::io("sync update timestamp", source))?;
            if unsafe {
                libc::renameat(
                    self.root.as_raw_fd(),
                    temporary.as_ptr(),
                    self.root.as_raw_fd(),
                    self.filename.as_ptr(),
                )
            } < 0
            {
                return Err(TimestampStoreError::io(
                    "publish update timestamp",
                    io::Error::last_os_error(),
                ));
            }
            if unsafe { libc::fsync(self.root.as_raw_fd()) } < 0 {
                return Err(TimestampStoreError::io(
                    "sync update data root",
                    io::Error::last_os_error(),
                ));
            }
            Ok(())
        })();
        if result.is_err() {
            unsafe {
                libc::unlinkat(self.root.as_raw_fd(), temporary.as_ptr(), 0);
            }
        }
        result
    }

    fn try_load(&self, expected_owner: u32) -> Result<Option<Duration>, TimestampStoreError> {
        let descriptor = unsafe {
            libc::openat(
                self.root.as_raw_fd(),
                self.filename.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if descriptor < 0 {
            let source = io::Error::last_os_error();
            return if source.kind() == io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(TimestampStoreError::io("open update timestamp", source))
            };
        }
        let mut file = unsafe { fs::File::from_raw_fd(descriptor) };
        let metadata = descriptor_stat(file.as_raw_fd())
            .map_err(|source| TimestampStoreError::io("inspect update timestamp", source))?;
        if metadata.st_mode as u32 & libc::S_IFMT as u32 != libc::S_IFREG as u32
            || metadata.st_uid != expected_owner
            || metadata.st_mode as u32 & 0o077 != 0
            || metadata.st_nlink != 1
            || metadata.st_size < 0
            || metadata.st_size as u64 > MAX_RECORD_BYTES
        {
            return Err(TimestampStoreError::Unsafe(
                "update timestamp must be a bounded owner-only regular file",
            ));
        }
        let mut bytes = Vec::with_capacity(metadata.st_size as usize);
        file.read_to_end(&mut bytes)
            .map_err(|source| TimestampStoreError::io("read update timestamp", source))?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            return Err(TimestampStoreError::Unsafe(
                "update timestamp exceeds its size limit",
            ));
        }
        let record: CheckTimestampRecord = serde_json::from_slice(&bytes)
            .map_err(|source| TimestampStoreError::Invalid(source.to_string()))?;
        if record.version != RECORD_VERSION || record.channel != channel_name(self.channel) {
            return Err(TimestampStoreError::Invalid(
                "update timestamp metadata does not match this channel".to_owned(),
            ));
        }
        Ok(Some(Duration::from_millis(record.last_check_at_ms)))
    }
}

fn channel_name(channel: ReleaseChannel) -> &'static str {
    match channel {
        ReleaseChannel::Test => "test",
        ReleaseChannel::Stable => "stable",
    }
}

fn descriptor_stat(descriptor: RawFd) -> io::Result<libc::stat> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { metadata.assume_init() })
}

#[derive(Debug)]
pub enum TimestampStoreError {
    Io(&'static str, io::Error),
    Unsafe(&'static str),
    Invalid(String),
}

impl TimestampStoreError {
    fn io(action: &'static str, source: io::Error) -> Self {
        Self::Io(action, source)
    }
}

impl fmt::Display for TimestampStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(action, source) => write!(formatter, "{action} failed: {source}"),
            Self::Unsafe(message) => formatter.write_str(message),
            Self::Invalid(message) => formatter.write_str(message),
        }
    }
}

impl Error for TimestampStoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(_, source) => Some(source),
            Self::Unsafe(_) | Self::Invalid(_) => None,
        }
    }
}
