use std::{
    collections::{BTreeMap, HashMap, HashSet},
    error::Error,
    ffi::OsString,
    fmt,
    os::unix::ffi::OsStrExt,
    sync::Arc,
};

use security_framework::{
    item::{ItemClass, ItemSearchOptions},
    passwords::{
        delete_generic_password_options, generic_password, set_generic_password_options,
        PasswordOptions,
    },
};
use security_framework_sys::base::errSecItemNotFound;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::bridge::{
    server::{BridgeHandler, CancellationToken},
    BridgeDispatchTables,
};
use crate::update::channel::ReleaseChannel;

pub mod migration;
mod secure_sheet;

pub use secure_sheet::{
    deletion_consumer_labels, AppKitCredentialDeletionBackend,
    AppKitCredentialDeletionConfirmation, AppKitCredentialSheet, AppKitCredentialSheetBackend,
    CredentialDeletionCompletion, CredentialDeletionSheetPresentation, CredentialReplacement,
    CredentialReplacementStore, CredentialSheetAction, CredentialSheetCompletion,
    CredentialSheetCoordinator, CredentialSheetGate, CredentialSheetOutcome,
    CredentialSheetPresentation, CredentialSheetPresenter, CredentialSheetRequest,
    CredentialSheetSecret, CredentialSheetZeroizationProbe, NativeTextFieldKind, MAIN_WINDOW_LABEL,
};

pub const MAX_SECRET_BYTES: usize = 8 * 1024;
pub const MAX_CREDENTIAL_REFERENCE_BYTES: usize = 128;
pub const MAX_CREDENTIAL_CONSUMERS: usize = 255;
pub const MAX_CREDENTIAL_CONSUMER_FIELD_BYTES: usize = 256;
pub const MAX_CREDENTIAL_DELETION_PLAN_BYTES: usize = 56 * 1024;

const TEST_KEYCHAIN_SERVICE: &str = "ai.openloop.credentials.test.v1";
const STABLE_KEYCHAIN_SERVICE: &str = "ai.openloop.credentials.v1";
const KEYCHAIN_SPIKE_PREFIX: &[u8] = b"--openloop-keychain";
const KEYCHAIN_SPIKE_SET: &str = "--openloop-keychain-spike=set";
const KEYCHAIN_SPIKE_VERIFY: &str = "--openloop-keychain-spike=verify";
const KEYCHAIN_SPIKE_CLEANUP: &str = "--openloop-keychain-spike=cleanup";
const SPIKE_REFERENCE: &str = "OPENLOOP_FOUNDATION_TASK_15_SPIKE";
const SPIKE_SECRET: &[u8] = b"openloop-keychain-spike-v1";
#[derive(Clone, PartialEq, Eq)]
pub struct CredentialAccount(String);

