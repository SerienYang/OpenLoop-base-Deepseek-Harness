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

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn embed_build_manifest(
    manifest_path: &Path,
    out_dir: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let bytes = fs::read(manifest_path).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "required Openloop core manifest is missing or unreadable at {}: {error}",
                manifest_path.display()
            ),
        )
    })?;
    let text = std::str::from_utf8(&bytes).map_err(|error| {
        invalid_data(format!(
            "Openloop core manifest at {} is not valid UTF-8: {error}",
            manifest_path.display()
        ))
    })?;
    let manifest: CanonicalBuildManifest = serde_json::from_str(text).map_err(|error| {
        invalid_data(format!(
            "Openloop core manifest at {} is not valid JSON: {error}",
            manifest_path.display()
        ))
    })?;
    let canonical = format!("{}\n", serde_json::to_string_pretty(&manifest)?);
    if bytes != canonical.as_bytes() {
        return Err(invalid_data(format!(
            "Openloop core manifest at {} is not canonical JSON",
            manifest_path.display()
        ))
        .into());
    }

    fs::write(out_dir.join("openloop-core.json"), &bytes)?;
    let sha256 = format!("{:x}", Sha256::digest(canonical.as_bytes()));
    println!("cargo:rustc-env=OPENLOOP_BUILD_MANIFEST_SHA256={sha256}");
    Ok(())
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_path = PathBuf::from("../../../dist-openloop/").join("openloop-core.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());

    let out_dir = env::var_os("OUT_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| invalid_data("Cargo did not provide OUT_DIR"))?;
    embed_build_manifest(&manifest_path, &out_dir)?;

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
