use std::{
    fmt, ptr,
    sync::{
        atomic::{AtomicBool, AtomicPtr, Ordering},
        mpsc, Arc, Mutex, Weak,
    },
};

use block2::RcBlock;
use objc2_app_kit::{
    NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSModalResponseCancel, NSSecureTextField,
    NSWindow,
};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize, NSString, NSThread};
use tauri::{AppHandle, Manager};
use zeroize::Zeroize;

use super::{
    validate_deletion_plan, validate_secret, CredentialAccount, CredentialDeletionConfirmation,
    CredentialDeletionPlan, CredentialError, KeychainStore,
};
use crate::bridge::server::CancellationToken;

pub const MAIN_WINDOW_LABEL: &str = "main";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeTextFieldKind {
    NSSecureTextField,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialSheetPresentation {
    pub target_identity: String,
    pub parent_window_label: &'static str,
    pub text_field_kind: NativeTextFieldKind,
    pub initial_value: &'static str,
    pub creates_independent_window_identity: bool,
}

impl CredentialSheetPresentation {
    fn for_account(account: &CredentialAccount) -> Self {
        Self {
            target_identity: account.as_str().to_owned(),
            parent_window_label: MAIN_WINDOW_LABEL,
            text_field_kind: NativeTextFieldKind::NSSecureTextField,
            initial_value: "",
            creates_independent_window_identity: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialSheetRequest {
    pub account: CredentialAccount,
}

struct SecretStorage {
    bytes: Mutex<Vec<u8>>,
    zeroized: AtomicBool,
}

pub struct CredentialSheetSecret {
    storage: Arc<SecretStorage>,
}

impl CredentialSheetSecret {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self {
            storage: Arc::new(SecretStorage {
                bytes: Mutex::new(bytes),
                zeroized: AtomicBool::new(false),
            }),
        }
    }

    #[doc(hidden)]
    pub fn new_observed(bytes: Vec<u8>) -> (Self, CredentialSheetZeroizationProbe) {
        let secret = Self::new(bytes);
        let probe = CredentialSheetZeroizationProbe {
            storage: secret.storage.clone(),
        };
        (secret, probe)
    }

    fn with_bytes<T>(
        &self,
        operation: impl FnOnce(&[u8]) -> Result<T, CredentialError>,
    ) -> Result<T, CredentialError> {
        let bytes = self
            .storage
            .bytes
            .lock()
            .map_err(|_| CredentialError::prompt_unavailable())?;
        operation(bytes.as_slice())
    }

    fn clear(&mut self) {
        let mut bytes = match self.storage.bytes.lock() {
            Ok(bytes) => bytes,
            Err(poisoned) => poisoned.into_inner(),
        };
        bytes.zeroize();
        self.storage.zeroized.store(true, Ordering::Release);
    }
}

impl fmt::Debug for CredentialSheetSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CredentialSheetSecret([redacted])")
    }
}

impl Drop for CredentialSheetSecret {
    fn drop(&mut self) {
        self.clear();
    }
}

pub struct CredentialSheetZeroizationProbe {
    storage: Arc<SecretStorage>,
}

impl CredentialSheetZeroizationProbe {
    pub fn is_zeroized(&self) -> bool {
        if !self.storage.zeroized.load(Ordering::Acquire) {
            return false;
        }
        match self.storage.bytes.lock() {
            Ok(bytes) => bytes.iter().all(|byte| *byte == 0),
            Err(poisoned) => poisoned.into_inner().iter().all(|byte| *byte == 0),
        }
    }
}

#[derive(Debug)]
pub enum CredentialSheetAction {
    Save(CredentialSheetSecret),
    Cancelled,
}

pub type CredentialSheetCompletion =
    Box<dyn FnOnce(Result<CredentialSheetAction, CredentialError>) + Send + 'static>;

pub trait AppKitCredentialSheetBackend: Send + Sync {
    fn begin_sheet(
        &self,
        presentation: CredentialSheetPresentation,
        completion: CredentialSheetCompletion,
    ) -> Result<(), CredentialError>;

    fn cancel_sheet(&self);

    fn clear_secret_control(&self);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialSheetOutcome {
    Saved,
    Cancelled,
}

pub trait CredentialSheetPresenter: Send + Sync {
    fn present(
        &self,
        request: &CredentialSheetRequest,
    ) -> Result<CredentialSheetAction, CredentialError>;

    fn present_cancellable(
        &self,
        request: &CredentialSheetRequest,
        _cancellation: &CancellationToken,
    ) -> Result<CredentialSheetAction, CredentialError> {
        self.present(request)
    }

    fn clear_secret_control(&self);
}

pub trait CredentialReplacementStore: Send + Sync {
    fn replace_credential(
        &self,
        account: &CredentialAccount,
        secret: &[u8],
    ) -> Result<(), CredentialError>;
}

impl CredentialReplacementStore for KeychainStore {
    fn replace_credential(
        &self,
        account: &CredentialAccount,
        secret: &[u8],
    ) -> Result<(), CredentialError> {
        self.set(account, secret)
    }
}

#[derive(Default)]
pub struct CredentialSheetGate {
    active: Mutex<bool>,
}

impl CredentialSheetGate {
    pub(super) fn try_acquire(&self) -> Result<ActiveSheet<'_>, CredentialError> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| CredentialError::prompt_unavailable())?;
        if *active {
            return Err(CredentialError::prompt_unavailable());
        }
        *active = true;
        Ok(ActiveSheet { gate: self })
    }
}

pub(super) struct ActiveSheet<'a> {
    gate: &'a CredentialSheetGate,
}

