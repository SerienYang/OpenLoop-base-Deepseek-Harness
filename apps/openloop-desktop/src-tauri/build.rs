use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env, fs, io,
    path::{Path, PathBuf},
};
use tauri_build::{AppManifest, Attributes};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanonicalBuildManifest {
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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanonicalArtifactManifest {
    core_manifest_sha256: String,
    artifacts: CanonicalArtifacts,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanonicalArtifacts {
    sidecar: String,
    runtime_sbom: String,
    web: String,
    bundle_graph: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dmg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updater: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ffmpeg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ffprobe: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct EmbeddedHashes {
    core: String,
    artifact_manifest: String,
    sidecar: String,
    runtime_sbom: String,
    web: String,
    bundle_graph: String,
}

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn read_canonical<T>(path: &Path, label: &str) -> Result<(Vec<u8>, T), Box<dyn std::error::Error>>
where
    T: for<'de> Deserialize<'de> + Serialize,
{
    let bytes = fs::read(path).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "required Openloop {label} manifest is missing or unreadable at {}: {error}",
                path.display()
            ),
        )
    })?;
    let text = std::str::from_utf8(&bytes).map_err(|error| {
        invalid_data(format!(
            "Openloop {label} manifest at {} is not valid UTF-8: {error}",
            path.display()
        ))
    })?;
    let manifest: T = serde_json::from_str(text).map_err(|error| {
        invalid_data(format!(
            "Openloop {label} manifest at {} is not valid JSON: {error}",
            path.display()
        ))
    })?;
    let canonical = format!("{}\n", serde_json::to_string_pretty(&manifest)?);
    if bytes != canonical.as_bytes() {
        return Err(invalid_data(format!(
            "Openloop {label} manifest at {} is not canonical JSON",
            path.display()
        ))
        .into());
    }
    Ok((bytes, manifest))
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn is_semver_identifier_list(value: &str, allow_numeric_leading_zero: bool) -> bool {
    !value.is_empty()
        && value.split('.').all(|identifier| {
            if identifier.is_empty()
                || !identifier
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                return false;
            }
            if allow_numeric_leading_zero {
                return true;
            }
            !identifier.bytes().all(|byte| byte.is_ascii_digit())
                || identifier.len() == 1
                || !identifier.starts_with('0')
        })
}

