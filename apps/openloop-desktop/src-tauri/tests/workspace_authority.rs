#![cfg(target_os = "macos")]

use std::{
    collections::VecDeque,
    fs,
    io::Write,
    net::Shutdown,
    os::unix::fs::{symlink, PermissionsExt},
    path::{Path, PathBuf},
    process,
    sync::{mpsc, Arc, Barrier, Mutex},
    thread,
    time::{Duration, Instant},
};

use openloop_desktop_lib::{
    bridge::{
        protocol::{encode_frame, sign_request, BridgeRequest, BRIDGE_PROTOCOL_VERSION},
        server::{
            AuthenticatedBridgeDispatcher, BridgeDispatchTables, BridgeListener, CancellationToken,
            PeerIdentity,
        },
    },
    launcher::capture_process_identity,
    update::channel::ReleaseChannel,
    workspaces::{
        bridge::{
            install_workspace_authority_handlers, install_workspace_authority_handlers_with_reveal,
            install_workspace_transaction_handlers, reveal_workspace_with_command,
        },
        confirmation::{
            confirm_workspace_revoke, AppKitWorkspaceRevokeConfirmation,
            AppKitWorkspaceRevokeConfirmationBackend, CommittedWorkspaceProjection,
            CommittedWorkspaceProjectionResolver, RevokeConfirmation,
            RevokeConfirmationCancellation, RevokeConfirmationCompletion, RevokePresentation,
        },
        grants::{
            reopen_verified_grant, FileIdentity, GrantStatus, GrantStore, VerifiedGrant,
            WorkspaceGrant, WorkspaceGrantError,
        },
        journal::{WorkspaceJournal, WorkspaceTransaction, WorkspaceTransactionKind},
        picker::{
            AppKitWorkspaceDirectoryPicker, AppKitWorkspaceDirectoryPickerBackend,
            DirectoryPickerCancellation, DirectoryPickerCompletion, PendingGrantRegistry,
            WorkspaceDirectoryPicker,
        },
    },
};
use tempfile::tempdir;
use uuid::Uuid;

fn dispatch_transaction(
    journal: WorkspaceJournal,
    method: &str,
    payload: serde_json::Value,
) -> serde_json::Value {
    let executable = std::env::current_exe().expect("test executable");
    let launch_id = Uuid::new_v4();
    let secret: Vec<u8> = (0..32).collect();
    let peer = PeerIdentity {
        uid: unsafe { libc::geteuid() },
        pid: process::id(),
    };
    let mut tables = BridgeDispatchTables::unavailable();
    install_workspace_transaction_handlers(&mut tables, journal).expect("transaction handlers");
    let dispatcher = AuthenticatedBridgeDispatcher::new(
        peer.uid,
        capture_process_identity(process::id(), &executable).expect("process identity"),
        executable,
        launch_id,
        secret.clone(),
        tables,
    )
    .expect("transaction dispatcher");
    let request = BridgeRequest {
        version: BRIDGE_PROTOCOL_VERSION,
        request_id: "workspace-transaction-request".to_owned(),
        launch_id: launch_id.to_string(),
        method: method.to_owned(),
        payload,
    };
    let response = dispatcher
        .dispatch(
            peer,
            sign_request(request, [7; 32], &secret).expect("signed Workspace request"),
        )
        .expect("authenticated Workspace response");
    serde_json::to_value(response).expect("response JSON")
}

fn dispatch_workspace(
    dispatcher: &AuthenticatedBridgeDispatcher,
    launch_id: Uuid,
    secret: &[u8],
    peer: PeerIdentity,
    sequence: u64,
    method: &str,
    payload: serde_json::Value,
) -> serde_json::Value {
    let request = BridgeRequest {
        version: BRIDGE_PROTOCOL_VERSION,
        request_id: format!("workspace-request-{sequence}"),
        launch_id: launch_id.to_string(),
        method: method.to_owned(),
        payload,
    };
    let mut nonce = [0; 32];
    nonce[..8].copy_from_slice(&sequence.to_be_bytes());
    let response = dispatcher
        .dispatch(
            peer,
            sign_request(request, nonce, secret).expect("signed Workspace request"),
        )
        .expect("authenticated Workspace response");
    serde_json::to_value(response).expect("response JSON")
}

fn secure_root(path: &Path) {
    fs::create_dir_all(path).expect("create secure root");
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).expect("secure permissions");
}

fn open_descriptor_count() -> usize {
    fs::read_dir("/dev/fd")
        .expect("read process descriptors")
        .filter_map(Result::ok)
        .count()
}

