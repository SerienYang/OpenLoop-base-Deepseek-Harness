use std::{error::Error, ffi::OsString, fmt, os::unix::ffi::OsStrExt, path::Path};

use serde::Serialize;
use tauri::Url;
use tauri_plugin_updater::{Update, Updater};

use super::{
    archive::{stage_verified_archive, ArchiveStageError},
    channel::ReleaseChannel,
    health::HEALTH_PROBE_ARGUMENT,
    recovery::{
        CandidateHealth, HealthStatus, PublicationOutcome, RecoveryError, RecoveryTransaction,
    },
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

    pub fn validate(&self, url: &Url, version: &str) -> Result<(), CoordinatorError> {
        #[cfg(debug_assertions)]
        if self.local_fixture.as_ref() == Some(url) {
            return Ok(());
        }
        validate_download_url(url, version, self.channel)
    }
}

pub fn validate_download_url(
    url: &Url,
    version: &str,
    channel: ReleaseChannel,
) -> Result<(), CoordinatorError> {
    if url.scheme() != "https"
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
        ReleaseChannel::Stable if tag.starts_with("openloop-test-") => {
            return Err(CoordinatorError::UnsafeDownloadUrl(
                "stable updates must not use a test release tag".to_owned(),
            ));
        }
        _ => {}
    }
    Ok(())
}

pub async fn check_update(
    updater: &Updater,
    current: &str,
    policy: &DownloadUrlPolicy,
) -> Result<(CheckReport, Option<Update>), CoordinatorError> {
    let update = updater.check().await.map_err(CoordinatorError::Check)?;
    if let Some(update) = update.as_ref() {
        policy.validate(&update.download_url, &update.version)?;
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
    policy.validate(&update.download_url, &update.version)?;
    let current = update.current_version.clone();
    let available = update.version.clone();
    let archive = update
        .download(|_, _| {}, || {})
        .await
        .map_err(CoordinatorError::Download)?;
    let candidate =
        stage_verified_archive(&archive, installed_app).map_err(CoordinatorError::Stage)?;
    let root = installed_app
        .parent()
        .ok_or(CoordinatorError::MissingInstallationRoot)?;
    let transaction = RecoveryTransaction::open(root, installed_app, candidate.path())
        .map_err(CoordinatorError::Recovery)?;
    let publication = match transaction
        .publish(health)
        .map_err(CoordinatorError::Recovery)?
    {
        PublicationOutcome::Committed => InstallPublication::Committed,
        PublicationOutcome::RolledBack(status) => InstallPublication::RolledBack(status),
    };
    Ok(InstallReport {
        current,
        available: Some(available),
        download: DownloadStatus::Verified,
        publication,
    })
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
            Self::InvalidArguments | Self::MissingInstallationRoot | Self::UnsafeDownloadUrl(_) => {
                None
            }
            Self::Check(source) | Self::Download(source) => Some(source),
            Self::Stage(source) => Some(source),
            Self::Recovery(source) => Some(source),
            Self::Serialize(source) => Some(source),
        }
    }
}
