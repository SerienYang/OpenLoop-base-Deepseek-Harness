#![cfg(target_os = "macos")]

use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    path::Path,
};

use openloop_desktop_lib::{
    update::channel::ReleaseChannel,
    workspaces::{
        confirmation::{
            confirm_workspace_revoke, CommittedWorkspaceProjection, RevokeConfirmation,
            RevokePresentation,
        },
        grants::{
            reopen_verified_grant, FileIdentity, GrantStatus, GrantStore, WorkspaceGrant,
            WorkspaceGrantError,
        },
        journal::{WorkspaceJournal, WorkspaceTransaction, WorkspaceTransactionKind},
        picker::PendingGrantRegistry,
    },
};
use tempfile::tempdir;
use uuid::Uuid;

fn secure_root(path: &Path) {
    fs::create_dir_all(path).expect("create secure root");
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).expect("secure permissions");
}

fn grant(path: &Path, workspace_id: &str, generation: u64) -> WorkspaceGrant {
    let canonical = fs::canonicalize(path).expect("canonical workspace");
    let metadata = fs::metadata(&canonical).expect("workspace metadata");
    WorkspaceGrant {
        version: 1,
        generation,
        operation_id: Uuid::new_v4(),
        workspace_id: workspace_id.to_owned(),
        canonical_path: canonical.clone(),
        display_path: canonical,
        identity: FileIdentity::from_metadata(&metadata),
        status: GrantStatus::Ready,
        authorized_at: 1,
    }
}

#[test]
fn grant_store_is_owner_only_channel_isolated_and_generation_guarded() {
    let root = tempdir().expect("root");
    let test_root = root.path().join("test");
    let stable_root = root.path().join("stable");
    secure_root(&test_root);
    secure_root(&stable_root);
    let workspace = root.path().join("workspace");
    secure_root(&workspace);

    let test_store = GrantStore::open(&test_root, ReleaseChannel::Test).expect("test store");
    let stable_store =
        GrantStore::open(&stable_root, ReleaseChannel::Stable).expect("stable store");
    let first = grant(&workspace, "workspace-1", 1);

    assert_eq!(
        test_store.commit(first.clone(), 0).expect("first commit"),
        1
    );
    assert_eq!(test_store.load().expect("load test").grants, vec![first]);
    assert!(stable_store.load().expect("load stable").grants.is_empty());
    assert_eq!(
        fs::metadata(test_store.path())
            .expect("store metadata")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );

    let conflict = test_store
        .commit(grant(&workspace, "workspace-2", 2), 0)
        .expect_err("stale generation");
    assert!(matches!(
        conflict,
        WorkspaceGrantError::GenerationConflict {
            expected: 0,
            actual: 1
        }
    ));
}

#[test]
fn grant_store_rejects_symlinks_wrong_owner_duplicates_unknown_status_and_corruption() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    secure_root(&channel);
    let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");

    fs::write(store.path(), b"{").expect("corrupt store");
    fs::set_permissions(store.path(), fs::Permissions::from_mode(0o600)).expect("permissions");
    assert!(matches!(store.load(), Err(WorkspaceGrantError::Corrupt(_))));

    fs::write(
        store.path(),
        br#"{"version":1,"generation":1,"grants":[{"version":1,"generation":1,"operationId":"00000000-0000-0000-0000-000000000001","workspaceId":"same","canonicalPath":"/tmp","displayPath":"/tmp","identity":{"volumeId":1,"fileId":1},"status":"ready","authorizedAt":1},{"version":1,"generation":1,"operationId":"00000000-0000-0000-0000-000000000002","workspaceId":"same","canonicalPath":"/tmp","displayPath":"/tmp","identity":{"volumeId":1,"fileId":2},"status":"ready","authorizedAt":1}]}"#,
    )
    .expect("duplicate store");
    assert!(matches!(
        store.load(),
        Err(WorkspaceGrantError::DuplicateWorkspaceId(_))
    ));

    let unknown = fs::read_to_string(store.path())
        .expect("duplicate source")
        .replace("\"ready\"", "\"unknown\"");
    fs::write(store.path(), unknown).expect("unknown status");
    assert!(matches!(store.load(), Err(WorkspaceGrantError::Corrupt(_))));

    fs::remove_file(store.path()).expect("remove store");
    let outside = root.path().join("outside.json");
    fs::write(&outside, b"{}").expect("outside");
    symlink(&outside, store.path()).expect("store symlink");
    assert!(matches!(
        store.load(),
        Err(WorkspaceGrantError::UnsafePath(_))
    ));

    fs::remove_file(store.path()).expect("remove symlink");
    assert!(matches!(
        GrantStore::open_for_owner(
            &channel,
            ReleaseChannel::Test,
            unsafe { libc::geteuid() }.wrapping_add(1)
        ),
        Err(WorkspaceGrantError::WrongOwnerOrMode(_))
    ));
    fs::set_permissions(&channel, fs::Permissions::from_mode(0o755)).expect("loose root");
    assert!(matches!(
        GrantStore::open(&channel, ReleaseChannel::Test),
        Err(WorkspaceGrantError::WrongOwnerOrMode(_))
    ));
}