fn wait_until(timeout: Duration, predicate: impl Fn() -> bool) {
    let deadline = Instant::now() + timeout;
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "condition was not met before timeout"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

fn grant(path: &Path, workspace_id: &str, generation: u64) -> WorkspaceGrant {
    let canonical = fs::canonicalize(path).expect("canonical workspace");
    let metadata = fs::metadata(&canonical).expect("workspace metadata");
    WorkspaceGrant {
        version: 1,
        generation,
        operation_id: Uuid::new_v4(),
        previous_operation_id: None,
        previous_status: None,
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
fn grant_store_validation_failure_prevents_persistence() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    let workspace = root.path().join("workspace");
    secure_root(&channel);
    secure_root(&workspace);
    let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");

    let error = store
        .commit_validated(grant(&workspace, "workspace-1", 1), 0, || {
            Err(WorkspaceGrantError::InvalidPendingGrant)
        })
        .expect_err("identity revalidation must fail");

    assert!(matches!(error, WorkspaceGrantError::InvalidPendingGrant));
    assert_eq!(store.load().expect("unchanged store").generation, 0);
    assert!(store
        .get("workspace-1")
        .expect("read rejected grant")
        .is_none());
}

#[test]
fn grant_store_status_update_and_delete_are_atomic_cas_mutations() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    let workspace = root.path().join("workspace");
    secure_root(&channel);
    secure_root(&workspace);
    let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");
    store
        .commit(grant(&workspace, "workspace-1", 0), 0)
        .expect("commit grant");

    assert_eq!(
        store
            .update_status("workspace-1", GrantStatus::Ready, GrantStatus::Revoking, 1,)
            .expect("mark revoking"),
        2
    );
    assert_eq!(
        store
            .get("workspace-1")
            .expect("read grant")
            .expect("grant")
            .status,
        GrantStatus::Revoking
    );
    assert!(store
        .update_status(
            "workspace-1",
            GrantStatus::Ready,
            GrantStatus::NeedsAuthorization,
            2,
        )
        .is_err());
    assert_eq!(
        store
            .delete("workspace-1", GrantStatus::Revoking, 2)
            .expect("delete grant"),
        3
    );
    assert!(store.get("workspace-1").expect("read deleted").is_none());
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
fn transaction_handlers_reject_illegal_abort_and_complete_stages() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    secure_root(&channel);
    let journal = WorkspaceJournal::open(&channel, ReleaseChannel::Test).expect("journal");
    let prepared = WorkspaceTransaction {
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
        .write(prepared.clone(), 0)
        .expect("prepared journal");

    let invalid_complete = dispatch_transaction(
        journal.clone(),
        "completeWorkspaceTransaction",
        serde_json::json!({
            "operationId": prepared.operation_id,
            "expectedGeneration": prepared.generation,
            "expectedStage": "prepared",
        }),
    );
    assert_eq!(invalid_complete["ok"], false);
    assert_eq!(invalid_complete["error"]["code"], "invalid_request");
    assert_eq!(journal.read().expect("journal remains"), Some(prepared));

    journal.clear(1).expect("clear prepared");
    let registry_committed = WorkspaceTransaction {
        version: 1,
        generation: 1,
        operation_id: Uuid::new_v4(),
        kind: WorkspaceTransactionKind::Add,
        workspace_id: Some("workspace-1".to_owned()),
        expected_catalog_generation: 0,
        expected_grant_generation: 0,
        stage: "registry-committed".to_owned(),
    };
    journal
        .write(registry_committed.clone(), 0)
        .expect("registry-committed journal");

    let invalid_abort = dispatch_transaction(
        journal.clone(),
        "abortWorkspaceTransaction",
        serde_json::json!({
            "operationId": registry_committed.operation_id,
            "expectedGeneration": registry_committed.generation,
            "expectedStage": "registry-committed",
        }),
    );
    assert_eq!(invalid_abort["ok"], false);
    assert_eq!(invalid_abort["error"]["code"], "invalid_request");
    assert_eq!(
        journal.read().expect("journal remains"),
        Some(registry_committed)
    );
}

#[test]
fn add_registry_commit_atomically_binds_workspace_id_and_generation() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    secure_root(&channel);
    let journal = WorkspaceJournal::open(&channel, ReleaseChannel::Test).expect("journal");
    let prepared = WorkspaceTransaction {
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
        .write(prepared.clone(), 0)
        .expect("prepared journal");

    let response = dispatch_transaction(
        journal.clone(),
        "advanceWorkspaceTransaction",
        serde_json::json!({
            "operationId": prepared.operation_id,
            "expectedGeneration": prepared.generation,
            "expectedStage": "prepared",
            "nextStage": "registry-committed",
            "workspaceId": "workspace-1",
        }),
    );

    assert_eq!(response["ok"], true);
    assert_eq!(
        journal.read().expect("journal").expect("transaction"),
        WorkspaceTransaction {
            generation: 2,
            workspace_id: Some("workspace-1".to_owned()),
            stage: "registry-committed".to_owned(),
            ..prepared
        }
    );
}

#[test]
fn prepare_persists_preallocated_workspace_and_operation_ids_without_a_path() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    secure_root(&channel);
    let journal = WorkspaceJournal::open(&channel, ReleaseChannel::Test).expect("journal");
    let operation_id = Uuid::new_v4();

    let response = dispatch_transaction(
        journal.clone(),
        "prepareWorkspaceTransaction",
        serde_json::json!({
            "operationId": operation_id,
            "kind": "add",
            "workspaceId": "host-preallocated-id",
            "expectedCatalogGeneration": 0,
            "expectedGrantGeneration": 0,
            "stage": "prepared",
        }),
    );

    assert_eq!(response["ok"], true);
    let transaction = journal
        .read()
        .expect("journal")
        .expect("prepared transaction");
    assert_eq!(
        transaction.workspace_id.as_deref(),
        Some("host-preallocated-id")
    );
    assert_eq!(transaction.operation_id, operation_id);
    let serialized = serde_json::to_string(&transaction).expect("serialize transaction");
    assert!(!serialized.contains("canonicalPath"));
    assert!(!serialized.contains("displayPath"));
}

#[test]
fn grant_generation_cas_serializes_concurrent_writers() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    let workspace = root.path().join("workspace");
    secure_root(&channel);
    secure_root(&workspace);
    let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");
    let barrier = Arc::new(Barrier::new(3));
    let threads = (0..2)
        .map(|index| {
            let store = store.clone();
            let barrier = barrier.clone();
            let workspace = workspace.clone();
            thread::spawn(move || {
                barrier.wait();
                store.commit(grant(&workspace, &format!("workspace-{index}"), 1), 0)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let outcomes = threads
        .into_iter()
        .map(|thread| thread.join().expect("writer"))
        .collect::<Vec<_>>();

    assert_eq!(
        outcomes.iter().filter(|result| result.is_ok()).count(),
        1,
        "{outcomes:?}"
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|result| matches!(
                result,
                Err(WorkspaceGrantError::GenerationConflict {
                    expected: 0,
                    actual: 1
                })
            ))
            .count(),
        1,
        "{outcomes:?}"
    );
}

#[test]
fn store_writes_remain_bound_to_the_opened_channel_descriptor() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    let moved = root.path().join("moved-channel");
    let workspace = root.path().join("workspace");
    secure_root(&channel);
    secure_root(&workspace);
    let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");
    fs::rename(&channel, &moved).expect("move opened root");
    secure_root(&channel);

    store
        .commit(grant(&workspace, "workspace-1", 1), 0)
        .expect("descriptor-bound commit");

    assert!(moved
        .join(store.path().file_name().expect("filename"))
        .is_file());
    assert!(!store.path().exists());
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
fn inspect_workspace_grant_separates_persisted_and_effective_status() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    let workspace = root.path().join("workspace");
    let moved = root.path().join("moved-workspace");
    secure_root(&channel);
    secure_root(&workspace);
    let canonical_workspace = fs::canonicalize(&workspace).expect("canonical workspace");
    let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");
    store
        .commit(grant(&workspace, "workspace-1", 0), 0)
        .expect("commit grant");
    let journal = WorkspaceJournal::open(&channel, ReleaseChannel::Test).expect("journal");
    let operation_id = Uuid::new_v4();
    journal
        .write(
            WorkspaceTransaction {
                version: 1,
                generation: 1,
                operation_id,
                kind: WorkspaceTransactionKind::Revoke,
                workspace_id: Some("workspace-1".to_owned()),
                expected_catalog_generation: 1,
                expected_grant_generation: 1,
                stage: "revoke-prepared".to_owned(),
            },
            0,
        )
        .expect("revoke journal");
    store
        .begin_operation(
            "workspace-1",
            GrantStatus::Ready,
            GrantStatus::Revoking,
            1,
            operation_id,
        )
        .expect("freeze grant");
    let launch_id = Uuid::new_v4();
    let mut pending = PendingGrantRegistry::new(launch_id);
    pending.inject_launch_grants(store.load_for_launch().expect("launch grants"));
    let registry = Arc::new(Mutex::new(pending));
    let picker = Arc::new(SequencePicker {
        outcomes: Mutex::new(VecDeque::new()),
    });
    let mut tables = BridgeDispatchTables::unavailable();
    install_workspace_authority_handlers(
        &mut tables,
        launch_id,
        store,
        journal,
        registry,
        picker,
        Arc::new(FixedConfirmation(true)),
    )
    .expect("authority handlers");
    let executable = std::env::current_exe().expect("test executable");
    let secret: Vec<u8> = (0..32).collect();
    let peer = PeerIdentity {
        uid: unsafe { libc::geteuid() },
        pid: process::id(),
    };
    let dispatcher = AuthenticatedBridgeDispatcher::new(
        peer.uid,
        capture_process_identity(process::id(), &executable).expect("process identity"),
        executable,
        launch_id,
        secret.clone(),
        tables,
    )
    .expect("Workspace dispatcher");

    fs::rename(&workspace, &moved).expect("move authorized workspace");
    secure_root(&workspace);
    let inspected = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        1,
        "inspectWorkspaceGrant",
        serde_json::json!({ "workspaceId": "workspace-1" }),
    );

    assert_eq!(
        inspected["result"],
        serde_json::json!({
            "exists": true,
            "generation": 2,
            "operationId": operation_id,
            "identityValid": false,
            "status": "revoking",
            "effectiveStatus": "identity-mismatch",
            "displayPath": "workspace",
        })
    );
    let serialized = inspected.to_string();
    assert!(!serialized.contains(canonical_workspace.to_string_lossy().as_ref()));
    assert!(inspected["result"].get("canonicalPath").is_none());
    assert!(inspected["result"].get("identity").is_none());
    assert!(inspected["result"].get("pendingGrantId").is_none());
}

#[test]
fn restart_injects_verified_descriptors_without_erasing_persisted_status() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    let workspace = root.path().join("workspace");
    secure_root(&channel);
    secure_root(&workspace);
    let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");
    store
        .commit(grant(&workspace, "workspace-1", 0), 0)
        .expect("commit grant");
    store
        .update_status("workspace-1", GrantStatus::Ready, GrantStatus::Revoking, 1)
        .expect("mark revoking");

    let launch_grants = store.load_for_launch().expect("launch grants");
    assert_eq!(launch_grants[0].grant().status, GrantStatus::Revoking);
    assert!(launch_grants[0].descriptor().is_some());
    let mut registry = PendingGrantRegistry::new(Uuid::new_v4());
    registry.inject_launch_grants(launch_grants);
    assert!(registry.committed_descriptor("workspace-1").is_some());
}

#[test]
fn restart_rejects_owner_or_mode_changes_even_when_identity_matches() {
    let root = tempdir().expect("root");
    let workspace = root.path().join("workspace");
    secure_root(&workspace);
    let original = grant(&workspace, "workspace-1", 1);
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o777))
        .expect("make workspace unsafe");

    let error = reopen_verified_grant(&original).expect_err("unsafe mode rejected");
    assert_eq!(error.status(), Some(GrantStatus::PermissionDenied));
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
    assert!(pending.committed_descriptor("workspace-1").is_some());
    assert!(pending.commit(launch, pending_id, "workspace-1").is_err());
}

