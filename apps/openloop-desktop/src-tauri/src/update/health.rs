use std::{
    error::Error,
    ffi::OsStr,
    fmt, fs, io,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Component, Path},
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use super::recovery::{CandidateHealth, HealthStatus};

pub const HEALTH_PROBE_ARGUMENT: &str = "--openloop-update-health-probe";
pub const TEST_PROBE_FAILURE_ENVIRONMENT: &str = "OPENLOOP_UPDATE_SPIKE_PROBE_FAILURE";
const MAX_PROBE_OUTPUT: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HealthProbeReport {
    status: String,
    pub app_version: String,
    pub core_manifest_sha256: String,
}

impl HealthProbeReport {
    fn healthy(app_version: &str, core_manifest_sha256: &str) -> Self {
        Self {
            status: "healthy".to_owned(),
            app_version: app_version.to_owned(),
            core_manifest_sha256: core_manifest_sha256.to_owned(),
        }
    }

    pub fn to_json_line(&self) -> Result<String, HealthProbeError> {
        serde_json::to_string(self)
            .map(|value| format!("{value}\n"))
            .map_err(|source| HealthProbeError::json("serialize health probe report", source))
    }
}

#[derive(Debug, Clone)]
pub struct BundleHealthProbe {
    app_version: String,
    bundle_identifier: String,
    core_manifest_sha256: String,
}

impl BundleHealthProbe {
    pub fn new(
        app_version: impl Into<String>,
        bundle_identifier: impl Into<String>,
        core_manifest_sha256: impl Into<String>,
    ) -> Self {
        Self {
            app_version: app_version.into(),
            bundle_identifier: bundle_identifier.into(),
            core_manifest_sha256: core_manifest_sha256.into(),
        }
    }

    pub fn inspect(
        &self,
        app: &Path,
        timeout: Duration,
    ) -> Result<HealthProbeReport, HealthProbeError> {
        require_real_directory(app, "candidate app")?;
        if app.extension() != Some(OsStr::new("app")) {
            return Err(HealthProbeError::invalid(
                "candidate bundle must use the .app extension",
            ));
        }
        let contents = app.join("Contents");
        let macos = contents.join("MacOS");
        require_real_directory(&contents, "candidate Contents")?;
        require_real_directory(&macos, "candidate MacOS")?;
        let info_plist = contents.join("Info.plist");
        require_regular_file(&info_plist, "candidate Info.plist", false)?;

        let executable_name = plist_value(&info_plist, "CFBundleExecutable")?;
        validate_file_name(&executable_name, "CFBundleExecutable")?;
        for (key, expected) in [
            ("CFBundleIdentifier", self.bundle_identifier.as_str()),
            ("CFBundleShortVersionString", self.app_version.as_str()),
            ("CFBundleVersion", self.app_version.as_str()),
        ] {
            let actual = plist_value(&info_plist, key)?;
            if actual != expected {
                return Err(HealthProbeError::invalid(format!(
                    "candidate Info.plist {key} does not match embedded build identity"
                )));
            }
        }
        let main_executable = macos.join(&executable_name);
        require_regular_file(&main_executable, "candidate main executable", true)?;

        let sidecar = macos.join("openloop-runtime");
        require_regular_file(&sidecar, "candidate runtime sidecar", true)?;
        let mut command = Command::new(&sidecar);
        command.arg("--health-smoke");
        let output = bounded_output(command, timeout)?;
        validate_success_output(&output, "runtime sidecar health smoke")?;
        let readiness: RuntimeHealthSmoke =
            parse_single_json_line(&output.stdout, "runtime sidecar health smoke")?;
        if readiness.message_type != "openloop.runtime.ready"
            || readiness.version != 1
            || readiness.profile != "openloop"
            || readiness.host != "127.0.0.1"
            || readiness.port == 0
            || readiness.origin != format!("http://127.0.0.1:{}", readiness.port)
            || readiness.core_manifest_sha256 != self.core_manifest_sha256
            || readiness.health_smoke.method != "GET"
            || readiness.health_smoke.path != "/"
            || readiness.health_smoke.status != 200
        {
            return Err(HealthProbeError::invalid(
                "runtime sidecar health smoke does not match candidate core identity",
            ));
        }
        validate_sha256(
            &readiness.core_manifest_sha256,
            "runtime sidecar core manifest identity",
        )?;
        Ok(HealthProbeReport::healthy(
            &self.app_version,
            &self.core_manifest_sha256,
        ))
    }

