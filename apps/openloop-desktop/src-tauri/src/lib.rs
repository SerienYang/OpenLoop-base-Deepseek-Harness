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
    serde_json::from_slice(EMBEDDED_BUILD_MANIFEST)
        .map_err(|error| format!("embedded build manifest is invalid: {error}"))
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![build_manifest])
        .run(tauri::generate_context!())
        .expect("failed to run Openloop desktop application");
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