fn is_semver(value: &str) -> bool {
    let (without_build, build) = value
        .split_once('+')
        .map_or((value, None), |(core, metadata)| (core, Some(metadata)));
    if let Some(metadata) = build {
        if !is_semver_identifier_list(metadata, true) {
            return false;
        }
    }

    let (core, prerelease) = without_build
        .split_once('-')
        .map_or((without_build, None), |(core, suffix)| (core, Some(suffix)));
    let core_parts: Vec<&str> = core.split('.').collect();
    if core_parts.len() != 3
        || core_parts.iter().any(|part| {
            part.is_empty()
                || !part.bytes().all(|byte| byte.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
        })
    {
        return false;
    }
    if let Some(prerelease) = prerelease {
        if !is_semver_identifier_list(prerelease, false) {
            return false;
        }
        if prerelease.split('.').any(|identifier| {
            identifier.bytes().all(|byte| byte.is_ascii_digit())
                && identifier.len() > 1
                && identifier.starts_with('0')
        }) {
            return false;
        }
        if prerelease.split('.').any(|identifier| {
            !identifier.bytes().all(|byte| byte.is_ascii_digit())
                && !identifier
                    .bytes()
                    .any(|byte| byte.is_ascii_alphabetic() || byte == b'-')
        }) {
            return false;
        }
    }
    true
}

fn is_safe_positive_integer(value: u64) -> bool {
    (1..=MAX_SAFE_INTEGER).contains(&value)
}

fn is_safe_nonnegative_integer(value: u64) -> bool {
    value <= MAX_SAFE_INTEGER
}

fn validate_core(manifest: &CanonicalBuildManifest) -> Result<(), Box<dyn std::error::Error>> {
    if manifest.channel != "test" && manifest.channel != "stable" {
        return Err(invalid_data("Openloop core manifest channel must be test or stable").into());
    }
    if !is_lower_hex(&manifest.dsh_commit, 40) {
        return Err(invalid_data(
            "Openloop core manifest dshCommit must be 40 lowercase hexadecimal characters",
        )
        .into());
    }
    if !is_semver(&manifest.app_version)
        || manifest.dsh_tag.is_empty()
        || !is_semver(&manifest.ui_sdk_version)
        || !is_semver(&manifest.plugin_package_spec_version)
        || !is_safe_positive_integer(manifest.runtime_version)
        || !is_safe_positive_integer(manifest.bridge_protocol_version)
        || !is_safe_nonnegative_integer(manifest.openloop_data_version)
        || !is_safe_nonnegative_integer(manifest.dsh_data_version)
    {
        return Err(
            invalid_data("Openloop core manifest contains an invalid required value").into(),
        );
    }
    Ok(())
}

fn validate_artifact_hashes(
    manifest: &CanonicalArtifactManifest,
) -> Result<(), Box<dyn std::error::Error>> {
    for (label, value) in [
        ("coreManifestSha256", manifest.core_manifest_sha256.as_str()),
        ("sidecar", manifest.artifacts.sidecar.as_str()),
        ("runtimeSbom", manifest.artifacts.runtime_sbom.as_str()),
        ("web", manifest.artifacts.web.as_str()),
        ("bundleGraph", manifest.artifacts.bundle_graph.as_str()),
    ] {
        if !is_lower_hex(value, 64) {
            return Err(invalid_data(format!(
                "Openloop artifact manifest {label} must be 64 lowercase hexadecimal characters"
            ))
            .into());
        }
    }
    for (label, value) in [
        ("app", manifest.artifacts.app.as_deref()),
        ("dmg", manifest.artifacts.dmg.as_deref()),
        ("updater", manifest.artifacts.updater.as_deref()),
        ("ffmpeg", manifest.artifacts.ffmpeg.as_deref()),
        ("ffprobe", manifest.artifacts.ffprobe.as_deref()),
    ] {
        if value.is_some_and(|hash| !is_lower_hex(hash, 64)) {
            return Err(invalid_data(format!(
                "Openloop artifact manifest {label} must be 64 lowercase hexadecimal characters"
            ))
            .into());
        }
    }
    Ok(())
}

fn embed_manifests(
    core_path: &Path,
    artifact_path: &Path,
    out_dir: &Path,
) -> Result<EmbeddedHashes, Box<dyn std::error::Error>> {
    let (core_bytes, core): (Vec<u8>, CanonicalBuildManifest) = read_canonical(core_path, "core")?;
    validate_core(&core)?;
    let (artifact_bytes, artifacts): (Vec<u8>, CanonicalArtifactManifest) =
        read_canonical(artifact_path, "artifact")?;
    validate_artifact_hashes(&artifacts)?;

    let core_sha256 = format!("{:x}", Sha256::digest(&core_bytes));
    if artifacts.core_manifest_sha256 != core_sha256 {
        return Err(invalid_data(format!(
            "Openloop artifact manifest coreManifestSha256 {} does not match exact core bytes {core_sha256}",
            artifacts.core_manifest_sha256
        ))
        .into());
    }

    fs::write(out_dir.join("openloop-core.json"), &core_bytes)?;
    fs::write(out_dir.join("openloop-artifacts.json"), &artifact_bytes)?;
    Ok(EmbeddedHashes {
        core: core_sha256,
        artifact_manifest: format!("{:x}", Sha256::digest(&artifact_bytes)),
        sidecar: artifacts.artifacts.sidecar,
        runtime_sbom: artifacts.artifacts.runtime_sbom,
        web: artifacts.artifacts.web,
        bundle_graph: artifacts.artifacts.bundle_graph,
    })
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let dist = PathBuf::from("../../../dist-openloop/");
    let core_path = dist.join("openloop-core.json");
    let artifact_path = dist.join("openloop-artifacts.json");
    println!("cargo:rerun-if-changed={}", core_path.display());
    println!("cargo:rerun-if-changed={}", artifact_path.display());

    let out_dir = env::var_os("OUT_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| invalid_data("Cargo did not provide OUT_DIR"))?;
    let hashes = embed_manifests(&core_path, &artifact_path, &out_dir)?;
    println!(
        "cargo:rustc-env=OPENLOOP_BUILD_MANIFEST_SHA256={}",
        hashes.core
    );
    println!(
        "cargo:rustc-env=OPENLOOP_CORE_MANIFEST_SHA256={}",
        hashes.core
    );
    println!(
        "cargo:rustc-env=OPENLOOP_ARTIFACT_MANIFEST_SHA256={}",
        hashes.artifact_manifest
    );
    println!("cargo:rustc-env=OPENLOOP_SIDECAR_SHA256={}", hashes.sidecar);
    println!(
        "cargo:rustc-env=OPENLOOP_RUNTIME_SBOM_SHA256={}",
        hashes.runtime_sbom
    );
    println!("cargo:rustc-env=OPENLOOP_WEB_SHA256={}", hashes.web);
    println!(
        "cargo:rustc-env=OPENLOOP_BUNDLE_GRAPH_SHA256={}",
        hashes.bundle_graph
    );
    for variable in [
        "OPENLOOP_UPDATER_PUBLIC_KEY",
        "OPENLOOP_STABLE_UPDATER_PUBLIC_KEY",
    ] {
        println!("cargo:rerun-if-env-changed={variable}");
        let value = env::var(variable).unwrap_or_default();
        if value.contains('\r') || value.contains('\n') {
            return Err(
                invalid_data(format!("{variable} must be a single-line base64 value")).into(),
            );
        }
        println!("cargo:rustc-env={variable}={value}");
    }

    tauri_build::try_build(
        Attributes::new().app_manifest(AppManifest::new().commands(&["build_manifest"])),
    )?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        panic!("Openloop desktop build configuration failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_directory(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must follow Unix epoch")
            .as_nanos();
        let path = env::temp_dir().join(format!(
            "openloop-build-contract-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("temporary directory must be created");
        path
    }

    fn canonical(value: serde_json::Value) -> Vec<u8> {
        format!(
            "{}\n",
            serde_json::to_string_pretty(&value).expect("fixture must serialize")
        )
        .into_bytes()
    }

    fn valid_core_manifest() -> CanonicalBuildManifest {
        CanonicalBuildManifest {
            app_version: "0.1.0".into(),
            channel: "test".into(),
            dsh_tag: "dsh-v0.1.0-rc.7".into(),
            dsh_commit: "99f6f02fecdb7dff40c3fbc9470f5907c29f74ca".into(),
            runtime_version: 1,
            bridge_protocol_version: 1,
            ui_sdk_version: "0.1.0".into(),
            plugin_package_spec_version: "0.1.0".into(),
            openloop_data_version: 0,
            dsh_data_version: 0,
        }
    }

    fn core_bytes() -> Vec<u8> {
        format!(
            "{}\n",
            serde_json::to_string_pretty(&valid_core_manifest()).unwrap()
        )
        .into_bytes()
    }

    fn artifact_bytes_with_core_hash(core_manifest_sha256: String) -> Vec<u8> {
        format!(
            "{}\n",
            serde_json::to_string_pretty(&CanonicalArtifactManifest {
                core_manifest_sha256,
                artifacts: CanonicalArtifacts {
                    sidecar: "1".repeat(64),
                    runtime_sbom: "2".repeat(64),
                    web: "3".repeat(64),
                    bundle_graph: "4".repeat(64),
                    app: None,
                    dmg: None,
                    updater: None,
                    ffmpeg: None,
                    ffprobe: None,
                },
            })
            .unwrap()
        )
        .into_bytes()
    }

    fn artifact_bytes(core: &[u8]) -> Vec<u8> {
        artifact_bytes_with_core_hash(format!("{:x}", Sha256::digest(core)))
    }

    fn write_fixture(root: &Path, core: &[u8], artifacts: &[u8]) -> (PathBuf, PathBuf, PathBuf) {
        let core_path = root.join("openloop-core.json");
        let artifact_path = root.join("openloop-artifacts.json");
        let out_dir = root.join("out");
        fs::create_dir_all(&out_dir).expect("OUT_DIR fixture must be created");
        fs::write(&core_path, core).expect("core fixture must be written");
        fs::write(&artifact_path, artifacts).expect("artifact fixture must be written");
        (core_path, artifact_path, out_dir)
    }

    #[test]
    fn embeds_exact_canonical_manifests_and_returns_required_hashes() {
        let root = temporary_directory("valid");
        let core = core_bytes();
        let artifacts = artifact_bytes(&core);
        let (core_path, artifact_path, out_dir) = write_fixture(&root, &core, &artifacts);

        let hashes = embed_manifests(&core_path, &artifact_path, &out_dir)
            .expect("valid manifests must embed");

        assert_eq!(fs::read(out_dir.join("openloop-core.json")).unwrap(), core);
        assert_eq!(
            fs::read(out_dir.join("openloop-artifacts.json")).unwrap(),
            artifacts
        );
        assert_eq!(hashes.core, format!("{:x}", Sha256::digest(&core)));
        assert_eq!(hashes.sidecar, "1".repeat(64));
        assert_eq!(hashes.runtime_sbom, "2".repeat(64));
        assert_eq!(hashes.web, "3".repeat(64));
        assert_eq!(hashes.bundle_graph, "4".repeat(64));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_noncanonical_unknown_missing_and_mismatched_artifact_manifests() {
        let root = temporary_directory("invalid");
        let core = core_bytes();
        let valid: serde_json::Value = serde_json::from_slice(&artifact_bytes(&core)).unwrap();
        let cases = [
            (b"{\"coreManifestSha256\":\n".to_vec(), "not valid JSON"),
            (
                artifact_bytes_with_core_hash("0".repeat(64)),
                "does not match",
            ),
            (
                canonical(serde_json::json!({
                    "coreManifestSha256": valid["coreManifestSha256"],
                    "artifacts": {
                        "sidecar": "1".repeat(64),
                        "web": "3".repeat(64),
                        "bundleGraph": "4".repeat(64)
                    }
                })),
                "runtimeSbom",
            ),
            (
                canonical(serde_json::json!({
                    "coreManifestSha256": valid["coreManifestSha256"],
                    "artifacts": {
                        "sidecar": "1".repeat(64),
                        "runtimeSbom": "2".repeat(64),
                        "web": "3".repeat(64),
                        "bundleGraph": "4".repeat(64),
                        "secret": "5".repeat(64)
                    }
                })),
                "unknown field",
            ),
        ];

        for (index, (artifacts, expected)) in cases.into_iter().enumerate() {
            let case_root = root.join(index.to_string());
            fs::create_dir_all(&case_root).unwrap();
            let (core_path, artifact_path, out_dir) = write_fixture(&case_root, &core, &artifacts);
            let error = embed_manifests(&core_path, &artifact_path, &out_dir)
                .expect_err("invalid artifact manifest must fail");
            assert!(
                error.to_string().contains(expected),
                "expected {expected:?}, got {error}"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mirrors_typescript_version_contract_boundaries() {
        let mut manifest = valid_core_manifest();
        manifest.app_version = "1.0".into();
        assert!(
            validate_core(&manifest).is_err(),
            "appVersion must be semver"
        );

        let mut manifest = valid_core_manifest();
        manifest.ui_sdk_version = "v0.1.0".into();
        assert!(
            validate_core(&manifest).is_err(),
            "uiSdkVersion must be semver"
        );

        let mut manifest = valid_core_manifest();
        manifest.plugin_package_spec_version = "1.0.0-01".into();
        assert!(
            validate_core(&manifest).is_err(),
            "pluginPackageSpecVersion must reject numeric prerelease leading zeroes"
        );

        let mut manifest = valid_core_manifest();
        manifest.runtime_version = 0;
        assert!(
            validate_core(&manifest).is_err(),
            "runtimeVersion zero is invalid"
        );

        let mut manifest = valid_core_manifest();
        manifest.bridge_protocol_version = 0;
        assert!(
            validate_core(&manifest).is_err(),
            "bridgeProtocolVersion zero is invalid"
        );

        let mut manifest = valid_core_manifest();
        manifest.runtime_version = 9_007_199_254_740_992;
        assert!(
            validate_core(&manifest).is_err(),
            "runtimeVersion above MAX_SAFE_INTEGER is invalid"
        );

        let mut manifest = valid_core_manifest();
        manifest.bridge_protocol_version = 9_007_199_254_740_992;
        assert!(
            validate_core(&manifest).is_err(),
            "bridgeProtocolVersion above MAX_SAFE_INTEGER is invalid"
        );

        let mut manifest = valid_core_manifest();
        manifest.openloop_data_version = 9_007_199_254_740_992;
        assert!(
            validate_core(&manifest).is_err(),
            "openloopDataVersion above MAX_SAFE_INTEGER is invalid"
        );

        let mut manifest = valid_core_manifest();
        manifest.dsh_data_version = 9_007_199_254_740_992;
        assert!(
            validate_core(&manifest).is_err(),
            "dshDataVersion above MAX_SAFE_INTEGER is invalid"
        );

        let mut manifest = valid_core_manifest();
        manifest.app_version = "1.2.3-rc.1+desktop".into();
        manifest.ui_sdk_version = "2.0.0-alpha.7".into();
        manifest.plugin_package_spec_version = "3.4.5-beta.2+plugin".into();
        manifest.openloop_data_version = 0;
        manifest.dsh_data_version = 0;
        assert!(
            validate_core(&manifest).is_ok(),
            "valid semver prereleases and zero data versions must be accepted"
        );
    }
}