#[test]
fn reauthorization_pending_grant_must_match_old_identity_or_registry_path() {
    let root = tempdir().expect("root");
    let original = root.path().join("original");
    let replacement = root.path().join("replacement");
    secure_root(&original);
    secure_root(&replacement);
    let canonical_replacement = fs::canonicalize(&replacement).expect("canonical replacement");
    let launch = Uuid::new_v4();
    let mut pending = PendingGrantRegistry::new(launch);
    let pending_id = pending.begin(&replacement).expect("pending replacement");
    let old_grant = grant(&original, "workspace-1", 1);

    assert!(pending
        .reauthorization_candidate(launch, pending_id, "workspace-1", Some(&old_grant), None,)
        .is_err());
    assert!(pending
        .reauthorization_candidate(launch, pending_id, "workspace-1", None, Some(&original),)
        .is_err());
    assert!(pending
        .reauthorization_candidate(
            launch,
            pending_id,
            "workspace-1",
            None,
            Some(&canonical_replacement),
        )
        .is_ok());
}

#[test]
fn commit_workspace_authorization_revalidates_moved_and_replaced_pending_paths() {
    for replace_original_path in [false, true] {
        let root = tempdir().expect("root");
        let channel = root.path().join("channel");
        let workspace = root.path().join("workspace");
        let moved = root.path().join("moved-workspace");
        secure_root(&channel);
        secure_root(&workspace);
        let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");
        let journal = WorkspaceJournal::open(&channel, ReleaseChannel::Test).expect("journal");
        let launch_id = Uuid::new_v4();
        let registry = Arc::new(Mutex::new(PendingGrantRegistry::new(launch_id)));
        let mut tables = BridgeDispatchTables::unavailable();
        install_workspace_authority_handlers(
            &mut tables,
            launch_id,
            store.clone(),
            journal.clone(),
            registry.clone(),
            Arc::new(SequencePicker {
                outcomes: Mutex::new(VecDeque::from([Some(workspace.clone())])),
            }),
            Arc::new(FixedConfirmation(true)),
        )
        .expect("authority handlers");
        let executable = std::env::current_exe().expect("test executable");
        let secret: Vec<u8> = (0..32).collect();
        let peer = PeerIdentity {
            uid: unsafe { libc::geteuid() },
            pid: process::id(),
        };
        let dispatcher = AuthenticatedBridgeDispatcher::new(
            peer.uid,
            capture_process_identity(process::id(), &executable).expect("process identity"),
            executable,
            launch_id,
            secret.clone(),
            tables,
        )
        .expect("Workspace dispatcher");
        let pending = dispatch_workspace(
            &dispatcher,
            launch_id,
            &secret,
            peer,
            1,
            "beginWorkspaceAuthorization",
            serde_json::Value::Null,
        );
        let pending_id = pending["result"]["pendingGrantId"]
            .as_str()
            .expect("pending grant id");
        let operation_id = Uuid::new_v4();
        journal
            .write(
                WorkspaceTransaction {
                    version: 1,
                    generation: 1,
                    operation_id,
                    kind: WorkspaceTransactionKind::Add,
                    workspace_id: Some("workspace-1".to_owned()),
                    expected_catalog_generation: 0,
                    expected_grant_generation: 0,
                    stage: "registry-committed".to_owned(),
                },
                0,
            )
            .expect("registry-committed journal");

        fs::rename(&workspace, &moved).expect("move selected Workspace");
        if replace_original_path {
            secure_root(&workspace);
        }

        let committed = dispatch_workspace(
            &dispatcher,
            launch_id,
            &secret,
            peer,
            2,
            "commitWorkspaceAuthorization",
            serde_json::json!({
                "pendingGrantId": pending_id,
                "workspaceId": "workspace-1",
                "expectedGrantGeneration": 0,
                "operationId": operation_id,
            }),
        );

        assert_eq!(committed["ok"], false);
        assert_eq!(committed["error"]["code"], "workspace_failure");
        assert!(store
            .get("workspace-1")
            .expect("read rejected grant")
            .is_none());
    }
}

struct FixedConfirmation(bool);

impl RevokeConfirmation for FixedConfirmation {
    fn confirm(&self, presentation: &RevokePresentation) -> Result<bool, WorkspaceGrantError> {
        assert_eq!(presentation.workspace_id, "workspace-1");
        assert_eq!(presentation.title, "Project Alpha");
        Ok(self.0)
    }
}

struct SequencePicker {
    outcomes: Mutex<VecDeque<Option<PathBuf>>>,
}

impl WorkspaceDirectoryPicker for SequencePicker {
    fn pick(&self) -> Result<Option<PathBuf>, WorkspaceGrantError> {
        self.outcomes
            .lock()
            .expect("picker outcomes")
            .pop_front()
            .ok_or(WorkspaceGrantError::PromptUnavailable)
    }
}

struct BlockingDirectoryPickerBackend {
    entered: Mutex<Option<mpsc::Sender<()>>>,
    completion: Arc<Mutex<Option<DirectoryPickerCompletion>>>,
    presentations: Arc<Mutex<usize>>,
    cancellations: Arc<Mutex<usize>>,
}

impl AppKitWorkspaceDirectoryPickerBackend for BlockingDirectoryPickerBackend {
    fn begin_sheet(
        &self,
        completion: DirectoryPickerCompletion,
    ) -> Result<DirectoryPickerCancellation, WorkspaceGrantError> {
        *self.presentations.lock().expect("picker presentation lock") += 1;
        *self.completion.lock().expect("picker completion lock") = Some(completion);
        if let Some(entered) = self.entered.lock().expect("picker entered lock").take() {
            entered.send(()).expect("report picker entry");
        }
        let active_completion = self.completion.clone();
        let cancellations = self.cancellations.clone();
        Ok(Box::new(move || {
            *cancellations.lock().expect("picker cancellation lock") += 1;
            let completion = active_completion
                .lock()
                .expect("picker completion lock")
                .take();
            if let Some(completion) = completion {
                completion(Ok(None));
            }
        }))
    }
}

#[test]
fn picker_cancellation_releases_an_open_blocking_backend() {
    let (entered_tx, entered_rx) = mpsc::channel();
    let backend = Arc::new(BlockingDirectoryPickerBackend {
        entered: Mutex::new(Some(entered_tx)),
        completion: Arc::new(Mutex::new(None)),
        presentations: Arc::new(Mutex::new(0)),
        cancellations: Arc::new(Mutex::new(0)),
    });
    let picker = Arc::new(AppKitWorkspaceDirectoryPicker::with_backend(
        backend.clone(),
    ));
    let cancellation = CancellationToken::default();
    let (finished_tx, finished_rx) = mpsc::channel();
    {
        let picker = picker.clone();
        let cancellation = cancellation.clone();
        thread::spawn(move || {
            finished_tx
                .send(picker.pick_cancellable(&cancellation))
                .expect("report picker outcome");
        });
    }
    entered_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("picker opened");

    cancellation.cancel();

    assert_eq!(
        finished_rx
            .recv_timeout(Duration::from_millis(250))
            .expect("cancellation must release picker")
            .expect("picker cancellation outcome"),
        None
    );
    assert_eq!(
        *backend
            .cancellations
            .lock()
            .expect("picker cancellation lock"),
        1
    );
    assert!(backend
        .completion
        .lock()
        .expect("picker completion lock")
        .is_none());
}

#[test]
fn picker_cancellation_before_presentation_skips_the_backend() {
    let backend = Arc::new(BlockingDirectoryPickerBackend {
        entered: Mutex::new(None),
        completion: Arc::new(Mutex::new(None)),
        presentations: Arc::new(Mutex::new(0)),
        cancellations: Arc::new(Mutex::new(0)),
    });
    let picker = AppKitWorkspaceDirectoryPicker::with_backend(backend.clone());
    let cancellation = CancellationToken::default();
    cancellation.cancel();

    assert_eq!(
        picker
            .pick_cancellable(&cancellation)
            .expect("pre-cancelled picker"),
        None
    );
    assert_eq!(
        *backend
            .presentations
            .lock()
            .expect("picker presentation lock"),
        0
    );
    assert_eq!(
        *backend
            .cancellations
            .lock()
            .expect("picker cancellation lock"),
        0
    );
}

struct BlockingRevokeConfirmationBackend {
    entered: Mutex<Option<mpsc::Sender<()>>>,
    completion: Arc<Mutex<Option<RevokeConfirmationCompletion>>>,
    presentations: Arc<Mutex<usize>>,
    cancellations: Arc<Mutex<usize>>,
}

