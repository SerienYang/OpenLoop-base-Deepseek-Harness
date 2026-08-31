use std::{
    cell::{Cell, RefCell},
    error::Error,
    ffi::{CString, OsString},
    fmt, io,
    mem::MaybeUninit,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
};

use serde::Serialize;
use tauri::Url;
use tauri_plugin_updater::{Update, Updater};

use super::{
    archive::{stage_verified_archive, ArchiveStageError},
    channel::{ReleaseChannel, UPDATE_NETWORK_TIMEOUT},
    health::HEALTH_PROBE_ARGUMENT,
    recovery::{
        CandidateHealth, HealthStatus, PublicationOutcome, RecoveryError, RecoveryTransaction,
    },
    state::{UpdateInstallObserver, UpdateStateError},
};

const CHECK_ARGUMENT: &str = "--openloop-update-spike=check";
const INSTALL_ARGUMENT: &str = "--openloop-update-spike=install";
const PRIVATE_ARGUMENT_PREFIX: &[u8] = b"--openloop-update";
const RELEASE_HOST: &str = "github.com";
const RELEASE_PATH_PREFIX: [&str; 4] = [
    "SerienYang",
    "OpenLoop-base-Deepseek-Harness",
    "releases",
    "download",
];
const RELEASE_ASSET: &str = "Openloop.app.tar.gz";
const MINIMUM_UPDATE_FREE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostAction {
    Normal,
    Check,
    Install,
    HealthProbe,
}

pub fn parse_host_action(arguments: &[OsString]) -> Result<HostAction, CoordinatorError> {
    if arguments.is_empty() {
        return Ok(HostAction::Normal);
    }
    if arguments.len() == 1 {
        match arguments[0].to_str() {
            Some(CHECK_ARGUMENT) => return Ok(HostAction::Check),
            Some(INSTALL_ARGUMENT) => return Ok(HostAction::Install),
            Some(HEALTH_PROBE_ARGUMENT) => return Ok(HostAction::HealthProbe),
            _ => {}
        }
    }
    if arguments.iter().any(|argument| {
        argument
            .as_os_str()
            .as_bytes()
            .starts_with(PRIVATE_ARGUMENT_PREFIX)
    }) {
        return Err(CoordinatorError::InvalidArguments);
    }
    Ok(HostAction::Normal)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckReport {
    pub current: String,
    pub available: Option<String>,
}

impl CheckReport {
    pub fn json_line(&self) -> Result<String, CoordinatorError> {
        json_line(self)
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DownloadStatus {
    NotStarted,
    Verified,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "result", content = "health")]
pub enum InstallPublication {
    NoUpdate,
    Committed,
    RolledBack(HealthStatus),
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub current: String,
    pub available: Option<String>,
    pub download: DownloadStatus,
    pub publication: InstallPublication,
    pub preserved_backup: Option<PathBuf>,
    pub failed_candidate: Option<PathBuf>,
}

impl InstallReport {
    pub fn json_line(&self) -> Result<String, CoordinatorError> {
        json_line(self)
    }
}

#[derive(Debug, Clone)]
pub struct DownloadUrlPolicy {
    channel: ReleaseChannel,
    #[cfg(debug_assertions)]
    local_fixture: Option<Url>,
}

impl DownloadUrlPolicy {
    pub fn production(channel: ReleaseChannel) -> Self {
        Self {
            channel,
            #[cfg(debug_assertions)]
            local_fixture: None,
        }
    }

    #[cfg(debug_assertions)]
    pub fn local_test_fixture(expected: &Url) -> Result<Self, CoordinatorError> {
        if expected.scheme() != "http"
            || expected.host_str() != Some("127.0.0.1")
            || expected.port().is_none()
            || expected.username() != ""
            || expected.password().is_some()
            || expected.query().is_some()
            || expected.fragment().is_some()
            || expected.path() != "/archive"
        {
            return Err(CoordinatorError::UnsafeDownloadUrl(
                "local test policy requires one exact loopback /archive URL".to_owned(),
            ));
        }
        Ok(Self {
            channel: ReleaseChannel::Test,
            local_fixture: Some(expected.clone()),
        })
    }

    pub fn validate_update(&self, update: &Update) -> Result<(), CoordinatorError> {
        let raw_url = raw_platform_download_url(update)?;
        let parsed_url = Url::parse(raw_url).map_err(|error| {
            CoordinatorError::UnsafeDownloadUrl(format!(
                "raw platform download URL is invalid: {error}"
            ))
        })?;
        if parsed_url != update.download_url {
            return Err(CoordinatorError::UnsafeDownloadUrl(
                "raw platform download URL does not match the updater download URL".to_owned(),
            ));
        }
        #[cfg(debug_assertions)]
        if let Some(expected) = self.local_fixture.as_ref() {
            if raw_url == expected.as_str() && &parsed_url == expected {
                return Ok(());
            }
            return Err(CoordinatorError::UnsafeDownloadUrl(
                "local test update must use the exact configured fixture URL".to_owned(),
            ));
        }
        validate_download_url(raw_url, &parsed_url, &update.version, self.channel)
    }
}

pub fn validate_download_url(
    raw_url: &str,
    url: &Url,
    version: &str,
    channel: ReleaseChannel,
) -> Result<(), CoordinatorError> {
    let canonical_prefix = "https://github.com/";
    if raw_url != url.as_str()
        || !raw_url.starts_with(canonical_prefix)
        || url.scheme() != "https"
        || url.host_str() != Some(RELEASE_HOST)
        || url.port().is_some()
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path().contains('%')
    {
        return Err(CoordinatorError::UnsafeDownloadUrl(
            "update download URL must be canonical credential-free HTTPS on github.com without a custom port, query, fragment, or encoding".to_owned(),
        ));
    }
    let segments = url
        .path_segments()
        .ok_or_else(|| {
            CoordinatorError::UnsafeDownloadUrl(
                "update download URL must have a hierarchical release path".to_owned(),
            )
        })?
        .collect::<Vec<_>>();
    if segments.len() != 6 || segments[..4] != RELEASE_PATH_PREFIX || segments[5] != RELEASE_ASSET {
        return Err(CoordinatorError::UnsafeDownloadUrl(
            "update download URL must use the exact OpenLoop immutable release asset path"
                .to_owned(),
        ));
    }
    let tag = segments[4];
    let safe_tag = !tag.is_empty()
        && tag
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'+'))
        && !tag.to_ascii_lowercase().contains("rolling")
        && !tag.to_ascii_lowercase().contains("latest");
    if !safe_tag {
        return Err(CoordinatorError::UnsafeDownloadUrl(
            "update release tag must be immutable".to_owned(),
        ));
    }
    match channel {
        ReleaseChannel::Test
            if tag != format!("openloop-test-a-v{version}")
                && tag != format!("openloop-test-b-v{version}") =>
        {
            return Err(CoordinatorError::UnsafeDownloadUrl(
                "test update release tag must match openloop-test-[ab]-v<version>".to_owned(),
            ));
        }
        ReleaseChannel::Stable if tag != format!("openloop-stable-v{version}") => {
            return Err(CoordinatorError::UnsafeDownloadUrl(
                "stable update release tag must match openloop-stable-v<version>".to_owned(),
            ));
        }
        _ => {}
    }
    Ok(())
}

