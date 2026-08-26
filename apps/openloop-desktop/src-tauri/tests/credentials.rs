#![cfg(target_os = "macos")]

use std::{
    collections::BTreeMap,
    ffi::OsString,
    process,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use openloop_desktop_lib::{
    bridge::{
        protocol::{
            encode_frame, read_json_frame, sign_request, sign_response,
            AuthenticatedBridgeResponse, BridgeRequest, BRIDGE_PROTOCOL_VERSION,
            MAX_BRIDGE_FRAME_BYTES,
        },
        server::{AuthenticatedBridgeDispatcher, CancellationToken, PeerIdentity},
    },
    credentials::{
        credential_bridge_dispatch_tables, delete_credential_with_confirmation,
        parse_keychain_spike_action, CredentialAccount, CredentialConsumerDisplay,
        CredentialConsumerLabel, CredentialDeletionConfirmation, CredentialDeletionOutcome,
        CredentialDeletionPlan, CredentialDeletionStore, CredentialError, CredentialReplacement,
        CredentialSheetOutcome, KeychainSpikeAction, KeychainSpikeReport, KeychainStore,
        MAX_SECRET_BYTES,
    },
    launcher::capture_process_identity,
    update::channel::ReleaseChannel,
};
use security_framework::passwords::{set_generic_password_options, PasswordOptions};
use serde_json::json;
use uuid::Uuid;

fn unique_account(label: &str) -> CredentialAccount {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock follows Unix epoch")
        .as_nanos();
    let label = label.replace('-', "_").to_ascii_uppercase();
    CredentialAccount::new(&format!("{label}_{}_{nonce}", std::process::id()))
        .expect("unique account is valid")
}

struct KeychainCleanup {
    account: CredentialAccount,
}

impl KeychainCleanup {
    fn new(account: CredentialAccount) -> Self {
        Self { account }
    }
}

impl Drop for KeychainCleanup {
    fn drop(&mut self) {
        let _ = KeychainStore::new(ReleaseChannel::Test).delete(&self.account);
        let _ = KeychainStore::new(ReleaseChannel::Stable).delete(&self.account);
    }
}

#[test]
fn services_are_exact_and_derived_only_from_release_channel() {
    assert_eq!(
        KeychainStore::new(ReleaseChannel::Test).service(),
        "ai.openloop.credentials.test.v1"
    );
    assert_eq!(
        KeychainStore::new(ReleaseChannel::Stable).service(),
        "ai.openloop.credentials.v1"
    );
}

fn credential_dispatcher(
    confirmation: Arc<dyn CredentialDeletionConfirmation>,
) -> (AuthenticatedBridgeDispatcher, Uuid, Vec<u8>, PeerIdentity) {
    credential_dispatcher_with_ui(None, Some(confirmation))
}

fn credential_dispatcher_with_ui(
    replacement: Option<Arc<dyn CredentialReplacement>>,
    confirmation: Option<Arc<dyn CredentialDeletionConfirmation>>,
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
        credential_bridge_dispatch_tables(
            KeychainStore::new(ReleaseChannel::Test),
            replacement,
            confirmation,
        )
        .expect("credential tables"),
    )
    .expect("credential dispatcher");
    (dispatcher, launch_id, secret, peer)
}

fn dispatch_credential(method: &str, payload: serde_json::Value) -> serde_json::Value {
    let (dispatcher, launch_id, secret, peer) =
        credential_dispatcher(Arc::new(FixedConfirmation::new(false)));
    let request = BridgeRequest {
        version: BRIDGE_PROTOCOL_VERSION,
        request_id: "credential-request".to_owned(),
        launch_id: launch_id.to_string(),
        method: method.to_owned(),
        payload,
    };
    let response = dispatcher
        .dispatch(
            peer,
            sign_request(request, [7; 32], &secret).expect("signed credential request"),
        )
        .expect("authenticated credential response");
    serde_json::to_value(response).expect("response JSON")
}

