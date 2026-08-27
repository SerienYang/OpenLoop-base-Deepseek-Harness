use std::{
    error::Error,
    ffi::{CString, OsStr, OsString},
    fmt, fs,
    io::{self, Read},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::process::CommandExt,
        unix::{ffi::OsStrExt, fs::DirBuilderExt},
    },
    path::{Component, Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::{
        mpsc::{self, Receiver, RecvTimeoutError},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    bridge::{
        server::{BridgeHandler, BridgeHandlerError},
        AuthenticatedBridgeDispatcher, BridgeDispatchTables, BridgeListener, BridgeServer,
    },
    launcher::{LaunchReadinessExpectation, LaunchSecrets, SupervisedChild},
};

use super::recovery::{CandidateHealth, HealthStatus};

pub const HEALTH_PROBE_ARGUMENT: &str = "--openloop-update-health-probe";
pub const TEST_PROBE_FAILURE_ENVIRONMENT: &str = "OPENLOOP_UPDATE_SPIKE_PROBE_FAILURE";
pub const MIGRATION_TRANSACTION_ENVIRONMENT: &str = "OPENLOOP_MIGRATION_TRANSACTION_ID";
const MAX_PROBE_OUTPUT: usize = 16 * 1024;
const PROCESS_REAP_GRACE: Duration = Duration::from_millis(100);

struct ProbeDirectory(PathBuf);

impl ProbeDirectory {
    fn create() -> Result<Self, HealthProbeError> {
        let path = std::env::temp_dir().join(format!("ol-health-{}", Uuid::new_v4().simple()));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(|source| {
                HealthProbeError::io("create private health probe directory", source)
            })?;
        Ok(Self(path))
    }
}

impl Drop for ProbeDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HealthProbeReport {
    status: String,
    pub app_version: String,
    pub core_manifest_sha256: String,
    pub migration_transaction_id: Option<Uuid>,
    pub readiness: AppHealthReadiness,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppHealthReadiness {
    pub host: bool,
    pub sidecar: bool,
    pub bridge: bool,
    pub data_version: bool,
    pub main_webview: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MainWebviewHealthAcknowledgement {
    pub launch_id: Uuid,
    pub core_manifest_sha256: String,
    pub openloop_data_version: u64,
    pub dsh_data_version: u64,
}

#[derive(Debug, Clone)]
pub struct MainWebviewHealthExpectation {
    launch_id: Uuid,
    core_manifest_sha256: String,
    openloop_data_version: u64,
    dsh_data_version: u64,
}

impl MainWebviewHealthExpectation {
    pub fn new(
        launch_id: Uuid,
        core_manifest_sha256: impl Into<String>,
        openloop_data_version: u64,
        dsh_data_version: u64,
    ) -> Self {
        Self {
            launch_id,
            core_manifest_sha256: core_manifest_sha256.into(),
            openloop_data_version,
            dsh_data_version,
        }
    }

    pub fn validate(
        &self,
        acknowledgement: &MainWebviewHealthAcknowledgement,
    ) -> Result<(), HealthProbeError> {
        if acknowledgement.launch_id != self.launch_id {
            return Err(HealthProbeError::invalid(
                "main WebView health launch identity does not match",
            ));
        }
        validate_sha256(
            &acknowledgement.core_manifest_sha256,
            "main WebView core manifest identity",
        )?;
        if acknowledgement.core_manifest_sha256 != self.core_manifest_sha256 {
            return Err(HealthProbeError::invalid(
                "main WebView core manifest identity does not match",
            ));
        }
        if acknowledgement.openloop_data_version != self.openloop_data_version
            || acknowledgement.dsh_data_version != self.dsh_data_version
        {
            return Err(HealthProbeError::invalid(
                "main WebView data version identity does not match",
            ));
        }
        Ok(())
    }
}

impl HealthProbeReport {
    pub fn new(
        app_version: impl Into<String>,
        core_manifest_sha256: impl Into<String>,
        migration_transaction_id: Option<Uuid>,
        readiness: AppHealthReadiness,
    ) -> Self {
        Self {
            status: "healthy".to_owned(),
            app_version: app_version.into(),
            core_manifest_sha256: core_manifest_sha256.into(),
            migration_transaction_id,
            readiness,
        }
    }

    pub fn validate_full_health(
        &self,
        expected_version: &str,
        expected_migration_transaction_id: Option<Uuid>,
    ) -> Result<(), HealthProbeError> {
        if self.status != "healthy" || self.app_version != expected_version {
            return Err(HealthProbeError::invalid(
                "candidate Host health report does not match the update version",
            ));
        }
        if self.migration_transaction_id != expected_migration_transaction_id {
            return Err(HealthProbeError::invalid(
                "candidate migration transaction identity does not match",
            ));
        }
        for (label, ready) in [
            ("host", self.readiness.host),
            ("sidecar", self.readiness.sidecar),
            ("bridge", self.readiness.bridge),
            ("dataVersion", self.readiness.data_version),
            ("mainWebview", self.readiness.main_webview),
        ] {
            if !ready {
                return Err(HealthProbeError::invalid(format!(
                    "candidate {label} health is not ready"
                )));
            }
        }
        validate_sha256(
            &self.core_manifest_sha256,
            "candidate Host core manifest identity",
        )
    }

    pub fn set_migration_transaction_id(&mut self, transaction_id: Option<Uuid>) {
        self.migration_transaction_id = transaction_id;
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
    openloop_data_version: u64,
    dsh_data_version: u64,
}

pub struct CandidateWebviewProbe {
    bootstrap_url: String,
    completion: Receiver<()>,
    deadline: Instant,
    app_version: String,
    core_manifest_sha256: String,
    child: SupervisedChild,
    _bridge: BridgeServer,
    _directory: ProbeDirectory,
}

impl CandidateWebviewProbe {
    pub fn bootstrap_url(&self) -> &str {
        &self.bootstrap_url
    }

    pub fn finish(mut self) -> Result<HealthProbeReport, HealthProbeError> {
        let completion = self
            .completion
            .recv_timeout(remaining_health_budget(self.deadline)?)
            .map_err(|error| match error {
                RecvTimeoutError::Timeout => HealthProbeError::TimedOut,
                RecvTimeoutError::Disconnected => {
                    HealthProbeError::invalid("candidate WebView callback channel disconnected")
                }
            });
        let termination = self
            .child
            .terminate_if_verified()
            .map_err(|source| HealthProbeError::invalid(source.to_string()));
        completion?;
        termination?;
        Ok(HealthProbeReport::new(
            &self.app_version,
            &self.core_manifest_sha256,
            None,
            AppHealthReadiness {
                host: true,
                sidecar: true,
                bridge: true,
                data_version: true,
                main_webview: true,
            },
        ))
    }
}

impl Drop for CandidateWebviewProbe {
    fn drop(&mut self) {
        let _ = self.child.terminate_if_verified();
    }
}

impl BundleHealthProbe {
    pub fn new(
        app_version: impl Into<String>,
        bundle_identifier: impl Into<String>,
        core_manifest_sha256: impl Into<String>,
        openloop_data_version: u64,
        dsh_data_version: u64,
    ) -> Self {
        Self {
            app_version: app_version.into(),
            bundle_identifier: bundle_identifier.into(),
            core_manifest_sha256: core_manifest_sha256.into(),
            openloop_data_version,
            dsh_data_version,
        }
    }

    pub fn begin(
        &self,
        app: &Path,
        timeout: Duration,
        dsh_home: &Path,
    ) -> Result<CandidateWebviewProbe, HealthProbeError> {
        let deadline = Instant::now() + timeout;
        validate_dsh_home(dsh_home, None)?;
        require_real_directory(app, "candidate app")?;
        if app.extension() != Some(OsStr::new("app")) {
            return Err(HealthProbeError::invalid(
                "candidate bundle must use the .app extension",
            ));
        }
        verify_bundle_code_signature(app, remaining_health_budget(deadline)?)?;
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
        let probe_directory = ProbeDirectory::create()?;
        let secrets = LaunchSecrets::generate(probe_directory.0.join("bridge.sock"))
            .map_err(|source| HealthProbeError::io("generate health probe secrets", source))?;
        let listener = BridgeListener::bind(&secrets.socket_path)
            .map_err(|source| HealthProbeError::invalid(source.to_string()))?;
        let mut child = SupervisedChild::spawn_with_dsh_home(&sidecar, &secrets, dsh_home)
            .map_err(|source| HealthProbeError::invalid(source.to_string()))?;
        let (completion_sender, completion) = mpsc::sync_channel(1);
        let expectation = MainWebviewHealthExpectation::new(
            secrets.launch_id,
            &self.core_manifest_sha256,
            self.openloop_data_version,
            self.dsh_data_version,
        );
        let handler: BridgeHandler = Arc::new(move |payload, _cancellation| {
            let acknowledgement: MainWebviewHealthAcknowledgement = serde_json::from_value(payload)
                .map_err(|_| BridgeHandlerError::invalid_request())?;
            expectation
                .validate(&acknowledgement)
                .map_err(|_| BridgeHandlerError::invalid_request())?;
            let _ = completion_sender.try_send(());
            Ok(serde_json::Value::Null)
        });
        let mut dispatch_tables = BridgeDispatchTables::unavailable();
        dispatch_tables
            .set_host_handler("acknowledgeMainWebviewHealth", handler)
            .map_err(|source| HealthProbeError::io("configure health bridge", source))?;
        let dispatcher = AuthenticatedBridgeDispatcher::new(
            unsafe { libc::geteuid() },
            child.identity().clone(),
            sidecar,
            secrets.launch_id,
            secrets.bridge_secret.to_vec(),
            dispatch_tables,
        )
        .map_err(|source| HealthProbeError::invalid(source.to_string()))?;
        let bridge = listener
            .serve(dispatcher)
            .map_err(|source| HealthProbeError::invalid(source.to_string()))?;
        let readiness = child
            .wait_readiness(
                &LaunchReadinessExpectation {
                    launch_id: secrets.launch_id,
                    core_manifest_sha256: self.core_manifest_sha256.clone(),
                },
                remaining_health_budget(deadline)?,
            )
            .map_err(|source| HealthProbeError::invalid(source.to_string()))?;
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
        Ok(CandidateWebviewProbe {
            bootstrap_url: format!(
                "{}#bootstrap={}&launch={}",
                readiness.origin,
                secrets.bootstrap_token_hex(),
                secrets.launch_id,
            ),
            completion,
            deadline,
            app_version: self.app_version.clone(),
            core_manifest_sha256: self.core_manifest_sha256.clone(),
            child,
            _bridge: bridge,
            _directory: probe_directory,
        })
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
    dsh_home: PathBuf,
    expected_migration_transaction_id: Option<Uuid>,
}

impl CandidateProcessHealth {
    pub fn new(expected_version: impl Into<String>, dsh_home: impl Into<PathBuf>) -> Self {
        Self {
            expected_version: expected_version.into(),
            dsh_home: dsh_home.into(),
            expected_migration_transaction_id: None,
        }
    }

    pub fn with_migration_transaction(mut self, transaction_id: Option<Uuid>) -> Self {
        self.expected_migration_transaction_id = transaction_id;
        self
    }

    fn run(&self, candidate: &Path, timeout: Duration) -> Result<(), HealthProbeError> {
        let deadline = Instant::now() + timeout;
        validate_dsh_home(&self.dsh_home, None)?;
        require_real_directory(candidate, "published candidate app")?;
        verify_bundle_code_signature(candidate, remaining_health_budget(deadline)?)?;
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
        command
            .arg(HEALTH_PROBE_ARGUMENT)
            .env("DSH_HOME", &self.dsh_home);
        if let Some(transaction_id) = self.expected_migration_transaction_id {
            command.env(
                MIGRATION_TRANSACTION_ENVIRONMENT,
                transaction_id.to_string(),
            );
        } else {
            command.env_remove(MIGRATION_TRANSACTION_ENVIRONMENT);
        }
        let output = bounded_output(command, remaining_health_budget(deadline)?)?;
        validate_success_output(&output, "candidate Host health probe")?;
        let report: HealthProbeReport =
            parse_single_json_line(&output.stdout, "candidate Host health probe")?;
        report.validate_full_health(
            &self.expected_version,
            self.expected_migration_transaction_id,
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

pub fn required_dsh_home(
    value: Option<&OsStr>,
    data_root_name: &str,
) -> Result<PathBuf, HealthProbeError> {
    let path = value
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| HealthProbeError::invalid("candidate Host requires DSH_HOME"))?;
    validate_dsh_home(&path, Some(data_root_name))?;
    Ok(path)
}

pub fn ensure_channel_dsh_home(
    app_data: &Path,
    data_root_name: &str,
) -> Result<PathBuf, HealthProbeError> {
    validate_data_root_name(data_root_name)?;
    let dsh_home = app_data.join(data_root_name).join("dsh");
    open_directory_chain(&dsh_home, true)
        .map_err(|source| HealthProbeError::io("create channel data root", source))?;
    validate_dsh_home(&dsh_home, Some(data_root_name))?;
    Ok(dsh_home)
}

fn validate_dsh_home(path: &Path, data_root_name: Option<&str>) -> Result<(), HealthProbeError> {
    if let Some(name) = data_root_name {
        validate_data_root_name(name)?;
    }
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
        || path.file_name() != Some(OsStr::new("dsh"))
        || data_root_name
            .is_some_and(|name| path.parent().and_then(Path::file_name) != Some(OsStr::new(name)))
    {
        return Err(HealthProbeError::invalid(
            "DSH_HOME must be the absolute channel data root dsh directory",
        ));
    }
    require_real_directory(path, "DSH_HOME")
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
    open_directory_chain(path, false)
        .map(|_| ())
        .map_err(|source| {
            HealthProbeError::invalid(format!(
                "{label} and every ancestor must be real directories: {source}"
            ))
        })
}

fn require_regular_file(
    path: &Path,
    label: &str,
    executable: bool,
) -> Result<(), HealthProbeError> {
    let parent = path
        .parent()
        .ok_or_else(|| HealthProbeError::invalid(format!("{label} has no parent")))?;
    let parent = open_directory_chain(parent, false).map_err(|source| {
        HealthProbeError::invalid(format!(
            "{label} ancestors must be real directories: {source}"
        ))
    })?;
    let name = path
        .file_name()
        .ok_or_else(|| HealthProbeError::invalid(format!("{label} has no file name")))?;
    let name = c_component(name)?;
    // SAFETY: `name` is one NUL-terminated component and `parent` is a retained
    // real directory descriptor. O_NOFOLLOW rejects a symlink leaf.
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        return Err(HealthProbeError::io(
            "open candidate file without following symlinks",
            io::Error::last_os_error(),
        ));
    }
    // SAFETY: `descriptor` was returned as a new owned descriptor.
    let descriptor = unsafe { OwnedFd::from_raw_fd(descriptor) };
    let metadata = descriptor_stat(descriptor.as_raw_fd())
        .map_err(|source| HealthProbeError::io("inspect candidate file", source))?;
    if metadata.st_mode as u32 & libc::S_IFMT as u32 != libc::S_IFREG as u32
        || metadata.st_nlink != 1
        || (executable && metadata.st_mode as u32 & 0o111 == 0)
    {
        return Err(HealthProbeError::invalid(format!(
            "{label} must be a single-link regular{} file",
            if executable { " executable" } else { "" }
        )));
    }
    Ok(())
}

fn validate_data_root_name(value: &str) -> Result<(), HealthProbeError> {
    let mut components = Path::new(value).components();
    if value.is_empty()
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(HealthProbeError::invalid(
            "channel data root name must be one relative component",
        ));
    }
    Ok(())
}

fn open_directory_chain(path: &Path, create: bool) -> io::Result<OwnedFd> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "directory path must be absolute without dot components",
        ));
    }
    let mut anchor = path.to_path_buf();
    let mut suffix = Vec::<OsString>::new();
    for _ in 0..3 {
        let Some(component) = anchor.file_name() else {
            break;
        };
        suffix.push(component.to_owned());
        anchor.pop();
    }
    suffix.reverse();
    let anchor = fs::canonicalize(&anchor)?;
    let anchor = CString::new(anchor.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "directory path contains NUL"))?;
    // SAFETY: anchor is a live NUL-terminated canonical absolute path. The
    // security boundary begins at its three trailing descendants: app_data,
    // channel root, and dsh (or the equivalent candidate bundle chain).
    let descriptor = unsafe {
        libc::open(
            anchor.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `descriptor` was returned as a new owned descriptor.
    let mut parent = unsafe { OwnedFd::from_raw_fd(descriptor) };
    for component in suffix {
        let component = c_component(&component)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
        match open_directory_at(parent.as_raw_fd(), &component) {
            Ok(child) => parent = child,
            Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                // SAFETY: the component is relative to the retained real parent
                // directory. mkdirat is exclusive and never follows a leaf.
                if unsafe { libc::mkdirat(parent.as_raw_fd(), component.as_ptr(), 0o700) } < 0 {
                    let create_error = io::Error::last_os_error();
                    if create_error.kind() != io::ErrorKind::AlreadyExists {
                        return Err(create_error);
                    }
                }
                parent = open_directory_at(parent.as_raw_fd(), &component)?;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(parent)
}

fn open_directory_at(parent: RawFd, name: &CString) -> io::Result<OwnedFd> {
    // SAFETY: `name` is one NUL-terminated component and `parent` is an open
    // real directory descriptor. O_NOFOLLOW rejects a symlink at this step.
    let descriptor = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `descriptor` was returned as a new owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

fn c_component(value: &OsStr) -> Result<CString, HealthProbeError> {
    if value.as_bytes().contains(&b'/') {
        return Err(HealthProbeError::invalid(
            "filesystem component contains a separator",
        ));
    }
    CString::new(value.as_bytes())
        .map_err(|_| HealthProbeError::invalid("filesystem component contains NUL"))
}

fn descriptor_stat(descriptor: RawFd) -> io::Result<libc::stat> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `metadata` points to writable storage and `descriptor` is open.
    if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful fstat initialized the complete stat value.
    Ok(unsafe { metadata.assume_init() })
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

fn remaining_health_budget(deadline: Instant) -> Result<Duration, HealthProbeError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        Err(HealthProbeError::TimedOut)
    } else {
        Ok(remaining)
    }
}

fn verify_bundle_code_signature(app: &Path, timeout: Duration) -> Result<(), HealthProbeError> {
    let mut command = Command::new("/usr/bin/codesign");
    command.args(["--verify", "--deep", "--strict"]).arg(app);
    let output = bounded_output(command, timeout)?;
    if !output.status.success() {
        return Err(HealthProbeError::invalid(format!(
            "candidate app code signature verification failed{}",
            if output.stderr.is_empty() {
                String::new()
            } else {
                format!(": {}", bounded_diagnostic(&output.stderr))
            }
        )));
    }
    Ok(())
}

fn bounded_output(mut command: Command, timeout: Duration) -> Result<Output, HealthProbeError> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|source| HealthProbeError::io("start health probe process", source))?;
    let stdout = child.stdout.take().ok_or_else(|| {
        HealthProbeError::io(
            "capture health probe stdout",
            io::Error::new(io::ErrorKind::BrokenPipe, "stdout pipe is unavailable"),
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        HealthProbeError::io(
            "capture health probe stderr",
            io::Error::new(io::ErrorKind::BrokenPipe, "stderr pipe is unavailable"),
        )
    })?;
    let stdout_reader = spawn_probe_reader(stdout);
    let stderr_reader = spawn_probe_reader(stderr);
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(
                    Duration::from_millis(5)
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
            Ok(None) => {
                let _ = terminate_process_group_with_grace(&mut child);
                return Err(HealthProbeError::TimedOut);
            }
            Err(source) => {
                let error = HealthProbeError::io("wait for health probe process", source);
                let _ = terminate_process_group_with_grace(&mut child);
                return Err(error);
            }
        }
    };
    let stdout = receive_probe_reader(
        &stdout_reader,
        deadline,
        "receive health probe stdout reader",
        &mut child,
    )?;
    let stderr = receive_probe_reader(
        &stderr_reader,
        deadline,
        "receive health probe stderr reader",
        &mut child,
    )?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn spawn_probe_reader(reader: impl Read + Send + 'static) -> Receiver<io::Result<Vec<u8>>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(drain_bounded(reader));
    });
    receiver
}

