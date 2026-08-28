#![cfg(target_os = "macos")]

use std::{
    ffi::CString,
    fs::{self, File},
    os::{
        fd::AsRawFd,
        unix::{
            ffi::OsStrExt,
            fs::{symlink, PermissionsExt},
            net::UnixListener,
        },
    },
    path::{Path, PathBuf},
    process,
    sync::{
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use openloop_desktop_lib::{
    bridge::{
        protocol::{sign_request, BridgeRequest, BRIDGE_PROTOCOL_VERSION, MAX_BRIDGE_FRAME_BYTES},
        server::{AuthenticatedBridgeDispatcher, BridgeDispatchTables, PeerIdentity},
    },
    files::{
        install_file_broker_handlers, openat::inspect_regular_descriptor, AtomicWriteOptions,
        FileBroker, FileBrokerError, FileBrokerHooks, FileKind, MAX_FILE_CHUNK_BYTES,
    },
    launcher::capture_process_identity,
    update::channel::ReleaseChannel,
    workspaces::{
        bridge::install_workspace_authority_handlers,
        confirmation::{RevokeConfirmation, RevokePresentation},
        grants::GrantStore,
        journal::{WorkspaceJournal, WorkspaceTransaction, WorkspaceTransactionKind},
        picker::{PendingGrantRegistry, WorkspaceDirectoryPicker},
    },
};
use tempfile::TempDir;
use uuid::Uuid;

struct BlockingWriteHook {
    entered: SyncSender<()>,
    release: Mutex<Receiver<()>>,
}

struct HardlinkWriteHook;

impl FileBrokerHooks for HardlinkWriteHook {
    fn before_atomic_write(&self, parent: i32, temporary: &std::ffi::CStr) {
        let attacker = CString::new("attacker-write-link.txt").expect("attacker name");
        assert_eq!(
            unsafe { libc::linkat(parent, temporary.as_ptr(), parent, attacker.as_ptr(), 0,) },
            0,
            "inject hardlink before write"
        );
    }
}

struct HardlinkPublishHook;

impl FileBrokerHooks for HardlinkPublishHook {
    fn before_atomic_publish(&self, parent: i32, temporary: &std::ffi::CStr) {
        let attacker = CString::new("attacker-publish-link.txt").expect("attacker name");
        assert_eq!(
            unsafe { libc::linkat(parent, temporary.as_ptr(), parent, attacker.as_ptr(), 0,) },
            0,
            "inject hardlink before publish"
        );
    }
}

struct RollbackRaceHook {
    workspace: Mutex<Option<PathBuf>>,
}

impl FileBrokerHooks for RollbackRaceHook {
    fn before_atomic_swap(
        &self,
        _parent: i32,
        _temporary: &std::ffi::CStr,
        _target: &std::ffi::CStr,
    ) {
        let workspace = self
            .workspace
            .lock()
            .expect("hook workspace")
            .clone()
            .expect("hook workspace configured");
        fs::rename(
            workspace.join("document.txt"),
            workspace.join("preserved-original.txt"),
        )
        .expect("preserve original before race");
        fs::write(workspace.join("document.txt"), b"attacker").expect("race target");
    }

    fn before_atomic_rollback(
        &self,
        _parent: i32,
        _temporary: &std::ffi::CStr,
        _target: &std::ffi::CStr,
    ) {
        let workspace = self
            .workspace
            .lock()
            .expect("hook workspace")
            .clone()
            .expect("hook workspace configured");
        fs::rename(
            workspace.join("document.txt"),
            workspace.join("preserved-staged.txt"),
        )
        .expect("move staged inode before rollback");
    }
}

impl FileBrokerHooks for BlockingWriteHook {
    fn before_atomic_write(&self, _parent: i32, _temporary: &std::ffi::CStr) {
        self.entered.send(()).expect("announce blocked write");
        self.release
            .lock()
            .expect("release receiver")
            .recv()
            .expect("release blocked write");
    }
}

struct NoopPicker;

impl WorkspaceDirectoryPicker for NoopPicker {
    fn pick(
        &self,
    ) -> Result<Option<PathBuf>, openloop_desktop_lib::workspaces::grants::WorkspaceGrantError>
    {
        Ok(None)
    }
}

struct ConfirmRevoke;

impl RevokeConfirmation for ConfirmRevoke {
    fn confirm(
        &self,
        _presentation: &RevokePresentation,
    ) -> Result<bool, openloop_desktop_lib::workspaces::grants::WorkspaceGrantError> {
        Ok(true)
    }
}

struct Harness {
    _root: TempDir,
    launch_id: Uuid,
    workspace: PathBuf,
    store: GrantStore,
    journal: WorkspaceJournal,
    registry: Arc<Mutex<PendingGrantRegistry>>,
    broker: Arc<FileBroker>,
}

impl Harness {
    fn new(ttl: Duration) -> Self {
        Self::with_hooks(ttl, Arc::new(()))
    }

    fn with_hooks(ttl: Duration, hooks: Arc<dyn FileBrokerHooks>) -> Self {
        let root = tempfile::tempdir().expect("temp root");
        let channel = root.path().join("channel");
        let workspace = root.path().join("workspace");
        secure_directory(&channel);
        secure_directory(&workspace);
        let store = GrantStore::open(&channel, ReleaseChannel::Test).expect("grant store");
        let journal =
            WorkspaceJournal::open(&channel, ReleaseChannel::Test).expect("Workspace journal");
        let launch_id = Uuid::new_v4();
        let mut registry = PendingGrantRegistry::new(launch_id);
        let pending = registry.begin(&workspace).expect("pending grant");
        let grant = registry
            .commit(launch_id, pending, "workspace-1")
            .expect("committed descriptor");
        store.commit(grant, 0).expect("persisted grant");
        let registry = Arc::new(Mutex::new(registry));
        let broker = Arc::new(FileBroker::with_handle_ttl_and_hooks(
            launch_id,
            store.clone(),
            journal.clone(),
            registry.clone(),
            ttl,
            hooks,
        ));
        Self {
            _root: root,
            launch_id,
            workspace,
            store,
            journal,
            registry,
            broker,
        }
    }
}

#[test]
fn revocation_waits_for_active_write_and_old_handle_cannot_write_afterward() {
    let (entered_tx, entered_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let harness = Harness::with_hooks(
        Duration::from_secs(60),
        Arc::new(BlockingWriteHook {
            entered: entered_tx,
            release: Mutex::new(release_rx),
        }),
    );
    fs::write(harness.workspace.join("document.txt"), b"before").expect("fixture");
    let current = harness
        .broker
        .open("workspace-1", "document.txt")
        .expect("open current");
    let write = harness
        .broker
        .begin_atomic_write(
            "workspace-1",
            "document.txt",
            AtomicWriteOptions {
                create_if_absent: false,
                expected_version: current.version,
            },
        )
        .expect("begin write");

    let writer_broker = harness.broker.clone();
    let writer_handle = write.handle_id.clone();
    let writer = thread::spawn(move || writer_broker.write_chunk(&writer_handle, b"after"));
    entered_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("write reached I/O hook");

    let operation_id = Uuid::new_v4();
    harness
        .journal
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
        .expect("prepare revoke");
    let gate = harness.registry.lock().expect("registry").operation_gate();
    let (dispatcher, launch_id, secret, peer) = broker_and_authority_dispatcher(&harness);
    let revoke = thread::spawn(move || {
        let response = dispatch_file(
            &dispatcher,
            launch_id,
            &secret,
            peer,
            91,
            "markWorkspaceGrantRevoking",
            serde_json::json!({
                "workspaceId": "workspace-1",
                "expectedGrantGeneration": 1,
                "operationId": operation_id,
            }),
        );
        assert_eq!(response["ok"], true);
    });

    let deadline = Instant::now() + Duration::from_secs(2);
    while !gate.is_blocking("workspace-1") && Instant::now() < deadline {
        thread::yield_now();
    }
    let blocked_active_write = gate.is_blocking("workspace-1") && !revoke.is_finished();

    release_tx.send(()).expect("release write");
    writer
        .join()
        .expect("writer thread")
        .expect("write completed");
    revoke.join().expect("revoke thread");
    assert!(
        blocked_active_write,
        "revoke handler must wait for active file I/O"
    );

    assert!(matches!(
        harness.broker.write_chunk(&write.handle_id, b"late"),
        Err(FileBrokerError::GrantUnavailable)
    ));
}

fn broker_and_authority_dispatcher(
    harness: &Harness,
) -> (AuthenticatedBridgeDispatcher, Uuid, Vec<u8>, PeerIdentity) {
    let mut tables = BridgeDispatchTables::unavailable();
    install_workspace_authority_handlers(
        &mut tables,
        harness.launch_id,
        harness.store.clone(),
        harness.journal.clone(),
        harness.registry.clone(),
        Arc::new(NoopPicker),
        Arc::new(ConfirmRevoke),
    )
    .expect("Workspace authority handlers");
    install_file_broker_handlers(&mut tables, harness.broker.clone())
        .expect("file broker handlers");
    authenticated_dispatcher(tables)
}

fn broker_dispatcher(
    broker: Arc<FileBroker>,
) -> (AuthenticatedBridgeDispatcher, Uuid, Vec<u8>, PeerIdentity) {
    let mut tables = BridgeDispatchTables::unavailable();
    install_file_broker_handlers(&mut tables, broker).expect("file broker handlers");
    authenticated_dispatcher(tables)
}

fn authenticated_dispatcher(
    tables: BridgeDispatchTables,
) -> (AuthenticatedBridgeDispatcher, Uuid, Vec<u8>, PeerIdentity) {
    let executable = std::env::current_exe().expect("test executable");
    let launch_id = Uuid::new_v4();
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
    .expect("file broker dispatcher");
    (dispatcher, launch_id, secret, peer)
}

fn dispatch_file(
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
        request_id: format!("file-request-{sequence}"),
        launch_id: launch_id.to_string(),
        method: method.to_owned(),
        payload,
    };
    let mut nonce = [0; 32];
    nonce[..8].copy_from_slice(&sequence.to_be_bytes());
    let response = dispatcher
        .dispatch(
            peer,
            sign_request(request, nonce, secret).expect("signed file request"),
        )
        .expect("authenticated file response");
    serde_json::to_value(response).expect("response JSON")
}

fn secure_directory(path: &Path) {
    fs::create_dir_all(path).expect("create secure directory");
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).expect("set secure permissions");
}

#[test]
fn broker_rejects_traversal_absolute_nul_and_encoded_paths() {
    let harness = Harness::new(Duration::from_secs(60));
    for path in [
        "",
        "..",
        "../secret",
        "dir/../secret",
        "/etc/passwd",
        "C:/Windows/system.ini",
        r"\\server\share",
        "dir\0file",
        "%2e%2e/secret",
        "%252e%252e/secret",
        "dir%2ffile",
        "dir%5cfile",
    ] {
        assert!(
            matches!(
                harness.broker.open("workspace-1", path),
                Err(FileBrokerError::InvalidPath)
            ),
            "{path:?}"
        );
    }
}

#[test]
fn broker_reads_stats_lists_and_creates_regular_files_in_bounded_chunks() {
    let harness = Harness::new(Duration::from_secs(60));
    secure_directory(&harness.workspace.join("src"));
    fs::write(
        harness.workspace.join("src").join("large.txt"),
        vec![b'x'; MAX_FILE_CHUNK_BYTES + 7],
    )
    .expect("fixture");

    let directory = harness
        .broker
        .open("workspace-1", "src")
        .expect("open directory");
    assert_eq!(directory.kind, FileKind::Directory);
    assert_eq!(
        harness
            .broker
            .list(&directory.handle_id, 0, 128)
            .expect("list directory")
            .entries
            .into_iter()
            .map(|entry| entry.name)
            .collect::<Vec<_>>(),
        vec!["large.txt"]
    );

    let file = harness
        .broker
        .open("workspace-1", "src/large.txt")
        .expect("open file");
    assert_eq!(file.kind, FileKind::Regular);
    let stat = harness.broker.stat(&file.handle_id).expect("stat file");
    assert_eq!(stat.size, (MAX_FILE_CHUNK_BYTES + 7) as u64);
    assert_eq!(stat.version.as_deref(), file.version.as_deref());
    let first = harness
        .broker
        .read(&file.handle_id, 0, MAX_FILE_CHUNK_BYTES)
        .expect("first chunk");
    assert_eq!(first.bytes.len(), MAX_FILE_CHUNK_BYTES);
    assert!(!first.eof);
    let second = harness
        .broker
        .read(&file.handle_id, first.next_offset, MAX_FILE_CHUNK_BYTES)
        .expect("second chunk");
    assert_eq!(second.bytes, vec![b'x'; 7]);
    assert!(second.eof);
    assert!(matches!(
        harness
            .broker
            .read(&file.handle_id, 0, MAX_FILE_CHUNK_BYTES + 1),
        Err(FileBrokerError::ChunkTooLarge)
    ));

    let created = harness
        .broker
        .create("workspace-1", "created.txt")
        .expect("create file");
    assert_eq!(created.kind, FileKind::Regular);
    assert_eq!(
        fs::metadata(harness.workspace.join("created.txt"))
            .expect("created metadata")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn broker_lists_links_and_special_entries_without_following_them() {
    let harness = Harness::new(Duration::from_secs(60));
    fs::write(harness.workspace.join("regular.txt"), b"content").expect("regular fixture");
    symlink(
        harness._root.path().join("outside"),
        harness.workspace.join("link"),
    )
    .expect("symlink fixture");
    let fifo = harness.workspace.join("pipe");
    let fifo_name = CString::new(fifo.as_os_str().as_bytes()).expect("FIFO path");
    assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);

    let root = harness.broker.open("workspace-1", ".").expect("open root");
    let listed = harness
        .broker
        .list(&root.handle_id, 0, 128)
        .expect("list without following entries");
    let mut serialized = serde_json::to_value(listed.entries)
        .expect("serialize entries")
        .as_array()
        .expect("entry array")
        .clone();
    serialized.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));

    assert_eq!(serialized[0]["name"], "link");
    assert_eq!(serialized[0]["kind"], "symlink");
    assert_eq!(serialized[1]["name"], "pipe");
    assert_eq!(serialized[1]["kind"], "other");
    assert_eq!(serialized[2]["name"], "regular.txt");
    assert_eq!(serialized[2]["kind"], "regular");
    assert_eq!(serialized[2]["size"], 7);
    assert!(serialized.iter().all(|entry| {
        entry["version"]
            .as_str()
            .is_some_and(|version| !version.is_empty())
    }));
}

