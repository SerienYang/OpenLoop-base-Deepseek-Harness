#![cfg(target_os = "macos")]

use std::{
    ffi::OsString,
    time::{SystemTime, UNIX_EPOCH},
};

use openloop_desktop_lib::{
    credentials::{
        credentials_navigation_allowed, parse_keychain_spike_action, CredentialAccount,
        KeychainSpikeAction, KeychainSpikeReport, KeychainStore, SecurePromptState,
        CREDENTIALS_PAGE, CREDENTIALS_WINDOW_HEIGHT, CREDENTIALS_WINDOW_LABEL,
        CREDENTIALS_WINDOW_WIDTH, MAX_SECRET_BYTES,
    },
    update::channel::ReleaseChannel,
};
use tauri::Url;

fn unique_account(label: &str) -> CredentialAccount {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock follows Unix epoch")
        .as_nanos();
    let label = label.replace('-', "_").to_ascii_uppercase();
    CredentialAccount::new(
        "foundation-task",
        &format!("{label}_{}_{nonce}", std::process::id()),
    )
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

#[test]
fn account_is_exact_and_rejects_ambiguous_or_non_ascii_identifiers() {
    let account =
        CredentialAccount::new("anthropic-api", "DEEPSEEK_API_KEY").expect("valid account");
    assert_eq!(account.as_str(), "anthropic-api:DEEPSEEK_API_KEY");

    for invalid_provider in [
        "",
        "Uppercase",
        " leading",
        "trailing ",
        "-leading",
        "trailing-",
        "_leading",
        "trailing_",
        ".leading",
        "trailing.",
        "has:colon",
        "has/slash",
        "has%percent",
        "has space",
        "has\tcontrol",
        "unicodé",
        "double..separator",
        "double--separator",
        "double__separator",
    ] {
        assert!(
            CredentialAccount::new(invalid_provider, "VALID_REFERENCE").is_err(),
            "accepted invalid provider {invalid_provider:?}"
        );
    }

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
            CredentialAccount::new("provider", invalid_reference).is_err(),
            "accepted invalid reference {invalid_reference:?}"
        );
    }

    assert!(CredentialAccount::new(&"a".repeat(64), &format!("A{}", "b".repeat(127))).is_ok());
    assert!(CredentialAccount::new(&"a".repeat(65), "VALID_REFERENCE").is_err());
    assert!(CredentialAccount::new("provider", &format!("A{}", "b".repeat(128))).is_err());
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
}

#[test]
fn prompt_context_rejects_stale_tokens_and_wrong_window_labels() {
    let state = SecurePromptState::default();
    let account = unique_account("prompt");
    let prompt_token = "11".repeat(32);
    let stale_token = "22".repeat(32);

    state
        .activate(account.clone(), prompt_token.clone())
        .expect("first prompt activation");
    assert!(state.activate(account.clone(), "33".repeat(32)).is_err());
    assert!(state.account_for_prompt("main", &prompt_token).is_err());
    assert!(state
        .account_for_prompt(CREDENTIALS_WINDOW_LABEL, &stale_token)
        .is_err());
    assert_eq!(
        state
            .account_for_prompt(CREDENTIALS_WINDOW_LABEL, &prompt_token)
            .expect("credentials context"),
        account
    );
}

#[test]
fn stale_prompt_clear_is_a_no_op_for_a_newer_session() {
    let state = SecurePromptState::default();
    let first_account = unique_account("first-prompt");
    let second_account = unique_account("second-prompt");
    let first_token = "44".repeat(32);
    let second_token = "55".repeat(32);

    state
        .activate(first_account, first_token.clone())
        .expect("first prompt activation");
    assert!(state
        .clear_for_prompt(CREDENTIALS_WINDOW_LABEL, &first_token)
        .expect("clear first prompt"));
    state
        .activate(second_account.clone(), second_token.clone())
        .expect("second prompt activation");
    assert!(!state
        .clear_for_prompt(CREDENTIALS_WINDOW_LABEL, &first_token)
        .expect("stale clear"));
    assert_eq!(
        state
            .account_for_prompt(CREDENTIALS_WINDOW_LABEL, &second_token)
            .expect("new prompt remains active"),
        second_account
    );
    state
        .clear_for_prompt(CREDENTIALS_WINDOW_LABEL, &second_token)
        .expect("clear second prompt");
    assert!(state
        .account_for_prompt(CREDENTIALS_WINDOW_LABEL, &second_token)
        .is_err());
}

#[test]
fn prompt_navigation_allows_only_the_exact_local_app_page() {
    assert_eq!(CREDENTIALS_WINDOW_LABEL, "credentials");
    assert_eq!(CREDENTIALS_PAGE, "src/credentials.html");
    assert_eq!(
        (CREDENTIALS_WINDOW_WIDTH, CREDENTIALS_WINDOW_HEIGHT),
        (420.0, 300.0)
    );

    for allowed in [
        "tauri://localhost/src/credentials.html",
        "http://localhost:1420/src/credentials.html",
    ] {
        assert!(
            credentials_navigation_allowed(&Url::parse(allowed).expect("valid URL")),
            "rejected prompt page {allowed}"
        );
    }
    for denied in [
        "tauri://localhost/",
        "tauri://localhost/src/credentials.html?query=1",
        "tauri://localhost/src/credentials.html#fragment",
        "tauri://localhost/src%2fcredentials.html",
        "https://localhost/src/credentials.html",
        "http://localhost:1420/src/other.html",
        "http://127.0.0.1:1420/src/credentials.html",
        "https://example.com/src/credentials.html",
    ] {
        assert!(
            !credentials_navigation_allowed(&Url::parse(denied).expect("valid URL")),
            "accepted prompt navigation {denied}"
        );
    }
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
