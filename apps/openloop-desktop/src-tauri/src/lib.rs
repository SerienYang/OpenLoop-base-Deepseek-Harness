use std::{
    ffi::{OsStr, OsString},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use tauri::{AppHandle, Manager, RunEvent, Url};
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_window_state::StateFlags;
#[cfg(target_os = "macos")]
use zeroize::Zeroizing;

#[cfg(target_os = "macos")]
use crate::credentials::{KeychainStore, SecurePromptState};
use crate::launcher::{
    InstanceAction, LaunchReadinessExpectation, LaunchSecrets, SingleInstance, SupervisedChild,
};
use crate::update::{
    archive::stage_verified_archive,
    coordinator::{
        parse_host_action, CheckReport, DownloadStatus, DownloadUrlPolicy, HostAction,
        InstallPublication, InstallReport,
    },
    health::{
        ensure_channel_dsh_home, required_dsh_home, BundleHealthProbe, CandidateProcessHealth,
        TEST_PROBE_FAILURE_ENVIRONMENT,
    },
    lease::UpdateLease,
    recovery::{PublicationOutcome, RecoveryTransaction},
};

pub mod browser;
#[cfg(target_os = "macos")]
pub mod credentials;
pub mod launcher;
pub mod spikes;
pub mod update;

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

#[cfg(target_os = "macos")]
#[tauri::command]
fn credentials_set(
    secret: Vec<u8>,
    prompt_token: String,
    window: tauri::WebviewWindow,
    prompt_state: tauri::State<'_, SecurePromptState>,
    keychain: tauri::State<'_, KeychainStore>,
) -> Result<(), String> {
    let secret = Zeroizing::new(secret);
    let account = prompt_state
        .account_for_prompt(window.label(), &prompt_token)
        .map_err(|error| error.to_string())?;
    keychain
        .set(&account, secret.as_slice())
        .map_err(|error| error.to_string())?;
    destroy_credentials_prompt(&window, &prompt_state, &prompt_token)
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn credentials_unset(
    prompt_token: String,
    window: tauri::WebviewWindow,
    prompt_state: tauri::State<'_, SecurePromptState>,
    keychain: tauri::State<'_, KeychainStore>,
) -> Result<(), String> {
    let account = prompt_state
        .account_for_prompt(window.label(), &prompt_token)
        .map_err(|error| error.to_string())?;
    keychain
        .delete(&account)
        .map_err(|error| error.to_string())?;
    destroy_credentials_prompt(&window, &prompt_state, &prompt_token)
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn credentials_status(
    prompt_token: String,
    window: tauri::WebviewWindow,
    prompt_state: tauri::State<'_, SecurePromptState>,
    keychain: tauri::State<'_, KeychainStore>,
) -> Result<bool, String> {
    let account = prompt_state
        .account_for_prompt(window.label(), &prompt_token)
        .map_err(|error| error.to_string())?;
    keychain.status(&account).map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn destroy_credentials_prompt(
    window: &tauri::WebviewWindow,
    prompt_state: &SecurePromptState,
    prompt_token: &str,
) -> Result<(), String> {
    let clear_result = prompt_state
        .clear_for_prompt(window.label(), prompt_token)
        .map(|_| ())
        .map_err(|error| error.to_string());
    let destroy_result = window
        .destroy()
        .map_err(|error| format!("credential prompt destruction failed: {error}"));
    clear_result.and(destroy_result)
}

fn embedded_build_manifest() -> Result<OpenloopBuildManifest, String> {
    serde_json::from_slice(EMBEDDED_BUILD_MANIFEST)
        .map_err(|error| format!("embedded build manifest is invalid: {error}"))
}

struct RuntimeProcessState {
    _instance: SingleInstance,
    _update_lease: UpdateLease,
    child: Mutex<SupervisedChild>,
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
) -> Result<Option<RuntimeProcessState>, String> {
    let dsh_home = channel_dsh_home(app, updater_config)?;
    let channel_root = dsh_home
        .parent()
        .ok_or_else(|| "Openloop channel data root is unavailable".to_owned())?;
    let update_lease = UpdateLease::shared(channel_root)
        .map_err(|error| format!("runtime update lease acquisition failed: {error}"))?;
    let requested_socket_path = channel_root.join("openloop-runtime.sock");
    let instance = SingleInstance::acquire(&requested_socket_path)
        .map_err(|error| format!("single-instance acquisition failed: {error}"))?;
    if instance.action() == InstanceAction::Forwarded {
        app.exit(0);
        return Ok(None);
    }
    let secrets = LaunchSecrets::generate(instance.socket_path().to_path_buf())
        .map_err(|error| format!("runtime launch secret generation failed: {error}"))?;
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
    Ok(Some(RuntimeProcessState {
        _instance: instance,
        _update_lease: update_lease,
        child: Mutex::new(child),
    }))
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

fn run_health_probe(
    manifest: &OpenloopBuildManifest,
    updater_config: &update::channel::UpdateChannelConfig,
) -> Result<(), String> {
    let dsh_home_value = std::env::var_os("DSH_HOME");
    let dsh_home = required_dsh_home(dsh_home_value.as_deref(), updater_config.data_root_name())
        .map_err(|error| error.to_string())?;
    let probe = BundleHealthProbe::new(
        &manifest.app_version,
        updater_config.bundle_identifier(),
        CORE_MANIFEST_SHA256,
    );
    let injected = std::env::var(TEST_PROBE_FAILURE_ENVIRONMENT).ok();
    if probe
        .test_failure_injection(&manifest.channel, injected.as_deref())
        .map_err(|error| error.to_string())?
    {
        return Err("trusted test health failure was injected".to_owned());
    }
    let app = current_app_bundle()?;
    let report = probe
        .inspect(&app, Duration::from_secs(45), &dsh_home)
        .map_err(|error| error.to_string())?;
    write_stdout_line(&report.to_json_line().map_err(|error| error.to_string())?)
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
    let update = app
        .updater()
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
    let installed = current_app_bundle()?;
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
    let root = installed
        .parent()
        .ok_or_else(|| "installed app has no recovery root".to_owned())?;
    let transaction = RecoveryTransaction::open(root, &installed, candidate.path())
        .map_err(|error| format!("open candidate recovery transaction failed: {error}"))?;
    let mut health = CandidateProcessHealth::new(&update.version, dsh_home);
    let (publication, preserved_backup, failed_candidate) = match transaction
        .publish(&mut health)
        .map_err(|error| {
        format!("publish candidate recovery transaction failed: {error}")
    })? {
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
    if action == HostAction::HealthProbe {
        return match run_health_probe(&manifest, &updater_config) {
            Ok(()) => 0,
            Err(error) => {
                write_failure_json(&error);
                1
            }
        };
    }
    let window_state_plugin = tauri_plugin_window_state::Builder::default()
        .with_state_flags(StateFlags::POSITION | StateFlags::SIZE | StateFlags::MAXIMIZED)
        .with_filter(|label| label == "main")
        .build();
    let updater_plugin = tauri_plugin_updater::Builder::new()
        .target("darwin-aarch64")
        .pubkey(updater_config.public_key())
        .build();
    let builder = tauri::Builder::default()
        .plugin(window_state_plugin)
        .plugin(updater_plugin)
        .manage(updater_config);
    #[cfg(target_os = "macos")]
    let builder = builder
        .manage(KeychainStore::new(channel))
        .manage(SecurePromptState::default())
        .invoke_handler(tauri::generate_handler![
            build_manifest,
            credentials_set,
            credentials_unset,
            credentials_status
        ]);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.invoke_handler(tauri::generate_handler![build_manifest]);
    let app = builder
        .setup(move |app| {
            if action != HostAction::Normal {
                return Ok(());
            }
            let updater_config = app.state::<update::channel::UpdateChannelConfig>();
            if let Some(state) = start_runtime(app.handle(), &updater_config)? {
                app.manage(state);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Openloop desktop application");
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