impl AppKitWorkspaceRevokeConfirmationBackend for BlockingRevokeConfirmationBackend {
    fn begin_sheet(
        &self,
        _presentation: RevokePresentation,
        completion: RevokeConfirmationCompletion,
    ) -> Result<RevokeConfirmationCancellation, WorkspaceGrantError> {
        *self
            .presentations
            .lock()
            .expect("confirmation presentation lock") += 1;
        *self
            .completion
            .lock()
            .expect("confirmation completion lock") = Some(completion);
        if let Some(entered) = self
            .entered
            .lock()
            .expect("confirmation entered lock")
            .take()
        {
            entered.send(()).expect("report confirmation entry");
        }
        let active_completion = self.completion.clone();
        let cancellations = self.cancellations.clone();
        Ok(Box::new(move || {
            *cancellations
                .lock()
                .expect("confirmation cancellation lock") += 1;
            let completion = active_completion
                .lock()
                .expect("confirmation completion lock")
                .take();
            if let Some(completion) = completion {
                completion(Ok(false));
            }
        }))
    }
}

#[test]
fn revoke_confirmation_cancellation_before_presentation_returns_cancelled_once() {
    let backend = Arc::new(BlockingRevokeConfirmationBackend {
        entered: Mutex::new(None),
        completion: Arc::new(Mutex::new(None)),
        presentations: Arc::new(Mutex::new(0)),
        cancellations: Arc::new(Mutex::new(0)),
    });
    let confirmation = AppKitWorkspaceRevokeConfirmation::with_backend(backend.clone());
    let cancellation = CancellationToken::default();
    cancellation.cancel();

    assert!(!confirmation
        .confirm_cancellable(
            &RevokePresentation {
                workspace_id: "workspace-1".to_owned(),
                title: "Project Alpha".to_owned(),
            },
            &cancellation,
        )
        .expect("pre-cancelled confirmation"));
    assert_eq!(
        *backend
            .cancellations
            .lock()
            .expect("confirmation cancellation lock"),
        0
    );
    assert_eq!(
        *backend
            .presentations
            .lock()
            .expect("confirmation presentation lock"),
        0
    );
    assert!(backend
        .completion
        .lock()
        .expect("confirmation completion lock")
        .is_none());
}

#[test]
fn revoke_confirmation_cancellation_releases_an_open_blocking_backend() {
    let (entered_tx, entered_rx) = mpsc::channel();
    let backend = Arc::new(BlockingRevokeConfirmationBackend {
        entered: Mutex::new(Some(entered_tx)),
        completion: Arc::new(Mutex::new(None)),
        presentations: Arc::new(Mutex::new(0)),
        cancellations: Arc::new(Mutex::new(0)),
    });
    let confirmation = Arc::new(AppKitWorkspaceRevokeConfirmation::with_backend(
        backend.clone(),
    ));
    let cancellation = CancellationToken::default();
    let (finished_tx, finished_rx) = mpsc::channel();
    {
        let confirmation = confirmation.clone();
        let cancellation = cancellation.clone();
        thread::spawn(move || {
            finished_tx
                .send(confirmation.confirm_cancellable(
                    &RevokePresentation {
                        workspace_id: "workspace-1".to_owned(),
                        title: "Project Alpha".to_owned(),
                    },
                    &cancellation,
                ))
                .expect("report confirmation outcome");
        });
    }
    entered_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("confirmation opened");

    cancellation.cancel();

    assert!(!finished_rx
        .recv_timeout(Duration::from_millis(250))
        .expect("cancellation must release confirmation")
        .expect("confirmation cancellation outcome"));
    assert_eq!(
        *backend
            .cancellations
            .lock()
            .expect("confirmation cancellation lock"),
        1
    );
    assert!(backend
        .completion
        .lock()
        .expect("confirmation completion lock")
        .is_none());
}

struct CancellationOnlyPicker {
    entered: Mutex<Option<mpsc::Sender<()>>>,
}

impl WorkspaceDirectoryPicker for CancellationOnlyPicker {
    fn pick(&self) -> Result<Option<PathBuf>, WorkspaceGrantError> {
        Err(WorkspaceGrantError::PromptUnavailable)
    }

    fn pick_cancellable(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Option<PathBuf>, WorkspaceGrantError> {
        if let Some(entered) = self.entered.lock().expect("picker entered lock").take() {
            entered.send(()).expect("report picker entry");
        }
        cancellation.wait();
        Ok(None)
    }
}

struct CancellationOnlyConfirmation {
    entered: Mutex<Option<mpsc::Sender<()>>>,
}

impl RevokeConfirmation for CancellationOnlyConfirmation {
    fn confirm(&self, _presentation: &RevokePresentation) -> Result<bool, WorkspaceGrantError> {
        Err(WorkspaceGrantError::PromptUnavailable)
    }

    fn confirm_cancellable(
        &self,
        _presentation: &RevokePresentation,
        cancellation: &CancellationToken,
    ) -> Result<bool, WorkspaceGrantError> {
        if let Some(entered) = self
            .entered
            .lock()
            .expect("confirmation entered lock")
            .take()
        {
            entered.send(()).expect("report confirmation entry");
        }
        cancellation.wait();
        Ok(false)
    }
}

struct ReleasedDirectoryPicker {
    path: PathBuf,
    entered: Mutex<Option<mpsc::Sender<()>>>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl WorkspaceDirectoryPicker for ReleasedDirectoryPicker {
    fn pick(&self) -> Result<Option<PathBuf>, WorkspaceGrantError> {
        Err(WorkspaceGrantError::PromptUnavailable)
    }

    fn pick_cancellable(
        &self,
        _cancellation: &CancellationToken,
    ) -> Result<Option<PathBuf>, WorkspaceGrantError> {
        if let Some(entered) = self.entered.lock().expect("picker entered lock").take() {
            entered.send(()).expect("report picker entry");
        }
        self.release
            .lock()
            .expect("picker release lock")
            .recv()
            .expect("release picker");
        Ok(Some(self.path.clone()))
    }
}

#[test]
fn disconnected_begin_request_releases_pending_grant_and_descriptor_before_delivery() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    let workspace = root.path().join("workspace");
    let socket_root = root.path().join("socket");
    secure_root(&channel);
    secure_root(&workspace);
    secure_root(&socket_root);
    let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");
    let journal = WorkspaceJournal::open(&channel, ReleaseChannel::Test).expect("journal");
    let launch_id = Uuid::new_v4();
    let registry = Arc::new(Mutex::new(PendingGrantRegistry::new(launch_id)));
    let (picker_entered_tx, picker_entered_rx) = mpsc::channel();
    let (release_picker_tx, release_picker_rx) = mpsc::channel();
    let mut tables = BridgeDispatchTables::unavailable();
    install_workspace_authority_handlers(
        &mut tables,
        launch_id,
        store,
        journal,
        registry.clone(),
        Arc::new(ReleasedDirectoryPicker {
            path: workspace,
            entered: Mutex::new(Some(picker_entered_tx)),
            release: Mutex::new(release_picker_rx),
        }),
        Arc::new(FixedConfirmation(true)),
    )
    .expect("authority handlers");
    let executable = std::env::current_exe().expect("test executable");
    let secret: Vec<u8> = (0..32).collect();
    let peer = PeerIdentity {
        uid: unsafe { libc::geteuid() },
        pid: process::id(),
    };
    let dispatcher = AuthenticatedBridgeDispatcher::new(
        peer.uid,
        capture_process_identity(process::id(), &executable).expect("process identity"),
        executable,
        launch_id,
        secret.clone(),
        tables,
    )
    .expect("Workspace dispatcher");
    let descriptor_baseline = open_descriptor_count();
    let socket_path = socket_root.join("bridge.sock");
    let server = BridgeListener::bind(&socket_path)
        .expect("bridge listener")
        .serve(dispatcher)
        .expect("bridge server");
    let request = BridgeRequest {
        version: BRIDGE_PROTOCOL_VERSION,
        request_id: "disconnected-begin".to_owned(),
        launch_id: launch_id.to_string(),
        method: "beginWorkspaceAuthorization".to_owned(),
        payload: serde_json::Value::Null,
    };
    let envelope = sign_request(request, [31; 32], &secret).expect("signed begin request");
    let mut stream =
        std::os::unix::net::UnixStream::connect(&socket_path).expect("connect Workspace bridge");
    stream
        .write_all(&encode_frame(&envelope).expect("begin request frame"))
        .expect("write begin request");
    picker_entered_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("picker entered");
    stream
        .shutdown(Shutdown::Both)
        .expect("disconnect before picker returns");
    drop(stream);
    release_picker_tx.send(()).expect("release picker");

