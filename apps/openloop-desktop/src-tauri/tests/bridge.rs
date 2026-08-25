use std::{
    collections::HashMap,
    fs,
    io::{self, Cursor, Read, Write},
    net::Shutdown,
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        net::UnixStream,
    },
    process,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    thread,
};

use openloop_desktop_lib::{
    bridge::{
        protocol::{
            canonical_request_bytes, encode_frame, sign_request, verify_request,
            AuthenticatedBridgeRequest, AuthenticatedBridgeResponse, BridgeRequest,
            NonceReplayGuard, BRIDGE_PROTOCOL_VERSION, MAX_BRIDGE_FRAME_BYTES,
        },
        server::{
            authorize_peer, peer_identity, AuthenticatedBridgeDispatcher, BridgeDispatchTables,
            BridgeHandler, BridgeListener, PeerIdentity, BROWSER_SAFE_METHODS, HOST_ONLY_METHODS,
        },
    },
    launcher::{capture_process_identity, ProcessIdentity},
};
use serde_json::json;
use tempfile::tempdir;
use uuid::Uuid;

const LAUNCH_ID: &str = "8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90";

fn secret() -> Vec<u8> {
    (0..32).collect()
}

fn nonce() -> [u8; 32] {
    std::array::from_fn(|index| index as u8)
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn request(method: &str) -> BridgeRequest {
    BridgeRequest {
        version: BRIDGE_PROTOCOL_VERSION,
        request_id: "request-1".to_owned(),
        launch_id: LAUNCH_ID.to_owned(),
        method: method.to_owned(),
        payload: json!({ "z": 1, "a": [true, null] }),
    }
}

fn current_process_identity() -> ProcessIdentity {
    capture_process_identity(
        process::id(),
        &std::env::current_exe().expect("current test executable"),
    )
    .expect("current process identity")
}

fn current_peer() -> PeerIdentity {
    PeerIdentity {
        uid: unsafe { libc::geteuid() },
        pid: process::id(),
    }
}

fn handler(counter: Arc<AtomicUsize>) -> BridgeHandler {
    Arc::new(move |_payload, _cancellation| {
        counter.fetch_add(1, Ordering::SeqCst);
        Ok(json!({ "reached": true }))
    })
}

fn private_socket_root() -> tempfile::TempDir {
    let fixture = tempdir().expect("socket root");
    fs::set_permissions(fixture.path(), fs::Permissions::from_mode(0o700))
        .expect("private socket root permissions");
    fixture
}

fn tables(counter: Arc<AtomicUsize>) -> BridgeDispatchTables {
    let mut browser_safe = HashMap::new();
    browser_safe.insert("getAppInfo".to_owned(), handler(counter));
    BridgeDispatchTables::new(browser_safe, HashMap::new()).expect("dispatch tables")
}

fn dispatcher(counter: Arc<AtomicUsize>) -> AuthenticatedBridgeDispatcher {
    AuthenticatedBridgeDispatcher::new(
        unsafe { libc::geteuid() },
        current_process_identity(),
        Uuid::parse_str(LAUNCH_ID).expect("launch id"),
        secret(),
        tables(counter),
    )
    .expect("authenticated dispatcher")
}

#[test]
fn canonical_request_and_hmac_match_the_typescript_vector() {
    let request = request("getAppInfo");
    assert_eq!(
        encode_hex(&canonical_request_bytes(&request, &nonce()).expect("canonical request")),
        concat!(
            "6f70656e6c6f6f702e6272696467652e726571756573742e763100",
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
            "0000000100000009726571756573742d310000002438663564376531372d396232",
            "622d346232632d396332612d3166336536623261346439300000000a6765744170",
            "70496e666f000000177b2261223a5b747275652c6e756c6c5d2c227a223a317d",
        ),
    );
    assert_eq!(
        sign_request(request, nonce(), &secret())
            .expect("authenticated request")
            .mac,
        "67238dc6350b46df3b5a3f7acd3212bdd770a086890fb7cd143d4afa3dd23166",
    );
}

#[test]
fn wrong_version_hmac_launch_and_replayed_nonce_fail_before_business_dispatch() {
    let calls = Arc::new(AtomicUsize::new(0));
    let dispatcher = dispatcher(calls.clone());

    let mut wrong_version = sign_request(request("getAppInfo"), nonce(), &secret()).unwrap();
    wrong_version.request.version = 2;
    assert!(dispatcher.dispatch(current_peer(), wrong_version).is_err());

    let mut wrong_hmac = sign_request(request("getAppInfo"), [2; 32], &secret()).unwrap();
    wrong_hmac.mac = "00".repeat(32);
    assert!(dispatcher.dispatch(current_peer(), wrong_hmac).is_err());

    let mut wrong_launch_request = request("getAppInfo");
    wrong_launch_request.launch_id = "7f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90".to_owned();
    let wrong_launch = sign_request(wrong_launch_request, [3; 32], &secret()).unwrap();
    assert!(dispatcher.dispatch(current_peer(), wrong_launch).is_err());

    let replay = sign_request(request("getAppInfo"), [4; 32], &secret()).unwrap();
    assert!(dispatcher.dispatch(current_peer(), replay.clone()).is_ok());
    assert!(dispatcher.dispatch(current_peer(), replay).is_err());

    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn peer_uid_and_exact_supervised_pid_fail_before_business_dispatch() {
    let calls = Arc::new(AtomicUsize::new(0));
    let request = sign_request(request("getAppInfo"), nonce(), &secret()).unwrap();

    let wrong_uid = PeerIdentity {
        uid: unsafe { libc::geteuid() }.saturating_add(1),
        pid: process::id(),
    };
    assert!(dispatcher(calls.clone())
        .dispatch(wrong_uid, request.clone())
        .is_err());

    let wrong_pid = PeerIdentity {
        uid: unsafe { libc::geteuid() },
        pid: process::id().saturating_add(1),
    };
    assert!(dispatcher(calls.clone())
        .dispatch(wrong_pid, request)
        .is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    let expected = current_process_identity();
    assert!(authorize_peer(current_peer(), unsafe { libc::geteuid() }, &expected).is_ok());
    let reused = ProcessIdentity {
        pid: expected.pid.saturating_add(1),
        ..expected
    };
    assert!(authorize_peer(current_peer(), unsafe { libc::geteuid() }, &reused).is_err());
}

#[test]
fn unix_peer_credentials_report_the_connecting_process_without_request_metadata() {
    let fixture = private_socket_root();
    let path = fixture.path().join("peer.sock");
    let listener = BridgeListener::bind(&path).expect("bridge listener");
    let connecting = thread::spawn({
        let path = path.clone();
        move || UnixStream::connect(path).expect("connect bridge socket")
    });
    let (accepted, observed) = listener.accept_peer().expect("accept peer");

    assert_eq!(observed.uid, unsafe { libc::geteuid() });
    assert_eq!(observed.pid, process::id());
    assert_eq!(peer_identity(&accepted).expect("peer identity"), observed);
    drop(connecting.join().expect("connecting thread"));
}

struct HeaderOnlyReader {
    header: Cursor<[u8; 4]>,
    body_reads: usize,
}

impl Read for HeaderOnlyReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.header.read(buffer)?;
        if count == 0 {
            self.body_reads += 1;
        }
        Ok(count)
    }
}

#[test]
fn oversized_frame_is_rejected_from_the_prefix_before_body_read_or_allocation() {
    let mut reader = HeaderOnlyReader {
        header: Cursor::new(((MAX_BRIDGE_FRAME_BYTES + 1) as u32).to_be_bytes()),
        body_reads: 0,
    };
    assert!(openloop_desktop_lib::bridge::protocol::read_frame(&mut reader).is_err());
    assert_eq!(reader.body_reads, 0);
}

#[test]
fn unknown_method_never_reaches_a_business_handler() {
    let calls = Arc::new(AtomicUsize::new(0));
    let dispatcher = dispatcher(calls.clone());
    let unknown = sign_request(request("notRegistered"), nonce(), &secret()).unwrap();
    let response = dispatcher
        .dispatch(current_peer(), unknown)
        .expect("authenticated error response");

    assert!(!response.ok);
    assert_eq!(response.error.expect("error").code, "method_not_found");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn browser_safe_and_host_only_dispatch_tables_are_disjoint_and_complete() {
    assert_eq!(
        BROWSER_SAFE_METHODS,
        [
            "getAppInfo",
            "getUpdateStatus",
            "checkForUpdate",
            "installUpdateAndRestart",
            "describeCredential",
            "openCredentialReplacement",
            "unsetCredential",
            "getCredentialMigrationStatus",
            "listWorkspaceGrants",
            "authorizeWorkspace",
            "reauthorizeWorkspace",
            "revokeWorkspace",
            "revealWorkspace",
        ],
    );
    assert_eq!(
        HOST_ONLY_METHODS,
        [
            "resolveCredential",
            "beginWorkspaceAuthorization",
            "commitWorkspaceAuthorization",
            "abortWorkspaceAuthorization",
            "openWorkspaceFile",
            "spawnWorkspaceProcess",
        ],
    );
    assert!(BROWSER_SAFE_METHODS
        .iter()
        .all(|method| !HOST_ONLY_METHODS.contains(method)));
}

#[test]
fn authenticated_cancel_targets_only_the_exact_active_request() {
    let calls = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(std::sync::Barrier::new(2));
    let observed_cancel = Arc::new(AtomicUsize::new(0));
    let blocking: BridgeHandler = {
        let started = started.clone();
        let observed_cancel = observed_cancel.clone();
        Arc::new(move |_payload, cancellation| {
            calls.fetch_add(1, Ordering::SeqCst);
            started.wait();
            cancellation.wait();
            if cancellation.is_cancelled() {
                observed_cancel.fetch_add(1, Ordering::SeqCst);
            }
            Ok(json!(null))
        })
    };
    let mut browser_safe = HashMap::new();
    browser_safe.insert("getAppInfo".to_owned(), blocking);
    let dispatcher = Arc::new(
        AuthenticatedBridgeDispatcher::new(
            unsafe { libc::geteuid() },
            current_process_identity(),
            Uuid::parse_str(LAUNCH_ID).unwrap(),
            secret(),
            BridgeDispatchTables::new(browser_safe, HashMap::new()).unwrap(),
        )
        .unwrap(),
    );
    let call = {
        let dispatcher = dispatcher.clone();
        thread::spawn(move || {
            dispatcher.dispatch(
                current_peer(),
                sign_request(request("getAppInfo"), [8; 32], &secret()).unwrap(),
            )
        })
    };
    started.wait();

    let mut cancel = request("$cancel");
    cancel.request_id = "cancel-1".to_owned();
    cancel.payload = json!({ "requestId": "request-1" });
    let response = dispatcher
        .dispatch(
            current_peer(),
            sign_request(cancel, [9; 32], &secret()).unwrap(),
        )
        .expect("cancel response");

    assert!(response.ok);
    assert!(call.join().expect("business thread").is_ok());
    assert_eq!(observed_cancel.load(Ordering::SeqCst), 1);
}

#[test]
fn bridge_socket_is_private_reclaims_only_a_stale_socket_and_cleans_up_on_drop() {
    let fixture = private_socket_root();
    let path = fixture.path().join("bridge.sock");
    {
        let stale = std::os::unix::net::UnixListener::bind(&path).expect("stale socket");
        drop(stale);
    }
    let listener = BridgeListener::bind(&path).expect("replace owned stale socket");
    let metadata = fs::symlink_metadata(&path).expect("socket metadata");
    assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
    assert_eq!(metadata.mode() & 0o077, 0);
    drop(listener);
    assert!(!path.exists());

    let regular = fixture.path().join("regular");
    fs::write(&regular, "not a socket").expect("regular file");
    assert!(BridgeListener::bind(&regular).is_err());
    assert_eq!(fs::read_to_string(regular).unwrap(), "not a socket");
}

#[test]
fn bridge_server_serves_one_authenticated_uds_round_trip_and_cleans_up() {
    let fixture = private_socket_root();
    let path = fixture.path().join("bridge.sock");
    let calls = Arc::new(AtomicUsize::new(0));
    let server = BridgeListener::bind(&path)
        .expect("bridge listener")
        .serve(dispatcher(calls.clone()))
        .expect("bridge server");
    let envelope = sign_request(request("getAppInfo"), nonce(), &secret()).unwrap();
    let mut stream = UnixStream::connect(&path).expect("bridge connection");

    stream
        .write_all(&encode_frame(&envelope).expect("request frame"))
        .expect("write request");
    stream
        .shutdown(Shutdown::Write)
        .expect("finish bridge request");
    let response: AuthenticatedBridgeResponse =
        openloop_desktop_lib::bridge::protocol::read_json_frame(&mut stream)
            .expect("authenticated response");

    assert!(response.response.ok);
    assert_eq!(response.response.request_id, "request-1");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    drop(server);
    assert!(!path.exists());
}

#[test]
fn frame_round_trip_is_length_prefixed_json_without_secret_debug_output() {
    let debug_secret = vec![42; 32];
    let envelope: AuthenticatedBridgeRequest =
        sign_request(request("getAppInfo"), nonce(), &debug_secret).unwrap();
    let frame = encode_frame(&envelope).expect("frame");
    assert_eq!(
        u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize,
        frame.len() - 4,
    );
    assert!(!format!("{envelope:?}").contains(&encode_hex(&debug_secret)));

    let decoded: AuthenticatedBridgeRequest =
        serde_json::from_slice(&frame[4..]).expect("frame JSON");
    let nonces = NonceReplayGuard::default();
    assert_eq!(
        verify_request(
            &decoded,
            &Uuid::parse_str(LAUNCH_ID).unwrap(),
            &debug_secret,
            &nonces,
        )
        .expect("verified request"),
        &envelope.request,
    );
}
