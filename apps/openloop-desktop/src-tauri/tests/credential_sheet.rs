#![cfg(target_os = "macos")]

use std::{
    collections::BTreeMap,
    sync::{mpsc, Arc, Mutex},
    thread,
};

use openloop_desktop_lib::{
    bridge::server::CancellationToken,
    credentials::{
        deletion_consumer_labels, CredentialAccount, CredentialConsumerDisplay,
        CredentialConsumerLabel, CredentialDeletionPlan, CredentialError,
        CredentialReplacementStore, CredentialSheetAction, CredentialSheetCoordinator,
        CredentialSheetOutcome, CredentialSheetPresenter, CredentialSheetRequest,
        CredentialSheetSecret, NativeTextFieldKind, MAIN_WINDOW_LABEL,
    },
};

struct RecordingStore {
    current: Mutex<Vec<u8>>,
    fail_writes: bool,
}

impl RecordingStore {
    fn new(current: &[u8], fail_writes: bool) -> Self {
        Self {
            current: Mutex::new(current.to_vec()),
            fail_writes,
        }
    }
}

impl CredentialReplacementStore for RecordingStore {
    fn replace_credential(
        &self,
        _account: &CredentialAccount,
        secret: &[u8],
    ) -> Result<(), CredentialError> {
        if self.fail_writes {
            return Err(CredentialAccount::new("").expect_err("invalid account"));
        }
        let mut current = self.current.lock().expect("recording store lock");
        current.clear();
        current.extend_from_slice(secret);
        Ok(())
    }
}

struct FixedPresenter {
    action: Mutex<Option<CredentialSheetAction>>,
    requests: Mutex<Vec<CredentialSheetRequest>>,
    clear_count: Mutex<usize>,
}

impl FixedPresenter {
    fn new(action: CredentialSheetAction) -> Self {
        Self {
            action: Mutex::new(Some(action)),
            requests: Mutex::new(Vec::new()),
            clear_count: Mutex::new(0),
        }
    }
}

impl CredentialSheetPresenter for FixedPresenter {
    fn present(
        &self,
        request: &CredentialSheetRequest,
    ) -> Result<CredentialSheetAction, CredentialError> {
        self.requests
            .lock()
            .expect("request lock")
            .push(request.clone());
        Ok(self
            .action
            .lock()
            .expect("action lock")
            .take()
            .expect("one presentation"))
    }

    fn clear_secret_control(&self) {
        *self.clear_count.lock().expect("clear count lock") += 1;
    }
}

fn account() -> CredentialAccount {
    CredentialAccount::new("DEEPSEEK_API_KEY").expect("test account")
}

#[test]
fn native_sheet_attaches_to_main_window_with_empty_secure_input() {
    let presenter = Arc::new(FixedPresenter::new(CredentialSheetAction::Cancelled));
    let store = Arc::new(RecordingStore::new(b"old", false));
    let coordinator = CredentialSheetCoordinator::new(presenter.clone(), store);

    assert_eq!(
        coordinator.replace(account()).expect("cancel sheet"),
        CredentialSheetOutcome::Cancelled
    );

    let requests = presenter.requests.lock().expect("request lock");
    let request = requests.first().expect("sheet request");
    assert_eq!(request.presentation.parent_window_label, MAIN_WINDOW_LABEL);
    assert_eq!(
        request.presentation.text_field_kind,
        NativeTextFieldKind::NSSecureTextField
    );
    assert_eq!(request.presentation.initial_value, "");
    assert!(!request.presentation.creates_independent_window_identity);
}

#[test]
fn save_writes_only_the_confirmed_value_and_zeroizes_all_temporary_storage() {
    let (secret, zeroization) = CredentialSheetSecret::new_observed(b"replacement".to_vec());
    let presenter = Arc::new(FixedPresenter::new(CredentialSheetAction::Save(secret)));
    let store = Arc::new(RecordingStore::new(b"old-old-old", false));
    let coordinator = CredentialSheetCoordinator::new(presenter.clone(), store.clone());

    assert_eq!(
        coordinator.replace(account()).expect("save sheet"),
        CredentialSheetOutcome::Saved
    );
    assert_eq!(
        store
            .current
            .lock()
            .expect("recording store lock")
            .as_slice(),
        b"replacement"
    );
    assert!(zeroization.is_zeroized());
    assert_eq!(*presenter.clear_count.lock().expect("clear count lock"), 1);
}

#[test]
fn cancel_retains_the_old_value_and_clears_the_native_control() {
    let presenter = Arc::new(FixedPresenter::new(CredentialSheetAction::Cancelled));
    let store = Arc::new(RecordingStore::new(b"old", false));
    let coordinator = CredentialSheetCoordinator::new(presenter.clone(), store.clone());

    assert_eq!(
        coordinator.replace(account()).expect("cancel sheet"),
        CredentialSheetOutcome::Cancelled
    );
    assert_eq!(
        store
            .current
            .lock()
            .expect("recording store lock")
            .as_slice(),
        b"old"
    );
    assert_eq!(*presenter.clear_count.lock().expect("clear count lock"), 1);
}