    wait_until(Duration::from_secs(1), || {
        registry.lock().expect("registry").pending_count() == 0
    });
    drop(server);
    wait_until(Duration::from_secs(1), || {
        open_descriptor_count() <= descriptor_baseline
    });
    assert_eq!(registry.lock().expect("registry").pending_count(), 0);
    assert!(open_descriptor_count() <= descriptor_baseline);
}

#[test]
fn bridge_cancellation_reaches_workspace_picker_and_revoke_confirmation() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    secure_root(&channel);
    let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");
    let journal = WorkspaceJournal::open(&channel, ReleaseChannel::Test).expect("journal");
    let launch_id = Uuid::new_v4();
    let (picker_entered_tx, picker_entered_rx) = mpsc::channel();
    let (confirmation_entered_tx, confirmation_entered_rx) = mpsc::channel();
    let mut tables = BridgeDispatchTables::unavailable();
    install_workspace_authority_handlers(
        &mut tables,
        launch_id,
        store,
        journal,
        Arc::new(Mutex::new(PendingGrantRegistry::new(launch_id))),
        Arc::new(CancellationOnlyPicker {
            entered: Mutex::new(Some(picker_entered_tx)),
        }),
        Arc::new(CancellationOnlyConfirmation {
            entered: Mutex::new(Some(confirmation_entered_tx)),
        }),
    )
    .expect("authority handlers");
    let executable = std::env::current_exe().expect("test executable");
    let secret: Vec<u8> = (0..32).collect();
    let peer = PeerIdentity {
        uid: unsafe { libc::geteuid() },
        pid: process::id(),
    };
    let dispatcher = Arc::new(
        AuthenticatedBridgeDispatcher::new(
            peer.uid,
            capture_process_identity(process::id(), &executable).expect("process identity"),
            executable,
            launch_id,
            secret.clone(),
            tables,
        )
        .expect("Workspace dispatcher"),
    );

    let picker_request = {
        let dispatcher = dispatcher.clone();
        let secret = secret.clone();
        thread::spawn(move || {
            dispatch_workspace(
                &dispatcher,
                launch_id,
                &secret,
                peer,
                1,
                "beginWorkspaceAuthorization",
                serde_json::Value::Null,
            )
        })
    };
    picker_entered_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("picker request entered");
    let picker_cancel = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        2,
        "$cancel",
        serde_json::json!({ "requestId": "workspace-request-1" }),
    );
    assert_eq!(picker_cancel["result"], serde_json::Value::Null);
    assert_eq!(
        picker_request.join().expect("picker request thread")["result"],
        serde_json::json!({ "outcome": "cancelled" }),
    );

    let confirmation_request = {
        let dispatcher = dispatcher.clone();
        let secret = secret.clone();
        thread::spawn(move || {
            dispatch_workspace(
                &dispatcher,
                launch_id,
                &secret,
                peer,
                3,
                "confirmWorkspaceRevoke",
                serde_json::json!({
                    "workspaceId": "workspace-1",
                    "title": "Project Alpha",
                }),
            )
        })
    };
    confirmation_entered_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("confirmation request entered");
    let confirmation_cancel = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        4,
        "$cancel",
        serde_json::json!({ "requestId": "workspace-request-3" }),
    );
    assert_eq!(confirmation_cancel["result"], serde_json::Value::Null);
    assert_eq!(
        confirmation_request
            .join()
            .expect("confirmation request thread")["result"],
        "cancelled",
    );
}

#[derive(Default)]
struct RecordingConfirmation {
    presentations: Mutex<Vec<RevokePresentation>>,
}

impl RevokeConfirmation for RecordingConfirmation {
    fn confirm(&self, presentation: &RevokePresentation) -> Result<bool, WorkspaceGrantError> {
        self.presentations
            .lock()
            .expect("presentations")
            .push(presentation.clone());
        Ok(true)
    }
}

fn recovery_dispatcher(
    store: GrantStore,
    journal: WorkspaceJournal,
    launch_id: Uuid,
) -> (AuthenticatedBridgeDispatcher, Vec<u8>, PeerIdentity) {
    let mut tables = BridgeDispatchTables::unavailable();
    install_workspace_transaction_handlers(&mut tables, journal.clone())
        .expect("transaction handlers");
    install_workspace_authority_handlers(
        &mut tables,
        launch_id,
        store,
        journal,
        Arc::new(Mutex::new(PendingGrantRegistry::new(launch_id))),
        Arc::new(SequencePicker {
            outcomes: Mutex::new(VecDeque::new()),
        }),
        Arc::new(FixedConfirmation(true)),
    )
    .expect("authority handlers");
    let executable = std::env::current_exe().expect("test executable");
    let secret: Vec<u8> = (0..32).collect();
    let peer = PeerIdentity {
        uid: unsafe { libc::geteuid() },
        pid: process::id(),
    };
    let dispatcher = AuthenticatedBridgeDispatcher::new(
        peer.uid,
        capture_process_identity(process::id(), &executable).expect("process identity"),
        executable,
        launch_id,
        secret.clone(),
        tables,
    )
    .expect("Workspace dispatcher");
    (dispatcher, secret, peer)
}

#[test]
fn revoke_recovery_deletes_only_original_stable_grant_without_operation_id() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    let workspace = root.path().join("workspace");
    secure_root(&channel);
    secure_root(&workspace);
    let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");
    store
        .commit(grant(&workspace, "workspace-1", 0), 0)
        .expect("commit grant");
    let journal = WorkspaceJournal::open(&channel, ReleaseChannel::Test).expect("journal");
    let operation_id = Uuid::new_v4();
    journal
        .write(
            WorkspaceTransaction {
                version: 1,
                generation: 1,
                operation_id,
                kind: WorkspaceTransactionKind::Revoke,
                workspace_id: Some("workspace-1".to_owned()),
                expected_catalog_generation: 1,
                expected_grant_generation: 1,
                stage: "registry-deleted".to_owned(),
            },
            0,
        )
        .expect("revoke journal");
    let launch_id = Uuid::new_v4();
    let (dispatcher, secret, peer) = recovery_dispatcher(store.clone(), journal, launch_id);

    let rejected = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        1,
        "deleteWorkspaceGrant",
        serde_json::json!({
            "workspaceId": "workspace-1",
            "expectedGrantGeneration": 1,
            "operationId": operation_id,
        }),
    );
    assert_eq!(rejected["ok"], false);
    assert!(store.get("workspace-1").expect("preserved grant").is_some());

    let deleted = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        2,
        "deleteWorkspaceGrant",
        serde_json::json!({
            "workspaceId": "workspace-1",
            "expectedGrantGeneration": 1,
        }),
    );
    assert_eq!(deleted["result"], 2);
    assert!(store.get("workspace-1").expect("deleted grant").is_none());
}