impl Drop for ActiveSheet<'_> {
    fn drop(&mut self) {
        match self.gate.active.lock() {
            Ok(mut active) => *active = false,
            Err(poisoned) => *poisoned.into_inner() = false,
        }
    }
}

pub trait CredentialReplacement: Send + Sync {
    fn replace(
        &self,
        account: CredentialAccount,
        cancellation: &CancellationToken,
    ) -> Result<CredentialSheetOutcome, CredentialError>;
}

pub struct CredentialSheetCoordinator {
    presenter: Arc<dyn CredentialSheetPresenter>,
    store: Arc<dyn CredentialReplacementStore>,
    gate: Arc<CredentialSheetGate>,
}

impl CredentialSheetCoordinator {
    pub fn new(
        presenter: Arc<dyn CredentialSheetPresenter>,
        store: Arc<dyn CredentialReplacementStore>,
    ) -> Self {
        Self::with_gate(presenter, store, Arc::new(CredentialSheetGate::default()))
    }

    pub fn with_gate(
        presenter: Arc<dyn CredentialSheetPresenter>,
        store: Arc<dyn CredentialReplacementStore>,
        gate: Arc<CredentialSheetGate>,
    ) -> Self {
        Self {
            presenter,
            store,
            gate,
        }
    }

    pub fn replace(
        &self,
        account: CredentialAccount,
    ) -> Result<CredentialSheetOutcome, CredentialError> {
        self.replace_cancellable(account, &CancellationToken::default())
    }

    pub fn replace_cancellable(
        &self,
        account: CredentialAccount,
        cancellation: &CancellationToken,
    ) -> Result<CredentialSheetOutcome, CredentialError> {
        let _active = self.gate.try_acquire()?;
        if cancellation.is_cancelled() {
            return Ok(CredentialSheetOutcome::Cancelled);
        }
        let request = CredentialSheetRequest {
            account: account.clone(),
        };
        let action = self.presenter.present_cancellable(&request, cancellation);
        self.presenter.clear_secret_control();
        match action? {
            CredentialSheetAction::Cancelled => Ok(CredentialSheetOutcome::Cancelled),
            CredentialSheetAction::Save(mut secret) => {
                let result = secret.with_bytes(|bytes| {
                    validate_secret(bytes)?;
                    let Some(result) = cancellation
                        .commit_if_active(|| self.store.replace_credential(&account, bytes))
                    else {
                        return Ok(CredentialSheetOutcome::Cancelled);
                    };
                    result?;
                    Ok(CredentialSheetOutcome::Saved)
                });
                secret.clear();
                result
            }
        }
    }
}

impl CredentialReplacement for CredentialSheetCoordinator {
    fn replace(
        &self,
        account: CredentialAccount,
        cancellation: &CancellationToken,
    ) -> Result<CredentialSheetOutcome, CredentialError> {
        self.replace_cancellable(account, cancellation)
    }
}

#[derive(Clone)]
pub struct AppKitCredentialSheet {
    backend: Arc<dyn AppKitCredentialSheetBackend>,
}

impl AppKitCredentialSheet {
    pub fn new(app: AppHandle) -> Self {
        Self::with_backend(Arc::new(Objc2AppKitCredentialSheetBackend {
            app,
            active: Mutex::new(None),
        }))
    }

    pub fn with_backend(backend: Arc<dyn AppKitCredentialSheetBackend>) -> Self {
        Self { backend }
    }
}

