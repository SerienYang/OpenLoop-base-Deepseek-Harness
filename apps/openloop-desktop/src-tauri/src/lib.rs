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

const EMBEDDED_BUILD_MANIFEST: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/openloop-core.json"));

#[allow(dead_code)]
pub(crate) const BUILD_MANIFEST_SHA256: &str = env!("OPENLOOP_BUILD_MANIFEST_SHA256");

#[tauri::command]
fn build_manifest() -> Result<OpenloopBuildManifest, String> {
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

        assert_eq!(manifest.app_version, "0.1.0");
        assert_eq!(manifest.channel, "test");
        assert_eq!(manifest.dsh_commit.len(), 40);
        assert_eq!(BUILD_MANIFEST_SHA256.len(), 64);
    }
}