fn drain_bounded(mut reader: impl Read) -> io::Result<Vec<u8>> {
    let mut retained = Vec::with_capacity(MAX_PROBE_OUTPUT + 1);
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(retained);
        }
        let keep = read.min((MAX_PROBE_OUTPUT + 1).saturating_sub(retained.len()));
        retained.extend_from_slice(&buffer[..keep]);
    }
}

fn receive_probe_reader(
    reader: &Receiver<io::Result<Vec<u8>>>,
    deadline: Instant,
    operation: &'static str,
    child: &mut Child,
) -> Result<Vec<u8>, HealthProbeError> {
    let result = match reader.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => {
            let _ = terminate_process_group_with_grace(child);
            return Err(HealthProbeError::TimedOut);
        }
        Err(RecvTimeoutError::Disconnected) => {
            return Err(HealthProbeError::io(
                operation,
                io::Error::other("reader thread disconnected"),
            ));
        }
    };
    result.map_err(|source| HealthProbeError::io(operation, source))
}

fn terminate_process_group_with_grace(child: &mut Child) -> Result<(), HealthProbeError> {
    let termination = terminate_process_group(child.id());
    let deadline = Instant::now() + PROCESS_REAP_GRACE;
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => break,
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(
                    Duration::from_millis(5)
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
            Ok(None) => break,
        }
    }
    termination
}

fn terminate_process_group(pid: u32) -> Result<(), HealthProbeError> {
    if unsafe { libc::killpg(pid as libc::pid_t, libc::SIGKILL) } == 0 {
        return Ok(());
    }
    let source = io::Error::last_os_error();
    if source.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(HealthProbeError::io(
            "terminate health probe process group",
            source,
        ))
    }
}

fn validate_success_output(output: &Output, label: &str) -> Result<(), HealthProbeError> {
    if output.stdout.len() > MAX_PROBE_OUTPUT {
        return Err(HealthProbeError::invalid(format!(
            "{label} output is oversized"
        )));
    }
    if output.stderr.len() > MAX_PROBE_OUTPUT {
        return Err(HealthProbeError::invalid(format!(
            "{label} stderr is oversized"
        )));
    }
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