#[test]
fn credential_bridge_dispatch_is_strict_and_keeps_resolution_host_only() {
    let missing = dispatch_credential(
        "resolveCredential",
        json!({ "ref": "OPENLOOP_TASK_13_MISSING" }),
    );
    assert_eq!(missing["ok"], true);
    assert!(missing["result"].is_null());

    let malformed = dispatch_credential(
        "openCredentialReplacement",
        json!({ "ref": "OPENLOOP_TASK_13_MISSING", "consumerNames": ["spoof"] }),
    );
    assert_eq!(malformed["ok"], false);
    assert_eq!(malformed["error"]["code"], "invalid_request");
}

#[test]
fn native_credential_status_is_read_only_without_both_mutation_presenters() {
    let account = unique_account("native_read_only");
    let _cleanup = KeychainCleanup::new(account.clone());
    let reference = account
        .as_str()
        .strip_prefix("credential:")
        .expect("credential account prefix");

    let missing = dispatch_credential("describeCredential", json!({ "ref": reference }));
    assert_eq!(missing["ok"], true);
    assert_eq!(
        missing["result"],
        json!({ "configured": false, "writable": false })
    );

    KeychainStore::new(ReleaseChannel::Test)
        .set(&account, b"configured")
        .expect("store configured credential");
    let configured = dispatch_credential("describeCredential", json!({ "ref": reference }));
    assert_eq!(configured["ok"], true);
    assert_eq!(
        configured["result"],
        json!({ "configured": true, "source": "keychain", "writable": false })
    );
}

#[derive(Default)]
struct RecordingReplacement {
    accounts: Mutex<Vec<String>>,
}

impl CredentialReplacement for RecordingReplacement {
    fn replace(
        &self,
        account: CredentialAccount,
        _cancellation: &CancellationToken,
    ) -> Result<CredentialSheetOutcome, CredentialError> {
        self.accounts
            .lock()
            .expect("replacement account lock")
            .push(account.as_str().to_owned());
        Ok(CredentialSheetOutcome::Saved)
    }
}

#[test]
fn bridge_is_writable_and_replaces_only_when_both_native_presenters_are_installed() {
    let replacement = Arc::new(RecordingReplacement::default());
    let (dispatcher, launch_id, secret, peer) = credential_dispatcher_with_ui(
        Some(replacement.clone()),
        Some(Arc::new(FixedConfirmation::new(false))),
    );
    let status_request = BridgeRequest {
        version: BRIDGE_PROTOCOL_VERSION,
        request_id: "native-status".to_owned(),
        launch_id: launch_id.to_string(),
        method: "describeCredential".to_owned(),
        payload: json!({ "ref": "NATIVE_WRITABLE" }),
    };
    let status = dispatcher
        .dispatch(
            peer,
            sign_request(status_request, [4; 32], &secret).expect("signed status request"),
        )
        .expect("status response");
    let status = serde_json::to_value(status).expect("status JSON");
    assert_eq!(
        status["result"],
        json!({ "configured": false, "writable": true })
    );

    let replacement_request = BridgeRequest {
        version: BRIDGE_PROTOCOL_VERSION,
        request_id: "native-replacement".to_owned(),
        launch_id: launch_id.to_string(),
        method: "openCredentialReplacement".to_owned(),
        payload: json!({ "ref": "NATIVE_WRITABLE" }),
    };
    let outcome = dispatcher
        .dispatch(
            peer,
            sign_request(replacement_request, [5; 32], &secret)
                .expect("signed replacement request"),
        )
        .expect("replacement response");
    let outcome = serde_json::to_value(outcome).expect("replacement JSON");
    assert_eq!(outcome["result"], "saved");
    assert_eq!(
        replacement
            .accounts
            .lock()
            .expect("replacement account lock")
            .as_slice(),
        &["credential:NATIVE_WRITABLE"]
    );
}

