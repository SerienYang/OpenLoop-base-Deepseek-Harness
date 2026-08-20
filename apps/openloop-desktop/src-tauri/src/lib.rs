use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use tauri::{AppHandle, Manager, RunEvent, Url};

use crate::launcher::{
    InstanceAction, LaunchReadinessExpectation, LaunchSecrets, SingleInstance, SupervisedChild,
};

pub mod browser;
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

fn embedded_build_manifest() -> Result<OpenloopBuildManifest, String> {
    serde_json::from_slice(EMBEDDED_BUILD_MANIFEST)
        .map_err(|error| format!("embedded build manifest is invalid: {error}"))
}

struct RuntimeProcessState {
    _instance: SingleInstance,
    child: Mutex<SupervisedChild>,
}

fn runtime_executable(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("runtime resource directory is unavailable: {error}"))?;
    let candidates = [
        resource_dir.join("binaries/openloop-runtime"),
        resource_dir.join(format!(
            "binaries/openloop-runtime-{}-apple-darwin",
            std::env::consts::ARCH
        )),
        Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/openloop-runtime"),
    ];
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "bundled Openloop runtime sidecar is missing".to_owned())
}

fn start_runtime(app: &AppHandle) -> Result<Option<RuntimeProcessState>, String> {
    let launch_id_path = std::env::temp_dir().join("openloop-runtime.sock");
    let secrets = LaunchSecrets::generate(launch_id_path.clone())
        .map_err(|error| format!("runtime launch secret generation failed: {error}"))?;
    let instance = SingleInstance::acquire(&secrets.socket_path)
        .map_err(|error| format!("single-instance acquisition failed: {error}"))?;
    if instance.action() == InstanceAction::Forwarded {
        app.exit(0);
        return Ok(None);
    }
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
    let mut child =
        SupervisedChild::spawn(&executable, &secrets).map_err(|error| error.to_string())?;
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
        child: Mutex::new(child),
    }))
}

pub fn run() {
    let channel = embedded_build_manifest()
        .and_then(|manifest| {
            manifest
                .channel
                .parse()
                .map_err(|error: update::channel::ChannelConfigError| error.to_string())
        })
        .expect("embedded Openloop release channel is invalid");
    let updater_config = update::channel::UpdateChannelConfig::embedded(channel)
        .expect("signed Openloop updater configuration is invalid");
    let updater_plugin = tauri_plugin_updater::Builder::new()
        .pubkey(updater_config.public_key())
        .build();
    let app = tauri::Builder::default()
        .plugin(updater_plugin)
        .manage(updater_config)
        .invoke_handler(tauri::generate_handler![build_manifest])
        .setup(|app| {
            if let Some(state) = start_runtime(&app.handle())? {
                app.manage(state);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Openloop desktop application");
    app.run(|app, event| {
        if matches!(event, RunEvent::Exit) {
            if let Some(state) = app.try_state::<RuntimeProcessState>() {
                if let Ok(mut child) = state.child.lock() {
                    let _ = child.terminate_if_verified();
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
