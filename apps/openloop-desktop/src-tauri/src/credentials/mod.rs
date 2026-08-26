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

mod secure_prompt;

pub use secure_prompt::{
    credentials_navigation_allowed, open_secure_prompt, SecurePromptState, CREDENTIALS_PAGE,
    CREDENTIALS_WINDOW_HEIGHT, CREDENTIALS_WINDOW_LABEL, CREDENTIALS_WINDOW_WIDTH,
};

pub const MAX_SECRET_BYTES: usize = 16 * 1024;

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
    if value.is_empty() || value.len() > 128 || !value.is_ascii() {
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

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialConsumerDisplay {
    pub key: String,
    pub values: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialConsumerLabel {
    pub owner_id: String,
    pub kind: String,
    pub display: CredentialConsumerDisplay,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
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
}

pub struct CancelCredentialDeletion;

impl CredentialDeletionConfirmation for CancelCredentialDeletion {
    fn confirm_deletion(&self, _plan: &CredentialDeletionPlan) -> Result<bool, CredentialError> {
        Ok(false)
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
    if !confirmation.confirm_deletion(&plan)? {
        return Ok(CredentialDeletionOutcome::Cancelled);
    }
    if cancellation.is_some_and(CancellationToken::is_cancelled) {
        return Ok(CredentialDeletionOutcome::Cancelled);
    }
    let account = CredentialAccount::new(&plan.reference)?;
    store.delete_credential(&account)?;
    Ok(CredentialDeletionOutcome::Deleted)
}

fn validate_deletion_plan(plan: &CredentialDeletionPlan) -> Result<(), CredentialError> {
    validate_credential_reference(&plan.reference)?;
    if plan.consumers.is_empty() || plan.consumers.len() > 256 {
        return Err(CredentialError::invalid_deletion_plan());
    }
    let mut owners = HashSet::new();
    for consumer in &plan.consumers {
        if consumer.owner_id.is_empty()
            || consumer.owner_id.len() > 256
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
            value.is_empty() || value.len() > 256 || value.chars().any(char::is_control)
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
    confirmation: Arc<dyn CredentialDeletionConfirmation>,
) -> Result<BridgeDispatchTables, CredentialError> {
    let mut browser_safe = HashMap::new();
    let describe: BridgeHandler = Arc::new(move |payload, _cancellation| {
        let request: CredentialReferencePayload = serde_json::from_value(payload)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::invalid_request())?;
        let account = CredentialAccount::new(&request.reference)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::invalid_request())?;
        let configured = store
            .status(&account)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::credential_failure())?;
        Ok(if configured {
            json!({ "configured": true, "source": "keychain", "writable": true })
        } else {
            json!({ "configured": false, "writable": true })
        })
    });
    browser_safe.insert("describeCredential".to_owned(), describe);
    let replacement: BridgeHandler = Arc::new(|payload, _cancellation| {
        let request: CredentialReferencePayload = serde_json::from_value(payload)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::invalid_request())?;
        CredentialAccount::new(&request.reference)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::invalid_request())?;
        Ok(Value::String("cancelled".to_owned()))
    });
    browser_safe.insert("openCredentialReplacement".to_owned(), replacement);
    let deletion_store = store;
    let deletion_confirmation = confirmation;
    let delete: BridgeHandler = Arc::new(move |payload, cancellation| {
        let plan: CredentialDeletionPlan = serde_json::from_value(payload)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::invalid_request())?;
        validate_deletion_plan(&plan)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::invalid_request())?;
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
    let resolve: BridgeHandler = Arc::new(move |payload, _cancellation| {
        let request: CredentialReferencePayload = serde_json::from_value(payload)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::invalid_request())?;
        let account = CredentialAccount::new(&request.reference)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::invalid_request())?;
        let secret = resolve_store
            .resolve_optional(&account)
            .map_err(|_| crate::bridge::server::BridgeHandlerError::credential_failure())?;
        Ok(secret
            .map(|bytes| Value::Array(bytes.iter().map(|byte| Value::from(*byte)).collect()))
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

    fn invalid_prompt() -> Self {
        Self::new("credential prompt context is invalid")
    }

    fn prompt_unavailable() -> Self {
        Self::new("credential prompt is unavailable")
    }

    fn prompt(message: String) -> Self {
        Self::new(message)
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