#[test]
fn broker_rejects_symlinks_at_every_depth_and_sensitive_hardlinks() {
    let harness = Harness::new(Duration::from_secs(60));
    let outside = harness._root.path().join("outside");
    secure_directory(&outside);
    fs::write(outside.join("secret"), b"outside").expect("outside secret");

    let parent_links = [
        harness.workspace.join("parent-link"),
        harness.workspace.join("safe").join("parent-link"),
        harness
            .workspace
            .join("safe")
            .join("nested")
            .join("parent-link"),
    ];
    secure_directory(&harness.workspace.join("safe").join("nested"));
    for link in &parent_links {
        symlink(&outside, link).expect("parent symlink");
    }
    symlink(outside.join("secret"), harness.workspace.join("leaf-link")).expect("leaf symlink");
    for path in [
        "parent-link/secret",
        "safe/parent-link/secret",
        "safe/nested/parent-link/secret",
        "leaf-link",
    ] {
        assert!(matches!(
            harness.broker.open("workspace-1", path),
            Err(FileBrokerError::UnsafeFile)
        ));
    }

    fs::write(harness.workspace.join("original"), b"sensitive").expect("hardlink source");
    fs::hard_link(
        harness.workspace.join("original"),
        harness.workspace.join("linked"),
    )
    .expect("hardlink");
    assert!(matches!(
        harness.broker.open("workspace-1", "linked"),
        Err(FileBrokerError::UnsafeFile)
    ));
}

