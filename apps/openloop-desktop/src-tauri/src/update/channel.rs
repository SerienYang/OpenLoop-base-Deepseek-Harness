use std::{
    error::Error,
    fmt,
    path::{Path, PathBuf},
    str::FromStr,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::PublicKey;
use tauri::Url;

const TEST_BUNDLE_IDENTIFIER: &str = "ai.openloop.desktop.test";
const STABLE_BUNDLE_IDENTIFIER: &str = "ai.openloop.desktop";
const TEST_MANIFEST: &str = "latest-test-k1.json";
const STABLE_MANIFEST: &str = "latest-stable-k1.json";
const TEST_DATA_ROOT: &str = "Openloop-Test";
const STABLE_DATA_ROOT: &str = "Openloop";
const TEST_KEY_ENVIRONMENT: &str = "OPENLOOP_UPDATER_PUBLIC_KEY";
const STABLE_KEY_ENVIRONMENT: &str = "OPENLOOP_STABLE_UPDATER_PUBLIC_KEY";
const TEST_ENDPOINT: &str = "https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-rolling/latest-test-k1.json";
const STABLE_ENDPOINT: &str = "https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-stable-rolling/latest-stable-k1.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseChannel {
    Test,
    Stable,
}

impl FromStr for ReleaseChannel {
    type Err = ChannelConfigError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "test" => Ok(Self::Test),
            "stable" => Ok(Self::Stable),
            _ => Err(ChannelConfigError::new(format!(
                "unsupported Openloop release channel {value:?}"
            ))),
        }
    }
}

#[derive(Debug, Clone)]
pub struct UpdateChannelConfig {
    channel: ReleaseChannel,
    endpoint: Url,
    public_key: String,
}

impl UpdateChannelConfig {
    pub fn new(
        channel: ReleaseChannel,
        public_key: Option<&str>,
    ) -> Result<Self, ChannelConfigError> {
        let environment = channel.public_key_environment();
        let public_key = public_key.ok_or_else(|| {
            ChannelConfigError::new(format!("{environment} is required for signed updates"))
        })?;
        if public_key.is_empty() || public_key.trim() != public_key {
            return Err(ChannelConfigError::new(format!(
                "{environment} must be a non-empty value without surrounding whitespace"
            )));
        }
        let decoded = STANDARD.decode(public_key).map_err(|error| {
            ChannelConfigError::new(format!(
                "{environment} must be a base64-encoded Tauri updater public key: {error}"
            ))
        })?;
        let decoded = std::str::from_utf8(&decoded).map_err(|error| {
            ChannelConfigError::new(format!(
                "{environment} decoded public key is not UTF-8: {error}"
            ))
        })?;
        PublicKey::decode(decoded).map_err(|error| {
            ChannelConfigError::new(format!(
                "{environment} decoded public key is not valid Minisign data: {error}"
            ))
        })?;
        let endpoint = Url::parse(channel.endpoint()).map_err(|error| {
            ChannelConfigError::new(format!("invalid built-in updater endpoint: {error}"))
        })?;
        if endpoint.scheme() != "https" {
            return Err(ChannelConfigError::new(
                "built-in updater endpoint must use HTTPS",
            ));
        }
        Ok(Self {
            channel,
            endpoint,
            public_key: public_key.to_owned(),
        })
    }

    pub fn embedded(channel: ReleaseChannel) -> Result<Self, ChannelConfigError> {
        let public_key = match channel {
            ReleaseChannel::Test => option_env!("OPENLOOP_UPDATER_PUBLIC_KEY"),
            ReleaseChannel::Stable => option_env!("OPENLOOP_STABLE_UPDATER_PUBLIC_KEY"),
        };
        Self::new(channel, public_key)
    }

    pub fn channel(&self) -> ReleaseChannel {
        self.channel
    }

    pub fn bundle_identifier(&self) -> &'static str {
        self.channel.bundle_identifier()
    }

    pub fn manifest_filename(&self) -> &'static str {
        self.channel.manifest_filename()
    }

    pub fn data_root_name(&self) -> &'static str {
        self.channel.data_root_name()
    }

    pub fn data_root(&self, app_data: &Path) -> PathBuf {
        app_data.join(self.data_root_name())
    }

    pub fn dsh_home(&self, app_data: &Path) -> PathBuf {
        self.data_root(app_data).join("dsh")
    }

    pub fn public_key_environment(&self) -> &'static str {
        self.channel.public_key_environment()
    }

    pub fn endpoint(&self) -> &Url {
        &self.endpoint
    }

    pub fn public_key(&self) -> &str {
        &self.public_key
    }
}

impl ReleaseChannel {
    fn bundle_identifier(self) -> &'static str {
        match self {
            Self::Test => TEST_BUNDLE_IDENTIFIER,
            Self::Stable => STABLE_BUNDLE_IDENTIFIER,
        }
    }

    fn manifest_filename(self) -> &'static str {
        match self {
            Self::Test => TEST_MANIFEST,
            Self::Stable => STABLE_MANIFEST,
        }
    }

    fn data_root_name(self) -> &'static str {
        match self {
            Self::Test => TEST_DATA_ROOT,
            Self::Stable => STABLE_DATA_ROOT,
        }
    }

    fn public_key_environment(self) -> &'static str {
        match self {
            Self::Test => TEST_KEY_ENVIRONMENT,
            Self::Stable => STABLE_KEY_ENVIRONMENT,
        }
    }

    fn endpoint(self) -> &'static str {
        match self {
            Self::Test => TEST_ENDPOINT,
            Self::Stable => STABLE_ENDPOINT,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelConfigError {
    message: String,
}

impl ChannelConfigError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for ChannelConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for ChannelConfigError {}
