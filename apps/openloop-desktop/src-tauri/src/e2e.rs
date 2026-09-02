use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
};

use tauri::AppHandle;

use crate::{
    bridge::server::CancellationToken,
    credentials::{
        AppKitCredentialSheet, CredentialAccount, CredentialSheetAction, CredentialSheetPresenter,
        CredentialSheetRequest,
    },
    update::{
        channel::ReleaseChannel,
        state::{
            AvailableUpdate, UpdateChecker, UpdateFailure, UpdateInstallObserver,
            UpdateInstallResult, UpdateInstaller,
        },
    },
};

pub const APPKIT_AUDIT_ENVIRONMENT: &str = "OPENLOOP_E2E_APPKIT_AUDIT";
pub const AUTO_CANCEL_APPKIT_ENVIRONMENT: &str = "OPENLOOP_E2E_AUTO_CANCEL_APPKIT";
pub const CREDENTIAL_PROBE_ENVIRONMENT: &str = "OPENLOOP_E2E_CREDENTIAL_PROBE";

#[derive(Debug)]
pub struct FixtureUpdate;

pub struct FixtureUpdateChecker;

impl UpdateChecker<FixtureUpdate> for FixtureUpdateChecker {
    fn check(&self) -> Result<Option<AvailableUpdate<FixtureUpdate>>, UpdateFailure> {
        Ok(Some(
            AvailableUpdate::new(FixtureUpdate, "0.2.0", ReleaseChannel::Test)
                .with_release_notes("Deterministic offline E2E update"),
        ))
    }
}

pub struct FixtureUpdateInstaller;

impl UpdateInstaller<FixtureUpdate> for FixtureUpdateInstaller {
    fn install(
        &self,
        _update: FixtureUpdate,
        _observer: &dyn UpdateInstallObserver,
    ) -> Result<UpdateInstallResult, UpdateFailure> {
        Err(UpdateFailure::Install)
    }
}

pub fn configured_dsh_home(data_root_name: &str) -> Result<Option<PathBuf>, String> {
    let Some(value) = std::env::var_os("DSH_HOME") else {
        return Ok(None);
    };
    crate::update::health::required_dsh_home(Some(value.as_os_str()), data_root_name)
        .map(Some)
        .map_err(|error| format!("Openloop E2E DSH_HOME is invalid: {error}"))
}

pub fn auto_cancel_appkit() -> bool {
    std::env::var(AUTO_CANCEL_APPKIT_ENVIRONMENT).as_deref() == Ok("1")
}

pub fn record_appkit_sheet(kind: &str, window_label: &str) -> std::io::Result<()> {
    let Some(path) = std::env::var_os(APPKIT_AUDIT_ENVIRONMENT).map(PathBuf::from) else {
        return Ok(());
    };
    require_audit_path(&path)?;
    let mut audit = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(audit, "{kind}:{window_label}")?;
    audit.sync_data()
}

pub fn run_credential_probe(app: AppHandle) -> Result<(), String> {
    if std::env::var(CREDENTIAL_PROBE_ENVIRONMENT).as_deref() != Ok("1") {
        return Ok(());
    }
    let account = CredentialAccount::new("OPENLOOP_E2E_CREDENTIAL")
        .map_err(|error| format!("Openloop E2E credential probe is invalid: {error}"))?;
    let action = AppKitCredentialSheet::new(app)
        .present_cancellable(
            &CredentialSheetRequest { account },
            &CancellationToken::default(),
        )
        .map_err(|error| format!("Openloop E2E credential probe failed: {error}"))?;
    if matches!(action, CredentialSheetAction::Cancelled) {
        Ok(())
    } else {
        Err("Openloop E2E credential probe must cancel without reading a secret".to_owned())
    }
}

fn require_audit_path(path: &Path) -> std::io::Result<()> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Openloop E2E AppKit audit path must be an absolute file path",
        ));
    }
    Ok(())
}