#[test]
fn broker_rejects_fifo_socket_and_device_descriptors_without_blocking() {
    let harness = Harness::new(Duration::from_secs(60));
    let fifo = harness.workspace.join("pipe");
    let fifo_name = CString::new(fifo.as_os_str().as_bytes()).expect("FIFO path");
    assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);
    let socket_path = harness.workspace.join("socket");
    let _listener = UnixListener::bind(&socket_path).expect("unix socket");

    for path in ["pipe", "socket"] {
        assert!(matches!(
            harness.broker.open("workspace-1", path),
            Err(FileBrokerError::UnsafeFile)
        ));
    }

    let device = File::open("/dev/null").expect("device");
    assert!(matches!(
        inspect_regular_descriptor(device.as_raw_fd()),
        Err(FileBrokerError::UnsafeFile)
    ));
}

#[test]
fn retained_root_descriptor_survives_rename_and_never_reaches_replacement() {
    let harness = Harness::new(Duration::from_secs(60));
    fs::write(harness.workspace.join("identity.txt"), b"original").expect("original file");
    let moved = harness._root.path().join("moved-workspace");
    fs::rename(&harness.workspace, &moved).expect("rename authorized root");
    secure_directory(&harness.workspace);
    fs::write(harness.workspace.join("identity.txt"), b"replacement").expect("replacement file");

    let file = harness
        .broker
        .open("workspace-1", "identity.txt")
        .expect("descriptor-relative open");
    let bytes = harness
        .broker
        .read(&file.handle_id, 0, MAX_FILE_CHUNK_BYTES)
        .expect("descriptor-relative read")
        .bytes;
    assert_eq!(bytes, b"original");
    assert_eq!(
        fs::read(harness.workspace.join("identity.txt")).expect("replacement remains"),
        b"replacement"
    );
}

