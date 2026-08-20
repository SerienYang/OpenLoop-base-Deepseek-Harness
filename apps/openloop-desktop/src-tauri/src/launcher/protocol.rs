use std::io::{self, Write};

use serde::Deserialize;
use uuid::Uuid;

use super::LaunchSecrets;

pub const LAUNCH_SECRETS_PROTOCOL_VERSION: u16 = 1;
pub const MAX_LAUNCH_SECRETS_FRAME_BYTES: usize = 16 * 1024;
pub const MAX_READINESS_LINE_BYTES: usize = 16 * 1024;
const MAGIC: &[u8; 4] = b"OLSP";
const FRAME_HEADER_BYTES: usize = 10;
const MAX_TOKEN_BYTES: usize = 4096;
const MAX_SOCKET_PATH_BYTES: usize = 1024;

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn put_field(frame: &mut Vec<u8>, field: &[u8], label: &str, maximum: usize) -> io::Result<()> {
    if field.is_empty() || field.len() > maximum {
        return Err(invalid(format!("{label} length is out of bounds")));
    }
    let length = u32::try_from(field.len()).map_err(|_| invalid("field is too large"))?;
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(field);
    Ok(())
}

/// Write one launch-secret frame and clear its temporary serialization buffer.
pub fn write_launch_secrets_frame<W: Write>(
    writer: &mut W,
    secrets: &LaunchSecrets,
) -> io::Result<()> {
    let launch_id = secrets.launch_id.as_bytes();
    let socket_path = secrets
        .socket_path
        .to_str()
        .ok_or_else(|| invalid("socket path is not UTF-8"))?;
    let socket_path = socket_path.as_bytes();
    let payload_bytes = 4
        + launch_id.len()
        + 4
        + secrets.bootstrap_token.len()
        + 4
        + secrets.bridge_secret.len()
        + 4
        + socket_path.len();
    if payload_bytes > MAX_LAUNCH_SECRETS_FRAME_BYTES - FRAME_HEADER_BYTES {
        return Err(invalid("launch secret payload is oversized"));
    }
    let payload_length =
        u32::try_from(payload_bytes).map_err(|_| invalid("payload is too large"))?;
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + payload_bytes);
    frame.extend_from_slice(MAGIC);
    frame.extend_from_slice(&LAUNCH_SECRETS_PROTOCOL_VERSION.to_be_bytes());
    frame.extend_from_slice(&payload_length.to_be_bytes());
    put_field(&mut frame, launch_id, "launch id", 16)?;
    put_field(
        &mut frame,
        &secrets.bootstrap_token,
        "bootstrap token",
        MAX_TOKEN_BYTES,
    )?;
    put_field(
        &mut frame,
        &secrets.bridge_secret,
        "bridge secret",
        MAX_TOKEN_BYTES,
    )?;
    put_field(
        &mut frame,
        socket_path,
        "socket path",
        MAX_SOCKET_PATH_BYTES,
    )?;
    let result = writer.write_all(&frame);
    frame.fill(0);
    result
}

fn take_field<'a>(
    frame: &'a [u8],
    offset: &mut usize,
    label: &str,
    maximum: usize,
) -> io::Result<&'a [u8]> {
    if frame.len().saturating_sub(*offset) < 4 {
        return Err(invalid(format!("{label} length is truncated")));
    }
    let length = u32::from_be_bytes(frame[*offset..*offset + 4].try_into().unwrap()) as usize;
    *offset += 4;
    if length == 0 || length > maximum || frame.len().saturating_sub(*offset) < length {
        return Err(invalid(format!("{label} length is out of bounds")));
    }
    let field = &frame[*offset..*offset + length];
    *offset += length;
    Ok(field)
}