impl CredentialSheetPresenter for AppKitCredentialSheet {
    fn present(
        &self,
        request: &CredentialSheetRequest,
    ) -> Result<CredentialSheetAction, CredentialError> {
        self.present_with_cancellation(request, &CancellationToken::default())
    }

    fn present_cancellable(
        &self,
        request: &CredentialSheetRequest,
        cancellation: &CancellationToken,
    ) -> Result<CredentialSheetAction, CredentialError> {
        self.present_with_cancellation(request, cancellation)
    }

    fn clear_secret_control(&self) {
        self.backend.clear_secret_control();
    }
}

impl AppKitCredentialSheet {
    fn present_with_cancellation(
        &self,
        request: &CredentialSheetRequest,
        cancellation: &CancellationToken,
    ) -> Result<CredentialSheetAction, CredentialError> {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.backend.begin_sheet(
            CredentialSheetPresentation::for_account(&request.account),
            Box::new(move |result| {
                let _ = sender.send(result);
            }),
        )?;
        let backend = self.backend.clone();
        let _cancellation = cancellation.subscribe(move || backend.cancel_sheet());
        receiver
            .recv()
            .map_err(|_| CredentialError::prompt_unavailable())?
    }
}

struct Objc2AppKitCredentialSheetBackend {
    app: AppHandle,
    active: Mutex<Option<Weak<NativeCredentialSheetSession>>>,
}

impl AppKitCredentialSheetBackend for Objc2AppKitCredentialSheetBackend {
    fn begin_sheet(
        &self,
        presentation: CredentialSheetPresentation,
        completion: CredentialSheetCompletion,
    ) -> Result<(), CredentialError> {
        if NSThread::isMainThread_class() {
            return Err(CredentialError::prompt_unavailable());
        }
        let window = self
            .app
            .get_webview_window(presentation.parent_window_label)
            .ok_or_else(CredentialError::prompt_unavailable)?;
        let schedule_window = window.clone();
        let session = Arc::new(NativeCredentialSheetSession::new(completion));
        *self
            .active
            .lock()
            .map_err(|_| CredentialError::prompt_unavailable())? = Some(Arc::downgrade(&session));
        let scheduled_session = session.clone();
        if window
            .run_on_main_thread({
                move || {
                    let result = begin_replacement_sheet(
                        &schedule_window,
                        &presentation,
                        scheduled_session.clone(),
                    );
                    if result.is_err() {
                        complete_replacement_sheet(
                            &scheduled_session,
                            Err(CredentialError::prompt_unavailable()),
                        );
                    }
                }
            })
            .is_err()
        {
            complete_replacement_sheet(&session, Err(CredentialError::prompt_unavailable()));
            return Err(CredentialError::prompt_unavailable());
        }
        Ok(())
    }

    fn cancel_sheet(&self) {
        let session = self
            .active
            .lock()
            .ok()
            .and_then(|active| active.as_ref().and_then(Weak::upgrade));
        let Some(session) = session else {
            return;
        };
        let Some(window) = self.app.get_webview_window(MAIN_WINDOW_LABEL) else {
            complete_replacement_sheet(&session, Ok(CredentialSheetAction::Cancelled));
            return;
        };
        let schedule_window = window.clone();
        let scheduled_session = session.clone();
        if window
            .run_on_main_thread(move || {
                cancel_replacement_sheet(&schedule_window, &scheduled_session);
            })
            .is_err()
        {
            complete_replacement_sheet(&session, Ok(CredentialSheetAction::Cancelled));
        }
    }

    fn clear_secret_control(&self) {
        // The AppKit completion clears the control before it invokes the callback.
    }
}

struct NativeCredentialSheetSession {
    completion: Mutex<Option<CredentialSheetCompletion>>,
    sheet: AtomicPtr<NSWindow>,
    secure_control: AtomicPtr<NSSecureTextField>,
}

impl NativeCredentialSheetSession {
    fn new(completion: CredentialSheetCompletion) -> Self {
        Self {
            completion: Mutex::new(Some(completion)),
            sheet: AtomicPtr::new(ptr::null_mut()),
            secure_control: AtomicPtr::new(ptr::null_mut()),
        }
    }

    fn is_pending(&self) -> bool {
        match self.completion.lock() {
            Ok(completion) => completion.is_some(),
            Err(poisoned) => poisoned.into_inner().is_some(),
        }
    }
}