#[test]
fn account_is_exact_and_rejects_ambiguous_or_non_ascii_identifiers() {
    let account = CredentialAccount::new("DEEPSEEK_API_KEY").expect("valid account");
    assert_eq!(account.as_str(), "credential:DEEPSEEK_API_KEY");

    for invalid_reference in [
        "",
        " leading",
        "trailing ",
        "1_LEADING_DIGIT",
        "-leading",
        "trailing-",
        ".leading",
        "trailing.",
        "has:colon",
        "has/slash",
        "has%percent",
        "has space",
        "has\tcontrol",
        "unicodé",
    ] {
        assert!(
            CredentialAccount::new(invalid_reference).is_err(),
            "accepted invalid reference {invalid_reference:?}"
        );
    }

    assert!(CredentialAccount::new(&format!("A{}", "b".repeat(127))).is_ok());
    assert!(CredentialAccount::new(&format!("A{}", "b".repeat(128))).is_err());
}

#[derive(Default)]
struct RecordingDeletionStore {
    deleted: Mutex<Vec<String>>,
}

impl CredentialDeletionStore for RecordingDeletionStore {
    fn delete_credential(&self, account: &CredentialAccount) -> Result<(), CredentialError> {
        self.deleted
            .lock()
            .expect("recording store lock")
            .push(account.as_str().to_owned());
        Ok(())
    }
}

struct FixedConfirmation {
    confirmed: bool,
    observed: Mutex<Vec<CredentialDeletionPlan>>,
}

impl FixedConfirmation {
    fn new(confirmed: bool) -> Self {
        Self {
            confirmed,
            observed: Mutex::new(Vec::new()),
        }
    }
}

impl CredentialDeletionConfirmation for FixedConfirmation {
    fn confirm_deletion(&self, plan: &CredentialDeletionPlan) -> Result<bool, CredentialError> {
        self.observed
            .lock()
            .expect("confirmation lock")
            .push(plan.clone());
        Ok(self.confirmed)
    }
}

fn deletion_plan() -> CredentialDeletionPlan {
    CredentialDeletionPlan {
        reference: "SHARED_API_KEY".to_owned(),
        consumers: vec![
            CredentialConsumerLabel {
                owner_id: "model-route:deepseek-official".to_owned(),
                kind: "model-route".to_owned(),
                display: CredentialConsumerDisplay {
                    key: "openloop.credentials.consumer.model-route".to_owned(),
                    values: BTreeMap::from([(
                        "routeId".to_owned(),
                        "deepseek-official".to_owned(),
                    )]),
                },
            },
            CredentialConsumerLabel {
                owner_id: "plugin:web-search-deepseek".to_owned(),
                kind: "plugin".to_owned(),
                display: CredentialConsumerDisplay {
                    key: "openloop.credentials.consumer.web-search-deepseek".to_owned(),
                    values: BTreeMap::new(),
                },
            },
        ],
    }
}

fn deletion_plan_payload(reference: &str) -> serde_json::Value {
    json!({
        "reference": reference,
        "consumers": [{
            "ownerId": "model-route:deepseek-official",
            "kind": "model-route",
            "display": {
                "key": "openloop.credentials.consumer.model-route",
                "values": { "routeId": "deepseek-official" },
            },
        }],
    })
}

#[test]
fn native_deletion_confirmation_cancel_retains_the_keychain_item() {
    let store = RecordingDeletionStore::default();
    let confirmation = FixedConfirmation::new(false);
    let plan = deletion_plan();

    assert_eq!(
        delete_credential_with_confirmation(&store, &confirmation, plan.clone())
            .expect("cancel deletion"),
        CredentialDeletionOutcome::Cancelled
    );
    assert!(store.deleted.lock().expect("store lock").is_empty());
    assert_eq!(
        confirmation
            .observed
            .lock()
            .expect("confirmation lock")
            .as_slice(),
        &[plan]
    );
}

