use std::{
    ffi::OsString,
    fs,
    os::unix::fs::{symlink, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

use openloop_desktop_lib::update::{
    coordinator::{parse_host_action, HostAction},
    health::{
        ensure_channel_dsh_home, required_dsh_home, BundleHealthProbe, CandidateProcessHealth,
        HEALTH_PROBE_ARGUMENT, TEST_PROBE_FAILURE_ENVIRONMENT,
    },
    recovery::{CandidateHealth, HealthStatus},
};
use tempfile::tempdir;

const VERSION: &str = "1.2.3-test.4";
const IDENTIFIER: &str = "ai.openloop.desktop.test";
const CORE_SHA256: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
static PROCESS_HEALTH_TEST_LOCK: Mutex<()> = Mutex::new(());

fn lock_process_health_tests() -> MutexGuard<'static, ()> {
    PROCESS_HEALTH_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn executable(path: &Path, script: &str) {
    fs::write(path, script).expect("write executable fixture");
    let mut permissions = fs::metadata(path).expect("fixture metadata").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).expect("fixture permissions");
}

fn info_plist(executable_name: &str, version: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>{executable_name}</string>
<key>CFBundleIdentifier</key><string>{IDENTIFIER}</string>
<key>CFBundleShortVersionString</key><string>{version}</string>
<key>CFBundleVersion</key><string>{version}</string>
</dict></plist>
"#
    )
}

fn app_bundle(main_script: &str, sidecar_script: &str) -> (tempfile::TempDir, PathBuf) {
    let root = tempdir().expect("fixture root");
    let app = root.path().join("Openloop.app");
    let macos = app.join("Contents/MacOS");
    fs::create_dir_all(&macos).expect("app MacOS directory");
    fs::write(
        app.join("Contents/Info.plist"),
        info_plist("openloop-desktop", VERSION),
    )
    .expect("Info.plist");
    executable(&macos.join("openloop-desktop"), main_script);
    executable(&macos.join("openloop-runtime"), sidecar_script);
    let signed = Command::new("/usr/bin/codesign")
        .args(["--force", "--deep", "--sign", "-"])
        .arg(&app)
        .output()
        .expect("sign fixture app");
    assert!(
        signed.status.success(),
        "fixture codesign failed: {}",
        String::from_utf8_lossy(&signed.stderr)
    );
    (root, app)
}

fn healthy_probe_report() -> String {
    format!(
        "{{\"status\":\"healthy\",\"appVersion\":\"{VERSION}\",\"coreManifestSha256\":\"{CORE_SHA256}\"}}"
    )
}

fn healthy_runtime_readiness() -> String {
    format!(
        "{{\"type\":\"openloop.runtime.ready\",\"version\":1,\"profile\":\"openloop\",\"host\":\"127.0.0.1\",\"port\":43123,\"origin\":\"http://127.0.0.1:43123\",\"coreManifestSha256\":\"{CORE_SHA256}\",\"healthSmoke\":{{\"method\":\"GET\",\"path\":\"/\",\"status\":200}}}}"
    )
}

#[test]
fn accepts_only_exact_private_host_update_arguments() {
    assert_eq!(parse_host_action(&[]).expect("normal"), HostAction::Normal);
    assert_eq!(
        parse_host_action(&[OsString::from("--openloop-update-spike=check")]).expect("check"),
        HostAction::Check
    );
    assert_eq!(
        parse_host_action(&[OsString::from("--openloop-update-spike=install")]).expect("install"),
        HostAction::Install
    );
    assert_eq!(
        parse_host_action(&[OsString::from(HEALTH_PROBE_ARGUMENT)]).expect("health"),
        HostAction::HealthProbe
    );
    assert_eq!(
        parse_host_action(&[OsString::from("--ordinary-tauri-argument")]).expect("ordinary"),
        HostAction::Normal
    );

    for args in [
        vec![OsString::from("--openloop-update")],
        vec![OsString::from("--openloop-update-spike")],
        vec![OsString::from("--openloop-update-spike=unknown")],
        vec![
            OsString::from("--openloop-update-spike=check"),
            OsString::from("extra"),
        ],
        vec![
            OsString::from(HEALTH_PROBE_ARGUMENT),
            OsString::from("extra"),
        ],
        vec![OsString::from("--openloop-update-health-probe=1")],
    ] {
        assert!(
            parse_host_action(&args).is_err(),
            "accepted private update arguments {args:?}"
        );
    }
}