impl CredentialAccount {
    pub fn new(credential_reference: &str) -> Result<Self, CredentialError> {
        validate_credential_reference(credential_reference)?;
        Ok(Self(format!("credential:{credential_reference}")))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for CredentialAccount {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CredentialAccount([redacted])")
    }
}

fn validate_credential_reference(value: &str) -> Result<(), CredentialError> {
    if value.is_empty() || value.len() > MAX_CREDENTIAL_REFERENCE_BYTES || !value.is_ascii() {
        return Err(CredentialError::invalid_identifier());
    }
    let mut bytes = value.bytes();
    if !bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err(CredentialError::invalid_identifier());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
pub struct KeychainStore {
    channel: ReleaseChannel,
}

impl KeychainStore {
    pub fn new(channel: ReleaseChannel) -> Self {
        Self { channel }
    }

    pub fn service(&self) -> &'static str {
        match self.channel {
            ReleaseChannel::Test => TEST_KEYCHAIN_SERVICE,
            ReleaseChannel::Stable => STABLE_KEYCHAIN_SERVICE,
        }
    }

    pub fn set(&self, account: &CredentialAccount, secret: &[u8]) -> Result<(), CredentialError> {
        validate_secret(secret)?;
        let options = self.password_options(account);
        set_generic_password_options(secret, options)
            .map_err(|error| CredentialError::keychain("set", error.code()))
    }

    pub fn resolve(
        &self,
        account: &CredentialAccount,
    ) -> Result<Zeroizing<Vec<u8>>, CredentialError> {
        let options = self.password_options(account);
        generic_password(options)
            .map(Zeroizing::new)
            .map_err(|error| CredentialError::keychain("resolve", error.code()))
    }

    pub fn resolve_optional(
        &self,
        account: &CredentialAccount,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, CredentialError> {
        match self.resolve(account) {
            Ok(secret) => Ok(Some(secret)),
            Err(error) if error.status == Some(errSecItemNotFound) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn status(&self, account: &CredentialAccount) -> Result<bool, CredentialError> {
        let mut options = ItemSearchOptions::new();
        options
            .class(ItemClass::generic_password())
            .service(self.service())
            .account(account.as_str())
            .cloud_sync(Some(false))
            .load_data(false)
            .load_attributes(false)
            .load_refs(false)
            .skip_authenticated_items(true);
        match options.search() {
            Ok(_) => Ok(true),
            Err(error) if error.code() == errSecItemNotFound => Ok(false),
            Err(error) => Err(CredentialError::keychain("status", error.code())),
        }
    }

    pub fn delete(&self, account: &CredentialAccount) -> Result<(), CredentialError> {
        let options = self.password_options(account);
        match delete_generic_password_options(options) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == errSecItemNotFound => Ok(()),
            Err(error) => Err(CredentialError::keychain("delete", error.code())),
        }
    }

    fn password_options(&self, account: &CredentialAccount) -> PasswordOptions {
        let mut options = PasswordOptions::new_generic_password(self.service(), account.as_str());
        options.set_access_synchronized(Some(false));
        options
    }
}

pub trait CredentialDeletionStore {
    fn delete_credential(&self, account: &CredentialAccount) -> Result<(), CredentialError>;
}

impl CredentialDeletionStore for KeychainStore {
    fn delete_credential(&self, account: &CredentialAccount) -> Result<(), CredentialError> {
        self.delete(account)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialConsumerDisplay {
    pub key: String,
    pub values: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialConsumerLabel {
    pub owner_id: String,
    pub kind: String,
    pub display: CredentialConsumerDisplay,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialDeletionPlan {
    pub reference: String,
    pub consumers: Vec<CredentialConsumerLabel>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialDeletionOutcome {
    Deleted,
    Cancelled,
}

pub trait CredentialDeletionConfirmation: Send + Sync {
    fn confirm_deletion(&self, plan: &CredentialDeletionPlan) -> Result<bool, CredentialError>;

    fn confirm_deletion_cancellable(
        &self,
        plan: &CredentialDeletionPlan,
        _cancellation: &CancellationToken,
    ) -> Result<bool, CredentialError> {
        self.confirm_deletion(plan)
    }
}

pub fn delete_credential_with_confirmation(
    store: &impl CredentialDeletionStore,
    confirmation: &(impl CredentialDeletionConfirmation + ?Sized),
    plan: CredentialDeletionPlan,
) -> Result<CredentialDeletionOutcome, CredentialError> {
    delete_credential_with_confirmation_cancellable(store, confirmation, plan, None)
}

fn delete_credential_with_confirmation_cancellable(
    store: &impl CredentialDeletionStore,
    confirmation: &(impl CredentialDeletionConfirmation + ?Sized),
    plan: CredentialDeletionPlan,
    cancellation: Option<&CancellationToken>,
) -> Result<CredentialDeletionOutcome, CredentialError> {
    validate_deletion_plan(&plan)?;
    if cancellation.is_some_and(CancellationToken::is_cancelled) {
        return Ok(CredentialDeletionOutcome::Cancelled);
    }
    let confirmed = if let Some(cancellation) = cancellation {
        confirmation.confirm_deletion_cancellable(&plan, cancellation)?
    } else {
        confirmation.confirm_deletion(&plan)?
    };
    if !confirmed {
        return Ok(CredentialDeletionOutcome::Cancelled);
    }
    let account = CredentialAccount::new(&plan.reference)?;
    if let Some(cancellation) = cancellation {
        let Some(result) = cancellation.commit_if_active(|| store.delete_credential(&account))
        else {
            return Ok(CredentialDeletionOutcome::Cancelled);
        };
        result?;
    } else {
        store.delete_credential(&account)?;
    }
    Ok(CredentialDeletionOutcome::Deleted)
}

fn validate_deletion_plan(plan: &CredentialDeletionPlan) -> Result<(), CredentialError> {
    validate_credential_reference(&plan.reference)?;
    if plan.consumers.is_empty() || plan.consumers.len() > MAX_CREDENTIAL_CONSUMERS {
        return Err(CredentialError::invalid_deletion_plan());
    }
    if serde_json::to_vec(plan)
        .map_err(|_| CredentialError::invalid_deletion_plan())?
        .len()
        > MAX_CREDENTIAL_DELETION_PLAN_BYTES
    {
        return Err(CredentialError::invalid_deletion_plan());
    }
    let mut owners = HashSet::new();
    for consumer in &plan.consumers {
        if consumer.owner_id.is_empty()
            || consumer.owner_id.len() > MAX_CREDENTIAL_CONSUMER_FIELD_BYTES
            || !consumer.owner_id.is_ascii()
            || consumer
                .owner_id
                .bytes()
                .any(|byte| byte.is_ascii_control())
            || !owners.insert(&consumer.owner_id)
            || !matches!(consumer.kind.as_str(), "model-route" | "plugin")
        {
            return Err(CredentialError::invalid_deletion_plan());
        }
        match consumer.display.key.as_str() {
            "openloop.credentials.consumer.model-route"
                if consumer.display.values.len() == 1
                    && consumer.display.values.contains_key("routeId") => {}
            "openloop.credentials.consumer.web-search-deepseek"
                if consumer.display.values.is_empty() => {}
            "openloop.credentials.consumer.mcp-server"
                if consumer.display.values.len() == 1
                    && consumer.display.values.contains_key("serverName") => {}
            _ => return Err(CredentialError::invalid_deletion_plan()),
        }
        if consumer.display.values.values().any(|value| {
            value.is_empty()
                || value.len() > MAX_CREDENTIAL_CONSUMER_FIELD_BYTES
                || value.chars().any(char::is_control)
        }) {
            return Err(CredentialError::invalid_deletion_plan());
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialReferencePayload {
    #[serde(rename = "ref")]
    reference: String,
}

pub fn credential_bridge_dispatch_tables(
    store: KeychainStore,
    replacement: Option<Arc<dyn CredentialReplacement>>,
    confirmation: Option<Arc<dyn CredentialDeletionConfirmation>>,
) -> Result<BridgeDispatchTables, CredentialError> {
    credential_bridge_dispatch_tables_with_legacy(store, replacement, confirmation, None)
}

pub fn credential_bridge_dispatch_tables_with_legacy(
    store: KeychainStore,
    replacement: Option<Arc<dyn CredentialReplacement>>,
    confirmation: Option<Arc<dyn CredentialDeletionConfirmation>>,
    legacy: Option<migration::ReadOnlyLegacySource>,
) -> Result<BridgeDispatchTables, CredentialError> {
    let writable = legacy.is_none() && replacement.is_some() && confirmation.is_some();
    let mutation_gate = writable.then(|| Arc::new(CredentialSheetGate::default()));
    let mut browser_safe = HashMap::new();
    let describe_legacy = legacy.clone();
    let describe: BridgeHandler = Arc::new(move |payload, _cancellation| {
        let request: CredentialReferencePayload = serde_json::from_value(payload)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::invalid_request())?;
        let account = CredentialAccount::new(&request.reference)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::invalid_request())?;
        if describe_legacy
            .as_ref()
            .map(|source| source.resolve(&account))
            .transpose()
            .map_err(|_| crate::bridge::server::BridgeHandlerError::credential_failure())?
            .flatten()
            .is_some()
        {
            return Ok(json!({
                "configured": true,
                "source": "legacy-file",
                "writable": false,
            }));
        }
        let configured = store
            .status(&account)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::credential_failure())?;
        Ok(if configured {
            json!({
                "configured": true,
                "source": "keychain",
                "writable": writable,
            })
        } else {
            json!({
                "configured": false,
                "writable": writable,
            })
        })
    });
    browser_safe.insert("describeCredential".to_owned(), describe);
    let replacement_ui = replacement;
    let replacement_gate = mutation_gate.clone();
    let replacement: BridgeHandler = Arc::new(move |payload, cancellation| {
        let request: CredentialReferencePayload = serde_json::from_value(payload)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::invalid_request())?;
        let account = CredentialAccount::new(&request.reference)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::invalid_request())?;
        let Some(replacement) = replacement_ui.as_ref() else {
            return Ok(Value::String("cancelled".to_owned()));
        };
        let _active = replacement_gate
            .as_ref()
            .map(|gate| gate.try_acquire())
            .transpose()
            .map_err(|_| crate::bridge::server::BridgeHandlerError::credential_failure())?;
        let outcome = replacement
            .replace(account, &cancellation)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::credential_failure())?;
        Ok(Value::String(
            match outcome {
                CredentialSheetOutcome::Saved => "saved",
                CredentialSheetOutcome::Cancelled => "cancelled",
            }
            .to_owned(),
        ))
    });
    browser_safe.insert("openCredentialReplacement".to_owned(), replacement);
    let deletion_store = store;
    let deletion_confirmation = confirmation;
    let deletion_gate = mutation_gate;
    let delete: BridgeHandler = Arc::new(move |payload, cancellation| {
        let plan: CredentialDeletionPlan = serde_json::from_value(payload)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::invalid_request())?;
        validate_deletion_plan(&plan)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::invalid_request())?;
        let Some(deletion_confirmation) = deletion_confirmation.as_ref() else {
            return Ok(Value::String("cancelled".to_owned()));
        };
        let _active = deletion_gate
            .as_ref()
            .map(|gate| gate.try_acquire())
            .transpose()
            .map_err(|_| crate::bridge::server::BridgeHandlerError::credential_failure())?;
        let outcome = delete_credential_with_confirmation_cancellable(
            &deletion_store,
            deletion_confirmation.as_ref(),
            plan,
            Some(&cancellation),
        )
        .map_err(|_| crate::bridge::server::BridgeHandlerError::credential_failure())?;
        Ok(Value::String(
            match outcome {
                CredentialDeletionOutcome::Deleted => "deleted",
                CredentialDeletionOutcome::Cancelled => "cancelled",
            }
            .to_owned(),
        ))
    });
    browser_safe.insert("unsetCredential".to_owned(), delete);

    let mut host_only = HashMap::new();
    let resolve_store = store;
    let resolve_legacy = legacy;
    let resolve: BridgeHandler = Arc::new(move |payload, _cancellation| {
        let request: CredentialReferencePayload = serde_json::from_value(payload)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::invalid_request())?;
        let account = CredentialAccount::new(&request.reference)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::invalid_request())?;
        let legacy_secret = resolve_legacy
            .as_ref()
            .map(|source| source.resolve(&account))
            .transpose()
            .map_err(|_| crate::bridge::server::BridgeHandlerError::credential_failure())?
            .flatten();
        let (secret, source) = if let Some(secret) = legacy_secret {
            (Some(secret), "legacy-file")
        } else {
            (
                resolve_store
                    .resolve_optional(&account)
                    .map_err(|_| crate::bridge::server::BridgeHandlerError::credential_failure())?,
                "keychain",
            )
        };
        if let Some(bytes) = secret.as_deref() {
            validate_secret(bytes)
                .map_err(|_| crate::bridge::server::BridgeHandlerError::credential_failure())?;
        }
        Ok(secret
            .map(|bytes| {
                json!({
                    "bytes": bytes.iter().map(|byte| Value::from(*byte)).collect::<Vec<_>>(),
                    "source": source,
                })
            })
            .unwrap_or(Value::Null))
    });
    host_only.insert("resolveCredential".to_owned(), resolve);
    BridgeDispatchTables::unavailable_with(browser_safe, host_only)
        .map_err(|_| CredentialError::bridge_failed())
}

pub fn validate_secret(secret: &[u8]) -> Result<(), CredentialError> {
    if secret.is_empty() || secret.len() > MAX_SECRET_BYTES {
        return Err(CredentialError::invalid_secret());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeychainSpikeAction {
    Set,
    Verify,
    Cleanup,
}

pub fn parse_keychain_spike_action(
    arguments: &[OsString],
    channel: ReleaseChannel,
) -> Result<Option<KeychainSpikeAction>, CredentialError> {
    let action = if arguments.len() == 1 {
        match arguments[0].to_str() {
            Some(KEYCHAIN_SPIKE_SET) => Some(KeychainSpikeAction::Set),
            Some(KEYCHAIN_SPIKE_VERIFY) => Some(KeychainSpikeAction::Verify),
            Some(KEYCHAIN_SPIKE_CLEANUP) => Some(KeychainSpikeAction::Cleanup),
            _ => None,
        }
    } else {
        None
    };
    if let Some(action) = action {
        if channel != ReleaseChannel::Test {
            return Err(CredentialError::invalid_spike());
        }
        return Ok(Some(action));
    }
    if arguments.iter().any(|argument| {
        argument
            .as_os_str()
            .as_bytes()
            .starts_with(KEYCHAIN_SPIKE_PREFIX)
    }) {
        return Err(CredentialError::invalid_spike());
    }
    Ok(None)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct KeychainSpikeReport {
    pub action: KeychainSpikeAction,
    pub configured: bool,
    pub verified: bool,
}

impl KeychainSpikeReport {
    pub fn json_line(&self) -> Result<String, CredentialError> {
        serde_json::to_string(self)
            .map(|line| format!("{line}\n"))
            .map_err(|_| CredentialError::spike_failed())
    }
}

pub fn run_keychain_spike(
    action: KeychainSpikeAction,
) -> Result<KeychainSpikeReport, CredentialError> {
    let store = KeychainStore::new(ReleaseChannel::Test);
    let account = CredentialAccount::new(SPIKE_REFERENCE)?;
    match action {
        KeychainSpikeAction::Set => {
            store.set(&account, SPIKE_SECRET)?;
            Ok(KeychainSpikeReport {
                action,
                configured: store.status(&account)?,
                verified: false,
            })
        }
        KeychainSpikeAction::Verify => {
            let configured = store.status(&account)?;
            let verified = configured && store.resolve(&account)?.as_slice() == SPIKE_SECRET;
            Ok(KeychainSpikeReport {
                action,
                configured,
                verified,
            })
        }
        KeychainSpikeAction::Cleanup => {
            store.delete(&account)?;
            Ok(KeychainSpikeReport {
                action,
                configured: store.status(&account)?,
                verified: false,
            })
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialError {
    message: String,
    status: Option<i32>,
}

impl CredentialError {
    fn invalid_identifier() -> Self {
        Self::new("credential identifier is invalid")
    }

    fn invalid_secret() -> Self {
        Self::new("credential secret size is invalid")
    }

    fn prompt_unavailable() -> Self {
        Self::new("credential prompt is unavailable")
    }

    fn invalid_spike() -> Self {
        Self::new("invalid private keychain spike arguments")
    }

    fn spike_failed() -> Self {
        Self::new("keychain spike output failed")
    }

    fn keychain(operation: &str, code: i32) -> Self {
        Self {
            message: format!("Keychain {operation} failed with status {code}"),
            status: Some(code),
        }
    }

    fn invalid_deletion_plan() -> Self {
        Self::new("credential deletion plan is invalid")
    }

    fn bridge_failed() -> Self {
        Self::new("credential bridge dispatch setup failed")
    }

    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
        }
    }
}

impl fmt::Display for CredentialError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for CredentialError {}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        sync::{mpsc, Arc, Mutex},
        thread,
        time::Duration,
    };

    use super::{
        delete_credential_with_confirmation_cancellable, validate_deletion_plan, CredentialAccount,
        CredentialConsumerDisplay, CredentialConsumerLabel, CredentialDeletionConfirmation,
        CredentialDeletionOutcome, CredentialDeletionPlan, CredentialDeletionStore,
        CredentialError, MAX_CREDENTIAL_CONSUMERS, MAX_CREDENTIAL_DELETION_PLAN_BYTES,
    };
    use crate::bridge::{
        protocol::{
            encode_frame, read_json_frame, sign_request, AuthenticatedBridgeRequest, BridgeRequest,
            BRIDGE_PROTOCOL_VERSION, MAX_BRIDGE_FRAME_BYTES,
        },
        server::CancellationToken,
    };

    struct Approved;

    impl CredentialDeletionConfirmation for Approved {
        fn confirm_deletion(
            &self,
            _plan: &CredentialDeletionPlan,
        ) -> Result<bool, CredentialError> {
            Ok(true)
        }
    }

    struct BlockingDeletionStore {
        entered: Mutex<Option<mpsc::Sender<()>>>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl CredentialDeletionStore for BlockingDeletionStore {
        fn delete_credential(&self, _account: &CredentialAccount) -> Result<(), CredentialError> {
            if let Some(entered) = self.entered.lock().expect("entered lock").take() {
                entered.send(()).expect("report deletion entry");
            }
            self.release
                .lock()
                .expect("release lock")
                .recv()
                .expect("release deletion");
            Ok(())
        }
    }

    fn deletion_plan() -> CredentialDeletionPlan {
        CredentialDeletionPlan {
            reference: "LINEARIZABLE_DELETE_KEY".to_owned(),
            consumers: vec![CredentialConsumerLabel {
                owner_id: "plugin:web-search-deepseek".to_owned(),
                kind: "plugin".to_owned(),
                display: CredentialConsumerDisplay {
                    key: "openloop.credentials.consumer.web-search-deepseek".to_owned(),
                    values: Default::default(),
                },
            }],
        }
    }

    #[test]
    fn deletion_plan_text_fields_use_a_256_byte_utf8_limit() {
        let mut boundary = deletion_plan();
        let consumer = &mut boundary.consumers[0];
        consumer.owner_id = "o".repeat(256);
        consumer.kind = "model-route".to_owned();
        consumer.display.key = "openloop.credentials.consumer.model-route".to_owned();
        consumer.display.values = BTreeMap::from([("routeId".to_owned(), "\u{1f600}".repeat(64))]);
        assert!(validate_deletion_plan(&boundary).is_ok());

        let mut oversized_owner = boundary.clone();
        oversized_owner.consumers[0].owner_id.push('o');
        assert!(validate_deletion_plan(&oversized_owner).is_err());

        let mut oversized_display = boundary;
        oversized_display.consumers[0]
            .display
            .values
            .insert("routeId".to_owned(), "\u{1f600}".repeat(65));
        assert!(validate_deletion_plan(&oversized_display).is_err());
    }

    #[test]
    fn largest_consumer_plan_round_trips_below_the_bridge_frame_limit() {
        let plan = CredentialDeletionPlan {
            reference: format!("A{}", "b".repeat(127)),
            consumers: (0..MAX_CREDENTIAL_CONSUMERS)
                .map(|index| CredentialConsumerLabel {
                    owner_id: format!("model-route:pi-ai:sha256:{index:064x}"),
                    kind: "model-route".to_owned(),
                    display: CredentialConsumerDisplay {
                        key: "openloop.credentials.consumer.model-route".to_owned(),
                        values: BTreeMap::from([("routeId".to_owned(), format!("r{index}"))]),
                    },
                })
                .collect(),
        };

        validate_deletion_plan(&plan).expect("largest plan is accepted");
        assert!(
            serde_json::to_vec(&plan).expect("plan JSON").len()
                <= MAX_CREDENTIAL_DELETION_PLAN_BYTES
        );
        let request = BridgeRequest {
            version: BRIDGE_PROTOCOL_VERSION,
            request_id: "deletion-plan-boundary".to_owned(),
            launch_id: "8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90".to_owned(),
            method: "unsetCredential".to_owned(),
            payload: serde_json::to_value(&plan).expect("plan payload"),
        };
        let envelope = sign_request(request, [7; 32], &[9; 32]).expect("signed plan");
        let frame = encode_frame(&envelope).expect("framed plan");
        assert!(frame.len() - 4 <= MAX_BRIDGE_FRAME_BYTES);
        let decoded: AuthenticatedBridgeRequest =
            read_json_frame(&mut frame.as_slice()).expect("round-trip plan");
        assert_eq!(decoded.request.payload, serde_json::to_value(plan).unwrap());
    }

    #[test]
    fn cancellation_cannot_land_between_the_final_check_and_deletion_commit() {
        let (entered, deletion_entered) = mpsc::channel();
        let (release, deletion_released) = mpsc::channel();
        let store = Arc::new(BlockingDeletionStore {
            entered: Mutex::new(Some(entered)),
            release: Mutex::new(deletion_released),
        });
        let cancellation = CancellationToken::new();
        let delete_store = store.clone();
        let delete_cancellation = cancellation.clone();
        let deletion = thread::spawn(move || {
            delete_credential_with_confirmation_cancellable(
                delete_store.as_ref(),
                &Approved,
                deletion_plan(),
                Some(&delete_cancellation),
            )
        });
        deletion_entered.recv().expect("deletion commit entered");
        let cancel_cancellation = cancellation.clone();
        let (cancelled, cancel_returned) = mpsc::channel();
        let cancel = thread::spawn(move || {
            cancel_cancellation.cancel();
            cancelled.send(()).expect("report cancellation return");
        });

        let cancellation_interleaved = cancel_returned
            .recv_timeout(Duration::from_millis(50))
            .is_ok();
        release.send(()).expect("release deletion");
        let outcome = deletion
            .join()
            .expect("deletion thread")
            .expect("deletion outcome");
        cancel.join().expect("cancellation thread");

        assert!(
            !cancellation_interleaved,
            "cancellation returned between the final check and destructive commit"
        );
        assert_eq!(outcome, CredentialDeletionOutcome::Deleted);
        assert!(cancellation.is_cancelled());
    }
}
