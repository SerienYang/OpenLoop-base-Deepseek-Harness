use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use openloop_desktop_lib::launcher::{
    parse_readiness_line, process_identity_matches, write_launch_secrets_frame, InstanceAction,
    LaunchReadinessExpectation, LaunchSecrets, ProcessIdentity, SingleInstance, StartupError,
    SupervisedChild,
};

fn secrets() -> LaunchSecrets {
    LaunchSecrets::for_test(
        "8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90",
        b"bootstrap-secret".to_vec(),
        b"bridge-secret".to_vec(),
        PathBuf::from("/tmp/openloop-runtime.sock"),
    )
}

#[test]
fn launch_secrets_have_non_debuggable_zeroizing_fields_and_bounded_frame() {
    let value = secrets();
    let debug = format!("{value:?}");
    assert!(!debug.contains("bootstrap-secret"));
    assert!(!debug.contains("bridge-secret"));

    let mut frame = Vec::new();
    write_launch_secrets_frame(&mut frame, &value).expect("frame must encode");
    assert!(frame.len() < 16 * 1024);
    assert!(frame
        .windows(b"bootstrap-secret".len())
        .any(|window| window == b"bootstrap-secret"));
}

#[test]
fn readiness_parser_requires_current_launch_identity_and_exact_build_contract() {
    let expected = LaunchReadinessExpectation {
        launch_id: secrets().launch_id,
        core_manifest_sha256: "a".repeat(64),
    };
    let line = format!(
        r#"{{"type":"openloop.runtime.ready","version":1,"launchId":"{}","profile":"openloop","host":"127.0.0.1","port":43210,"origin":"http://127.0.0.1:43210","coreManifestSha256":"{}","healthSmoke":{{"method":"GET","path":"/","status":200}}}}"#,
        expected.launch_id, expected.core_manifest_sha256,
    );

    let readiness = parse_readiness_line(line.as_bytes(), &expected).expect("readiness must parse");
    assert_eq!(readiness.port, 43210);

    for bad in [
        line.replacen(
            &expected.launch_id.to_string(),
            "7f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90",
            1,
        ),
        line.replacen(&expected.core_manifest_sha256, "short", 1),
        format!("{line}\nextra"),
        format!("{}\n", "x".repeat(17 * 1024)),
    ] {
        assert!(
            parse_readiness_line(bad.as_bytes(), &expected).is_err(),
            "accepted invalid readiness"
        );
    }
}

#[test]
fn stale_child_is_not_killed_by_pid_only() {
    let expected = ProcessIdentity {
        pid: 42,
        start_time: 100,
        executable_sha256: "a".repeat(64),
    };
    let reused_pid = ProcessIdentity {
        pid: 42,
        start_time: 101,
        executable_sha256: "a".repeat(64),
    };
    let replaced_executable = ProcessIdentity {
        pid: 42,
        start_time: 100,
        executable_sha256: "b".repeat(64),
    };

    assert!(process_identity_matches(&expected, &expected));
    assert!(!process_identity_matches(&expected, &reused_pid));
    assert!(!process_identity_matches(&expected, &replaced_executable));
}

#[test]
fn startup_timeout_terminates_only_the_verified_child() {
    let child =
        SupervisedChild::spawn_with_args(Path::new("/bin/sh"), ["-c", "sleep 5"], &secrets())
            .expect("shell child");
    let mut child = child;
    let expected = LaunchReadinessExpectation {
        launch_id: secrets().launch_id,
        core_manifest_sha256: "a".repeat(64),
    };

    assert!(matches!(
        child.wait_readiness(&expected, Duration::from_millis(20)),
        Err(StartupError::Timeout),
    ));
}

#[test]
fn second_instance_forwards_open_request_without_starting_a_sidecar() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos()
        % 1_000_000_000;
    let root = PathBuf::from(format!("/tmp/ol-{suffix}"));
    fs::create_dir(&root).expect("temp directory");
    let socket = root.join("openloop.sock");
    let first = SingleInstance::acquire(&socket).expect("first instance");
    let second = SingleInstance::acquire(&socket).expect("second instance must forward");

    assert!(matches!(second.action(), InstanceAction::Forwarded));
    assert!(matches!(first.action(), InstanceAction::Primary));
    drop(first);
    fs::remove_dir_all(root).expect("remove temp directory");
}