#[test]
fn handles_expire_close_and_stop_after_grant_revocation() {
    let expired = Harness::new(Duration::ZERO);
    fs::write(expired.workspace.join("file"), b"value").expect("expired fixture");
    let handle = expired
        .broker
        .open("workspace-1", "file")
        .expect("open expiring handle");
    assert!(matches!(
        expired.broker.stat(&handle.handle_id),
        Err(FileBrokerError::InvalidHandle)
    ));

    let closed = Harness::new(Duration::from_secs(60));
    fs::write(closed.workspace.join("file"), b"value").expect("closed fixture");
    let handle = closed
        .broker
        .open("workspace-1", "file")
        .expect("open closeable handle");
    closed
        .broker
        .close(&handle.handle_id)
        .expect("close handle");
    assert!(matches!(
        closed.broker.stat(&handle.handle_id),
        Err(FileBrokerError::InvalidHandle)
    ));

    let revoked = Harness::new(Duration::from_secs(60));
    fs::write(revoked.workspace.join("file"), b"value").expect("revoked fixture");
    let handle = revoked
        .broker
        .open("workspace-1", "file")
        .expect("open revocable handle");
    revoked
        .store
        .update_status(
            "workspace-1",
            openloop_desktop_lib::workspaces::grants::GrantStatus::Ready,
            openloop_desktop_lib::workspaces::grants::GrantStatus::Revoking,
            1,
        )
        .expect("revoke grant");
    assert!(matches!(
        revoked.broker.stat(&handle.handle_id),
        Err(FileBrokerError::GrantUnavailable)
    ));
    assert!(revoked
        .registry
        .lock()
        .expect("registry")
        .committed_descriptor("workspace-1")
        .is_some());

    let reauthorizing = Harness::new(Duration::from_secs(60));
    fs::write(reauthorizing.workspace.join("file"), b"value").expect("reauthorizing fixture");
    let handle = reauthorizing
        .broker
        .open("workspace-1", "file")
        .expect("open before reauthorization");
    reauthorizing
        .journal
        .write(
            WorkspaceTransaction {
                version: 1,
                generation: 1,
                operation_id: Uuid::new_v4(),
                kind: WorkspaceTransactionKind::Reauthorize,
                workspace_id: Some("workspace-1".to_owned()),
                expected_catalog_generation: 1,
                expected_grant_generation: 1,
                stage: "reauthorize-prepared".to_owned(),
            },
            0,
        )
        .expect("prepare reauthorization");
    assert!(matches!(
        reauthorizing.broker.stat(&handle.handle_id),
        Err(FileBrokerError::GrantUnavailable)
    ));
}