#[test]
fn self_probe_validates_info_plist_and_bundled_sidecar_core_identity() {
    let dsh_home_root = tempdir().expect("DSH_HOME root");
    let dsh_home = dsh_home_root.path().join("Openloop-Test/dsh");
    fs::create_dir_all(&dsh_home).expect("DSH_HOME");
    let sidecar = format!(
        "#!/bin/sh\n[ \"$#\" -eq 1 ] && [ \"$1\" = \"--health-smoke\" ] || exit 91\n[ \"$DSH_HOME\" = '{}' ] || exit 92\nprintf '%s\\n' '{}'\n",
        dsh_home.display(),
        healthy_runtime_readiness()
    );
    let (_root, app) = app_bundle("#!/bin/sh\nexit 0\n", &sidecar);
    let probe = BundleHealthProbe::new(VERSION, IDENTIFIER, CORE_SHA256);

    let report = probe
        .inspect(&app, PROBE_TIMEOUT, &dsh_home)
        .expect("valid candidate bundle health");

    assert_eq!(report.app_version, VERSION);
    assert_eq!(report.core_manifest_sha256, CORE_SHA256);

    fs::write(
        app.join("Contents/Info.plist"),
        info_plist("openloop-desktop", "9.9.9"),
    )
    .expect("replace Info.plist");
    assert!(
        probe.inspect(&app, PROBE_TIMEOUT, &dsh_home).is_err(),
        "mismatched build version passed health"
    );

    fs::write(
        app.join("Contents/Info.plist"),
        info_plist("openloop-desktop", VERSION),
    )
    .expect("restore Info.plist");
    let wrong_core = sidecar.replace(CORE_SHA256, &"b".repeat(64));
    executable(&app.join("Contents/MacOS/openloop-runtime"), &wrong_core);
    assert!(
        probe.inspect(&app, PROBE_TIMEOUT, &dsh_home).is_err(),
        "mismatched sidecar core identity passed health"
    );
}

#[test]
fn candidate_process_health_reports_success_failure_and_timeout() {
    let _guard = lock_process_health_tests();
    let dsh_home_root = tempdir().expect("DSH_HOME root");
    let dsh_home = dsh_home_root.path().join("Openloop-Test/dsh");
    fs::create_dir_all(&dsh_home).expect("DSH_HOME");
    let success = format!(
        "#!/bin/sh\n[ \"$#\" -eq 1 ] && [ \"$1\" = \"{HEALTH_PROBE_ARGUMENT}\" ] || exit 91\n[ \"$DSH_HOME\" = '{}' ] || exit 92\nprintf '%s\\n' '{}'\n",
        dsh_home.display(),
        healthy_probe_report()
    );
    let (_success_root, success_app) = app_bundle(&success, "#!/bin/sh\nexit 0\n");
    let mut health = CandidateProcessHealth::new(VERSION, &dsh_home);
    assert_eq!(
        health.await_health(&success_app, PROBE_TIMEOUT),
        HealthStatus::Healthy
    );

    fs::write(
        success_app.join("Contents/MacOS/openloop-desktop"),
        "#!/bin/sh\nexit 0\n# tampered after signing\n",
    )
    .expect("tamper signed candidate Host");
    let mut tampered_health = CandidateProcessHealth::new(VERSION, &dsh_home);
    let tampered = tampered_health.await_health(&success_app, PROBE_TIMEOUT);
    assert!(
        matches!(tampered, HealthStatus::Failed(ref message) if message.contains("code signature")),
        "tampered candidate Host was not rejected: {tampered:?}"
    );

    let failure = format!(
        "#!/bin/sh\n[ \"$1\" = \"{HEALTH_PROBE_ARGUMENT}\" ] || exit 91\nprintf 'probe failed\\n' >&2\nexit 7\n"
    );
    let (_failure_root, failure_app) = app_bundle(&failure, "#!/bin/sh\nexit 0\n");
    let mut health = CandidateProcessHealth::new(VERSION, &dsh_home);
    let status = health.await_health(&failure_app, PROBE_TIMEOUT);
    assert!(
        matches!(status, HealthStatus::Failed(ref message) if message.contains("status") || message.contains("failed")),
        "unexpected failed status: {status:?}"
    );

    let timeout_marker = tempdir().expect("timeout marker root");
    let marker = timeout_marker.path().join("descendant-survived");
    let timeout = format!(
        "#!/bin/sh\n[ \"$1\" = \"{HEALTH_PROBE_ARGUMENT}\" ] || exit 91\nnohup sh -c \"sleep 0.2; touch '{}'\" >/dev/null 2>&1 &\nwait\n",
        marker.display()
    );
    let (_timeout_root, timeout_app) = app_bundle(&timeout, "#!/bin/sh\nexit 0\n");
    let mut health = CandidateProcessHealth::new(VERSION, &dsh_home);
    assert_eq!(
        health.await_health(&timeout_app, Duration::from_millis(30)),
        HealthStatus::TimedOut
    );
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        !marker.exists(),
        "timed-out Host probe left its descendant running"
    );
}