/// Decode a launch-secret frame for protocol tests and non-Node fixtures.
pub fn decode_launch_secrets_frame(frame: &[u8]) -> io::Result<LaunchSecrets> {
    if frame.len() < FRAME_HEADER_BYTES || frame.len() > MAX_LAUNCH_SECRETS_FRAME_BYTES {
        return Err(invalid("launch secret frame length is out of bounds"));
    }
    if &frame[..4] != MAGIC {
        return Err(invalid("launch secret frame magic is invalid"));
    }
    let version = u16::from_be_bytes(frame[4..6].try_into().unwrap());
    if version != LAUNCH_SECRETS_PROTOCOL_VERSION {
        return Err(invalid("launch secret protocol version is unsupported"));
    }
    let payload_length = u32::from_be_bytes(frame[6..10].try_into().unwrap()) as usize;
    if payload_length > MAX_LAUNCH_SECRETS_FRAME_BYTES - FRAME_HEADER_BYTES
        || FRAME_HEADER_BYTES + payload_length != frame.len()
    {
        return Err(invalid("launch secret payload length does not match"));
    }
    let mut offset = FRAME_HEADER_BYTES;
    let launch_id = take_field(frame, &mut offset, "launch id", 16)?;
    if launch_id.len() != 16 {
        return Err(invalid("launch id length is invalid"));
    }
    let bootstrap_token = take_field(frame, &mut offset, "bootstrap token", MAX_TOKEN_BYTES)?;
    let bridge_secret = take_field(frame, &mut offset, "bridge secret", MAX_TOKEN_BYTES)?;
    let socket_path = take_field(frame, &mut offset, "socket path", MAX_SOCKET_PATH_BYTES)?;
    if offset != frame.len() {
        return Err(invalid("launch secret frame has trailing bytes"));
    }
    let socket_path =
        std::str::from_utf8(socket_path).map_err(|_| invalid("socket path is not UTF-8"))?;
    if !socket_path.starts_with('/') {
        return Err(invalid("socket path must be absolute"));
    }
    Ok(LaunchSecrets::new(
        Uuid::from_bytes(launch_id.try_into().unwrap()),
        bootstrap_token.to_vec(),
        bridge_secret.to_vec(),
        socket_path.into(),
    ))
}

#[derive(Debug, Clone)]
pub struct LaunchReadinessExpectation {
    pub launch_id: Uuid,
    pub core_manifest_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeReadiness {
    #[serde(rename = "type")]
    pub message_type: String,
    pub version: u8,
    pub launch_id: String,
    pub profile: String,
    pub host: String,
    pub port: u16,
    pub origin: String,
    pub core_manifest_sha256: String,
    pub health_smoke: HealthSmoke,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HealthSmoke {
    pub method: String,
    pub path: String,
    pub status: u16,
}

pub fn parse_readiness_line(
    bytes: &[u8],
    expected: &LaunchReadinessExpectation,
) -> io::Result<RuntimeReadiness> {
    if bytes.is_empty() || bytes.len() > MAX_READINESS_LINE_BYTES {
        return Err(invalid("readiness line is oversized or empty"));
    }
    let mut line = bytes;
    if line.ends_with(b"\n") {
        line = &line[..line.len() - 1];
        if line.ends_with(b"\r") {
            line = &line[..line.len() - 1];
        }
    }
    if line.contains(&b'\n') || line.contains(&b'\r') {
        return Err(invalid("readiness must contain exactly one JSON line"));
    }
    let readiness: RuntimeReadiness = serde_json::from_slice(line)
        .map_err(|error| invalid(format!("readiness JSON is invalid: {error}")))?;
    if readiness.message_type != "openloop.runtime.ready"
        || readiness.version != 1
        || readiness.profile != "openloop"
        || readiness.host != "127.0.0.1"
        || readiness.port == 0
        || readiness.launch_id != expected.launch_id.to_string()
        || readiness.origin != format!("http://127.0.0.1:{}", readiness.port)
        || readiness.core_manifest_sha256 != expected.core_manifest_sha256
        || readiness.health_smoke.method != "GET"
        || readiness.health_smoke.path != "/"
        || readiness.health_smoke.status != 200
    {
        return Err(invalid(
            "readiness does not match the current runtime contract",
        ));
    }
    if readiness.core_manifest_sha256.len() != 64
        || !readiness
            .core_manifest_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(invalid(
            "readiness core manifest hash is not a lowercase SHA-256",
        ));
    }
    Ok(readiness)
}