fn complete_replacement_sheet(
    session: &NativeCredentialSheetSession,
    result: Result<CredentialSheetAction, CredentialError>,
) {
    let callback = match session.completion.lock() {
        Ok(mut callback) => callback.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };
    if let Some(callback) = callback {
        callback(result);
    }
}

fn begin_replacement_sheet(
    window: &tauri::WebviewWindow,
    presentation: &CredentialSheetPresentation,
    session: Arc<NativeCredentialSheetSession>,
) -> Result<(), CredentialError> {
    if presentation.creates_independent_window_identity {
        return Err(CredentialError::prompt_unavailable());
    }
    if !session.is_pending() {
        return Ok(());
    }
    let mtm = MainThreadMarker::new().ok_or_else(CredentialError::prompt_unavailable)?;
    let parent = parent_ns_window(window)?;
    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str("Replace credential"));
    alert.setInformativeText(&NSString::from_str(&format!(
        "Target: {}\n\nEnter a new value. The existing Keychain value is kept unless Save succeeds.",
        presentation.target_identity
    )));
    alert.addButtonWithTitle(&NSString::from_str("Save"));
    alert.addButtonWithTitle(&NSString::from_str("Cancel"));

    let input = match presentation.text_field_kind {
        NativeTextFieldKind::NSSecureTextField => NSSecureTextField::new(mtm),
    };
    input.setFrame(NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(320.0, 24.0),
    ));
    input.setStringValue(&NSString::from_str(presentation.initial_value));
    input.setPlaceholderString(Some(&NSString::from_str("New credential")));
    alert.setAccessoryView(Some(&input));
    alert.layout();
    let sheet = alert.window();
    let _ = sheet.makeFirstResponder(Some(&input));
    session
        .sheet
        .store((&*sheet as *const NSWindow).cast_mut(), Ordering::Release);
    session.secure_control.store(
        (&*input as *const NSSecureTextField).cast_mut(),
        Ordering::Release,
    );

    let retained_alert = alert.clone();
    let completion_session = session.clone();
    let completion = RcBlock::new(move |response| {
        let action = if response == NSAlertFirstButtonReturn {
            let value = input.stringValue();
            let secret = CredentialSheetSecret::new(value.to_string().into_bytes());
            input.setStringValue(&NSString::from_str(""));
            drop(value);
            CredentialSheetAction::Save(secret)
        } else {
            input.setStringValue(&NSString::from_str(""));
            CredentialSheetAction::Cancelled
        };
        completion_session
            .secure_control
            .store(ptr::null_mut(), Ordering::Release);
        completion_session
            .sheet
            .store(ptr::null_mut(), Ordering::Release);
        complete_replacement_sheet(&completion_session, Ok(action));
        drop(retained_alert.clone());
    });

    parent.beginSheet_completionHandler(&sheet, Some(&completion));
    Ok(())
}