#[test]
fn candidate_process_health_times_out_when_a_detached_descendant_holds_the_pipes() {
    let _guard = lock_process_health_tests();
    let dsh_home_root = tempdir().expect("DSH_HOME root");
    let dsh_home = dsh_home_root.path().join("Openloop-Test/dsh");
    fs::create_dir_all(&dsh_home).expect("DSH_HOME");
    let marker_root = tempdir().expect("detached helper marker root");
    let marker = marker_root.path().join("ready");
    let script = format!(
        "#!/bin/sh\n[ \"$1\" = \"{HEALTH_PROBE_ARGUMENT}\" ] || exit 91\n/usr/bin/python3 -c 'import os, sys, time; pid = os.fork(); os._exit(0) if pid else None; os.setsid(); open(sys.argv[1], \"w\").close(); os.write(1, b\"x\"); time.sleep(5)' '{}' &\nwhile [ ! -f '{}' ]; do sleep 0.01; done\nexit 0\n",
        marker.display(),
        marker.display()
    );
    let (_root, app) = app_bundle(&script, "#!/bin/sh\nexit 0\n");
    let mut health = CandidateProcessHealth::new(VERSION, &dsh_home);
    let started = Instant::now();

    let status = health.await_health(&app, Duration::from_secs(2));

    assert_eq!(status, HealthStatus::TimedOut);
    assert!(marker.exists(), "setsid pipe holder did not start");
    assert!(
        started.elapsed() < Duration::from_millis(2_500),
        "health timeout exceeded its hard bound: {:?}",
        started.elapsed()
    );
}

#[test]
fn candidate_process_health_drains_oversized_stdout_without_timing_out() {
    let _guard = lock_process_health_tests();
    let dsh_home_root = tempdir().expect("DSH_HOME root");
    let dsh_home = dsh_home_root.path().join("Openloop-Test/dsh");
    fs::create_dir_all(&dsh_home).expect("DSH_HOME");
    let script = format!(
        "#!/bin/sh\n[ \"$1\" = \"{HEALTH_PROBE_ARGUMENT}\" ] || exit 91\n/usr/bin/awk 'BEGIN {{ for (i = 0; i < 16384; i++) printf \"0123456789abcdef\" }}'\n"
    );
    let (_root, app) = app_bundle(&script, "#!/bin/sh\nexit 0\n");
    let mut health = CandidateProcessHealth::new(VERSION, &dsh_home);

    let status = health.await_health(&app, PROBE_TIMEOUT);

    assert!(
        matches!(status, HealthStatus::Failed(ref message) if message.contains("oversized")),
        "oversized stdout was not reported before timeout: {status:?}"
    );
}

#[test]
fn candidate_process_health_drains_oversized_stderr_without_timing_out() {
    let _guard = lock_process_health_tests();
    let dsh_home_root = tempdir().expect("DSH_HOME root");
    let dsh_home = dsh_home_root.path().join("Openloop-Test/dsh");
    fs::create_dir_all(&dsh_home).expect("DSH_HOME");
    let script = format!(
        "#!/bin/sh\n[ \"$1\" = \"{HEALTH_PROBE_ARGUMENT}\" ] || exit 91\n/usr/bin/awk 'BEGIN {{ for (i = 0; i < 16384; i++) printf \"0123456789abcdef\" }}' >&2\n"
    );
    let (_root, app) = app_bundle(&script, "#!/bin/sh\nexit 0\n");
    let mut health = CandidateProcessHealth::new(VERSION, &dsh_home);

    let status = health.await_health(&app, PROBE_TIMEOUT);

    assert!(
        matches!(status, HealthStatus::Failed(ref message) if message.contains("oversized")),
        "oversized stderr was not reported before timeout: {status:?}"
    );
}

#[test]
fn candidate_host_requires_a_channel_specific_dsh_home() {
    let root = tempdir().expect("app data");
    let test = root.path().join("Openloop-Test/dsh");
    let stable = root.path().join("Openloop/dsh");
    fs::create_dir_all(&test).expect("test DSH_HOME");
    fs::create_dir_all(&stable).expect("stable DSH_HOME");

    assert_eq!(
        required_dsh_home(Some(test.as_os_str()), "Openloop-Test").expect("test DSH_HOME"),
        test
    );
    assert_eq!(
        required_dsh_home(Some(stable.as_os_str()), "Openloop").expect("stable DSH_HOME"),
        stable
    );
    assert_ne!(test, stable);
    assert!(required_dsh_home(None, "Openloop-Test").is_err());
    assert!(required_dsh_home(Some(stable.as_os_str()), "Openloop-Test").is_err());
    assert!(required_dsh_home(
        Some(Path::new("Openloop-Test/dsh").as_os_str()),
        "Openloop-Test"
    )
    .is_err());
}

