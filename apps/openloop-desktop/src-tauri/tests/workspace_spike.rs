use std::{ffi::OsStr, fs, os::unix::fs::symlink, path::Path, process::Output};

use openloop_desktop_lib::spikes::{seatbelt::SeatbeltProfile, workspace::WorkspaceRoot};
use tempfile::tempdir;

fn assert_success(output: &Output, operation: &str) {
    assert!(
        output.status.success(),
        "{operation} failed with {:?}\nstdout:\n{}\nstderr:\n{}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

#[test]
fn workspace_root_allows_descriptor_relative_reads_and_writes() {
    let fixture = tempdir().expect("temp root");
    let workspace_path = fixture.path().join("workspace");
    fs::create_dir_all(workspace_path.join("nested")).expect("workspace fixture");
    fs::write(workspace_path.join("nested/input.txt"), b"inside").expect("input fixture");
    let workspace = WorkspaceRoot::open(&workspace_path).expect("workspace descriptor");

    assert_eq!(
        workspace.read("nested/input.txt").expect("workspace read"),
        b"inside"
    );
    workspace
        .write("nested/output.txt", b"written")
        .expect("workspace write");
    assert_eq!(
        fs::read(workspace_path.join("nested/output.txt")).expect("written file"),
        b"written"
    );
}

#[test]
fn rejects_lexical_and_encoded_escape_paths() {
    let fixture = tempdir().expect("temp root");
    let workspace_path = fixture.path().join("workspace");
    fs::create_dir_all(workspace_path.join("nested")).expect("workspace fixture");
    let workspace = WorkspaceRoot::open(&workspace_path).expect("workspace descriptor");

    for path in [
        "",
        "/etc/passwd",
        ".",
        "./inside.txt",
        "..",
        "../private/secret.txt",
        "nested/../secret.txt",
        "nested//secret.txt",
        "nested/.",
        "%2e%2e/secret.txt",
        "%2E%2E/secret.txt",
        "nested/%2e/secret.txt",
        "nested%2fsecret.txt",
        "nested%2Fsecret.txt",
        "nested%5csecret.txt",
        "nested%5Csecret.txt",
    ] {
        assert!(workspace.read(path).is_err(), "read accepted {path:?}");
        assert!(
            workspace.write(path, b"escape").is_err(),
            "write accepted {path:?}"
        );
    }
}

#[test]
fn rejects_symlink_at_every_parent_level() {
    let fixture = tempdir().expect("temp root");
    let workspace_path = fixture.path().join("workspace");
    let private_path = fixture.path().join("private");
    fs::create_dir_all(workspace_path.join("real-one/real-two")).expect("workspace fixture");
    fs::create_dir(&private_path).expect("private fixture");
    fs::write(private_path.join("secret.txt"), b"private").expect("private secret");

    symlink(&private_path, workspace_path.join("first")).expect("first-level symlink");
    symlink(&private_path, workspace_path.join("real-one/second")).expect("second-level symlink");
    symlink(
        &private_path,
        workspace_path.join("real-one/real-two/third"),
    )
    .expect("third-level symlink");

    let workspace = WorkspaceRoot::open(&workspace_path).expect("workspace descriptor");
    for parent in ["first", "real-one/second", "real-one/real-two/third"] {
        assert!(
            workspace.read(&format!("{parent}/secret.txt")).is_err(),
            "read followed parent symlink {parent}"
        );
        assert!(
            workspace
                .write(&format!("{parent}/created.txt"), b"escape")
                .is_err(),
            "write followed parent symlink {parent}"
        );
    }

    assert!(!private_path.join("created.txt").exists());
    assert_eq!(
        fs::read(private_path.join("secret.txt")).expect("private secret remains"),
        b"private"
    );
}

#[test]
fn rejects_create_through_final_symlink() {
    let fixture = tempdir().expect("temp root");
    let workspace_path = fixture.path().join("workspace");
    let private_path = fixture.path().join("private");
    fs::create_dir(&workspace_path).expect("workspace fixture");
    fs::create_dir(&private_path).expect("private fixture");
    let secret_path = private_path.join("secret.txt");
    fs::write(&secret_path, b"private").expect("private secret");
    symlink(&secret_path, workspace_path.join("output.txt")).expect("final symlink");

    let workspace = WorkspaceRoot::open(&workspace_path).expect("workspace descriptor");
    assert!(workspace.read("output.txt").is_err());
    assert!(workspace.write("output.txt", b"overwritten").is_err());
    assert_eq!(
        fs::read(secret_path).expect("private secret remains"),
        b"private"
    );
}

#[test]
fn held_root_descriptor_does_not_follow_rename_replacement() {
    let fixture = tempdir().expect("temp root");
    let workspace_path = fixture.path().join("workspace");
    let moved_workspace_path = fixture.path().join("workspace-moved");
    let private_path = fixture.path().join("private");
    fs::create_dir(&workspace_path).expect("workspace fixture");
    fs::create_dir(&private_path).expect("private fixture");
    let workspace = WorkspaceRoot::open(&workspace_path).expect("workspace descriptor");

    fs::rename(&workspace_path, &moved_workspace_path).expect("rename workspace");
    symlink(&private_path, &workspace_path).expect("replace workspace path with symlink");

    workspace
        .write("after-race.txt", b"held-root")
        .expect("descriptor-relative write");
    assert_eq!(
        fs::read(moved_workspace_path.join("after-race.txt")).expect("held root write"),
        b"held-root"
    );
    assert!(!private_path.join("after-race.txt").exists());
    assert!(WorkspaceRoot::open(&workspace_path).is_err());
}

#[test]
fn seatbelt_allows_workspace_and_task_temp_but_denies_private_and_home() {
    let fixture = tempdir().expect("temp root");
    let workspace_path = fixture.path().join("workspace");
    let task_temp_path = fixture.path().join("task-temp");
    let private_path = fixture.path().join("sibling-private");
    fs::create_dir(&workspace_path).expect("workspace fixture");
    fs::create_dir(&task_temp_path).expect("task temp fixture");
    fs::create_dir(&private_path).expect("private fixture");
    fs::write(workspace_path.join("readable.txt"), b"workspace\n").expect("workspace input");
    fs::write(private_path.join("secret.txt"), b"private\n").expect("private input");

    let profile = SeatbeltProfile::new(&workspace_path, &task_temp_path).expect("Seatbelt profile");
    println!("Seatbelt profile used by this test:\n{}", profile.as_str());

    let allowed_script = r#"
set -eu
IFS= read -r workspace_value < "$1/readable.txt"
[ "$workspace_value" = workspace ]
printf workspace-write > "$1/written.txt"
printf 'task-temp-write\n' > "$2/written.txt"
IFS= read -r task_temp_value < "$2/written.txt"
[ "$task_temp_value" = task-temp-write ]
"#;
    let allowed = profile
        .run(
            Path::new("/bin/sh"),
            [
                OsStr::new("-c"),
                OsStr::new(allowed_script),
                OsStr::new("openloop-seatbelt"),
                workspace_path.as_os_str(),
                task_temp_path.as_os_str(),
            ],
        )
        .expect("run allowed command");
    assert_success(&allowed, "workspace/task-temp command");
    assert_eq!(
        fs::read(workspace_path.join("written.txt")).expect("workspace output"),
        b"workspace-write"
    );
    assert_eq!(
        fs::read(task_temp_path.join("written.txt")).expect("task temp output"),
        b"task-temp-write\n"
    );

    let private_read = profile
        .run(
            Path::new("/bin/sh"),
            [
                OsStr::new("-c"),
                OsStr::new(r#"IFS= read -r value < "$1/secret.txt""#),
                OsStr::new("openloop-seatbelt"),
                private_path.as_os_str(),
            ],
        )
        .expect("run denied private read");
    println!(
        "Denied sibling read: status={:?}, stderr={}",
        private_read.status.code(),
        String::from_utf8_lossy(&private_read.stderr)
    );
    assert!(
        !private_read.status.success(),
        "sibling private read escaped"
    );

    let home = std::env::var_os("HOME").expect("HOME");
    let denied_home_path =
        Path::new(&home).join(format!(".openloop-seatbelt-denied-{}", std::process::id()));
    let _ = fs::remove_file(&denied_home_path);
    let home_write = profile
        .run(
            Path::new("/bin/sh"),
            [
                OsStr::new("-c"),
                OsStr::new(r#"printf denied > "$1""#),
                OsStr::new("openloop-seatbelt"),
                denied_home_path.as_os_str(),
            ],
        )
        .expect("run denied home write");
    println!(
        "Denied home write: status={:?}, stderr={}",
        home_write.status.code(),
        String::from_utf8_lossy(&home_write.stderr)
    );
    assert!(!home_write.status.success(), "home write escaped");
    assert!(!denied_home_path.exists());
}

#[test]
fn seatbelt_denies_unlisted_nested_subprocess() {
    let fixture = tempdir().expect("temp root");
    let workspace_path = fixture.path().join("workspace");
    let task_temp_path = fixture.path().join("task-temp");
    fs::create_dir(&workspace_path).expect("workspace fixture");
    fs::create_dir(&task_temp_path).expect("task temp fixture");
    let profile = SeatbeltProfile::new(&workspace_path, &task_temp_path).expect("Seatbelt profile");

    let nested = profile
        .run(
            Path::new("/bin/sh"),
            [OsStr::new("-c"), OsStr::new("/usr/bin/true")],
        )
        .expect("run nested subprocess attempt");
    println!(
        "Denied nested subprocess: status={:?}, stderr={}",
        nested.status.code(),
        String::from_utf8_lossy(&nested.stderr)
    );
    assert!(
        !nested.status.success(),
        "unlisted nested subprocess unexpectedly executed"
    );
}