    pub fn test_failure_injection(
        &self,
        channel: &str,
        value: Option<&str>,
    ) -> Result<bool, HealthProbeError> {
        match value {
            None => Ok(false),
            Some("1") if channel == "test" => Ok(true),
            Some("1") => Err(HealthProbeError::invalid(
                "health probe failure injection is forbidden outside the test channel",
            )),
            Some(_) => Err(HealthProbeError::invalid(format!(
                "{TEST_PROBE_FAILURE_ENVIRONMENT} must be exactly 1 when set"
            ))),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CandidateProcessHealth {
    expected_version: String,
}

impl CandidateProcessHealth {
    pub fn new(expected_version: impl Into<String>) -> Self {
        Self {
            expected_version: expected_version.into(),
        }
    }

    fn run(&self, candidate: &Path, timeout: Duration) -> Result<(), HealthProbeError> {
        require_real_directory(candidate, "published candidate app")?;
        let contents = candidate.join("Contents");
        let macos = contents.join("MacOS");
        require_real_directory(&contents, "published candidate Contents")?;
        require_real_directory(&macos, "published candidate MacOS")?;
        let info_plist = contents.join("Info.plist");
        require_regular_file(&info_plist, "published candidate Info.plist", false)?;
        let executable_name = plist_value(&info_plist, "CFBundleExecutable")?;
        validate_file_name(&executable_name, "CFBundleExecutable")?;
        let executable = macos.join(executable_name);
        require_regular_file(&executable, "published candidate main executable", true)?;

        let mut command = Command::new(executable);
        command.arg(HEALTH_PROBE_ARGUMENT);
        let output = bounded_output(command, timeout)?;
        validate_success_output(&output, "candidate Host health probe")?;
        let report: HealthProbeReport =
            parse_single_json_line(&output.stdout, "candidate Host health probe")?;
        if report.status != "healthy" || report.app_version != self.expected_version {
            return Err(HealthProbeError::invalid(
                "candidate Host health report does not match the update version",
            ));
        }
        validate_sha256(
            &report.core_manifest_sha256,
            "candidate Host core manifest identity",
        )
    }
}

impl CandidateHealth for CandidateProcessHealth {
    fn await_health(&mut self, candidate: &Path, timeout: Duration) -> HealthStatus {
        match self.run(candidate, timeout) {
            Ok(()) => HealthStatus::Healthy,
            Err(HealthProbeError::TimedOut) => HealthStatus::TimedOut,
            Err(error) => HealthStatus::Failed(error.to_string()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeHealthSmoke {
    #[serde(rename = "type")]
    message_type: String,
    version: u8,
    profile: String,
    host: String,
    port: u16,
    origin: String,
    core_manifest_sha256: String,
    health_smoke: RuntimeHealthRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeHealthRequest {
    method: String,
    path: String,
    status: u16,
}

fn validate_file_name(value: &str, label: &str) -> Result<(), HealthProbeError> {
    let path = Path::new(value);
    let mut components = path.components();
    if value.is_empty()
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(HealthProbeError::invalid(format!(
            "{label} must be one relative file name"
        )));
    }
    Ok(())
}

fn require_real_directory(path: &Path, label: &str) -> Result<(), HealthProbeError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|source| HealthProbeError::io("inspect candidate directory", source))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(HealthProbeError::invalid(format!(
            "{label} must be a real directory"
        )));
    }
    Ok(())
}

fn require_regular_file(
    path: &Path,
    label: &str,
    executable: bool,
) -> Result<(), HealthProbeError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|source| HealthProbeError::io("inspect candidate file", source))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.nlink() != 1
        || (executable && metadata.permissions().mode() & 0o111 == 0)
    {
        return Err(HealthProbeError::invalid(format!(
            "{label} must be a single-link regular{} file",
            if executable { " executable" } else { "" }
        )));
    }
    Ok(())
}

fn plist_value(path: &Path, key: &str) -> Result<String, HealthProbeError> {
    let output = Command::new("/usr/bin/plutil")
        .args(["-extract", key, "raw", "-o", "-"])
        .arg(path)
        .output()
        .map_err(|source| HealthProbeError::io("run plutil", source))?;
    if !output.status.success() || !output.stderr.is_empty() {
        return Err(HealthProbeError::invalid(format!(
            "candidate Info.plist is missing valid {key}"
        )));
    }
    let value = std::str::from_utf8(&output.stdout)
        .map_err(|source| HealthProbeError::utf8("read Info.plist value", source))?
        .strip_suffix('\n')
        .unwrap_or_else(|| std::str::from_utf8(&output.stdout).expect("already validated UTF-8"));
    if value.is_empty() || value.contains('\r') || value.contains('\n') {
        return Err(HealthProbeError::invalid(format!(
            "candidate Info.plist {key} must be one non-empty line"
        )));
    }
    Ok(value.to_owned())
}

fn bounded_output(mut command: Command, timeout: Duration) -> Result<Output, HealthProbeError> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|source| HealthProbeError::io("start health probe process", source))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child
            .try_wait()
            .map_err(|source| HealthProbeError::io("wait for health probe process", source))?
        {
            Some(_) => {
                return child
                    .wait_with_output()
                    .map_err(|source| HealthProbeError::io("collect health probe output", source));
            }
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(HealthProbeError::TimedOut);
            }
            None => thread::sleep(Duration::from_millis(5)),
        }
    }
}

