use std::{
    io::{self, Read, Write},
    sync::Mutex,
};

use hmac::{Hmac, Mac};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

pub const BRIDGE_PROTOCOL_VERSION: u8 = 1;
pub const MAX_BRIDGE_FRAME_BYTES: usize = 64 * 1024;
pub const BRIDGE_NONCE_BYTES: usize = 32;
const MAX_NONCES: usize = 4096;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const REQUEST_DOMAIN: &[u8] = b"openloop.bridge.request.v1\0";
const RESPONSE_DOMAIN: &[u8] = b"openloop.bridge.response.v1\0";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeRequest {
    pub version: u8,
    pub request_id: String,
    pub launch_id: String,
    pub method: String,
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuthenticatedBridgeRequest {
    pub request: BridgeRequest,
    pub nonce: String,
    pub mac: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BridgeError {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeResponse {
    pub version: u8,
    pub request_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BridgeError>,
}

impl BridgeResponse {
    pub fn success(request_id: impl Into<String>, result: Value) -> Self {
        Self {
            version: BRIDGE_PROTOCOL_VERSION,
            request_id: request_id.into(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(
        request_id: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            version: BRIDGE_PROTOCOL_VERSION,
            request_id: request_id.into(),
            ok: false,
            result: None,
            error: Some(BridgeError {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}

impl Zeroize for BridgeResponse {
    fn zeroize(&mut self) {
        self.version = 0;
        self.request_id.zeroize();
        self.ok = false;
        if let Some(result) = &mut self.result {
            zeroize_json_value(result);
        }
        self.result = None;
        if let Some(error) = &mut self.error {
            error.code.zeroize();
            error.message.zeroize();
        }
        self.error = None;
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuthenticatedBridgeResponse {
    pub response: BridgeResponse,
    pub nonce: String,
    pub mac: String,
}

impl Zeroize for AuthenticatedBridgeResponse {
    fn zeroize(&mut self) {
        self.response.zeroize();
        self.nonce.zeroize();
        self.mac.zeroize();
    }
}

pub struct NonceReplayGuard {
    maximum: usize,
    window: Mutex<NonceReplayWindow>,
}

struct NonceReplayWindow {
    highest: Option<u64>,
    seen: Vec<bool>,
}

impl Default for NonceReplayGuard {
    fn default() -> Self {
        Self::new(MAX_NONCES)
    }
}

impl NonceReplayGuard {
    pub fn new(maximum: usize) -> Self {
        assert!(maximum > 0, "nonce cache must not be empty");
        Self {
            maximum,
            window: Mutex::new(NonceReplayWindow {
                highest: None,
                seen: vec![false; maximum],
            }),
        }
    }

    pub fn claim(&self, nonce: [u8; BRIDGE_NONCE_BYTES]) -> io::Result<()> {
        let sequence = u64::from_be_bytes(
            nonce[..8]
                .try_into()
                .map_err(|_| invalid("bridge nonce sequence is invalid"))?,
        );
        let mut window = self
            .window
            .lock()
            .map_err(|_| invalid("bridge nonce cache lock is poisoned"))?;
        if let Some(highest) = window.highest {
            if sequence > highest {
                let advance = sequence - highest;
                if advance >= self.maximum as u64 {
                    window.seen.fill(false);
                } else {
                    for current in highest + 1..=sequence {
                        window.seen[(current % self.maximum as u64) as usize] = false;
                    }
                }
                window.highest = Some(sequence);
            } else if highest - sequence >= self.maximum as u64 {
                return Err(permission_denied("bridge nonce replay rejected"));
            }
        } else {
            window.highest = Some(sequence);
        }
        let index = (sequence % self.maximum as u64) as usize;
        if window.seen[index] {
            return Err(permission_denied("bridge nonce replay rejected"));
        }
        window.seen[index] = true;
        Ok(())
    }
}

pub fn canonical_request_bytes(
    request: &BridgeRequest,
    nonce: &[u8; BRIDGE_NONCE_BYTES],
) -> io::Result<Vec<u8>> {
    validate_request(request)?;
    let payload = canonical_json(&request.payload)?;
    let mut bytes = Vec::with_capacity(
        REQUEST_DOMAIN.len()
            + nonce.len()
            + 4
            + request.request_id.len()
            + request.launch_id.len()
            + request.method.len()
            + payload.len()
            + 16,
    );
    bytes.extend_from_slice(REQUEST_DOMAIN);
    bytes.extend_from_slice(nonce);
    bytes.extend_from_slice(&(u32::from(request.version)).to_be_bytes());
    put_field(&mut bytes, request.request_id.as_bytes())?;
    put_field(&mut bytes, request.launch_id.as_bytes())?;
    put_field(&mut bytes, request.method.as_bytes())?;
    put_field(&mut bytes, payload.as_bytes())?;
    Ok(bytes)
}

pub fn sign_request(
    request: BridgeRequest,
    nonce: [u8; BRIDGE_NONCE_BYTES],
    secret: &[u8],
) -> io::Result<AuthenticatedBridgeRequest> {
    require_secret(secret)?;
    let mac = hmac_sha256(secret, &canonical_request_bytes(&request, &nonce)?)?;
    Ok(AuthenticatedBridgeRequest {
        request,
        nonce: encode_hex(&nonce),
        mac: encode_hex(&mac),
    })
}

pub fn verify_request<'a>(
    envelope: &'a AuthenticatedBridgeRequest,
    expected_launch_id: &Uuid,
    secret: &[u8],
    nonces: &NonceReplayGuard,
) -> io::Result<&'a BridgeRequest> {
    if envelope.request.version != BRIDGE_PROTOCOL_VERSION {
        return Err(permission_denied("bridge protocol version is unsupported"));
    }
    if envelope.request.launch_id != expected_launch_id.to_string() {
        return Err(permission_denied("bridge launch is not current"));
    }
    require_secret(secret)?;
    let nonce = decode_fixed_hex::<BRIDGE_NONCE_BYTES>(&envelope.nonce, "bridge nonce")?;
    let actual_mac = decode_fixed_hex::<32>(&envelope.mac, "bridge MAC")?;
    verify_hmac_sha256(
        secret,
        &canonical_request_bytes(&envelope.request, &nonce)?,
        &actual_mac,
    )?;
    nonces.claim(nonce)?;
    Ok(&envelope.request)
}

pub fn sign_response(
    response: BridgeResponse,
    nonce: [u8; BRIDGE_NONCE_BYTES],
    secret: &[u8],
) -> io::Result<AuthenticatedBridgeResponse> {
    validate_response(&response)?;
    require_secret(secret)?;
    let canonical = canonical_response_bytes(&response, &nonce)?;
    let mac = hmac_sha256(secret, &canonical)?;
    Ok(AuthenticatedBridgeResponse {
        response,
        nonce: encode_hex(&nonce),
        mac: encode_hex(&mac),
    })
}

pub fn encode_frame<T: Serialize>(value: &T) -> io::Result<Vec<u8>> {
    Ok(encode_frame_zeroizing(value)?.to_vec())
}

fn encode_frame_zeroizing<T: Serialize>(value: &T) -> io::Result<Zeroizing<Vec<u8>>> {
    let body = Zeroizing::new(
        serde_json::to_vec(value)
            .map_err(|error| invalid(format!("bridge frame JSON is invalid: {error}")))?,
    );
    if body.is_empty() || body.len() > MAX_BRIDGE_FRAME_BYTES {
        return Err(invalid("bridge frame is oversized or empty"));
    }
    let length = u32::try_from(body.len()).map_err(|_| invalid("bridge frame is oversized"))?;
    let mut frame = Zeroizing::new(Vec::with_capacity(4 + body.len()));
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

pub fn write_frame<W: Write, T: Serialize>(writer: &mut W, value: &T) -> io::Result<()> {
    writer.write_all(&encode_frame_zeroizing(value)?)
}

pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Vec<u8>> {
    let mut header = [0_u8; 4];
    reader.read_exact(&mut header)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_BRIDGE_FRAME_BYTES {
        return Err(invalid("bridge frame is oversized or empty"));
    }
    let mut body = vec![0_u8; length];
    reader.read_exact(&mut body)?;
    Ok(body)
}

pub fn read_json_frame<R: Read, T: DeserializeOwned>(reader: &mut R) -> io::Result<T> {
    serde_json::from_slice(&read_frame(reader)?)
        .map_err(|error| invalid(format!("bridge frame JSON is invalid: {error}")))
}

fn canonical_response_bytes(
    response: &BridgeResponse,
    nonce: &[u8; BRIDGE_NONCE_BYTES],
) -> io::Result<Zeroizing<Vec<u8>>> {
    validate_response(response)?;
    let mut body = if response.ok {
        serde_json::json!({ "ok": true, "result": response.result.as_ref().unwrap() })
    } else {
        serde_json::json!({ "error": response.error.as_ref().unwrap(), "ok": false })
    };
    let serialized = canonical_json(&body);
    zeroize_json_value(&mut body);
    let body = Zeroizing::new(serialized?);
    let mut bytes = Zeroizing::new(Vec::with_capacity(
        RESPONSE_DOMAIN.len() + nonce.len() + response.request_id.len() + body.len() + 12,
    ));
    bytes.extend_from_slice(RESPONSE_DOMAIN);
    bytes.extend_from_slice(nonce);
    bytes.extend_from_slice(&(u32::from(response.version)).to_be_bytes());
    put_field(&mut bytes, response.request_id.as_bytes())?;
    put_field(&mut bytes, body.as_bytes())?;
    Ok(bytes)
}

fn validate_request(request: &BridgeRequest) -> io::Result<()> {
    if request.version != BRIDGE_PROTOCOL_VERSION
        || request.request_id.is_empty()
        || request.launch_id.is_empty()
        || request.method.is_empty()
    {
        return Err(invalid("bridge request fields are invalid"));
    }
    canonical_json(&request.payload).map(|_| ())
}

fn validate_response(response: &BridgeResponse) -> io::Result<()> {
    if response.version != BRIDGE_PROTOCOL_VERSION || response.request_id.is_empty() {
        return Err(invalid("bridge response fields are invalid"));
    }
    match (&response.ok, &response.result, &response.error) {
        (true, Some(result), None) => validate_json(result),
        (false, None, Some(error)) if !error.code.is_empty() => Ok(()),
        _ => Err(invalid("bridge response result shape is invalid")),
    }
}

fn canonical_json(value: &Value) -> io::Result<String> {
    validate_json(value)?;
    serde_json::to_string(value)
        .map_err(|error| invalid(format!("bridge canonical JSON failed: {error}")))
}

fn validate_json(value: &Value) -> io::Result<()> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => Ok(()),
        Value::Number(number) => {
            let valid = number
                .as_u64()
                .is_some_and(|value| value <= MAX_SAFE_INTEGER)
                || number
                    .as_i64()
                    .is_some_and(|value| value.unsigned_abs() <= MAX_SAFE_INTEGER);
            if valid {
                Ok(())
            } else {
                Err(invalid("bridge JSON numbers must be safe integers"))
            }
        }
        Value::Array(values) => values.iter().try_for_each(validate_json),
        Value::Object(values) => values.values().try_for_each(validate_json),
    }
}

pub(crate) fn zeroize_json_value(value: &mut Value) {
    match value {
        Value::Null => {}
        Value::Bool(boolean) => *boolean = false,
        Value::Number(number) => *number = serde_json::Number::from(0),
        Value::String(string) => string.zeroize(),
        Value::Array(values) => {
            values.iter_mut().for_each(zeroize_json_value);
            values.clear();
        }
        Value::Object(values) => {
            for (mut key, mut nested) in std::mem::take(values) {
                key.zeroize();
                zeroize_json_value(&mut nested);
            }
        }
    }
}

fn put_field(bytes: &mut Vec<u8>, field: &[u8]) -> io::Result<()> {
    let length = u32::try_from(field.len()).map_err(|_| invalid("bridge field is oversized"))?;
    bytes.extend_from_slice(&length.to_be_bytes());
    bytes.extend_from_slice(field);
    Ok(())
}

fn require_secret(secret: &[u8]) -> io::Result<()> {
    if secret.len() < 32 {
        Err(invalid("bridge secret must contain at least 32 bytes"))
    } else {
        Ok(())
    }
}

fn hmac_sha256(secret: &[u8], message: &[u8]) -> io::Result<[u8; 32]> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret)
        .map_err(|_| invalid("bridge secret cannot initialize HMAC"))?;
    mac.update(message);
    Ok(mac.finalize().into_bytes().into())
}

fn verify_hmac_sha256(secret: &[u8], message: &[u8], actual: &[u8; 32]) -> io::Result<()> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret)
        .map_err(|_| invalid("bridge secret cannot initialize HMAC"))?;
    mac.update(message);
    mac.verify_slice(actual)
        .map_err(|_| permission_denied("bridge request authentication failed"))
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn decode_nonce(value: &str) -> io::Result<[u8; BRIDGE_NONCE_BYTES]> {
    decode_fixed_hex(value, "bridge nonce")
}

fn decode_fixed_hex<const N: usize>(value: &str, label: &str) -> io::Result<[u8; N]> {
    if value.len() != N * 2
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(invalid(format!("{label} is not canonical lowercase hex")));
    }
    let mut bytes = [0_u8; N];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| invalid(format!("{label} is invalid")))?;
    }
    Ok(bytes)
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn permission_denied(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message.into())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::zeroize_json_value;

    #[test]
    fn recursive_json_zeroization_scrubs_nested_secret_material() {
        let mut value = json!({
            "secret": [115, 101, 99, 114, 101, 116],
            "nested": {
                "text": "sensitive",
                "flag": true,
            },
            "sensitive-key": "value",
        });

        zeroize_json_value(&mut value);

        assert_eq!(value, json!({}));
    }
}