fn cancel_replacement_sheet(window: &tauri::WebviewWindow, session: &NativeCredentialSheetSession) {
    debug_assert!(NSThread::isMainThread_class());
    if !session.is_pending() {
        return;
    }
    let secure_control = session
        .secure_control
        .swap(ptr::null_mut(), Ordering::AcqRel);
    if !secure_control.is_null() {
        // SAFETY: the pointer is installed and cleared only on the main thread
        // while the NSAlert completion block retains the secure text field.
        unsafe { &*secure_control }.setStringValue(&NSString::from_str(""));
    }
    let sheet = session.sheet.swap(ptr::null_mut(), Ordering::AcqRel);
    if !sheet.is_null() {
        if let Ok(parent) = parent_ns_window(window) {
            // SAFETY: the pointer belongs to the retained NSAlert and all
            // access is serialized on the AppKit main thread.
            parent.endSheet_returnCode(unsafe { &*sheet }, NSModalResponseCancel);
        }
    }
    complete_replacement_sheet(session, Ok(CredentialSheetAction::Cancelled));
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialDeletionSheetPresentation {
    pub parent_window_label: &'static str,
    pub consumer_labels: Vec<String>,
    pub creates_independent_window_identity: bool,
}

pub type CredentialDeletionCompletion =
    Box<dyn FnOnce(Result<bool, CredentialError>) + Send + 'static>;

pub trait AppKitCredentialDeletionBackend: Send + Sync {
    fn begin_sheet(
        &self,
        presentation: CredentialDeletionSheetPresentation,
        completion: CredentialDeletionCompletion,
    ) -> Result<(), CredentialError>;

    fn cancel_sheet(&self);
}

#[derive(Clone)]
pub struct AppKitCredentialDeletionConfirmation {
    backend: Arc<dyn AppKitCredentialDeletionBackend>,
    gate: Arc<CredentialSheetGate>,
}

impl AppKitCredentialDeletionConfirmation {
    pub fn new(app: AppHandle, gate: Arc<CredentialSheetGate>) -> Self {
        Self::with_backend(
            Arc::new(Objc2AppKitCredentialDeletionBackend {
                app,
                active: Mutex::new(None),
            }),
            gate,
        )
    }

    pub fn with_backend(
        backend: Arc<dyn AppKitCredentialDeletionBackend>,
        gate: Arc<CredentialSheetGate>,
    ) -> Self {
        Self { backend, gate }
    }
}

impl CredentialDeletionConfirmation for AppKitCredentialDeletionConfirmation {
    fn confirm_deletion(&self, plan: &CredentialDeletionPlan) -> Result<bool, CredentialError> {
        self.confirm_deletion_with_cancellation(plan, &CancellationToken::default())
    }

    fn confirm_deletion_cancellable(
        &self,
        plan: &CredentialDeletionPlan,
        cancellation: &CancellationToken,
    ) -> Result<bool, CredentialError> {
        self.confirm_deletion_with_cancellation(plan, cancellation)
    }
}

impl AppKitCredentialDeletionConfirmation {
    fn confirm_deletion_with_cancellation(
        &self,
        plan: &CredentialDeletionPlan,
        cancellation: &CancellationToken,
    ) -> Result<bool, CredentialError> {
        let _active = self.gate.try_acquire()?;
        let labels = deletion_consumer_labels(plan)?;
        let (sender, receiver) = mpsc::sync_channel(1);
        self.backend.begin_sheet(
            CredentialDeletionSheetPresentation {
                parent_window_label: MAIN_WINDOW_LABEL,
                consumer_labels: labels,
                creates_independent_window_identity: false,
            },
            Box::new(move |result| {
                let _ = sender.send(result);
            }),
        )?;
        let backend = self.backend.clone();
        let _cancellation = cancellation.subscribe(move || backend.cancel_sheet());
        receiver
            .recv()
            .map_err(|_| CredentialError::prompt_unavailable())?
    }
}

struct Objc2AppKitCredentialDeletionBackend {
    app: AppHandle,
    active: Mutex<Option<Weak<NativeCredentialDeletionSession>>>,
}

impl AppKitCredentialDeletionBackend for Objc2AppKitCredentialDeletionBackend {
    fn begin_sheet(
        &self,
        presentation: CredentialDeletionSheetPresentation,
        completion: CredentialDeletionCompletion,
    ) -> Result<(), CredentialError> {
        if NSThread::isMainThread_class() {
            return Err(CredentialError::prompt_unavailable());
        }
        let window = self
            .app
            .get_webview_window(presentation.parent_window_label)
            .ok_or_else(CredentialError::prompt_unavailable)?;
        let schedule_window = window.clone();
        let session = Arc::new(NativeCredentialDeletionSession::new(completion));
        *self
            .active
            .lock()
            .map_err(|_| CredentialError::prompt_unavailable())? = Some(Arc::downgrade(&session));
        let scheduled_session = session.clone();
        if window
            .run_on_main_thread({
                move || {
                    let result = begin_deletion_sheet(
                        &schedule_window,
                        &presentation,
                        scheduled_session.clone(),
                    );
                    if result.is_err() {
                        complete_deletion_sheet(
                            &scheduled_session,
                            Err(CredentialError::prompt_unavailable()),
                        );
                    }
                }
            })
            .is_err()
        {
            complete_deletion_sheet(&session, Err(CredentialError::prompt_unavailable()));
            return Err(CredentialError::prompt_unavailable());
        }
        Ok(())
    }

    fn cancel_sheet(&self) {
        let session = self
            .active
            .lock()
            .ok()
            .and_then(|active| active.as_ref().and_then(Weak::upgrade));
        let Some(session) = session else {
            return;
        };
        let Some(window) = self.app.get_webview_window(MAIN_WINDOW_LABEL) else {
            complete_deletion_sheet(&session, Ok(false));
            return;
        };
        let schedule_window = window.clone();
        let scheduled_session = session.clone();
        if window
            .run_on_main_thread(move || {
                cancel_deletion_sheet(&schedule_window, &scheduled_session);
            })
            .is_err()
        {
            complete_deletion_sheet(&session, Ok(false));
        }
    }
}

pub fn deletion_consumer_labels(
    plan: &CredentialDeletionPlan,
) -> Result<Vec<String>, CredentialError> {
    validate_deletion_plan(plan)?;
    plan.consumers
        .iter()
        .map(|consumer| match consumer.display.key.as_str() {
            "openloop.credentials.consumer.model-route" => Ok(format!(
                "Model route: {}",
                consumer.display.values["routeId"]
            )),
            "openloop.credentials.consumer.web-search-deepseek" => {
                Ok("DeepSeek Web Search".to_owned())
            }
            "openloop.credentials.consumer.mcp-server" => Ok(format!(
                "MCP server: {}",
                consumer.display.values["serverName"]
            )),
            _ => Err(CredentialError::invalid_deletion_plan()),
        })
        .collect()
}

struct NativeCredentialDeletionSession {
    completion: Mutex<Option<CredentialDeletionCompletion>>,
    sheet: AtomicPtr<NSWindow>,
}

impl NativeCredentialDeletionSession {
    fn new(completion: CredentialDeletionCompletion) -> Self {
        Self {
            completion: Mutex::new(Some(completion)),
            sheet: AtomicPtr::new(ptr::null_mut()),
        }
    }

    fn is_pending(&self) -> bool {
        match self.completion.lock() {
            Ok(completion) => completion.is_some(),
            Err(poisoned) => poisoned.into_inner().is_some(),
        }
    }
}

fn complete_deletion_sheet(
    session: &NativeCredentialDeletionSession,
    result: Result<bool, CredentialError>,
) {
    let callback = match session.completion.lock() {
        Ok(mut callback) => callback.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };
    if let Some(callback) = callback {
        callback(result);
    }
}

fn begin_deletion_sheet(
    window: &tauri::WebviewWindow,
    presentation: &CredentialDeletionSheetPresentation,
    session: Arc<NativeCredentialDeletionSession>,
) -> Result<(), CredentialError> {
    if presentation.creates_independent_window_identity {
        return Err(CredentialError::prompt_unavailable());
    }
    if !session.is_pending() {
        return Ok(());
    }
    let mtm = MainThreadMarker::new().ok_or_else(CredentialError::prompt_unavailable)?;
    let parent = parent_ns_window(window)?;
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Warning);
    alert.setMessageText(&NSString::from_str("Delete credential?"));
    alert.setInformativeText(&NSString::from_str(&format!(
        "The following Openloop features use this credential:\n\n- {}",
        presentation.consumer_labels.join("\n- ")
    )));
    alert.addButtonWithTitle(&NSString::from_str("Delete"));
    alert.addButtonWithTitle(&NSString::from_str("Cancel"));
    let retained_alert = alert.clone();
    let sheet = alert.window();
    session
        .sheet
        .store((&*sheet as *const NSWindow).cast_mut(), Ordering::Release);
    let completion_session = session.clone();
    let completion = RcBlock::new(move |response| {
        completion_session
            .sheet
            .store(ptr::null_mut(), Ordering::Release);
        complete_deletion_sheet(
            &completion_session,
            Ok(response == NSAlertFirstButtonReturn),
        );
        drop(retained_alert.clone());
    });

    parent.beginSheet_completionHandler(&sheet, Some(&completion));
    Ok(())
}

fn cancel_deletion_sheet(window: &tauri::WebviewWindow, session: &NativeCredentialDeletionSession) {
    debug_assert!(NSThread::isMainThread_class());
    if !session.is_pending() {
        return;
    }
    let sheet = session.sheet.swap(ptr::null_mut(), Ordering::AcqRel);
    if !sheet.is_null() {
        if let Ok(parent) = parent_ns_window(window) {
            // SAFETY: the pointer belongs to the retained NSAlert and all
            // access is serialized on the AppKit main thread.
            parent.endSheet_returnCode(unsafe { &*sheet }, NSModalResponseCancel);
        }
    }
    complete_deletion_sheet(session, Ok(false));
}

fn parent_ns_window(window: &tauri::WebviewWindow) -> Result<&NSWindow, CredentialError> {
    debug_assert!(NSThread::isMainThread_class());
    let pointer = window
        .ns_window()
        .map_err(|_| CredentialError::prompt_unavailable())?;
    if pointer.is_null() {
        return Err(CredentialError::prompt_unavailable());
    }
    // SAFETY: Tauri returns this main window's live NSWindow pointer and this
    // function is called only from its main-thread callback.
    Ok(unsafe { &*pointer.cast::<NSWindow>() })
}