#[test]
fn reauthorization_recovery_deletes_only_owned_ready_replacements() {
    for stage in ["reauthorize-prepared", "grant-committed"] {
        let root = tempdir().expect("root");
        let channel = root.path().join(stage);
        let workspace = root.path().join("workspace");
        secure_root(&channel);
        secure_root(&workspace);
        let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");
        store
            .commit(grant(&workspace, "workspace-1", 0), 0)
            .expect("commit original grant");
        let operation_id = Uuid::new_v4();
        store
            .begin_operation(
                "workspace-1",
                GrantStatus::Ready,
                GrantStatus::Reauthorizing,
                1,
                operation_id,
            )
            .expect("freeze original grant");
        let journal = WorkspaceJournal::open(&channel, ReleaseChannel::Test).expect("journal");
        journal
            .write(
                WorkspaceTransaction {
                    version: 1,
                    generation: 1,
                    operation_id,
                    kind: WorkspaceTransactionKind::Reauthorize,
                    workspace_id: Some("workspace-1".to_owned()),
                    expected_catalog_generation: 1,
                    expected_grant_generation: 1,
                    stage: stage.to_owned(),
                },
                0,
            )
            .expect("reauthorization journal");
        let launch_id = Uuid::new_v4();
        let (dispatcher, secret, peer) = recovery_dispatcher(store.clone(), journal, launch_id);

        let rejected = dispatch_workspace(
            &dispatcher,
            launch_id,
            &secret,
            peer,
            1,
            "deleteWorkspaceGrant",
            serde_json::json!({
                "workspaceId": "workspace-1",
                "expectedGrantGeneration": 2,
                "operationId": operation_id,
            }),
        );
        assert_eq!(rejected["ok"], false, "{stage} accepted an E+1 freeze");
        let mut replacement = grant(&workspace, "workspace-1", 2);
        replacement.operation_id = operation_id;
        store
            .commit(replacement, 2)
            .expect("commit replacement grant");

        let rejected = dispatch_workspace(
            &dispatcher,
            launch_id,
            &secret,
            peer,
            2,
            "deleteWorkspaceGrant",
            serde_json::json!({
                "workspaceId": "workspace-1",
                "expectedGrantGeneration": 3,
            }),
        );
        assert_eq!(
            rejected["ok"], false,
            "{stage} accepted an omitted operation ID"
        );
        let rejected = dispatch_workspace(
            &dispatcher,
            launch_id,
            &secret,
            peer,
            3,
            "deleteWorkspaceGrant",
            serde_json::json!({
                "workspaceId": "workspace-1",
                "expectedGrantGeneration": 3,
                "operationId": Uuid::new_v4(),
            }),
        );
        assert_eq!(
            rejected["ok"], false,
            "{stage} accepted a foreign operation"
        );
        assert!(store
            .get("workspace-1")
            .expect("preserved replacement")
            .is_some());

        let deleted = dispatch_workspace(
            &dispatcher,
            launch_id,
            &secret,
            peer,
            4,
            "deleteWorkspaceGrant",
            serde_json::json!({
                "workspaceId": "workspace-1",
                "expectedGrantGeneration": 3,
                "operationId": operation_id,
            }),
        );
        assert_eq!(
            deleted["result"], 4,
            "{stage} rejected its owned replacement"
        );
        assert!(store
            .get("workspace-1")
            .expect("deleted replacement")
            .is_none());
    }
}

#[test]
fn reauthorization_prepared_recovery_deletes_only_its_owned_legacy_e_plus_one_grant() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    let workspace = root.path().join("workspace");
    secure_root(&channel);
    secure_root(&workspace);
    let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");
    let operation_id = Uuid::new_v4();
    let mut persisted = grant(&workspace, "workspace-1", 0);
    persisted.operation_id = operation_id;
    store
        .commit(persisted, 0)
        .expect("commit legacy replacement");
    let journal = WorkspaceJournal::open(&channel, ReleaseChannel::Test).expect("journal");
    journal
        .write(
            WorkspaceTransaction {
                version: 1,
                generation: 1,
                operation_id,
                kind: WorkspaceTransactionKind::Reauthorize,
                workspace_id: Some("workspace-1".to_owned()),
                expected_catalog_generation: 1,
                expected_grant_generation: 0,
                stage: "reauthorize-prepared".to_owned(),
            },
            0,
        )
        .expect("reauthorization journal");
    let launch_id = Uuid::new_v4();
    let (dispatcher, secret, peer) = recovery_dispatcher(store.clone(), journal, launch_id);

    let rejected = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        1,
        "deleteWorkspaceGrant",
        serde_json::json!({
            "workspaceId": "workspace-1",
            "expectedGrantGeneration": 1,
            "operationId": Uuid::new_v4(),
        }),
    );
    assert_eq!(rejected["ok"], false);
    assert!(store.get("workspace-1").expect("preserved grant").is_some());

    let deleted = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        2,
        "deleteWorkspaceGrant",
        serde_json::json!({
            "workspaceId": "workspace-1",
            "expectedGrantGeneration": 1,
            "operationId": operation_id,
        }),
    );
    assert_eq!(deleted["result"], 2);
    assert!(store.get("workspace-1").expect("deleted grant").is_none());
}

#[test]
fn reauthorization_recovery_rejects_original_and_e_plus_one_grants() {
    for (label, stage, expected_grant_generation, operation_id_in_grant) in [
        ("original", "reauthorize-prepared", 1, None),
        ("e-plus-one", "grant-committed", 0, Some(Uuid::new_v4())),
    ] {
        let root = tempdir().expect("root");
        let channel = root.path().join(label);
        let workspace = root.path().join("workspace");
        secure_root(&channel);
        secure_root(&workspace);
        let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");
        let operation_id = operation_id_in_grant.unwrap_or_else(Uuid::new_v4);
        let mut persisted = grant(&workspace, "workspace-1", 0);
        if operation_id_in_grant.is_some() {
            persisted.operation_id = operation_id;
        }
        store.commit(persisted, 0).expect("commit grant");
        let journal = WorkspaceJournal::open(&channel, ReleaseChannel::Test).expect("journal");
        journal
            .write(
                WorkspaceTransaction {
                    version: 1,
                    generation: 1,
                    operation_id,
                    kind: WorkspaceTransactionKind::Reauthorize,
                    workspace_id: Some("workspace-1".to_owned()),
                    expected_catalog_generation: 1,
                    expected_grant_generation,
                    stage: stage.to_owned(),
                },
                0,
            )
            .expect("reauthorization journal");
        let launch_id = Uuid::new_v4();
        let (dispatcher, secret, peer) = recovery_dispatcher(store.clone(), journal, launch_id);
        let payload = if operation_id_in_grant.is_some() {
            serde_json::json!({
                "workspaceId": "workspace-1",
                "expectedGrantGeneration": 1,
                "operationId": operation_id,
            })
        } else {
            serde_json::json!({
                "workspaceId": "workspace-1",
                "expectedGrantGeneration": 1,
            })
        };

        let rejected = dispatch_workspace(
            &dispatcher,
            launch_id,
            &secret,
            peer,
            1,
            "deleteWorkspaceGrant",
            payload,
        );
        assert_eq!(rejected["ok"], false, "{label} grant was accepted");
        assert!(store.get("workspace-1").expect("preserved grant").is_some());
    }
}

#[test]
fn native_revoke_confirmation_accepts_a_registry_title_without_a_host_grant() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    secure_root(&channel);
    let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");
    let journal = WorkspaceJournal::open(&channel, ReleaseChannel::Test).expect("journal");
    let launch_id = Uuid::new_v4();
    let registry = Arc::new(Mutex::new(PendingGrantRegistry::new(launch_id)));
    let confirmation = Arc::new(RecordingConfirmation::default());
    let mut tables = BridgeDispatchTables::unavailable();
    install_workspace_authority_handlers(
        &mut tables,
        launch_id,
        store,
        journal,
        registry,
        Arc::new(SequencePicker {
            outcomes: Mutex::new(VecDeque::new()),
        }),
        confirmation.clone(),
    )
    .expect("authority handlers");
    let executable = std::env::current_exe().expect("test executable");
    let secret: Vec<u8> = (0..32).collect();
    let peer = PeerIdentity {
        uid: unsafe { libc::geteuid() },
        pid: process::id(),
    };
    let dispatcher = AuthenticatedBridgeDispatcher::new(
        peer.uid,
        capture_process_identity(process::id(), &executable).expect("process identity"),
        executable,
        launch_id,
        secret.clone(),
        tables,
    )
    .expect("Workspace dispatcher");

    let confirmed = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        1,
        "confirmWorkspaceRevoke",
        serde_json::json!({
            "workspaceId": "workspace-1",
            "title": "Project Alpha",
        }),
    );

    assert_eq!(confirmed["result"], "confirmed");
    assert_eq!(
        confirmation
            .presentations
            .lock()
            .expect("presentations")
            .as_slice(),
        [RevokePresentation {
            workspace_id: "workspace-1".to_owned(),
            title: "Project Alpha".to_owned(),
        }]
    );
}