#[test]
fn atomic_write_uses_descriptor_relative_temp_fsync_rename_and_version_cas() {
    let harness = Harness::new(Duration::from_secs(60));
    fs::write(harness.workspace.join("document.txt"), b"before").expect("fixture");
    let current = harness
        .broker
        .open("workspace-1", "document.txt")
        .expect("open current");
    let expected_version = current.version.clone().expect("regular file version");
    harness
        .broker
        .close(&current.handle_id)
        .expect("close current");

    let write = harness
        .broker
        .begin_atomic_write(
            "workspace-1",
            "document.txt",
            AtomicWriteOptions {
                create_if_absent: false,
                expected_version: Some(expected_version),
            },
        )
        .expect("begin atomic write");
    harness
        .broker
        .write_chunk(&write.handle_id, b"after")
        .expect("write chunk");
    let version = harness
        .broker
        .commit_atomic_write(&write.handle_id)
        .expect("commit atomic write");
    assert!(!version.is_empty());
    assert_eq!(
        fs::read(harness.workspace.join("document.txt")).expect("written file"),
        b"after"
    );
    assert_eq!(
        fs::metadata(harness.workspace.join("document.txt"))
            .expect("written metadata")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn atomic_write_detects_hardlink_added_during_write_and_preserves_attacker_link() {
    let harness = Harness::with_hooks(Duration::from_secs(60), Arc::new(HardlinkWriteHook));
    fs::write(harness.workspace.join("document.txt"), b"before").expect("fixture");
    let current = harness
        .broker
        .open("workspace-1", "document.txt")
        .expect("open current");
    let write = harness
        .broker
        .begin_atomic_write(
            "workspace-1",
            "document.txt",
            AtomicWriteOptions {
                create_if_absent: false,
                expected_version: current.version,
            },
        )
        .expect("begin write");

    assert!(matches!(
        harness.broker.write_chunk(&write.handle_id, b"after"),
        Err(FileBrokerError::UnsafeFile)
    ));
    harness
        .broker
        .close(&write.handle_id)
        .expect("close rejected write");
    assert_eq!(
        fs::read(harness.workspace.join("document.txt")).expect("target unchanged"),
        b"before"
    );
    assert_eq!(
        fs::read(harness.workspace.join("attacker-write-link.txt"))
            .expect("attacker hardlink preserved"),
        b"after"
    );
}

#[test]
fn atomic_write_detects_hardlink_added_before_publish_and_does_not_publish() {
    let harness = Harness::with_hooks(Duration::from_secs(60), Arc::new(HardlinkPublishHook));
    fs::write(harness.workspace.join("document.txt"), b"before").expect("fixture");
    let current = harness
        .broker
        .open("workspace-1", "document.txt")
        .expect("open current");
    let write = harness
        .broker
        .begin_atomic_write(
            "workspace-1",
            "document.txt",
            AtomicWriteOptions {
                create_if_absent: false,
                expected_version: current.version,
            },
        )
        .expect("begin write");
    harness
        .broker
        .write_chunk(&write.handle_id, b"after")
        .expect("stage bytes");

    assert!(matches!(
        harness.broker.commit_atomic_write(&write.handle_id),
        Err(FileBrokerError::UnsafeFile)
    ));
    assert_eq!(
        fs::read(harness.workspace.join("document.txt")).expect("target unchanged"),
        b"before"
    );
    assert_eq!(
        fs::read(harness.workspace.join("attacker-publish-link.txt"))
            .expect("attacker hardlink preserved"),
        b"after"
    );
}

#[test]
fn failed_swap_rollback_preserves_staged_displaced_and_attacker_files() {
    let hook = Arc::new(RollbackRaceHook {
        workspace: Mutex::new(None),
    });
    let harness = Harness::with_hooks(Duration::from_secs(60), hook.clone());
    *hook.workspace.lock().expect("hook workspace") = Some(harness.workspace.clone());
    fs::write(harness.workspace.join("document.txt"), b"before").expect("fixture");
    let current = harness
        .broker
        .open("workspace-1", "document.txt")
        .expect("open current");
    let write = harness
        .broker
        .begin_atomic_write(
            "workspace-1",
            "document.txt",
            AtomicWriteOptions {
                create_if_absent: false,
                expected_version: current.version,
            },
        )
        .expect("begin raced write");
    harness
        .broker
        .write_chunk(&write.handle_id, b"after")
        .expect("stage bytes");

    assert!(harness
        .broker
        .commit_atomic_write(&write.handle_id)
        .is_err());
    assert_eq!(
        fs::read(harness.workspace.join("preserved-original.txt")).expect("original preserved"),
        b"before"
    );
    assert_eq!(
        fs::read(harness.workspace.join("preserved-staged.txt")).expect("staged preserved"),
        b"after"
    );
    let temporary_contents = fs::read_dir(&harness.workspace)
        .expect("workspace entries")
        .filter_map(Result::ok)
        .find_map(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(".openloop-write-"))
                .then(|| fs::read(entry.path()).expect("preserved displaced temp"))
        })
        .expect("displaced temp remains");
    assert_eq!(temporary_contents, b"attacker");
}