fn validate_success_output(output: &Output, label: &str) -> Result<(), HealthProbeError> {
    if !output.status.success() {
        let stderr = bounded_diagnostic(&output.stderr);
        return Err(HealthProbeError::invalid(format!(
            "{label} exited with status {}{}",
            output.status,
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {stderr}")
            }
        )));
    }
    if !output.stderr.is_empty() {
        return Err(HealthProbeError::invalid(format!(
            "{label} wrote unexpected stderr"
        )));
    }
    if output.stdout.len() > MAX_PROBE_OUTPUT {
        return Err(HealthProbeError::invalid(format!(
            "{label} output is oversized"
        )));
    }
    Ok(())
}

fn bounded_diagnostic(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(512)])
        .trim()
        .to_owned()
}

fn parse_single_json_line<T: for<'de> Deserialize<'de>>(
    bytes: &[u8],
    label: &str,
) -> Result<T, HealthProbeError> {
    if bytes.is_empty() || bytes.len() > MAX_PROBE_OUTPUT || !bytes.ends_with(b"\n") {
        return Err(HealthProbeError::invalid(format!(
            "{label} must emit exactly one JSON line"
        )));
    }
    let line = &bytes[..bytes.len() - 1];
    if line.is_empty() || line.contains(&b'\n') || line.contains(&b'\r') {
        return Err(HealthProbeError::invalid(format!(
            "{label} must emit exactly one JSON line"
        )));
    }
    serde_json::from_slice(line)
        .map_err(|source| HealthProbeError::json("parse health probe JSON", source))
}

fn validate_sha256(value: &str, label: &str) -> Result<(), HealthProbeError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(HealthProbeError::invalid(format!(
            "{label} must be a lowercase SHA-256"
        )));
    }
    Ok(())
}

#[derive(Debug)]
pub enum HealthProbeError {
    Invalid(String),
    Io {
        operation: &'static str,
        source: io::Error,
    },
    Json {
        operation: &'static str,
        source: serde_json::Error,
    },
    Utf8 {
        operation: &'static str,
        source: std::str::Utf8Error,
    },
    TimedOut,
}

impl HealthProbeError {
    fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(message.into())
    }

    fn io(operation: &'static str, source: io::Error) -> Self {
        Self::Io { operation, source }
    }

    fn json(operation: &'static str, source: serde_json::Error) -> Self {
        Self::Json { operation, source }
    }

    fn utf8(operation: &'static str, source: std::str::Utf8Error) -> Self {
        Self::Utf8 { operation, source }
    }
}

impl fmt::Display for HealthProbeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => formatter.write_str(message),
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
            Self::Json { operation, source } => write!(formatter, "{operation} failed: {source}"),
            Self::Utf8 { operation, source } => write!(formatter, "{operation} failed: {source}"),
            Self::TimedOut => formatter.write_str("health probe timed out"),
        }
    }
}

impl Error for HealthProbeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Invalid(_) | Self::TimedOut => None,
            Self::Io { source, .. } => Some(source),
            Self::Json { source, .. } => Some(source),
            Self::Utf8 { source, .. } => Some(source),
        }
    }
}
