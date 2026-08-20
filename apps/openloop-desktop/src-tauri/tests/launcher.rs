use std::{
    ffi::OsString,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
fn dropping_a_stale_supervised_child_is_bounded_without_killing_by_pid() {
    let fixture = tempfile::tempdir().expect("temporary executable root");
    let executable = fixture.path().join("runtime");
    fs::write(&executable, "#!/bin/sh\nsleep 5\n").expect("runtime script");
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
        .expect("runtime permissions");
    let child = SupervisedChild::spawn(&executable, &secrets()).expect("supervised child");
    let pid = child.identity().pid;
    let replacement = fixture.path().join("replacement");
    fs::write(&replacement, "#!/bin/sh\nexit 0\n").expect("replacement script");
    fs::set_permissions(&replacement, fs::Permissions::from_mode(0o755))
        .expect("replacement permissions");
    fs::rename(&replacement, &executable).expect("replace executable path");

    let started = Instant::now();
    drop(child);
    let elapsed = started.elapsed();

    let kill_result = unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
    if kill_result == 0 {
        let mut status = 0;
        let waited = unsafe { libc::waitpid(pid as libc::pid_t, &mut status, 0) };
        assert_eq!(waited, pid as libc::pid_t, "reap stale test child");
    } else {
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH),
            "unexpected stale test child cleanup failure"
        );
    }
    assert!(
        elapsed < Duration::from_millis(750),
        "stale child Drop blocked for {elapsed:?}"
    );
}

#[test]
fn supervised_child_passes_only_the_exact_dsh_home_override() {
    let fixture = tempfile::tempdir().expect("temporary child output");
    let dsh_home = fixture.path().join("Openloop-Test").join("dsh");
    let dsh_home_output = fixture.path().join("dsh-home");
    let environment_output = fixture.path().join("environment");
    let args = vec![
        OsString::from("-c"),
        OsString::from("printf '%s' \"$DSH_HOME\" > \"$1\"; /usr/bin/env > \"$2\""),
        OsString::from("openloop-environment-probe"),
        dsh_home_output.as_os_str().to_owned(),
        environment_output.as_os_str().to_owned(),
    ];

    let mut child = SupervisedChild::spawn_with_args_and_dsh_home(
        Path::new("/bin/sh"),
        args,
        &secrets(),
        &dsh_home,
    )
    .expect("shell child with DSH_HOME");
    let status = (0..100)
        .find_map(|_| match child.try_wait().expect("poll shell child") {
            Some(status) => Some(status),
            None => {
                thread::sleep(Duration::from_millis(10));
                None
            }
        })
        .expect("shell child must exit");

    assert!(status.success());
    assert_eq!(
        fs::read_to_string(dsh_home_output).expect("DSH_HOME output"),
        dsh_home.to_str().expect("UTF-8 temporary path"),
    );
    let environment = fs::read_to_string(environment_output).expect("child environment");
    assert!(!environment.contains("bootstrap-secret"));
    assert!(!environment.contains("bridge-secret"));
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