#[test]
fn reveal_workspace_requires_a_ready_grant_before_invoking_finder() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    let workspace = root.path().join("Project Alpha");
    secure_root(&channel);
    secure_root(&workspace);
    let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");
    store
        .commit(grant(&workspace, "workspace-1", 0), 0)
        .expect("commit grant");
    store
        .update_status(
            "workspace-1",
            GrantStatus::Ready,
            GrantStatus::NeedsAuthorization,
            1,
        )
        .expect("make grant non-ready");
    let journal = WorkspaceJournal::open(&channel, ReleaseChannel::Test).expect("journal");
    let launch_id = Uuid::new_v4();
    let revealed = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
    let reveal_calls = revealed.clone();
    let mut tables = BridgeDispatchTables::unavailable();
    install_workspace_authority_handlers_with_reveal(
        &mut tables,
        launch_id,
        store.clone(),
        journal,
        Arc::new(Mutex::new(PendingGrantRegistry::new(launch_id))),
        Arc::new(SequencePicker {
            outcomes: Mutex::new(VecDeque::new()),
        }),
        Arc::new(FixedConfirmation(true)),
        Arc::new(move |verified: VerifiedGrant| {
            reveal_calls
                .lock()
                .expect("reveal calls")
                .push(verified.grant().canonical_path.clone());
            Ok(())
        }),
    )
    .expect("authority handlers");
    let executable = std::env::current_exe().expect("test executable");
    let secret: Vec<u8> = (0..32).collect();
    let peer = PeerIdentity {
        uid: unsafe { libc::geteuid() },
        pid: process::id(),
    };
    let dispatcher = AuthenticatedBridgeDispatcher::new(
        peer.uid,
        capture_process_identity(process::id(), &executable).expect("process identity"),
        executable,
        launch_id,
        secret.clone(),
        tables,
    )
    .expect("Workspace dispatcher");

    let non_ready = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        1,
        "revealWorkspace",
        serde_json::json!({ "workspaceId": "workspace-1" }),
    );
    assert_eq!(non_ready["ok"], false);
    assert_eq!(non_ready["error"]["code"], "workspace_failure");
    assert!(revealed.lock().expect("reveal calls").is_empty());

    store
        .update_status(
            "workspace-1",
            GrantStatus::NeedsAuthorization,
            GrantStatus::Ready,
            2,
        )
        .expect("restore ready grant");
    let ready = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        2,
        "revealWorkspace",
        serde_json::json!({ "workspaceId": "workspace-1" }),
    );
    assert_eq!(ready["ok"], true);
    assert_eq!(ready["result"], serde_json::Value::Null);
    assert_eq!(
        revealed.lock().expect("reveal calls").as_slice(),
        [fs::canonicalize(&workspace).expect("canonical workspace")]
    );
}

#[test]
fn reveal_workspace_child_inherits_verified_descriptor_across_path_replacement() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    let workspace = root.path().join("workspace");
    let moved = root.path().join("moved-workspace");
    let observation = root.path().join("reveal-observation");
    secure_root(&channel);
    secure_root(&workspace);
    let persisted = grant(&workspace, "workspace-1", 0);
    let original_identity = persisted.identity;
    let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");
    store.commit(persisted, 0).expect("commit grant");
    let journal = WorkspaceJournal::open(&channel, ReleaseChannel::Test).expect("journal");
    let launch_id = Uuid::new_v4();
    let replace_path = workspace.clone();
    let moved_path = moved.clone();
    let observation_path = observation.clone();
    let mut tables = BridgeDispatchTables::unavailable();
    install_workspace_authority_handlers_with_reveal(
        &mut tables,
        launch_id,
        store,
        journal,
        Arc::new(Mutex::new(PendingGrantRegistry::new(launch_id))),
        Arc::new(SequencePicker {
            outcomes: Mutex::new(VecDeque::new()),
        }),
        Arc::new(FixedConfirmation(true)),
        Arc::new(move |verified: VerifiedGrant| {
            fs::rename(&replace_path, &moved_path).expect("move verified Workspace");
            secure_root(&replace_path);
            let mut command = process::Command::new("/bin/sh");
            command
                .arg("-c")
                .arg("printf '%s\\n' \"$1\" > \"$0\" && /usr/bin/stat -f '%i' \"$1\" >> \"$0\"")
                .arg(&observation_path);
            reveal_workspace_with_command(verified, command)
        }),
    )
    .expect("authority handlers");
    let executable = std::env::current_exe().expect("test executable");
    let secret: Vec<u8> = (0..32).collect();
    let peer = PeerIdentity {
        uid: unsafe { libc::geteuid() },
        pid: process::id(),
    };
    let dispatcher = AuthenticatedBridgeDispatcher::new(
        peer.uid,
        capture_process_identity(process::id(), &executable).expect("process identity"),
        executable,
        launch_id,
        secret.clone(),
        tables,
    )
    .expect("Workspace dispatcher");

    let response = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        1,
        "revealWorkspace",
        serde_json::json!({ "workspaceId": "workspace-1" }),
    );

    assert_eq!(response["ok"], true);
    assert_eq!(response["result"], serde_json::Value::Null);
    let observed = fs::read_to_string(&observation).expect("reveal child observation");
    let mut lines = observed.lines();
    assert!(
        lines
            .next()
            .is_some_and(|path| path.starts_with("/dev/fd/")),
        "reveal child must receive a descriptor-backed path"
    );
    let original_inode = original_identity.file_id.to_string();
    assert_eq!(lines.next(), Some(original_inode.as_str()));
    assert_ne!(
        FileIdentity::from_metadata(&fs::metadata(&workspace).expect("replacement metadata")),
        original_identity
    );
}

