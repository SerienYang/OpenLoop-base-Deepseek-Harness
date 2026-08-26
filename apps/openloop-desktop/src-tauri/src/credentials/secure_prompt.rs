use std::sync::{Mutex, MutexGuard};

use tauri::{
    webview::NewWindowResponse, AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

use super::{CredentialAccount, CredentialError};

pub const CREDENTIALS_WINDOW_LABEL: &str = "credentials";
pub const CREDENTIALS_PAGE: &str = "src/credentials.html";
pub const CREDENTIALS_WINDOW_WIDTH: f64 = 420.0;
pub const CREDENTIALS_WINDOW_HEIGHT: f64 = 300.0;

const PROMPT_TOKEN_BYTES: usize = 32;
const TOKEN_HEX: &[u8; 16] = b"0123456789abcdef";

struct SecurePromptContext {
    account: CredentialAccount,
    token: String,
}

#[derive(Default)]
pub struct SecurePromptState {
    active: Mutex<Option<SecurePromptContext>>,
}

impl SecurePromptState {
    pub fn activate(
        &self,
        account: CredentialAccount,
        prompt_token: String,
    ) -> Result<(), CredentialError> {
        if !valid_prompt_token(&prompt_token) {
            return Err(CredentialError::invalid_prompt());
        }
        let mut active = self.lock()?;
        if active.is_some() {
            return Err(CredentialError::prompt_unavailable());
        }
        *active = Some(SecurePromptContext {
            account,
            token: prompt_token,
        });
        Ok(())
    }

    pub fn account_for_prompt(
        &self,
        label: &str,
        prompt_token: &str,
    ) -> Result<CredentialAccount, CredentialError> {
        validate_window_label(label)?;
        let active = self.lock()?;
        active
            .as_ref()
            .filter(|context| context.token == prompt_token)
            .map(|context| context.account.clone())
            .ok_or_else(CredentialError::invalid_prompt)
    }

    pub fn clear_for_prompt(
        &self,
        label: &str,
        prompt_token: &str,
    ) -> Result<bool, CredentialError> {
        validate_window_label(label)?;
        let mut active = self.lock()?;
        if active
            .as_ref()
            .is_some_and(|context| context.token == prompt_token)
        {
            *active = None;
            return Ok(true);
        }
        Ok(false)
    }

    fn lock(&self) -> Result<MutexGuard<'_, Option<SecurePromptContext>>, CredentialError> {
        self.active
            .lock()
            .map_err(|_| CredentialError::prompt_unavailable())
    }
}

fn validate_window_label(label: &str) -> Result<(), CredentialError> {
    if label == CREDENTIALS_WINDOW_LABEL {
        Ok(())
    } else {
        Err(CredentialError::invalid_prompt())
    }
}

fn valid_prompt_token(prompt_token: &str) -> bool {
    prompt_token.len() == PROMPT_TOKEN_BYTES * 2
        && prompt_token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn generate_prompt_token() -> Result<String, CredentialError> {
    let mut random = [0_u8; PROMPT_TOKEN_BYTES];
    getrandom::fill(&mut random)
        .map_err(|_| CredentialError::prompt("secure prompt token generation failed".to_owned()))?;
    let mut token = String::with_capacity(PROMPT_TOKEN_BYTES * 2);
    for byte in random {
        token.push(TOKEN_HEX[(byte >> 4) as usize] as char);
        token.push(TOKEN_HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(token)
}

fn prompt_initialization_script(prompt_token: &str) -> String {
    format!(
        r#"Object.defineProperty(window, "__OPENLOOP_CREDENTIAL_PROMPT_TOKEN__", {{ value: "{prompt_token}", writable: false, configurable: false, enumerable: false }});"#
    )
}

pub fn credentials_navigation_allowed(url: &Url) -> bool {
    let is_bundled_page =
        url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none();
    let is_dev_page = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port() == Some(1420);
    (is_bundled_page || is_dev_page)
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == format!("/{CREDENTIALS_PAGE}")
        && !url.path().contains('%')
        && url.query().is_none()
        && url.fragment().is_none()
}

pub fn open_secure_prompt(
    app: &AppHandle,
    credential_reference: &str,
) -> Result<(), CredentialError> {
    let account = CredentialAccount::new(credential_reference)?;
    let state = app
        .try_state::<SecurePromptState>()
        .ok_or_else(CredentialError::prompt_unavailable)?;
    if app.get_webview_window(CREDENTIALS_WINDOW_LABEL).is_some() {
        return Err(CredentialError::prompt_unavailable());
    }

    let prompt_token = generate_prompt_token()?;
    let initialization_script = prompt_initialization_script(&prompt_token);
    state.activate(account, prompt_token.clone())?;

    let window = match WebviewWindowBuilder::new(
        app,
        CREDENTIALS_WINDOW_LABEL,
        WebviewUrl::App(CREDENTIALS_PAGE.into()),
    )
    .title("Openloop Credentials")
    .inner_size(CREDENTIALS_WINDOW_WIDTH, CREDENTIALS_WINDOW_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .fullscreen(false)
    .center()
    .content_protected(true)
    .incognito(true)
    .devtools(false)
    .initialization_script(initialization_script)
    .on_navigation(credentials_navigation_allowed)
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_download(|_, _| false)
    .build()
    {
        Ok(window) => window,
        Err(error) => {
            let _ = state.clear_for_prompt(CREDENTIALS_WINDOW_LABEL, &prompt_token);
            return Err(CredentialError::prompt(format!(
                "secure prompt creation failed: {error}"
            )));
        }
    };
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
        ) {
            if let Some(state) = handle.try_state::<SecurePromptState>() {
                let _ = state.clear_for_prompt(CREDENTIALS_WINDOW_LABEL, &prompt_token);
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialization_script_exposes_only_the_prompt_token() {
        let prompt_token = "ab".repeat(PROMPT_TOKEN_BYTES);
        let script = prompt_initialization_script(&prompt_token);

        assert!(script.contains(&prompt_token));
        assert!(script.contains("Object.defineProperty"));
        assert!(!script.contains("provider"));
        assert!(!script.contains("reference"));
        assert!(!script.contains("localStorage"));
        assert!(!script.contains("sessionStorage"));
    }

    #[test]
    fn generated_prompt_tokens_have_256_bits_of_random_material() {
        let first = generate_prompt_token().expect("first prompt token");
        let second = generate_prompt_token().expect("second prompt token");

        assert!(valid_prompt_token(&first));
        assert!(valid_prompt_token(&second));
        assert_ne!(first, second);
    }
}