#[test]
fn invalid_or_failed_writes_retain_the_old_value_and_zeroize_input() {
    for value in [Vec::new(), vec![b'x'; 8193], b"replacement".to_vec()] {
        let write_failure = value == b"replacement";
        let (secret, zeroization) = CredentialSheetSecret::new_observed(value);
        let presenter = Arc::new(FixedPresenter::new(CredentialSheetAction::Save(secret)));
        let store = Arc::new(RecordingStore::new(b"old", write_failure));
        let coordinator = CredentialSheetCoordinator::new(presenter.clone(), store.clone());

        assert!(coordinator.replace(account()).is_err());
        assert_eq!(
            store
                .current
                .lock()
                .expect("recording store lock")
                .as_slice(),
            b"old"
        );
        assert!(zeroization.is_zeroized());
        assert_eq!(*presenter.clear_count.lock().expect("clear count lock"), 1);
    }
}

struct BlockingPresenter {
    entered: Mutex<Option<mpsc::Sender<()>>>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl CredentialSheetPresenter for BlockingPresenter {
    fn present(
        &self,
        _request: &CredentialSheetRequest,
    ) -> Result<CredentialSheetAction, CredentialError> {
        if let Some(entered) = self.entered.lock().expect("entered lock").take() {
            entered.send(()).expect("report sheet entry");
        }
        self.release
            .lock()
            .expect("release lock")
            .recv()
            .expect("release sheet");
        Ok(CredentialSheetAction::Cancelled)
    }

    fn clear_secret_control(&self) {}
}

#[test]
fn only_one_credential_sheet_can_be_active() {
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let presenter = Arc::new(BlockingPresenter {
        entered: Mutex::new(Some(entered_tx)),
        release: Mutex::new(release_rx),
    });
    let store = Arc::new(RecordingStore::new(b"old", false));
    let coordinator = Arc::new(CredentialSheetCoordinator::new(presenter, store));
    let first = {
        let coordinator = coordinator.clone();
        thread::spawn(move || coordinator.replace(account()))
    };
    entered_rx.recv().expect("first sheet entered");

    assert!(coordinator.replace(account()).is_err());

    release_tx.send(()).expect("release first sheet");
    assert_eq!(
        first.join().expect("sheet thread").expect("first outcome"),
        CredentialSheetOutcome::Cancelled
    );
}

#[test]
fn cancellation_while_the_sheet_is_open_prevents_a_late_save() {
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let presenter = Arc::new(BlockingSavePresenter {
        entered: Mutex::new(Some(entered_tx)),
        release: Mutex::new(release_rx),
    });
    let store = Arc::new(RecordingStore::new(b"old", false));
    let coordinator = Arc::new(CredentialSheetCoordinator::new(presenter, store.clone()));
    let cancellation = CancellationToken::default();
    let pending = {
        let coordinator = coordinator.clone();
        let cancellation = cancellation.clone();
        thread::spawn(move || coordinator.replace_cancellable(account(), &cancellation))
    };
    entered_rx.recv().expect("sheet entered");
    cancellation.cancel();
    release_tx.send(()).expect("release sheet");

    assert_eq!(
        pending
            .join()
            .expect("sheet thread")
            .expect("sheet outcome"),
        CredentialSheetOutcome::Cancelled
    );
    assert_eq!(
        store
            .current
            .lock()
            .expect("recording store lock")
            .as_slice(),
        b"old"
    );
}

struct BlockingSavePresenter {
    entered: Mutex<Option<mpsc::Sender<()>>>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl CredentialSheetPresenter for BlockingSavePresenter {
    fn present(
        &self,
        _request: &CredentialSheetRequest,
    ) -> Result<CredentialSheetAction, CredentialError> {
        if let Some(entered) = self.entered.lock().expect("entered lock").take() {
            entered.send(()).expect("report sheet entry");
        }
        self.release
            .lock()
            .expect("release lock")
            .recv()
            .expect("release sheet");
        Ok(CredentialSheetAction::Save(CredentialSheetSecret::new(
            b"replacement".to_vec(),
        )))
    }

    fn clear_secret_control(&self) {}
}

#[test]
fn deletion_confirmation_renders_every_host_owned_consumer_label() {
    let plan = CredentialDeletionPlan {
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
            CredentialConsumerLabel {
                owner_id: "plugin:mcp-client:docs".to_owned(),
                kind: "plugin".to_owned(),
                display: CredentialConsumerDisplay {
                    key: "openloop.credentials.consumer.mcp-server".to_owned(),
                    values: BTreeMap::from([("serverName".to_owned(), "docs".to_owned())]),
                },
            },
        ],
    };

    assert_eq!(
        deletion_consumer_labels(&plan).expect("validated labels"),
        [
            "Model route: deepseek-official",
            "DeepSeek Web Search",
            "MCP server: docs",
        ]
    );
}

#[test]
fn production_backend_uses_appkit_sheet_without_a_second_webview() {
    let source = include_str!("../src/credentials/secure_sheet.rs");

    assert!(source.contains("run_on_main_thread"));
    assert!(source.contains("MainThreadMarker"));
    assert!(source.contains("NSSecureTextField"));
    assert!(source.contains("beginSheet"));
    assert!(!source.contains("WebviewWindowBuilder"));
    assert!(!source.contains("WebviewUrl"));
    assert!(!source.contains("NSApplication::sharedApplication"));
}