#[test]
fn atomic_write_rejects_stale_versions_existing_create_and_final_symlink() {
    let harness = Harness::new(Duration::from_secs(60));
    fs::write(harness.workspace.join("document.txt"), b"before").expect("fixture");
    let current = harness
        .broker
        .open("workspace-1", "document.txt")
        .expect("open current");
    let expected_version = current.version.clone().expect("regular file version");
    let write = harness
        .broker
        .begin_atomic_write(
            "workspace-1",
            "document.txt",
            AtomicWriteOptions {
                create_if_absent: false,
                expected_version: Some(expected_version),
            },
        )
        .expect("begin stale write");
    harness
        .broker
        .write_chunk(&write.handle_id, b"stale")
        .expect("stage stale bytes");
    fs::write(harness.workspace.join("document.txt"), b"concurrent").expect("concurrent write");
    assert!(matches!(
        harness.broker.commit_atomic_write(&write.handle_id),
        Err(FileBrokerError::VersionConflict)
    ));
    assert_eq!(
        fs::read(harness.workspace.join("document.txt")).expect("concurrent content"),
        b"concurrent"
    );
    assert!(!fs::read_dir(&harness.workspace)
        .expect("workspace entries")
        .filter_map(Result::ok)
        .any(|entry| entry
            .file_name()
            .to_string_lossy()
            .starts_with(".openloop-write-")));

    assert!(matches!(
        harness.broker.begin_atomic_write(
            "workspace-1",
            "document.txt",
            AtomicWriteOptions {
                create_if_absent: true,
                expected_version: None,
            },
        ),
        Err(FileBrokerError::AlreadyExists)
    ));

    let outside = harness._root.path().join("outside");
    fs::write(&outside, b"outside").expect("outside file");
    symlink(&outside, harness.workspace.join("link.txt")).expect("final symlink");
    assert!(matches!(
        harness.broker.begin_atomic_write(
            "workspace-1",
            "link.txt",
            AtomicWriteOptions {
                create_if_absent: false,
                expected_version: None,
            },
        ),
        Err(FileBrokerError::UnsafeFile)
    ));
}