#[test]
fn installed_workspace_authority_handlers_dispatch_real_mutations_without_path_leaks() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    let workspace = root.path().join("workspace");
    secure_root(&channel);
    secure_root(&workspace);
    let canonical_workspace = fs::canonicalize(&workspace).expect("canonical workspace");
    let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("store");
    let journal = WorkspaceJournal::open(&channel, ReleaseChannel::Test).expect("journal");
    let launch_id = Uuid::new_v4();
    let registry = Arc::new(Mutex::new(PendingGrantRegistry::new(launch_id)));
    let picker = Arc::new(SequencePicker {
        outcomes: Mutex::new(VecDeque::from([None, Some(workspace.clone())])),
    });
    let confirmation = Arc::new(RecordingConfirmation::default());
    let mut tables = BridgeDispatchTables::unavailable();
    install_workspace_authority_handlers(
        &mut tables,
        launch_id,
        store.clone(),
        journal.clone(),
        registry.clone(),
        picker.clone(),
        confirmation.clone(),
    )
    .expect("authority handlers");
    let executable = std::env::current_exe().expect("test executable");
    let secret: Vec<u8> = (0..32).collect();
    let peer = PeerIdentity {
        uid: unsafe { libc::geteuid() },
        pid: process::id(),
    };
    let dispatcher = AuthenticatedBridgeDispatcher::new(
        peer.uid,
        capture_process_identity(process::id(), &executable).expect("process identity"),
        executable,
        launch_id,
        secret.clone(),
        tables,
    )
    .expect("Workspace dispatcher");

    let missing_reveal = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        0,
        "revealWorkspace",
        serde_json::json!({ "workspaceId": "missing-workspace" }),
    );
    assert_eq!(missing_reveal["ok"], false);
    assert_eq!(missing_reveal["error"]["code"], "workspace_failure");

    let cancelled = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        1,
        "beginWorkspaceAuthorization",
        serde_json::Value::Null,
    );
    assert_eq!(
        cancelled["result"],
        serde_json::json!({ "outcome": "cancelled" })
    );
    assert_eq!(registry.lock().expect("registry").pending_count(), 0);

    let spoofed = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        2,
        "beginWorkspaceAuthorization",
        serde_json::json!({ "path": workspace }),
    );
    assert_eq!(spoofed["ok"], false);
    assert_eq!(spoofed["error"]["code"], "invalid_request");

    let pending = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        3,
        "beginWorkspaceAuthorization",
        serde_json::Value::Null,
    );
    assert_eq!(pending["result"]["outcome"], "pending");
    let pending_id = pending["result"]["pendingGrantId"]
        .as_str()
        .expect("pending id");
    assert_eq!(registry.lock().expect("registry").pending_count(), 1);
    let operation_id = Uuid::new_v4();
    journal
        .write(
            WorkspaceTransaction {
                version: 1,
                generation: 1,
                operation_id,
                kind: WorkspaceTransactionKind::Add,
                workspace_id: Some("workspace-1".to_owned()),
                expected_catalog_generation: 0,
                expected_grant_generation: 0,
                stage: "registry-committed".to_owned(),
            },
            0,
        )
        .expect("registry-committed journal");

    let committed = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        4,
        "commitWorkspaceAuthorization",
        serde_json::json!({
            "pendingGrantId": pending_id,
            "workspaceId": "workspace-1",
            "expectedGrantGeneration": 0,
            "operationId": operation_id,
        }),
    );
    assert_eq!(
        committed["result"],
        serde_json::json!({
            "workspaceId": "workspace-1",
            "displayPath": "workspace",
            "state": "ready",
        })
    );
    let serialized = committed["result"].to_string();
    assert!(!serialized.contains(canonical_workspace.to_string_lossy().as_ref()));
    assert!(!serialized.contains(workspace.to_string_lossy().as_ref()));
    assert!(!serialized.contains("canonicalPath"));
    assert!(!serialized.contains("pendingGrantId"));
    assert!(!serialized.contains("identity"));
    let committed_grant = store
        .get("workspace-1")
        .expect("read grant")
        .expect("committed grant");
    assert_eq!(committed_grant.canonical_path, canonical_workspace);
    assert_eq!(committed_grant.display_path, workspace);
    assert_eq!(committed_grant.status, GrantStatus::Ready);
    assert_eq!(committed_grant.operation_id, operation_id);
    assert!(registry
        .lock()
        .expect("registry")
        .committed_descriptor("workspace-1")
        .is_some());

    let inspected = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        5,
        "inspectWorkspaceGrant",
        serde_json::json!({ "workspaceId": "workspace-1" }),
    );
    assert_eq!(
        inspected["result"],
        serde_json::json!({
            "exists": true,
            "generation": 1,
            "operationId": operation_id,
            "identityValid": true,
            "displayPath": "workspace",
            "status": "ready",
            "effectiveStatus": "ready",
        })
    );
    let serialized = inspected.to_string();
    assert!(!serialized.contains(canonical_workspace.to_string_lossy().as_ref()));
    assert!(!serialized.contains(workspace.to_string_lossy().as_ref()));
    assert!(inspected["result"].get("canonicalPath").is_none());
    assert!(inspected["result"].get("identity").is_none());
    assert!(inspected["result"].get("pendingGrantId").is_none());

    let needs_authorization = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        6,
        "markWorkspaceGrantNeedsAuthorization",
        serde_json::json!({
            "workspaceId": "workspace-1",
            "expectedGrantGeneration": 1,
        }),
    );
    assert_eq!(needs_authorization["result"], 2);
    assert_eq!(
        store
            .update_status(
                "workspace-1",
                GrantStatus::NeedsAuthorization,
                GrantStatus::Ready,
                2,
            )
            .expect("restore ready for transaction test"),
        3
    );

    journal.clear(1).expect("clear add transaction");
    let reauthorize_operation_id = Uuid::new_v4();
    journal
        .write(
            WorkspaceTransaction {
                version: 1,
                generation: 1,
                operation_id: reauthorize_operation_id,
                kind: WorkspaceTransactionKind::Reauthorize,
                workspace_id: Some("workspace-1".to_owned()),
                expected_catalog_generation: 1,
                expected_grant_generation: 3,
                stage: "reauthorize-prepared".to_owned(),
            },
            0,
        )
        .expect("reauthorize-prepared journal");
    let reauthorizing = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        7,
        "markWorkspaceGrantReauthorizing",
        serde_json::json!({
            "workspaceId": "workspace-1",
            "expectedGrantGeneration": 3,
            "operationId": reauthorize_operation_id,
        }),
    );
    assert_eq!(reauthorizing["result"], 4);
    let frozen = store
        .get("workspace-1")
        .expect("frozen grant")
        .expect("frozen record");
    assert_eq!(frozen.status, GrantStatus::Reauthorizing);
    assert_eq!(frozen.operation_id, reauthorize_operation_id);
    assert_eq!(frozen.previous_operation_id, Some(operation_id));
    assert_eq!(frozen.previous_status, Some(GrantStatus::Ready));
    let inspected_frozen = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        8,
        "inspectWorkspaceGrant",
        serde_json::json!({ "workspaceId": "workspace-1" }),
    );
    assert_eq!(
        inspected_frozen["result"],
        serde_json::json!({
            "exists": true,
            "generation": 4,
            "operationId": reauthorize_operation_id,
            "identityValid": true,
            "displayPath": "workspace",
            "status": "reauthorizing",
            "effectiveStatus": "ready",
        })
    );
    let serialized = inspected_frozen.to_string();
    assert!(!serialized.contains(canonical_workspace.to_string_lossy().as_ref()));
    assert!(!serialized.contains(workspace.to_string_lossy().as_ref()));
    let restored = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        9,
        "restoreWorkspaceGrantReady",
        serde_json::json!({
            "workspaceId": "workspace-1",
            "expectedGrantGeneration": 4,
            "operationId": reauthorize_operation_id,
        }),
    );
    assert_eq!(restored["result"], 5);
    let restored_grant = store
        .get("workspace-1")
        .expect("restored grant")
        .expect("restored record");
    assert_eq!(restored_grant.status, GrantStatus::Ready);
    assert_eq!(restored_grant.operation_id, operation_id);
    assert_eq!(restored_grant.previous_operation_id, None);
    assert_eq!(restored_grant.previous_status, None);

    let confirmed = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        10,
        "confirmWorkspaceRevoke",
        serde_json::json!({
            "workspaceId": "workspace-1",
            "title": "Project Alpha",
        }),
    );
    assert_eq!(confirmed["result"], "confirmed");
    assert_eq!(
        confirmation
            .presentations
            .lock()
            .expect("presentations")
            .as_slice(),
        [RevokePresentation {
            workspace_id: "workspace-1".to_owned(),
            title: "Project Alpha".to_owned(),
        }]
    );

    journal.clear(1).expect("clear reauthorization transaction");
    let revoke_operation_id = Uuid::new_v4();
    let revoke_transaction = WorkspaceTransaction {
        version: 1,
        generation: 1,
        operation_id: revoke_operation_id,
        kind: WorkspaceTransactionKind::Revoke,
        workspace_id: Some("workspace-1".to_owned()),
        expected_catalog_generation: 1,
        expected_grant_generation: 5,
        stage: "revoke-prepared".to_owned(),
    };
    journal
        .write(revoke_transaction.clone(), 0)
        .expect("revoke-prepared journal");
    let revoking = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        11,
        "markWorkspaceGrantRevoking",
        serde_json::json!({
            "workspaceId": "workspace-1",
            "expectedGrantGeneration": 5,
            "operationId": revoke_operation_id,
        }),
    );
    assert_eq!(revoking["result"], 6);
    journal
        .write(
            WorkspaceTransaction {
                generation: 2,
                stage: "registry-deleted".to_owned(),
                ..revoke_transaction
            },
            1,
        )
        .expect("registry-deleted journal");
    let deleted = dispatch_workspace(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        12,
        "deleteWorkspaceGrant",
        serde_json::json!({
            "workspaceId": "workspace-1",
            "expectedGrantGeneration": 6,
            "operationId": revoke_operation_id,
        }),
    );
    assert_eq!(deleted["result"], 7);
    assert!(store.get("workspace-1").expect("deleted grant").is_none());
    assert!(registry
        .lock()
        .expect("registry")
        .committed_descriptor("workspace-1")
        .is_none());
}

#[test]
fn installed_transaction_handler_reads_the_durable_journal() {
    let root = tempdir().expect("root");
    let channel = root.path().join("channel");
    secure_root(&channel);
    let journal = WorkspaceJournal::open(&channel, ReleaseChannel::Test).expect("journal");
    let transaction = WorkspaceTransaction {
        version: 1,
        generation: 1,
        operation_id: Uuid::new_v4(),
        kind: WorkspaceTransactionKind::Revoke,
        workspace_id: Some("workspace-1".to_owned()),
        expected_catalog_generation: 2,
        expected_grant_generation: 3,
        stage: "revoke-prepared".to_owned(),
    };
    journal
        .write(transaction.clone(), 0)
        .expect("persist transaction");

    let response =
        dispatch_transaction(journal, "readWorkspaceTransaction", serde_json::Value::Null);

    assert_eq!(response["ok"], true);
    assert_eq!(
        response["result"],
        serde_json::to_value(transaction).expect("transaction JSON")
    );
}

struct FixedProjection;

impl CommittedWorkspaceProjectionResolver for FixedProjection {
    fn resolve(
        &self,
        workspace_id: &str,
    ) -> Result<Option<CommittedWorkspaceProjection>, WorkspaceGrantError> {
        assert_eq!(workspace_id, "workspace-1");
        Ok(Some(CommittedWorkspaceProjection {
            workspace_id: workspace_id.to_owned(),
            title: "Project Alpha".to_owned(),
        }))
    }
}

#[test]
fn revoke_confirmation_uses_committed_title_and_cancellation_is_value_only() {
    assert!(
        !confirm_workspace_revoke(&FixedConfirmation(false), &FixedProjection, "workspace-1")
            .expect("cancel confirmation")
    );
    assert!(
        confirm_workspace_revoke(&FixedConfirmation(true), &FixedProjection, "workspace-1")
            .expect("approve confirmation")
    );
}