#[test]
fn channel_data_root_creation_rejects_shared_symlinks_and_keeps_roots_distinct() {
    let root = tempdir().expect("fixture root");
    let app_data = root.path().join("app-data");
    fs::create_dir(&app_data).expect("app data");

    let test = ensure_channel_dsh_home(&app_data, "Openloop-Test").expect("test data root");
    let stable = ensure_channel_dsh_home(&app_data, "Openloop").expect("stable data root");
    let test_metadata = fs::metadata(&test).expect("test root metadata");
    let stable_metadata = fs::metadata(&stable).expect("stable root metadata");

    assert_ne!(
        fs::canonicalize(&test).expect("canonical test root"),
        fs::canonicalize(&stable).expect("canonical stable root")
    );
    assert_ne!(
        (test_metadata.dev(), test_metadata.ino()),
        (stable_metadata.dev(), stable_metadata.ino())
    );

    let linked_app_data = root.path().join("linked-app-data");
    let shared = root.path().join("shared");
    fs::create_dir(&linked_app_data).expect("linked app data");
    fs::create_dir_all(shared.join("dsh")).expect("shared dsh");
    symlink(&shared, linked_app_data.join("Openloop-Test")).expect("test shared symlink");
    symlink(&shared, linked_app_data.join("Openloop")).expect("stable shared symlink");

    assert!(ensure_channel_dsh_home(&linked_app_data, "Openloop-Test").is_err());
    assert!(ensure_channel_dsh_home(&linked_app_data, "Openloop").is_err());
    assert!(required_dsh_home(
        Some(linked_app_data.join("Openloop-Test/dsh").as_os_str()),
        "Openloop-Test"
    )
    .is_err());
    assert!(required_dsh_home(
        Some(linked_app_data.join("Openloop/dsh").as_os_str()),
        "Openloop"
    )
    .is_err());
}

#[test]
fn candidate_health_rejects_an_app_reached_through_a_symlink_ancestor() {
    let dsh_home_root = tempdir().expect("DSH_HOME root");
    let dsh_home = dsh_home_root.path().join("Openloop-Test/dsh");
    fs::create_dir_all(&dsh_home).expect("DSH_HOME");
    let sidecar = format!(
        "#!/bin/sh\nprintf '%s\\n' '{}'\n",
        healthy_runtime_readiness()
    );
    let (app_root, app) = app_bundle("#!/bin/sh\nexit 0\n", &sidecar);
    let alias = dsh_home_root.path().join("candidate-alias");
    symlink(app_root.path(), &alias).expect("candidate ancestor symlink");
    let aliased_app = alias.join(app.file_name().expect("app name"));
    let probe = BundleHealthProbe::new(VERSION, IDENTIFIER, CORE_SHA256);

    assert!(
        probe
            .inspect(&aliased_app, PROBE_TIMEOUT, &dsh_home)
            .is_err(),
        "candidate path with a symlink ancestor passed bundle health"
    );

    let mut process_health = CandidateProcessHealth::new(VERSION, &dsh_home);
    assert!(
        matches!(
            process_health.await_health(&aliased_app, PROBE_TIMEOUT),
            HealthStatus::Failed(_)
        ),
        "candidate path with a symlink ancestor passed process health"
    );
}

#[test]
fn probe_failure_injection_is_test_channel_private_mode_only() {
    let probe = BundleHealthProbe::new(VERSION, IDENTIFIER, CORE_SHA256);

    assert!(probe
        .test_failure_injection("test", Some("1"))
        .expect("test channel injection"));
    assert!(!probe
        .test_failure_injection("test", None)
        .expect("missing injection"));
    assert!(
        probe.test_failure_injection("stable", Some("1")).is_err(),
        "stable channel accepted health failure injection"
    );
    assert!(
        probe
            .test_failure_injection("test", Some("unknown"))
            .is_err(),
        "unknown health failure injection value was ignored"
    );
    assert_eq!(
        TEST_PROBE_FAILURE_ENVIRONMENT,
        "OPENLOOP_UPDATE_SPIKE_PROBE_FAILURE"
    );
}