fn raw_platform_download_url(update: &Update) -> Result<&str, CoordinatorError> {
    update
        .raw_json
        .get("platforms")
        .and_then(serde_json::Value::as_object)
        .and_then(|platforms| platforms.get(&update.target))
        .and_then(|platform| platform.get("url"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            CoordinatorError::UnsafeDownloadUrl(format!(
                "update manifest must contain one string platforms.{}.url",
                update.target
            ))
        })
}

pub async fn check_update(
    updater: &Updater,
    current: &str,
    policy: &DownloadUrlPolicy,
) -> Result<(CheckReport, Option<Update>), CoordinatorError> {
    let mut update = updater.check().await.map_err(CoordinatorError::Check)?;
    if let Some(update) = update.as_ref() {
        policy.validate_update(update)?;
    }
    if let Some(update) = update.as_mut() {
        update.timeout = Some(UPDATE_NETWORK_TIMEOUT);
    }
    let report = CheckReport {
        current: current.to_owned(),
        available: update.as_ref().map(|value| value.version.clone()),
    };
    Ok((report, update))
}

pub async fn install_checked_update(
    update: Update,
    installed_app: &Path,
    health: &mut impl CandidateHealth,
    policy: &DownloadUrlPolicy,
) -> Result<InstallReport, CoordinatorError> {
    install_checked_update_with_observer(
        update,
        installed_app,
        health,
        policy,
        &NoopInstallObserver,
    )
    .await
}

pub async fn install_checked_update_with_observer(
    update: Update,
    installed_app: &Path,
    health: &mut impl CandidateHealth,
    policy: &DownloadUrlPolicy,
    observer: &dyn UpdateInstallObserver,
) -> Result<InstallReport, CoordinatorError> {
    policy.validate_update(&update)?;
    let root = installed_app
        .parent()
        .ok_or(CoordinatorError::MissingInstallationRoot)?;
    let available_bytes = available_disk_bytes(root).map_err(CoordinatorError::DiskInspection)?;
    ensure_update_disk_capacity(available_bytes, MINIMUM_UPDATE_FREE_BYTES)?;
    let current = update.current_version.clone();
    let available = update.version.clone();
    let downloaded = Cell::new(0_u64);
    let observer_error = RefCell::new(None);
    let archive = update
        .download(
            |chunk, total| {
                let received = downloaded.get().saturating_add(chunk as u64);
                downloaded.set(received);
                if observer_error.borrow().is_none() {
                    if let Err(error) = observer.download_progress(received, total) {
                        *observer_error.borrow_mut() = Some(error);
                    }
                }
            },
            || {
                if observer_error.borrow().is_none() {
                    if let Err(error) = observer.verifying() {
                        *observer_error.borrow_mut() = Some(error);
                    }
                }
            },
        )
        .await
        .map_err(CoordinatorError::Download)?;
    if let Some(error) = observer_error.into_inner() {
        return Err(CoordinatorError::State(error));
    }
    let candidate =
        stage_verified_archive(&archive, installed_app).map_err(CoordinatorError::Stage)?;
    observer
        .ready_to_install()
        .map_err(CoordinatorError::State)?;
    observer.installing().map_err(CoordinatorError::State)?;
    let transaction = RecoveryTransaction::open(root, installed_app, candidate.path())
        .map_err(CoordinatorError::Recovery)?;
    let (publication, preserved_backup, failed_candidate) = match transaction
        .publish(health)
        .map_err(CoordinatorError::Recovery)?
    {
        PublicationOutcome::Committed { preserved_backup } => {
            (InstallPublication::Committed, Some(preserved_backup), None)
        }
        PublicationOutcome::RolledBack {
            status,
            failed_candidate,
        } => (
            InstallPublication::RolledBack(status),
            None,
            Some(failed_candidate),
        ),
    };
    Ok(InstallReport {
        current,
        available: Some(available),
        download: DownloadStatus::Verified,
        publication,
        preserved_backup,
        failed_candidate,
    })
}