#[test]
fn journal_rejects_corruption_and_uses_generation_cas() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    secure_root(&channel);
    let journal = WorkspaceJournal::open(&channel, ReleaseChannel::Test).expect("journal");
    let transaction = WorkspaceTransaction {
        version: 1,
        generation: 1,
        operation_id: Uuid::new_v4(),
        kind: WorkspaceTransactionKind::Add,
        workspace_id: None,
        expected_catalog_generation: 0,
        expected_grant_generation: 0,
        stage: "prepared".to_owned(),
    };
    journal
        .write(transaction.clone(), 0)
        .expect("journal prepare");
    assert_eq!(journal.read().expect("journal read"), Some(transaction));
    assert!(matches!(
        journal.write(
            WorkspaceTransaction {
                generation: 2,
                ..journal.read().expect("read").expect("transaction")
            },
            0
        ),
        Err(WorkspaceGrantError::GenerationConflict {
            expected: 0,
            actual: 1
        })
    ));
    fs::write(journal.path(), b"not-json").expect("corrupt journal");
    assert!(matches!(
        journal.read(),
        Err(WorkspaceGrantError::Corrupt(_))
    ));
}

#[test]
fn restart_reopens_by_descriptor_and_rejects_replacement_or_parent_symlink() {
    let root = tempdir().expect("root");
    let parent = root.path().join("parent");
    let workspace = parent.join("workspace");
    secure_root(&workspace);
    let original = grant(&workspace, "workspace-1", 1);
    let verified = reopen_verified_grant(&original).expect("verified descriptor");
    assert_eq!(verified.grant().status, GrantStatus::Ready);

    let moved = parent.join("moved");
    fs::rename(&workspace, &moved).expect("move original");
    secure_root(&workspace);
    let mismatch = reopen_verified_grant(&original).expect_err("replacement rejected");
    assert_eq!(mismatch.status(), Some(GrantStatus::IdentityMismatch));

    fs::remove_dir(&workspace).expect("remove replacement");
    symlink(&moved, &workspace).expect("leaf symlink");
    let symlink_error = reopen_verified_grant(&original).expect_err("leaf symlink rejected");
    assert!(matches!(
        symlink_error.status(),
        Some(GrantStatus::IdentityMismatch | GrantStatus::PermissionDenied)
    ));
}

#[test]
fn restart_never_publishes_ready_before_descriptor_verification() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    let parent = root.path().join("parent");
    let workspace = parent.join("nested").join("workspace");
    secure_root(&channel);
    secure_root(&workspace);
    let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");
    store
        .commit(grant(&workspace, "workspace-1", 1), 0)
        .expect("commit grant");

    let moved = root.path().join("moved-parent");
    fs::rename(&parent, &moved).expect("move parent");
    symlink(&moved, &parent).expect("replace parent with symlink");

    let restarted = store.load_for_launch().expect("restart projection");
    assert_eq!(restarted.len(), 1);
    assert_eq!(restarted[0].grant().status, GrantStatus::PermissionDenied);
    assert!(!restarted[0].is_ready());
}

#[test]
fn restart_rejects_symlink_replacement_at_every_parent_depth() {
    for depth in 0..3 {
        let root = tempdir().expect("root");
        let parents = ["one", "two", "three"];
        let workspace = parents
            .iter()
            .fold(root.path().to_path_buf(), |path, component| {
                path.join(component)
            })
            .join("workspace");
        secure_root(&workspace);
        let original = grant(&workspace, "workspace-1", 1);
        let attacked = parents
            .iter()
            .take(depth + 1)
            .fold(root.path().to_path_buf(), |path, component| {
                path.join(component)
            });
        let moved = root.path().join(format!("moved-{depth}"));
        fs::rename(&attacked, &moved).expect("move attacked parent");
        symlink(&moved, &attacked).expect("replace parent with symlink");

        let error = reopen_verified_grant(&original).expect_err("parent symlink rejected");
        assert!(matches!(
            error.status(),
            Some(
                GrantStatus::Missing
                    | GrantStatus::PermissionDenied
                    | GrantStatus::IdentityMismatch
            )
        ));
    }
}

#[test]
fn pending_grants_are_launch_bound_memory_only_and_commit_once() {
    let root = tempdir().expect("root");
    let workspace = root.path().join("workspace");
    secure_root(&workspace);
    let launch = Uuid::new_v4();
    let mut pending = PendingGrantRegistry::new(launch);
    let pending_id = pending.begin(&workspace).expect("pending grant");

    assert!(pending
        .commit(Uuid::new_v4(), pending_id, "workspace-1")
        .is_err());
    let committed = pending
        .commit(launch, pending_id, "workspace-1")
        .expect("commit pending");
    assert_eq!(committed.workspace_id, "workspace-1");
    assert!(pending.commit(launch, pending_id, "workspace-1").is_err());
}

struct FixedConfirmation(bool);

impl RevokeConfirmation for FixedConfirmation {
    fn confirm(&self, presentation: &RevokePresentation) -> Result<bool, WorkspaceGrantError> {
        assert_eq!(presentation.workspace_id, "workspace-1");
        assert_eq!(presentation.title, "Project Alpha");
        Ok(self.0)
    }
}

#[test]
fn revoke_confirmation_uses_committed_title_and_cancellation_is_value_only() {
    let projection = CommittedWorkspaceProjection {
        workspace_id: "workspace-1".to_owned(),
        title: "Project Alpha".to_owned(),
    };
    assert!(
        !confirm_workspace_revoke(&FixedConfirmation(false), &projection)
            .expect("cancel confirmation")
    );
    assert!(
        confirm_workspace_revoke(&FixedConfirmation(true), &projection)
            .expect("approve confirmation")
    );
}