#[test]
fn native_deletion_confirmation_deletes_only_after_confirmation() {
    let store = RecordingDeletionStore::default();
    let confirmation = FixedConfirmation::new(true);

    assert_eq!(
        delete_credential_with_confirmation(&store, &confirmation, deletion_plan())
            .expect("confirmed deletion"),
        CredentialDeletionOutcome::Deleted
    );
    assert_eq!(
        store.deleted.lock().expect("store lock").as_slice(),
        &["credential:SHARED_API_KEY"]
    );
}

struct BlockingApproval {
    entered: Mutex<Option<mpsc::Sender<()>>>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl CredentialDeletionConfirmation for BlockingApproval {
    fn confirm_deletion(&self, _plan: &CredentialDeletionPlan) -> Result<bool, CredentialError> {
        if let Some(entered) = self.entered.lock().expect("entered lock").take() {
            entered.send(()).expect("report confirmation entry");
        }
        self.release
            .lock()
            .expect("release lock")
            .recv()
            .expect("release confirmation");
        Ok(true)
    }
}

#[test]
fn bridge_cancellation_while_confirmation_is_pending_prevents_deletion() {
    let reference = format!(
        "CANCEL_PENDING_{}_{}",
        process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock follows Unix epoch")
            .as_nanos()
    );
    let account = CredentialAccount::new(&reference).expect("cancellation account");
    let _cleanup = KeychainCleanup::new(account.clone());
    let store = KeychainStore::new(ReleaseChannel::Test);
    store
        .set(&account, b"pending-cancellation-secret")
        .expect("seed cancellation credential");
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let confirmation = Arc::new(BlockingApproval {
        entered: Mutex::new(Some(entered_tx)),
        release: Mutex::new(release_rx),
    });
    let (dispatcher, launch_id, secret, peer) = credential_dispatcher(confirmation);
    let delete_request = BridgeRequest {
        version: BRIDGE_PROTOCOL_VERSION,
        request_id: "pending-delete".to_owned(),
        launch_id: launch_id.to_string(),
        method: "unsetCredential".to_owned(),
        payload: deletion_plan_payload(&reference),
    };
    let delete_dispatcher = dispatcher.clone();
    let delete_secret = secret.clone();
    let pending = thread::spawn(move || {
        delete_dispatcher
            .dispatch(
                peer,
                sign_request(delete_request, [8; 32], &delete_secret)
                    .expect("signed deletion request"),
            )
            .expect("deletion response")
    });
    entered_rx.recv().expect("confirmation opened");

    let cancel_request = BridgeRequest {
        version: BRIDGE_PROTOCOL_VERSION,
        request_id: "cancel-pending-delete".to_owned(),
        launch_id: launch_id.to_string(),
        method: "$cancel".to_owned(),
        payload: json!({ "requestId": "pending-delete" }),
    };
    dispatcher
        .dispatch(
            peer,
            sign_request(cancel_request, [9; 32], &secret).expect("signed cancellation request"),
        )
        .expect("cancellation response");
    release_tx.send(()).expect("approve confirmation");

    let response =
        serde_json::to_value(pending.join().expect("deletion thread")).expect("response JSON");
    assert_eq!(response["result"], "cancelled");
    assert_eq!(
        store
            .resolve(&account)
            .expect("credential retained")
            .as_slice(),
        b"pending-cancellation-secret"
    );
}

#[test]
fn bridge_serializes_replacement_against_confirmed_deletion_commit() {
    let reference = format!(
        "MUTATION_SERIALIZATION_{}_{}",
        process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock follows Unix epoch")
            .as_nanos()
    );
    let replacement = Arc::new(RecordingReplacement::default());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let confirmation = Arc::new(BlockingApproval {
        entered: Mutex::new(Some(entered_tx)),
        release: Mutex::new(release_rx),
    });
    let (dispatcher, launch_id, secret, peer) =
        credential_dispatcher_with_ui(Some(replacement.clone()), Some(confirmation));
    let delete_request = BridgeRequest {
        version: BRIDGE_PROTOCOL_VERSION,
        request_id: "serialized-delete".to_owned(),
        launch_id: launch_id.to_string(),
        method: "unsetCredential".to_owned(),
        payload: deletion_plan_payload(&reference),
    };
    let delete_dispatcher = dispatcher.clone();
    let delete_secret = secret.clone();
    let pending = thread::spawn(move || {
        delete_dispatcher
            .dispatch(
                peer,
                sign_request(delete_request, [12; 32], &delete_secret)
                    .expect("signed deletion request"),
            )
            .expect("deletion response")
    });
    entered_rx.recv().expect("confirmation opened");

    let replace_request = BridgeRequest {
        version: BRIDGE_PROTOCOL_VERSION,
        request_id: "overlapping-replacement".to_owned(),
        launch_id: launch_id.to_string(),
        method: "openCredentialReplacement".to_owned(),
        payload: json!({ "ref": reference }),
    };
    let replacement_response = dispatcher
        .dispatch(
            peer,
            sign_request(replace_request, [13; 32], &secret).expect("signed replacement request"),
        )
        .expect("replacement response");
    let replacement_response =
        serde_json::to_value(replacement_response).expect("replacement JSON");
    assert_eq!(replacement_response["ok"], false);
    assert_eq!(replacement_response["error"]["code"], "credential_failure");
    assert!(replacement
        .accounts
        .lock()
        .expect("replacement account lock")
        .is_empty());

    release_tx.send(()).expect("release confirmation");
    let deletion_response =
        serde_json::to_value(pending.join().expect("deletion thread")).expect("deletion JSON");
    assert_eq!(deletion_response["result"], "deleted");
}

#[test]
fn bridge_pre_cancellation_skips_confirmation_and_deletion() {
    let reference = format!(
        "CANCEL_BEFORE_{}_{}",
        process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock follows Unix epoch")
            .as_nanos()
    );
    let account = CredentialAccount::new(&reference).expect("pre-cancellation account");
    let _cleanup = KeychainCleanup::new(account.clone());
    let store = KeychainStore::new(ReleaseChannel::Test);
    store
        .set(&account, b"pre-cancellation-secret")
        .expect("seed pre-cancellation credential");
    let confirmation = Arc::new(FixedConfirmation::new(true));
    let (dispatcher, launch_id, secret, peer) = credential_dispatcher(confirmation.clone());
    let cancel_request = BridgeRequest {
        version: BRIDGE_PROTOCOL_VERSION,
        request_id: "cancel-before-delete".to_owned(),
        launch_id: launch_id.to_string(),
        method: "$cancel".to_owned(),
        payload: json!({ "requestId": "pre-cancelled-delete" }),
    };
    dispatcher
        .dispatch(
            peer,
            sign_request(cancel_request, [10; 32], &secret)
                .expect("signed pre-cancellation request"),
        )
        .expect("pre-cancellation response");
    let delete_request = BridgeRequest {
        version: BRIDGE_PROTOCOL_VERSION,
        request_id: "pre-cancelled-delete".to_owned(),
        launch_id: launch_id.to_string(),
        method: "unsetCredential".to_owned(),
        payload: deletion_plan_payload(&reference),
    };

    let response = dispatcher
        .dispatch(
            peer,
            sign_request(delete_request, [11; 32], &secret).expect("signed deletion request"),
        )
        .expect("deletion response");
    let response = serde_json::to_value(response).expect("response JSON");

    assert_eq!(response["result"], "cancelled");
    assert!(confirmation
        .observed
        .lock()
        .expect("confirmation lock")
        .is_empty());
    assert_eq!(
        store
            .resolve(&account)
            .expect("credential retained")
            .as_slice(),
        b"pre-cancellation-secret"
    );
}

#[test]
fn native_deletion_rejects_unrecognized_display_keys_before_confirmation() {
    let store = RecordingDeletionStore::default();
    let confirmation = FixedConfirmation::new(true);
    let mut plan = deletion_plan();
    plan.consumers[0].display.key = "browser.controls.this".to_owned();

    assert!(delete_credential_with_confirmation(&store, &confirmation, plan).is_err());
    assert!(confirmation
        .observed
        .lock()
        .expect("confirmation lock")
        .is_empty());
    assert!(store.deleted.lock().expect("store lock").is_empty());
}

#[test]
fn keychain_roundtrip_isolated_by_service_and_cleanup_is_idempotent() {
    let account = unique_account("roundtrip");
    let _cleanup = KeychainCleanup::new(account.clone());
    let test_store = KeychainStore::new(ReleaseChannel::Test);
    let stable_store = KeychainStore::new(ReleaseChannel::Stable);

    test_store
        .delete(&account)
        .expect("missing delete is idempotent");
    stable_store
        .delete(&account)
        .expect("missing stable delete is idempotent");
    assert!(!test_store.status(&account).expect("missing test status"));
    assert!(!stable_store
        .status(&account)
        .expect("missing stable status"));

    test_store
        .set(&account, b"test-channel-secret")
        .expect("set test credential");
    assert!(test_store.status(&account).expect("configured test status"));
    assert!(!stable_store
        .status(&account)
        .expect("isolated stable status"));
    assert_eq!(
        test_store
            .resolve(&account)
            .expect("resolve test")
            .as_slice(),
        b"test-channel-secret"
    );

    stable_store
        .set(&account, b"stable-channel-secret")
        .expect("set stable credential");
    assert_eq!(
        stable_store
            .resolve(&account)
            .expect("resolve stable")
            .as_slice(),
        b"stable-channel-secret"
    );
    assert_eq!(
        test_store
            .resolve(&account)
            .expect("resolve test")
            .as_slice(),
        b"test-channel-secret"
    );

    test_store.delete(&account).expect("delete test credential");
    test_store
        .delete(&account)
        .expect("repeated test delete is idempotent");
    assert!(!test_store.status(&account).expect("deleted test status"));
    assert!(stable_store
        .status(&account)
        .expect("stable remains configured"));
}

#[test]
fn secret_size_bounds_are_enforced_before_keychain_access() {
    let account = unique_account("bounds");
    let store = KeychainStore::new(ReleaseChannel::Test);

    assert!(store.set(&account, &[]).is_err());
    assert!(store
        .set(&account, &vec![b'x'; MAX_SECRET_BYTES + 1])
        .is_err());
    assert!(!store
        .status(&account)
        .expect("oversized write was not attempted"));
}

#[test]
fn maximum_secret_resolves_through_a_bounded_bridge_response_frame() {
    let account = unique_account("bridge_maximum");
    let _cleanup = KeychainCleanup::new(account.clone());
    let store = KeychainStore::new(ReleaseChannel::Test);
    let maximum = vec![u8::MAX; MAX_SECRET_BYTES];
    store
        .set(&account, &maximum)
        .expect("store maximum credential");
    let reference = account
        .as_str()
        .strip_prefix("credential:")
        .expect("credential account prefix");
    let (dispatcher, launch_id, secret, peer) =
        credential_dispatcher(Arc::new(FixedConfirmation::new(false)));
    let request = BridgeRequest {
        version: BRIDGE_PROTOCOL_VERSION,
        request_id: "maximum-secret".to_owned(),
        launch_id: launch_id.to_string(),
        method: "resolveCredential".to_owned(),
        payload: json!({ "ref": reference }),
    };
    let response = dispatcher
        .dispatch(
            peer,
            sign_request(request, [10; 32], &secret).expect("signed resolve request"),
        )
        .expect("maximum credential response");
    let response = sign_response(response, [10; 32], &secret).expect("signed credential response");
    let frame = encode_frame(&response).expect("maximum credential frame");

    assert!(frame.len() - 4 <= MAX_BRIDGE_FRAME_BYTES);
    let decoded: AuthenticatedBridgeResponse =
        read_json_frame(&mut frame.as_slice()).expect("maximum credential round trip");
    assert_eq!(
        decoded.response.result.expect("credential result"),
        serde_json::to_value(maximum).expect("maximum credential JSON")
    );
}

#[test]
fn oversized_existing_keychain_value_fails_before_bridge_serialization() {
    let account = unique_account("bridge_oversized");
    let _cleanup = KeychainCleanup::new(account.clone());
    let store = KeychainStore::new(ReleaseChannel::Test);
    let mut options = PasswordOptions::new_generic_password(store.service(), account.as_str());
    options.set_access_synchronized(Some(false));
    set_generic_password_options(&vec![b'x'; MAX_SECRET_BYTES + 1], options)
        .expect("seed oversized external Keychain item");
    let reference = account
        .as_str()
        .strip_prefix("credential:")
        .expect("credential account prefix");

    let response = dispatch_credential("resolveCredential", json!({ "ref": reference }));

    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "credential_failure");
    assert!(serde_json::to_vec(&response).expect("response JSON").len() < 1024);
}

