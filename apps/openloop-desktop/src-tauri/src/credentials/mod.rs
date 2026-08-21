use std::{error::Error, ffi::OsString, fmt, os::unix::ffi::OsStrExt};

use security_framework::{
    item::{ItemClass, ItemSearchOptions},
    passwords::{
        delete_generic_password_options, generic_password, set_generic_password_options,
        PasswordOptions,
    },
};
use security_framework_sys::base::errSecItemNotFound;
use serde::Serialize;
use zeroize::Zeroizing;

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
const SPIKE_PROVIDER: &str = "openloop";
const SPIKE_REFERENCE: &str = "foundation-task-15-spike";
const SPIKE_SECRET: &[u8] = b"openloop-keychain-spike-v1";

#[derive(Clone, PartialEq, Eq)]
pub struct CredentialAccount(String);

impl CredentialAccount {
    pub fn new(provider_id: &str, credential_reference: &str) -> Result<Self, CredentialError> {
        validate_identifier(provider_id, 64)?;
        validate_identifier(credential_reference, 128)?;
        Ok(Self(format!("{provider_id}:{credential_reference}")))
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

fn validate_identifier(value: &str, maximum: usize) -> Result<(), CredentialError> {
    if value.is_empty() || value.len() > maximum || !value.is_ascii() {
        return Err(CredentialError::invalid_identifier());
    }
    let bytes = value.as_bytes();
    if is_separator(bytes[0]) || is_separator(bytes[bytes.len() - 1]) {
        return Err(CredentialError::invalid_identifier());
    }
    let mut previous_was_separator = false;
    for byte in bytes {
        let separator = is_separator(*byte);
        if !(byte.is_ascii_lowercase() || byte.is_ascii_digit() || separator)
            || (separator && previous_was_separator)
        {
            return Err(CredentialError::invalid_identifier());
        }
        previous_was_separator = separator;
    }
    Ok(())
}

fn is_separator(byte: u8) -> bool {
    matches!(byte, b'-' | b'_' | b'.')
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
    let account = CredentialAccount::new(SPIKE_PROVIDER, SPIKE_REFERENCE)?;
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
        Self::new(format!("Keychain {operation} failed with status {code}"))
    }

    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for CredentialError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for CredentialError {}