#[test]
fn create_if_absent_atomic_write_creates_one_new_file() {
    let harness = Harness::new(Duration::from_secs(60));
    let write = harness
        .broker
        .begin_atomic_write(
            "workspace-1",
            "new.txt",
            AtomicWriteOptions {
                create_if_absent: true,
                expected_version: None,
            },
        )
        .expect("begin create");
    harness
        .broker
        .write_chunk(&write.handle_id, b"created")
        .expect("write created bytes");
    harness
        .broker
        .commit_atomic_write(&write.handle_id)
        .expect("commit create");
    assert_eq!(
        fs::read(harness.workspace.join("new.txt")).expect("created file"),
        b"created"
    );
}

#[test]
fn bridge_exposes_only_opaque_handles_and_enforces_the_chunk_limit() {
    let harness = Harness::new(Duration::from_secs(60));
    fs::write(
        harness.workspace.join("bridge.txt"),
        vec![b'b'; MAX_FILE_CHUNK_BYTES],
    )
    .expect("bridge fixture");
    let (dispatcher, launch_id, secret, peer) = broker_dispatcher(harness.broker.clone());

    let opened = dispatch_file(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        1,
        "openWorkspaceFile",
        serde_json::json!({
            "workspaceId": "workspace-1",
            "relativePath": "bridge.txt",
            "mode": "read",
        }),
    );
    assert_eq!(opened["ok"], true);
    let serialized = opened["result"].to_string();
    assert!(!serialized.contains(harness.workspace.to_string_lossy().as_ref()));
    assert!(!serialized.contains("descriptor"));
    let handle_id = opened["result"]["handleId"]
        .as_str()
        .expect("opaque handle");

    let chunk = dispatch_file(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        2,
        "readWorkspaceFile",
        serde_json::json!({
            "handleId": handle_id,
            "offset": 0,
            "maxBytes": MAX_FILE_CHUNK_BYTES,
        }),
    );
    assert_eq!(chunk["ok"], true);
    assert!(
        serde_json::to_vec(&chunk).expect("chunk JSON").len() < MAX_BRIDGE_FRAME_BYTES,
        "maximum file chunk must fit below the bridge frame limit"
    );

    let oversized = dispatch_file(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        3,
        "readWorkspaceFile",
        serde_json::json!({
            "handleId": handle_id,
            "offset": 0,
            "maxBytes": MAX_FILE_CHUNK_BYTES + 1,
        }),
    );
    assert_eq!(oversized["ok"], false);
    assert_eq!(oversized["error"]["code"], "file_failure");
}