#[test]
fn keychain_spike_parser_is_exact_test_only_and_argument_free() {
    assert_eq!(
        parse_keychain_spike_action(&[], ReleaseChannel::Test).expect("normal"),
        None
    );
    assert_eq!(
        parse_keychain_spike_action(
            &[OsString::from("--openloop-keychain-spike=set")],
            ReleaseChannel::Test,
        )
        .expect("set"),
        Some(KeychainSpikeAction::Set)
    );
    assert_eq!(
        parse_keychain_spike_action(
            &[OsString::from("--openloop-keychain-spike=verify")],
            ReleaseChannel::Test,
        )
        .expect("verify"),
        Some(KeychainSpikeAction::Verify)
    );
    assert_eq!(
        parse_keychain_spike_action(
            &[OsString::from("--openloop-keychain-spike=cleanup")],
            ReleaseChannel::Test,
        )
        .expect("cleanup"),
        Some(KeychainSpikeAction::Cleanup)
    );
    assert_eq!(
        parse_keychain_spike_action(
            &[OsString::from("--ordinary-tauri-argument")],
            ReleaseChannel::Test,
        )
        .expect("ordinary"),
        None
    );

    for arguments in [
        vec![OsString::from("--openloop-keychain")],
        vec![OsString::from("--openloop-keychain-spike")],
        vec![OsString::from("--openloop-keychain-spike=unknown")],
        vec![
            OsString::from("--openloop-keychain-spike=set"),
            OsString::from("extra"),
        ],
    ] {
        assert!(
            parse_keychain_spike_action(&arguments, ReleaseChannel::Test).is_err(),
            "accepted private keychain arguments {arguments:?}"
        );
    }
    assert!(parse_keychain_spike_action(
        &[OsString::from("--openloop-keychain-spike=set")],
        ReleaseChannel::Stable,
    )
    .is_err());
}

#[test]
fn keychain_spike_output_is_bounded_and_contains_no_sensitive_identity() {
    let line = KeychainSpikeReport {
        action: KeychainSpikeAction::Verify,
        configured: true,
        verified: true,
    }
    .json_line()
    .expect("serialize spike report");
    let value: serde_json::Value = serde_json::from_str(line.trim()).expect("valid report JSON");

    assert_eq!(
        value,
        serde_json::json!({
            "action": "verify",
            "configured": true,
            "verified": true,
        })
    );
    assert!(!line.contains("secret"));
    assert!(!line.contains("account"));
    assert!(line.len() < 96);
}
