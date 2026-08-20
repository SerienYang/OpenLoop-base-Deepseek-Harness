mod process;
mod protocol;
mod single_instance;

pub use process::{
    capture_process_identity, process_identity_matches, ProcessIdentity, StartupError,
    SupervisedChild,
};
pub use protocol::{
    decode_launch_secrets_frame, parse_readiness_line, write_launch_secrets_frame, HealthSmoke,
    LaunchReadinessExpectation, RuntimeReadiness, MAX_READINESS_LINE_BYTES,
};
pub use single_instance::{InstanceAction, SingleInstance};

use std::{fmt, io, path::PathBuf};
use uuid::Uuid;
use zeroize::Zeroizing;

/// One parent-to-runtime launch handoff. Debug output intentionally omits all
/// secret contents and only reports secret lengths.
pub struct LaunchSecrets {
    pub launch_id: Uuid,
    pub bootstrap_token: Zeroizing<Vec<u8>>,
    pub bridge_secret: Zeroizing<Vec<u8>>,
    pub socket_path: PathBuf,
}

impl LaunchSecrets {
    pub fn new(
        launch_id: Uuid,
        bootstrap_token: Vec<u8>,
        bridge_secret: Vec<u8>,
        socket_path: PathBuf,
    ) -> Self {
        Self {
            launch_id,
            bootstrap_token: Zeroizing::new(bootstrap_token),
            bridge_secret: Zeroizing::new(bridge_secret),
            socket_path,
        }
    }

    pub fn for_test(
        launch_id: &str,
        bootstrap_token: Vec<u8>,
        bridge_secret: Vec<u8>,
        socket_path: PathBuf,
    ) -> Self {
        Self::new(
            Uuid::parse_str(launch_id).expect("test launch id must be a UUID"),
            bootstrap_token,
            bridge_secret,
            socket_path,
        )
    }

    pub fn generate(socket_path: PathBuf) -> io::Result<Self> {
        let mut bootstrap_token = vec![0u8; 32];
        let mut bridge_secret = vec![0u8; 32];
        getrandom::fill(&mut bootstrap_token)
            .map_err(|error| io::Error::other(error.to_string()))?;
        getrandom::fill(&mut bridge_secret).map_err(|error| io::Error::other(error.to_string()))?;
        Ok(Self::new(
            Uuid::new_v4(),
            bootstrap_token,
            bridge_secret,
            socket_path,
        ))
    }

    pub fn bootstrap_token_hex(&self) -> String {
        self.bootstrap_token
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

impl fmt::Debug for LaunchSecrets {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LaunchSecrets")
            .field("launch_id", &self.launch_id)
            .field("bootstrap_token", &"<redacted>")
            .field("bridge_secret", &"<redacted>")
            .field("socket_path", &self.socket_path)
            .finish()
    }
}