#[test]
fn bridge_directory_pages_fit_the_frame_with_long_control_character_names() {
    let harness = Harness::new(Duration::from_secs(60));
    let mut expected_names = (0..128)
        .map(|index| format!("{index:03}-{}", "\n\"\\\u{0007}".repeat(60)))
        .collect::<Vec<_>>();
    for name in &expected_names {
        fs::write(harness.workspace.join(name), b"value").expect("long-name fixture");
    }
    let (dispatcher, launch_id, secret, peer) = broker_dispatcher(harness.broker.clone());
    let opened = dispatch_file(
        &dispatcher,
        launch_id,
        &secret,
        peer,
        100,
        "openWorkspaceRoot",
        serde_json::json!({ "workspaceId": "workspace-1" }),
    );
    let handle_id = opened["result"]["handleId"]
        .as_str()
        .expect("directory handle");

    let mut offset = 0;
    let mut sequence = 101;
    let mut listed = Vec::new();
    loop {
        let page = dispatch_file(
            &dispatcher,
            launch_id,
            &secret,
            peer,
            sequence,
            "listWorkspaceFiles",
            serde_json::json!({
                "handleId": handle_id,
                "offset": offset,
                "maxEntries": 128,
            }),
        );
        assert_eq!(page["ok"], true);
        assert!(
            serde_json::to_vec(&page).expect("page JSON").len() < MAX_BRIDGE_FRAME_BYTES,
            "directory page must fit below the bridge frame limit"
        );
        listed.extend(
            page["result"]["entries"]
                .as_array()
                .expect("directory entries")
                .iter()
                .map(|entry| entry["name"].as_str().expect("entry name").to_owned()),
        );
        offset = page["result"]["nextOffset"].as_u64().expect("next offset") as usize;
        sequence += 1;
        if page["result"]["eof"] == true {
            break;
        }
    }
    expected_names.sort();
    listed.sort();
    assert_eq!(listed, expected_names);
}
