use std::{
    fs, io,
    os::{fd::AsRawFd, unix::fs::symlink},
    path::Path,
};

use openloop_desktop_lib::update::lease::UpdateLease;
use tempfile::tempdir;

#[test]
fn runtime_update_lease_allows_multiple_shared_holders() {
    let fixture = tempdir().expect("temporary channel root");
    let first = UpdateLease::shared(fixture.path()).expect("first runtime lease");
    let second = UpdateLease::shared(fixture.path()).expect("second runtime lease");

    assert_eq!(
        UpdateLease::lock_path(fixture.path()),
        fixture.path().join("openloop-update.lock")
    );
    assert!(UpdateLease::lock_path(fixture.path()).is_file());
    drop((first, second));
}

#[test]
fn runtime_and_update_leases_conflict_until_the_holder_drops() {
    let fixture = tempdir().expect("temporary channel root");
    let runtime = UpdateLease::shared(fixture.path()).expect("runtime lease");
    let error = UpdateLease::exclusive(fixture.path()).expect_err("update must be rejected");
    assert_eq!(error.kind(), io::ErrorKind::WouldBlock);

    drop(runtime);
    let update = UpdateLease::exclusive(fixture.path()).expect("update lease after runtime drop");
    let error = UpdateLease::shared(fixture.path()).expect_err("runtime must be rejected");
    assert_eq!(error.kind(), io::ErrorKind::WouldBlock);

    drop(update);
    UpdateLease::shared(fixture.path()).expect("runtime lease after update drop");
}

#[test]
fn update_lease_is_channel_scoped_and_close_on_exec() {
    let fixture = tempdir().expect("temporary app data");
    let test_root = fixture.path().join("Openloop-Test");
    let stable_root = fixture.path().join("Openloop");
    fs::create_dir_all(&test_root).expect("test channel root");
    fs::create_dir_all(&stable_root).expect("stable channel root");

    assert_ne!(
        UpdateLease::lock_path(&test_root),
        UpdateLease::lock_path(&stable_root)
    );
    let lease = UpdateLease::shared(&test_root).expect("test channel lease");
    let descriptor_flags = unsafe { libc::fcntl(lease.as_raw_fd(), libc::F_GETFD) };

    assert!(descriptor_flags >= 0, "read lease descriptor flags");
    assert_ne!(descriptor_flags & libc::FD_CLOEXEC, 0);
    assert_eq!(
        UpdateLease::lock_path(Path::new("/channel")),
        Path::new("/channel/openloop-update.lock")
    );
}

#[test]
fn update_lease_rejects_symlinked_roots_and_lock_files() {
    let fixture = tempdir().expect("temporary app data");
    let real_root = fixture.path().join("Openloop-Test");
    fs::create_dir(&real_root).expect("real channel root");
    let alias = fixture.path().join("alias");
    symlink(&real_root, &alias).expect("channel root symlink");

    assert!(
        UpdateLease::exclusive(&alias).is_err(),
        "lease followed a symlinked channel root"
    );

    let external = fixture.path().join("external.lock");
    fs::write(&external, b"external").expect("external lock target");
    symlink(&external, UpdateLease::lock_path(&real_root)).expect("lock symlink");
    assert!(
        UpdateLease::exclusive(&real_root).is_err(),
        "lease followed a symlinked lock file"
    );
}

#[test]
fn migration_exclusive_lease_blocks_runtime_and_second_migration() {
    let fixture = tempdir().expect("temporary channel root");
    let migration = UpdateLease::exclusive(fixture.path()).expect("migration lease");

    assert_eq!(
        UpdateLease::shared(fixture.path())
            .expect_err("runtime must wait for migration")
            .kind(),
        io::ErrorKind::WouldBlock
    );
    assert_eq!(
        UpdateLease::exclusive(fixture.path())
            .expect_err("second migration must be rejected")
            .kind(),
        io::ErrorKind::WouldBlock
    );

    drop(migration);
    UpdateLease::shared(fixture.path()).expect("runtime starts after migration lease releases");
}

#[test]
fn migration_lease_downgrades_without_opening_an_update_race() {
    let fixture = tempdir().expect("temporary channel root");
    let migration = UpdateLease::exclusive(fixture.path()).expect("migration lease");

    let runtime = migration
        .downgrade()
        .expect("atomically downgrade migration lease");
    UpdateLease::shared(fixture.path()).expect("another runtime may share after downgrade");
    assert_eq!(
        UpdateLease::exclusive(fixture.path())
            .expect_err("update must remain blocked after downgrade")
            .kind(),
        io::ErrorKind::WouldBlock
    );

    drop(runtime);
}