struct NoopInstallObserver;

impl UpdateInstallObserver for NoopInstallObserver {
    fn download_progress(
        &self,
        _downloaded: u64,
        _total: Option<u64>,
    ) -> Result<(), UpdateStateError> {
        Ok(())
    }

    fn verifying(&self) -> Result<(), UpdateStateError> {
        Ok(())
    }

    fn ready_to_install(&self) -> Result<(), UpdateStateError> {
        Ok(())
    }

    fn installing(&self) -> Result<(), UpdateStateError> {
        Ok(())
    }
}

pub fn ensure_update_disk_capacity(
    available_bytes: u64,
    required_bytes: u64,
) -> Result<(), CoordinatorError> {
    if available_bytes < required_bytes {
        return Err(CoordinatorError::InsufficientDiskSpace {
            available_bytes,
            required_bytes,
        });
    }
    Ok(())
}

fn available_disk_bytes(path: &Path) -> io::Result<u64> {
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "update path contains NUL"))?;
    let mut status = MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `path` is NUL-terminated and `status` points to writable storage.
    if unsafe { libc::statvfs(path.as_ptr(), status.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: statvfs initialized `status` after returning success.
    let status = unsafe { status.assume_init() };
    Ok((status.f_bavail as u64).saturating_mul(status.f_frsize))
}

fn json_line(value: &impl Serialize) -> Result<String, CoordinatorError> {
    serde_json::to_string(value)
        .map(|value| format!("{value}\n"))
        .map_err(CoordinatorError::Serialize)
}

#[derive(Debug)]
pub enum CoordinatorError {
    InvalidArguments,
    Check(tauri_plugin_updater::Error),
    Download(tauri_plugin_updater::Error),
    Stage(ArchiveStageError),
    MissingInstallationRoot,
    InsufficientDiskSpace {
        available_bytes: u64,
        required_bytes: u64,
    },
    DiskInspection(io::Error),
    State(UpdateStateError),
    Recovery(RecoveryError),
    UnsafeDownloadUrl(String),
    Serialize(serde_json::Error),
}

impl fmt::Display for CoordinatorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidArguments => formatter
                .write_str("unknown or non-exact private Openloop update process arguments"),
            Self::Check(source) => write!(formatter, "signed update check failed: {source}"),
            Self::Download(source) => {
                write!(
                    formatter,
                    "signed update download or verification failed: {source}"
                )
            }
            Self::Stage(source) => write!(formatter, "verified update staging failed: {source}"),
            Self::MissingInstallationRoot => {
                formatter.write_str("installed app has no recovery root")
            }
            Self::InsufficientDiskSpace {
                available_bytes,
                required_bytes,
            } => write!(
                formatter,
                "insufficient disk space for update: {available_bytes} available, {required_bytes} required"
            ),
            Self::DiskInspection(source) => {
                write!(formatter, "inspect update disk space failed: {source}")
            }
            Self::State(source) => write!(formatter, "update state notification failed: {source}"),
            Self::Recovery(source) => {
                write!(formatter, "candidate recovery transaction failed: {source}")
            }
            Self::UnsafeDownloadUrl(message) => {
                write!(formatter, "unsafe update download URL: {message}")
            }
            Self::Serialize(source) => {
                write!(formatter, "serialize update result failed: {source}")
            }
        }
    }
}

impl Error for CoordinatorError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidArguments
            | Self::MissingInstallationRoot
            | Self::InsufficientDiskSpace { .. }
            | Self::UnsafeDownloadUrl(_) => None,
            Self::Check(source) | Self::Download(source) => Some(source),
            Self::DiskInspection(source) => Some(source),
            Self::Stage(source) => Some(source),
            Self::State(source) => Some(source),
            Self::Recovery(source) => Some(source),
            Self::Serialize(source) => Some(source),
        }
    }
}
