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
pub const RUN_ID_ENVIRONMENT: &str = "OPENLOOP_E2E_RUN_ID";
pub const RUNTIME_AUDIT_ENVIRONMENT: &str = "OPENLOOP_E2E_RUNTIME_AUDIT";

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

pub fn record_runtime_process(pid: u32) -> Result<(), String> {
    let path = std::env::var_os(RUNTIME_AUDIT_ENVIRONMENT)
        .map(PathBuf::from)
        .ok_or_else(|| "Openloop E2E runtime audit path is required".to_owned())?;
    let run_id = std::env::var(RUN_ID_ENVIRONMENT)
        .map_err(|_| "Openloop E2E run ID is required".to_owned())?;
    write_runtime_process_audit(&path, &run_id, pid)
        .map_err(|error| format!("Openloop E2E runtime audit failed: {error}"))
}

fn write_runtime_process_audit(path: &Path, run_id: &str, pid: u32) -> std::io::Result<()> {
    require_audit_path(path)?;
    let payload = serde_json::json!({ "runId": run_id, "pid": pid });
    let mut audit = OpenOptions::new().write(true).create_new(true).open(path)?;
    serde_json::to_writer(&mut audit, &payload)?;
    writeln!(audit)?;
    audit.sync_all()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_one_run_scoped_runtime_process_audit() {
        let fixture = tempfile::tempdir().expect("runtime audit fixture");
        let audit = fixture.path().join("runtime-process.json");

        write_runtime_process_audit(&audit, "run-123", 4321).expect("runtime process audit");

        assert_eq!(
            std::fs::read_to_string(audit).expect("runtime process audit bytes"),
            "{\"pid\":4321,\"runId\":\"run-123\"}\n"
        );
    }
}
