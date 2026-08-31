#[cfg(target_os = "macos")]
use std::time::{SystemTime, UNIX_EPOCH};
use std::{
    ffi::{OsStr, OsString},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use tauri::{AppHandle, Manager, RunEvent, Url};
#[cfg(target_os = "macos")]
use tauri_plugin_updater::Update;
use tauri_plugin_updater::UpdaterExt;

#[cfg(not(target_os = "macos"))]
use crate::bridge::BridgeDispatchTables;
use crate::bridge::{
    server::{BridgeHandler, BridgeHandlerError},
    AuthenticatedBridgeDispatcher, BridgeListener, BridgeServer,
};
#[cfg(target_os = "macos")]
use crate::credentials::{
    credential_bridge_dispatch_tables_with_migration_status,
    migration::{
        commit_migration, credential_health_plan, plan_migration, prepare_migration,
        prepare_migration_with_transaction_id, rollback_migration, MigrationOutcome,
        NoopMigrationHook, ReadOnlyLegacySource,
    },
    AppKitCredentialDeletionConfirmation, AppKitCredentialSheet, CredentialAccount,
    CredentialMigrationStatusHandle, CredentialSheetCoordinator, CredentialSheetGate,
    KeychainStore,
};
#[cfg(target_os = "macos")]
use crate::files::{install_file_broker_handlers, FileBroker};
use crate::launcher::{
    InstanceAction, LaunchReadinessExpectation, LaunchSecrets, SingleInstance, SupervisedChild,
};
#[cfg(target_os = "macos")]
use crate::update::recovery::PublicationCompanion;
use crate::update::{
    archive::stage_verified_archive,
    coordinator::{
        parse_host_action, CheckReport, DownloadStatus, DownloadUrlPolicy, HostAction,
        InstallPublication, InstallReport,
    },
    health::{
        ensure_channel_dsh_home, install_credential_health_plan_handler, required_dsh_home,
        BundleHealthProbe, CandidateProcessHealth, CredentialHealthPlan,
        MainWebviewHealthAcknowledgement, MainWebviewHealthExpectation,
        MIGRATION_TRANSACTION_ENVIRONMENT, TEST_PROBE_FAILURE_ENVIRONMENT,
    },
    lease::UpdateLease,
    recovery::{
        pending_update_migration_transaction_id, recover_interrupted_update,
        recover_interrupted_update_with_bound_companion, PublicationOutcome, RecoveryTransaction,
    },
};
#[cfg(target_os = "macos")]
use crate::update::{
    coordinator::{check_update, install_checked_update_with_observer, CoordinatorError},
    schedule::{ScheduledUpdateWorker, UpdateCheckSchedule, UpdateCheckTimestampStore},
    state::{
        install_update_bridge_handlers, AppKitUpdateInstallConfirmation, AvailableUpdate,
        UpdateChecker, UpdateFailure, UpdateInstallObserver, UpdateInstallResult, UpdateInstaller,
        UpdateRestartRequester, UpdateState,
    },
};
#[cfg(target_os = "macos")]
use crate::workspaces::{
    bridge::{install_workspace_authority_handlers, install_workspace_transaction_handlers},
    confirmation::AppKitWorkspaceRevokeConfirmation,
    grants::GrantStore,
    journal::WorkspaceJournal,
    picker::{AppKitWorkspaceDirectoryPicker, PendingGrantRegistry},
};

pub mod bridge;
pub mod browser;
#[cfg(target_os = "macos")]
pub mod credentials;
#[cfg(target_os = "macos")]
pub mod files;
pub mod launcher;
pub mod spikes;
pub mod update;
#[cfg(target_os = "macos")]
pub mod workspaces;

#[cfg(target_os = "macos")]
pub fn build_browser_webview(
    label: impl Into<String>,
    target: Url,
    proxy: &browser::network_policy_proxy::RunningNetworkPolicyProxy,
) -> tauri::WebviewBuilder<tauri::Wry> {
    let navigation_policy = proxy.navigation_policy();
    tauri::WebviewBuilder::new(label, tauri::WebviewUrl::External(target))
        .incognito(true)
        .proxy_url(proxy.proxy_url())
        .on_navigation(move |url| navigation_policy.validate_navigation(url.as_str()).is_ok())
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenloopBuildManifest {
    app_version: String,
    channel: String,
    dsh_tag: String,
    dsh_commit: String,
    runtime_version: u64,
    bridge_protocol_version: u64,
    ui_sdk_version: String,
    plugin_package_spec_version: String,
    openloop_data_version: u64,
    dsh_data_version: u64,
    brand: OpenloopBrandManifest,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenloopBrandManifest {
    product_name: String,
    document_suffix: String,
    mark_asset: String,
    hero_title: String,
    preview_label: String,
    attribution: String,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenloopArtifactManifest {
    core_manifest_sha256: String,
    artifacts: OpenloopArtifacts,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenloopArtifacts {
    sidecar: String,
    runtime_sbom: String,
    web: String,
    bundle_graph: String,
    app: Option<String>,
    dmg: Option<String>,
    updater: Option<String>,
    ffmpeg: Option<String>,
    ffprobe: Option<String>,
}

const EMBEDDED_BUILD_MANIFEST: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/openloop-core.json"));
static EMBEDDED_ARTIFACT_MANIFEST: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/openloop-artifacts.json"));

#[allow(dead_code)]
pub(crate) const BUILD_MANIFEST_SHA256: &str = env!("OPENLOOP_BUILD_MANIFEST_SHA256");
#[allow(dead_code)]
pub(crate) const CORE_MANIFEST_SHA256: &str = env!("OPENLOOP_CORE_MANIFEST_SHA256");
#[allow(dead_code)]
pub(crate) const ARTIFACT_MANIFEST_SHA256: &str = env!("OPENLOOP_ARTIFACT_MANIFEST_SHA256");
#[allow(dead_code)]
pub(crate) const SIDECAR_SHA256: &str = env!("OPENLOOP_SIDECAR_SHA256");
#[allow(dead_code)]
pub(crate) const RUNTIME_SBOM_SHA256: &str = env!("OPENLOOP_RUNTIME_SBOM_SHA256");
#[allow(dead_code)]
pub(crate) const WEB_SHA256: &str = env!("OPENLOOP_WEB_SHA256");
#[allow(dead_code)]
pub(crate) const BUNDLE_GRAPH_SHA256: &str = env!("OPENLOOP_BUNDLE_GRAPH_SHA256");

fn embedded_artifact_manifest() -> Result<OpenloopArtifactManifest, String> {
    serde_json::from_slice(EMBEDDED_ARTIFACT_MANIFEST)
        .map_err(|error| format!("embedded artifact manifest is invalid: {error}"))
}

fn validate_embedded_artifact_manifest() -> Result<(), String> {
    let manifest = embedded_artifact_manifest()?;
    let expected = [
        (
            "coreManifestSha256",
            manifest.core_manifest_sha256.as_str(),
            CORE_MANIFEST_SHA256,
        ),
        (
            "sidecar",
            manifest.artifacts.sidecar.as_str(),
            SIDECAR_SHA256,
        ),
        (
            "runtimeSbom",
            manifest.artifacts.runtime_sbom.as_str(),
            RUNTIME_SBOM_SHA256,
        ),
        ("web", manifest.artifacts.web.as_str(), WEB_SHA256),
        (
            "bundleGraph",
            manifest.artifacts.bundle_graph.as_str(),
            BUNDLE_GRAPH_SHA256,
        ),
    ];
    for (label, actual, expected) in expected {
        if actual != expected {
            return Err(format!(
                "embedded artifact manifest {label} does not match build identity"
            ));
        }
    }
    Ok(())
}

#[tauri::command]
fn build_manifest() -> Result<OpenloopBuildManifest, String> {
    validate_embedded_artifact_manifest()?;
    embedded_build_manifest()
}

fn embedded_build_manifest() -> Result<OpenloopBuildManifest, String> {
    serde_json::from_slice(EMBEDDED_BUILD_MANIFEST)
        .map_err(|error| format!("embedded build manifest is invalid: {error}"))
}

struct RuntimeProcessState {
    _instance: SingleInstance,
    _update_lease: UpdateLease,
    _bridge: BridgeServer,
    #[cfg(target_os = "macos")]
    _update_schedule: ScheduledUpdateWorker,
    #[cfg(target_os = "macos")]
    _health: Arc<Mutex<RuntimeHealthState>>,
    child: Mutex<SupervisedChild>,
}

#[cfg(target_os = "macos")]
struct TauriUpdateChecker {
    app: AppHandle,
    current_version: String,
    updater_config: update::channel::UpdateChannelConfig,
    policy: DownloadUrlPolicy,
    schedule: Arc<Mutex<UpdateCheckSchedule>>,
    timestamp_store: Arc<UpdateCheckTimestampStore>,
}

fn build_channel_updater(
    app: &AppHandle,
    config: &update::channel::UpdateChannelConfig,
) -> tauri_plugin_updater::Result<tauri_plugin_updater::Updater> {
    let (endpoints, public_key) = config.updater_builder_config().into_parts();
    app.updater_builder()
        .endpoints(endpoints)?
        .pubkey(public_key)
        .build()
}

#[cfg(target_os = "macos")]
impl UpdateChecker<Update> for TauriUpdateChecker {
    fn check(&self) -> Result<Option<AvailableUpdate<Update>>, UpdateFailure> {
        let checked_at = update_time();
        if let Ok(mut schedule) = self.schedule.lock() {
            schedule.manual_action(checked_at);
        }
        let _ = self.timestamp_store.record(checked_at);
        let updater = build_channel_updater(&self.app, &self.updater_config)
            .map_err(|_| UpdateFailure::Check)?;
        let (_report, update) = tauri::async_runtime::block_on(check_update(
            &updater,
            &self.current_version,
            &self.policy,
        ))
        .map_err(|error| update_failure(&error))?;
        Ok(update.map(|update| {
            let version = update.version.clone();
            let release_notes = update.body.clone();
            AvailableUpdate::new(update, version, self.updater_config.channel())
                .with_optional_release_notes(release_notes)
        }))
    }
}

#[cfg(target_os = "macos")]
struct TauriUpdateInstaller {
    installed_app: PathBuf,
    channel_root: PathBuf,
    dsh_home: PathBuf,
    policy: DownloadUrlPolicy,
}

#[cfg(target_os = "macos")]
impl UpdateInstaller<Update> for TauriUpdateInstaller {
    fn install(
        &self,
        update: Update,
        observer: &dyn UpdateInstallObserver,
    ) -> Result<UpdateInstallResult, UpdateFailure> {
        let credential_plan = credential_health_plan(&self.channel_root, &self.dsh_home, None)
            .map_err(|_| UpdateFailure::Install)?;
        let mut health = CandidateProcessHealth::new(&update.version, &self.dsh_home)
            .with_migration_expectation(
                credential_plan.migration_transaction_id,
                credential_plan.references.len(),
            );
        let report = tauri::async_runtime::block_on(install_checked_update_with_observer(
            update,
            &self.installed_app,
            &mut health,
            &self.policy,
            observer,
        ))
        .map_err(|error| update_failure(&error))?;
        match report.publication {
            InstallPublication::Committed => Ok(UpdateInstallResult::Committed),
            InstallPublication::RolledBack(_) => Ok(UpdateInstallResult::RolledBack),
            InstallPublication::NoUpdate => Err(UpdateFailure::Install),
        }
    }
}

#[cfg(target_os = "macos")]
struct TauriUpdateRestart(AppHandle);

#[cfg(target_os = "macos")]
impl UpdateRestartRequester for TauriUpdateRestart {
    fn request_restart(&self) {
        self.0.request_restart();
    }
}

#[cfg(target_os = "macos")]
fn update_failure(error: &CoordinatorError) -> UpdateFailure {
    match error {
        CoordinatorError::Check(_) => UpdateFailure::Check,
        CoordinatorError::UnsafeDownloadUrl(_) => UpdateFailure::UnsafeSource,
        CoordinatorError::Download(
            tauri_plugin_updater::Error::Minisign(_)
            | tauri_plugin_updater::Error::Base64(_)
            | tauri_plugin_updater::Error::SignatureUtf8(_),
        ) => UpdateFailure::SignatureVerification,
        CoordinatorError::Download(_) => UpdateFailure::DownloadInterrupted,
        CoordinatorError::InsufficientDiskSpace { .. } => UpdateFailure::InsufficientDiskSpace,
        CoordinatorError::Recovery(_) => UpdateFailure::Recovery,
        CoordinatorError::InvalidArguments
        | CoordinatorError::Stage(_)
        | CoordinatorError::MissingInstallationRoot
        | CoordinatorError::DiskInspection(_)
        | CoordinatorError::State(_)
        | CoordinatorError::Serialize(_) => UpdateFailure::Install,
    }
}

#[cfg(target_os = "macos")]
fn update_time() -> Duration {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
}

#[cfg(target_os = "macos")]
struct RuntimeHealthState {
    acknowledged: bool,
    pending_migration: Option<PendingCredentialMigration>,
}

#[cfg(target_os = "macos")]
struct PendingCredentialMigration {
    channel_root: PathBuf,
    dsh_home: PathBuf,
    transaction_id: Option<uuid::Uuid>,
    store: KeychainStore,
}

#[cfg(target_os = "macos")]
impl PendingCredentialMigration {
    fn new(
        channel_root: &Path,
        dsh_home: &Path,
        transaction_id: uuid::Uuid,
        store: KeychainStore,
    ) -> Self {
        Self {
            channel_root: channel_root.to_owned(),
            dsh_home: dsh_home.to_owned(),
            transaction_id: Some(transaction_id),
            store,
        }
    }

    fn commit_migration(&mut self) -> Result<(), String> {
        let Some(transaction_id) = self.transaction_id else {
            return Ok(());
        };
        commit_migration(
            &self.channel_root,
            &self.dsh_home,
            transaction_id,
            &mut NoopMigrationHook,
        )
        .map_err(|error| error.to_string())?;
        self.transaction_id = None;
        Ok(())
    }

    fn rollback_migration(&mut self) -> Result<(), String> {
        let Some(transaction_id) = self.transaction_id else {
            return Ok(());
        };
        rollback_migration(
            &self.channel_root,
            &self.dsh_home,
            transaction_id,
            &self.store,
            &mut NoopMigrationHook,
        )
        .map(|_| ())
        .map_err(|error| error.to_string())?;
        self.transaction_id = None;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
impl PublicationCompanion for PendingCredentialMigration {
    fn commit(&mut self) -> Result<(), String> {
        self.commit_migration()
    }

    fn rollback(&mut self) -> Result<(), String> {
        self.rollback_migration()
    }
}

#[cfg(target_os = "macos")]
impl Drop for PendingCredentialMigration {
    fn drop(&mut self) {
        let _ = self.rollback_migration();
    }
}

fn find_runtime_executable(executable: &Path, resource_dir: &Path) -> Option<PathBuf> {
    let executable_dir = executable.parent()?;
    let candidates = [
        executable_dir.join("openloop-runtime"),
        resource_dir.join("binaries/openloop-runtime"),
        resource_dir.join(format!(
            "binaries/openloop-runtime-{}-apple-darwin",
            std::env::consts::ARCH
        )),
        Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/openloop-runtime"),
    ];
    candidates.into_iter().find(|path| path.is_file())
}

fn runtime_executable(app: &AppHandle) -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("current Host executable is unavailable: {error}"))?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("runtime resource directory is unavailable: {error}"))?;
    find_runtime_executable(&executable, &resource_dir)
        .ok_or_else(|| "bundled Openloop runtime sidecar is missing".to_owned())
}

fn start_runtime(
    app: &AppHandle,
    updater_config: &update::channel::UpdateChannelConfig,
    manifest: &OpenloopBuildManifest,
) -> Result<Option<RuntimeProcessState>, String> {
    let dsh_home = channel_dsh_home(app, updater_config)?;
    let channel_root = dsh_home
        .parent()
        .ok_or_else(|| "Openloop channel data root is unavailable".to_owned())?;
    let requested_socket_path = channel_root.join("openloop-runtime.sock");
    let instance = SingleInstance::acquire(&requested_socket_path)
        .map_err(|error| format!("single-instance acquisition failed: {error}"))?;
    if instance.action() == InstanceAction::Forwarded {
        app.exit(0);
        return Ok(None);
    }
    #[cfg(target_os = "macos")]
    let store = KeychainStore::new(updater_config.channel());
    #[cfg(target_os = "macos")]
    let (migration_outcome, pending_migration, migration_lease) = {
        let migration_lease = UpdateLease::exclusive(channel_root)
            .map_err(|error| format!("credential migration lease acquisition failed: {error}"))?;
        let installed = current_app_bundle()?;
        let update_root = installed
            .parent()
            .ok_or_else(|| "installed app has no recovery root".to_owned())?;
        recover_interrupted_publication(update_root, channel_root, &dsh_home, store)?;
        let migration_outcome =
            prepare_migration(channel_root, &dsh_home, &store, &mut NoopMigrationHook)
                .unwrap_or(MigrationOutcome::ReadOnlyLegacy);
        let pending_migration = migration_outcome.transaction_id().map(|transaction_id| {
            PendingCredentialMigration::new(channel_root, &dsh_home, transaction_id, store)
        });
        (migration_outcome, pending_migration, migration_lease)
    };
    #[cfg(not(target_os = "macos"))]
    let migration_lease = UpdateLease::exclusive(channel_root)
        .map_err(|error| format!("credential migration lease acquisition failed: {error}"))?;
    let update_lease = migration_lease
        .downgrade()
        .map_err(|error| format!("runtime lease downgrade failed: {error}"))?;
    let bridge_socket_path = if instance.socket_path() == requested_socket_path {
        channel_root.join("openloop-bridge.sock")
    } else {
        let mut bridge_socket_name = instance
            .socket_path()
            .file_name()
            .ok_or_else(|| "single-instance socket has no file name".to_owned())?
            .to_os_string();
        bridge_socket_name.push(".bridge");
        instance.socket_path().with_file_name(bridge_socket_name)
    };
    let secrets = LaunchSecrets::generate(bridge_socket_path)
        .map_err(|error| format!("runtime launch secret generation failed: {error}"))?;
    let bridge_listener = BridgeListener::bind(&secrets.socket_path)
        .map_err(|error| format!("desktop bridge bind failed: {error}"))?;
    let window = app.get_webview_window("main");
    let forward_window = window.clone();
    instance
        .spawn_open_request_forwarder(move || {
            if let Some(window) = forward_window.as_ref() {
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .map_err(|error| format!("single-instance forwarding setup failed: {error}"))?;
    let executable = runtime_executable(app)?;
    let expectation = LaunchReadinessExpectation {
        launch_id: secrets.launch_id,
        core_manifest_sha256: CORE_MANIFEST_SHA256.to_owned(),
    };
    let mut child = SupervisedChild::spawn_with_dsh_home(&executable, &secrets, &dsh_home)
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    let health = Arc::new(Mutex::new(RuntimeHealthState {
        acknowledged: false,
        pending_migration,
    }));
    #[cfg(target_os = "macos")]
    let migration_status = CredentialMigrationStatusHandle::from_outcome(&migration_outcome);
    #[cfg(target_os = "macos")]
    let (dispatch_tables, update_state, update_checker, update_schedule) = {
        let sheet_gate = std::sync::Arc::new(CredentialSheetGate::default());
        let writable = migration_outcome != MigrationOutcome::ReadOnlyLegacy;
        let legacy = if migration_outcome == MigrationOutcome::ReadOnlyLegacy {
            Some(
                ReadOnlyLegacySource::new(channel_root, &dsh_home)
                    .map_err(|error| format!("legacy credential fallback setup failed: {error}"))?,
            )
        } else {
            None
        };
        let replacement = writable.then(|| {
            std::sync::Arc::new(CredentialSheetCoordinator::with_gate(
                std::sync::Arc::new(AppKitCredentialSheet::new(app.clone())),
                std::sync::Arc::new(store),
                sheet_gate.clone(),
            )) as std::sync::Arc<dyn crate::credentials::CredentialReplacement>
        });
        let deletion = writable.then(|| {
            std::sync::Arc::new(AppKitCredentialDeletionConfirmation::new(
                app.clone(),
                sheet_gate,
            )) as std::sync::Arc<dyn crate::credentials::CredentialDeletionConfirmation>
        });
        let mut tables = credential_bridge_dispatch_tables_with_migration_status(
            store,
            replacement,
            deletion,
            legacy,
            migration_status.clone(),
        )
        .map_err(|error| format!("credential bridge setup failed: {error}"))?;
        let workspace_journal = WorkspaceJournal::open(channel_root, updater_config.channel())
            .map_err(|error| format!("Workspace journal setup failed: {error}"))?;
        let workspace_grants = GrantStore::open(channel_root, updater_config.channel())
            .map_err(|error| format!("Workspace grant store setup failed: {error}"))?;
        let launch_grants = workspace_grants
            .load_for_launch()
            .map_err(|error| format!("Workspace grant verification failed: {error}"))?;
        let mut pending_grants = PendingGrantRegistry::new(secrets.launch_id);
        pending_grants.inject_launch_grants(launch_grants);
        let pending_grants = Arc::new(Mutex::new(pending_grants));
        let file_broker = Arc::new(FileBroker::new(
            secrets.launch_id,
            workspace_grants.clone(),
            workspace_journal.clone(),
            pending_grants.clone(),
        ));
        install_workspace_authority_handlers(
            &mut tables,
            secrets.launch_id,
            workspace_grants,
            workspace_journal.clone(),
            pending_grants,
            Arc::new(AppKitWorkspaceDirectoryPicker::new(app.clone())),
            Arc::new(AppKitWorkspaceRevokeConfirmation::new(app.clone())),
        )?;
        install_file_broker_handlers(&mut tables, file_broker)?;
        install_workspace_transaction_handlers(&mut tables, workspace_journal)?;
        let update_state = Arc::new(UpdateState::new(
            updater_config.channel(),
            Duration::from_secs(15 * 60),
        ));
        let update_timestamp_store = Arc::new(
            UpdateCheckTimestampStore::open(channel_root, updater_config.channel())
                .map_err(|error| format!("update schedule store setup failed: {error}"))?,
        );
        let update_schedule = Arc::new(Mutex::new(UpdateCheckSchedule::new(
            update_timestamp_store.load(),
        )));
        let update_checker: Arc<dyn UpdateChecker<Update>> = Arc::new(TauriUpdateChecker {
            app: app.clone(),
            current_version: manifest.app_version.clone(),
            updater_config: updater_config.clone(),
            policy: DownloadUrlPolicy::production(updater_config.channel()),
            schedule: update_schedule.clone(),
            timestamp_store: update_timestamp_store,
        });
        let installed_app = current_app_bundle()?;
        let update_installer: Arc<dyn UpdateInstaller<Update>> = Arc::new(TauriUpdateInstaller {
            installed_app,
            channel_root: channel_root.to_owned(),
            dsh_home: dsh_home.clone(),
            policy: DownloadUrlPolicy::production(updater_config.channel()),
        });
        install_update_bridge_handlers(
            &mut tables,
            update_state.clone(),
            updater_config.channel(),
            update_checker.clone(),
            update_installer,
            Arc::new(AppKitUpdateInstallConfirmation::new(app.clone())),
            Arc::new(TauriUpdateRestart(app.clone())),
            Arc::new(update_time),
        )?;
        let health_plan = match migration_outcome.transaction_id() {
            Some(transaction_id) => {
                let plan = credential_health_plan(channel_root, &dsh_home, Some(transaction_id))
                    .map_err(|error| {
                        format!("main WebView credential health plan failed: {error}")
                    })?;
                CredentialHealthPlan {
                    migration_transaction_id: plan.migration_transaction_id,
                    references: plan.references,
                }
            }
            None => CredentialHealthPlan {
                migration_transaction_id: None,
                references: Vec::new(),
            },
        };
        install_credential_health_plan_handler(&mut tables, health_plan.clone())
            .map_err(|error| format!("credential health bridge setup failed: {error}"))?;
        let health_state = health.clone();
        let completed_migration_status = migration_status.clone();
        let mut expectation = MainWebviewHealthExpectation::new(
            secrets.launch_id,
            CORE_MANIFEST_SHA256,
            manifest.openloop_data_version,
            manifest.dsh_data_version,
        );
        if health_plan.migration_transaction_id.is_some() {
            expectation = expectation.with_credential_health_plan(health_plan);
        }
        let handler: BridgeHandler = Arc::new(move |payload, _cancellation| {
            let acknowledgement: MainWebviewHealthAcknowledgement = serde_json::from_value(payload)
                .map_err(|_| BridgeHandlerError::invalid_request())?;
            expectation
                .validate(&acknowledgement)
                .map_err(|_| BridgeHandlerError::invalid_request())?;
            let mut health = health_state
                .lock()
                .map_err(|_| BridgeHandlerError::credential_failure())?;
            if health.acknowledged {
                return Err(BridgeHandlerError::invalid_request());
            }
            if let Some(migration) = health.pending_migration.as_mut() {
                migration
                    .commit_migration()
                    .map_err(|_| BridgeHandlerError::credential_failure())?;
                completed_migration_status
                    .complete()
                    .map_err(|_| BridgeHandlerError::credential_failure())?;
            }
            health.pending_migration.take();
            health.acknowledged = true;
            Ok(serde_json::Value::Null)
        });
        tables
            .set_host_handler("acknowledgeMainWebviewHealth", handler)
            .map_err(|error| format!("main WebView health bridge setup failed: {error}"))?;
        (tables, update_state, update_checker, update_schedule)
    };
    #[cfg(not(target_os = "macos"))]
    let dispatch_tables = BridgeDispatchTables::unavailable();
    let bridge_dispatcher = AuthenticatedBridgeDispatcher::new(
        unsafe { libc::geteuid() },
        child.identity().clone(),
        executable,
        secrets.launch_id,
        secrets.bridge_secret.to_vec(),
        dispatch_tables,
    )
    .map_err(|error| format!("desktop bridge authentication setup failed: {error}"))?;
    let bridge = bridge_listener
        .serve(bridge_dispatcher)
        .map_err(|error| format!("desktop bridge server startup failed: {error}"))?;
    let readiness = child
        .wait_readiness(&expectation, Duration::from_secs(10))
        .map_err(|error| error.to_string())?;
    let bootstrap_url = format!(
        "{}#bootstrap={}&launch={}",
        readiness.origin,
        secrets.bootstrap_token_hex(),
        secrets.launch_id,
    );
    let window = window.ok_or_else(|| "Openloop main webview is missing".to_owned())?;
    window
        .navigate(
            Url::parse(&bootstrap_url)
                .map_err(|error| format!("Openloop runtime bootstrap URL is invalid: {error}"))?,
        )
        .map_err(|error| format!("Openloop main webview navigation failed: {error}"))?;
    #[cfg(target_os = "macos")]
    let update_schedule = ScheduledUpdateWorker::start(
        update_schedule,
        update_state,
        update_checker,
        Arc::new(update_time),
    )?;
    Ok(Some(RuntimeProcessState {
        _instance: instance,
        _update_lease: update_lease,
        _bridge: bridge,
        #[cfg(target_os = "macos")]
        _update_schedule: update_schedule,
        #[cfg(target_os = "macos")]
        _health: health,
        child: Mutex::new(child),
    }))
}

#[cfg(target_os = "macos")]
fn recover_interrupted_publication(
    update_root: &Path,
    channel_root: &Path,
    dsh_home: &Path,
    store: KeychainStore,
) -> Result<(), String> {
    let transaction_id = pending_update_migration_transaction_id(update_root)
        .map_err(|error| format!("inspect interrupted update failed: {error}"))?;
    if let Some(transaction_id) = transaction_id {
        let mut migration =
            PendingCredentialMigration::new(channel_root, dsh_home, transaction_id, store);
        recover_interrupted_update_with_bound_companion(update_root, transaction_id, &mut migration)
            .map_err(|error| format!("recover interrupted update failed: {error}"))
    } else {
        recover_interrupted_update(update_root)
            .map_err(|error| format!("recover interrupted update failed: {error}"))
    }
}

fn channel_dsh_home(
    app: &AppHandle,
    updater_config: &update::channel::UpdateChannelConfig,
) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Openloop app data directory is unavailable: {error}"))?;
    ensure_channel_dsh_home(&app_data, updater_config.data_root_name())
        .map_err(|error| format!("Openloop channel data root is unavailable: {error}"))
}

fn embedded_channel() -> Result<update::channel::ReleaseChannel, String> {
    embedded_build_manifest().and_then(|manifest| {
        manifest
            .channel
            .parse()
            .map_err(|error: update::channel::ChannelConfigError| error.to_string())
    })
}

fn current_app_bundle() -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("current Host executable is unavailable: {error}"))?;
    let macos = executable
        .parent()
        .ok_or_else(|| "current Host executable has no parent".to_owned())?;
    if macos.file_name() != Some(OsStr::new("MacOS")) {
        return Err("current Host executable is not inside an App MacOS directory".to_owned());
    }
    let contents = macos
        .parent()
        .ok_or_else(|| "current Host executable has no Contents directory".to_owned())?;
    if contents.file_name() != Some(OsStr::new("Contents")) {
        return Err("current Host executable is not inside an App Contents directory".to_owned());
    }
    let app = contents
        .parent()
        .ok_or_else(|| "current Host executable has no App bundle".to_owned())?;
    if app.extension() != Some(OsStr::new("app")) {
        return Err("current Host executable is not inside an .app bundle".to_owned());
    }
    Ok(app.to_owned())
}

fn write_stdout_line(line: &str) -> Result<(), String> {
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(line.as_bytes())
        .and_then(|()| stdout.flush())
        .map_err(|error| format!("write Host spike output failed: {error}"))
}

fn write_failure_json(error: &str) {
    let value = serde_json::json!({
        "result": "failed",
        "error": error,
    });
    if let Ok(line) = serde_json::to_string(&value) {
        let _ = write_stdout_line(&format!("{line}\n"));
    }
}

fn start_health_probe(
    app: &AppHandle,
    manifest: &OpenloopBuildManifest,
    updater_config: &update::channel::UpdateChannelConfig,
) -> Result<(), String> {
    let dsh_home_value = std::env::var_os("DSH_HOME");
    let dsh_home = required_dsh_home(dsh_home_value.as_deref(), updater_config.data_root_name())
        .map_err(|error| error.to_string())?;
    let injected = std::env::var(TEST_PROBE_FAILURE_ENVIRONMENT).ok();
    let probe = BundleHealthProbe::new(
        &manifest.app_version,
        updater_config.bundle_identifier(),
        CORE_MANIFEST_SHA256,
        manifest.openloop_data_version,
        manifest.dsh_data_version,
    );
    if probe
        .test_failure_injection(&manifest.channel, injected.as_deref())
        .map_err(|error| error.to_string())?
    {
        return Err("trusted test health failure was injected".to_owned());
    }
    let app_bundle = current_app_bundle()?;
    let migration_transaction_id = std::env::var(MIGRATION_TRANSACTION_ENVIRONMENT)
        .ok()
        .map(|value| {
            value
                .parse()
                .map_err(|_| "candidate migration transaction identity is invalid".to_owned())
        })
        .transpose()?;
    let channel_root = dsh_home
        .parent()
        .ok_or_else(|| "candidate channel data root is unavailable".to_owned())?;
    let migration_plan = credential_health_plan(channel_root, &dsh_home, migration_transaction_id)
        .map_err(|error| format!("candidate credential health plan failed: {error}"))?;
    let health_plan = CredentialHealthPlan {
        migration_transaction_id: migration_plan.migration_transaction_id,
        references: migration_plan.references,
    };
    let store = KeychainStore::new(updater_config.channel());
    let session = probe
        .begin_with_credential_health(
            &app_bundle,
            Duration::from_secs(45),
            &dsh_home,
            health_plan,
            move |reference| {
                let account = CredentialAccount::new(reference).map_err(|_| ())?;
                store.status(&account).map_err(|_| ())
            },
        )
        .map_err(|error| error.to_string())?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "candidate health WebView is missing".to_owned())?;
    window
        .hide()
        .map_err(|error| format!("hide candidate health WebView failed: {error}"))?;
    window
        .navigate(
            Url::parse(session.bootstrap_url())
                .map_err(|error| format!("candidate health bootstrap URL is invalid: {error}"))?,
        )
        .map_err(|error| format!("navigate candidate health WebView failed: {error}"))?;
    let app = app.clone();
    std::thread::spawn(move || match session.finish() {
        Ok(report) => {
            match report
                .to_json_line()
                .map_err(|error| error.to_string())
                .and_then(|line| write_stdout_line(&line))
            {
                Ok(()) => app.exit(0),
                Err(error) => {
                    write_failure_json(&error);
                    app.exit(1);
                }
            }
        }
        Err(error) => {
            write_failure_json(&error.to_string());
            app.exit(1);
        }
    });
    Ok(())
}

async fn run_update_spike(
    app: &AppHandle,
    action: HostAction,
    current: &str,
) -> Result<String, String> {
    let updater_config = app.state::<update::channel::UpdateChannelConfig>();
    let dsh_home = channel_dsh_home(app, &updater_config)?;
    let channel_root = dsh_home
        .parent()
        .ok_or_else(|| "Openloop channel data root is unavailable".to_owned())?;
    let _update_lease = UpdateLease::exclusive(channel_root)
        .map_err(|error| format!("exclusive update lease acquisition failed: {error}"))?;
    let installed = current_app_bundle()?;
    let update_root = installed
        .parent()
        .ok_or_else(|| "installed app has no recovery root".to_owned())?;
    #[cfg(target_os = "macos")]
    recover_interrupted_publication(
        update_root,
        channel_root,
        &dsh_home,
        KeychainStore::new(updater_config.channel()),
    )?;
    #[cfg(not(target_os = "macos"))]
    recover_interrupted_update(update_root)
        .map_err(|error| format!("recover interrupted update failed: {error}"))?;
    let update = build_channel_updater(app, &updater_config)
        .map_err(|error| format!("create signed updater failed: {error}"))?
        .check()
        .await
        .map_err(|error| format!("signed update check failed: {error}"))?;
    let download_policy = DownloadUrlPolicy::production(updater_config.channel());
    if let Some(update) = update.as_ref() {
        download_policy
            .validate_update(update)
            .map_err(|error| error.to_string())?;
    }
    let check = CheckReport {
        current: current.to_owned(),
        available: update.as_ref().map(|value| value.version.clone()),
    };
    if action == HostAction::Check {
        return check.json_line().map_err(|error| error.to_string());
    }
    let Some(update) = update else {
        return InstallReport {
            current: check.current,
            available: None,
            download: DownloadStatus::NotStarted,
            publication: InstallPublication::NoUpdate,
            preserved_backup: None,
            failed_candidate: None,
        }
        .json_line()
        .map_err(|error| error.to_string());
    };
    let current = update.current_version.clone();
    let available = update.version.clone();
    download_policy
        .validate_update(&update)
        .map_err(|error| error.to_string())?;
    let archive = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| format!("signed update download or verification failed: {error}"))?;
    let candidate = stage_verified_archive(&archive, &installed)
        .map_err(|error| format!("verified update staging failed: {error}"))?;
    let transaction = RecoveryTransaction::open(update_root, &installed, candidate.path())
        .map_err(|error| format!("open candidate recovery transaction failed: {error}"))?;
    #[cfg(target_os = "macos")]
    let publication_outcome = {
        let store = KeychainStore::new(updater_config.channel());
        let migration_plan = plan_migration(channel_root, &dsh_home, &mut NoopMigrationHook)
            .map_err(|error| format!("candidate credential migration planning failed: {error}"))?;
        let transaction = transaction
            .prepare(migration_plan.transaction_id())
            .map_err(|error| format!("prepare candidate recovery transaction failed: {error}"))?;
        let migration = match migration_plan.transaction_id() {
            Some(transaction_id) => prepare_migration_with_transaction_id(
                channel_root,
                &dsh_home,
                &store,
                transaction_id,
                &mut NoopMigrationHook,
            )
            .map_err(|error| format!("candidate credential migration failed: {error}"))?,
            None => MigrationOutcome::NotNeeded,
        };
        let mut pending_migration = migration.transaction_id().map(|transaction_id| {
            PendingCredentialMigration::new(channel_root, &dsh_home, transaction_id, store)
        });
        let credential_plan =
            credential_health_plan(channel_root, &dsh_home, migration.transaction_id())
                .map_err(|error| format!("candidate credential health plan failed: {error}"))?;
        let mut health = CandidateProcessHealth::new(&update.version, dsh_home)
            .with_migration_expectation(
                credential_plan.migration_transaction_id,
                credential_plan.references.len(),
            );
        if let Some(companion) = pending_migration.as_mut() {
            transaction.publish_with_companion(&mut health, companion)
        } else {
            transaction.publish(&mut health)
        }
    };
    #[cfg(not(target_os = "macos"))]
    let publication_outcome = {
        let mut health = CandidateProcessHealth::new(&update.version, dsh_home);
        transaction.publish(&mut health)
    };
    let publication_outcome = publication_outcome
        .map_err(|error| format!("publish candidate recovery transaction failed: {error}"))?;
    let (publication, preserved_backup, failed_candidate) = match publication_outcome {
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
    InstallReport {
        current,
        available: Some(available),
        download: DownloadStatus::Verified,
        publication,
        preserved_backup,
        failed_candidate,
    }
    .json_line()
    .map_err(|error| error.to_string())
}

pub fn run() -> i32 {
    let arguments = std::env::args_os().skip(1).collect::<Vec<OsString>>();
    let action = match parse_host_action(&arguments) {
        Ok(action) => action,
        Err(error) => {
            write_failure_json(&error.to_string());
            return 2;
        }
    };
    let manifest = match embedded_build_manifest() {
        Ok(manifest) => manifest,
        Err(error) => {
            write_failure_json(&error);
            return 1;
        }
    };
    let channel = match embedded_channel() {
        Ok(channel) => channel,
        Err(error) => {
            write_failure_json(&error);
            return 1;
        }
    };
    #[cfg(target_os = "macos")]
    match credentials::parse_keychain_spike_action(&arguments, channel) {
        Ok(Some(action)) => {
            return match credentials::run_keychain_spike(action)
                .and_then(|report| report.json_line())
                .map_err(|error| error.to_string())
                .and_then(|line| write_stdout_line(&line))
            {
                Ok(()) => 0,
                Err(error) => {
                    write_failure_json(&error);
                    1
                }
            };
        }
        Ok(None) => {}
        Err(error) => {
            write_failure_json(&error.to_string());
            return 2;
        }
    }
    let updater_config = match update::channel::UpdateChannelConfig::embedded(channel) {
        Ok(config) => config,
        Err(error) => {
            write_failure_json(&error.to_string());
            return 1;
        }
    };
    let updater_plugin = tauri_plugin_updater::Builder::new()
        .target("darwin-aarch64")
        .pubkey(updater_config.public_key())
        .build();
    let builder = tauri::Builder::default()
        .plugin(updater_plugin)
        .manage(updater_config)
        .invoke_handler(tauri::generate_handler![build_manifest]);
    let runtime_manifest = manifest.clone();
    let app = builder
        .setup(move |app| {
            let updater_config = app.state::<update::channel::UpdateChannelConfig>();
            if action == HostAction::HealthProbe {
                start_health_probe(app.handle(), &runtime_manifest, &updater_config)?;
                return Ok(());
            }
            if action != HostAction::Normal {
                return Ok(());
            }
            if let Some(state) = start_runtime(app.handle(), &updater_config, &runtime_manifest)? {
                app.manage(state);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Openloop desktop application");
    if action == HostAction::HealthProbe {
        return app.run_return(|_, _| {});
    }
    if matches!(action, HostAction::Check | HostAction::Install) {
        return match tauri::async_runtime::block_on(run_update_spike(
            app.handle(),
            action,
            &manifest.app_version,
        )) {
            Ok(line) => match write_stdout_line(&line) {
                Ok(()) => 0,
                Err(error) => {
                    write_failure_json(&error);
                    1
                }
            },
            Err(error) => {
                write_failure_json(&error);
                1
            }
        };
    }
    app.run(|app, event| {
        if matches!(event, RunEvent::Exit) {
            if let Some(state) = app.try_state::<RuntimeProcessState>() {
                if let Ok(mut child) = state.child.lock() {
                    let _ = child.terminate_if_verified();
                }
            }
        }
    });
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn reads_the_embedded_test_manifest() {
        let manifest = build_manifest().expect("embedded manifest must deserialize");
        let artifacts =
            embedded_artifact_manifest().expect("embedded artifact manifest must deserialize");

        assert_eq!(manifest.app_version, "0.1.0");
        assert_eq!(manifest.channel, "test");
        assert_eq!(manifest.dsh_commit.len(), 40);
        assert_eq!(BUILD_MANIFEST_SHA256.len(), 64);
        assert_eq!(artifacts.core_manifest_sha256, CORE_MANIFEST_SHA256);
        assert_eq!(artifacts.artifacts.sidecar, SIDECAR_SHA256);
        assert_eq!(artifacts.artifacts.runtime_sbom, RUNTIME_SBOM_SHA256);
        assert_eq!(artifacts.artifacts.web, WEB_SHA256);
        assert_eq!(artifacts.artifacts.bundle_graph, BUNDLE_GRAPH_SHA256);
        assert_eq!(ARTIFACT_MANIFEST_SHA256.len(), 64);
    }

    #[test]
    fn finds_the_packaged_runtime_next_to_the_host_executable() {
        let fixture = tempfile::tempdir().expect("temporary app bundle");
        let macos = fixture.path().join("Openloop.app/Contents/MacOS");
        let resources = fixture.path().join("Openloop.app/Contents/Resources");
        fs::create_dir_all(&macos).expect("MacOS directory");
        fs::create_dir_all(&resources).expect("Resources directory");
        let host = macos.join("openloop-desktop");
        let runtime = macos.join("openloop-runtime");
        fs::write(&runtime, b"runtime").expect("packaged runtime");

        assert_eq!(find_runtime_executable(&host, &resources), Some(runtime),);
    }
}
