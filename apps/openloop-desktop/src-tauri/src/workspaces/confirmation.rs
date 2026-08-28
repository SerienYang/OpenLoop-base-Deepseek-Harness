use std::{
    ptr,
    sync::{
        atomic::{AtomicPtr, Ordering},
        mpsc, Arc, Mutex,
    },
};

use block2::RcBlock;
use objc2_app_kit::{
    NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSModalResponseCancel, NSWindow,
};
use objc2_foundation::{MainThreadMarker, NSString, NSThread};
use tauri::{AppHandle, Manager};

use crate::bridge::server::CancellationToken;

use super::grants::WorkspaceGrantError;

const MAIN_WINDOW_LABEL: &str = "main";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommittedWorkspaceProjection {
    pub workspace_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevokePresentation {
    pub workspace_id: String,
    pub title: String,
}

pub trait RevokeConfirmation: Send + Sync {
    fn confirm(&self, presentation: &RevokePresentation) -> Result<bool, WorkspaceGrantError>;

    fn confirm_cancellable(
        &self,
        presentation: &RevokePresentation,
        _cancellation: &CancellationToken,
    ) -> Result<bool, WorkspaceGrantError> {
        self.confirm(presentation)
    }
}

pub trait CommittedWorkspaceProjectionResolver: Send + Sync {
    fn resolve(
        &self,
        workspace_id: &str,
    ) -> Result<Option<CommittedWorkspaceProjection>, WorkspaceGrantError>;
}

pub fn confirm_workspace_revoke(
    confirmation: &dyn RevokeConfirmation,
    resolver: &dyn CommittedWorkspaceProjectionResolver,
    workspace_id: &str,
) -> Result<bool, WorkspaceGrantError> {
    if workspace_id.trim().is_empty() {
        return Err(WorkspaceGrantError::Corrupt(
            "Workspace id is empty".to_owned(),
        ));
    }
    let committed = resolver
        .resolve(workspace_id)?
        .ok_or_else(|| WorkspaceGrantError::Corrupt("Workspace is not committed".to_owned()))?;
    if committed.workspace_id != workspace_id || committed.title.trim().is_empty() {
        return Err(WorkspaceGrantError::Corrupt(
            "committed Workspace projection is inconsistent".to_owned(),
        ));
    }
    confirmation.confirm(&RevokePresentation {
        workspace_id: committed.workspace_id.clone(),
        title: committed.title.clone(),
    })
}

#[derive(Clone)]
pub struct AppKitWorkspaceRevokeConfirmation {
    backend: Arc<dyn AppKitWorkspaceRevokeConfirmationBackend>,
}

pub type RevokeConfirmationCompletion =
    Box<dyn FnOnce(Result<bool, WorkspaceGrantError>) + Send + 'static>;
pub type RevokeConfirmationCancellation = Box<dyn FnOnce() + Send + 'static>;

pub trait AppKitWorkspaceRevokeConfirmationBackend: Send + Sync {
    fn begin_sheet(
        &self,
        presentation: RevokePresentation,
        completion: RevokeConfirmationCompletion,
    ) -> Result<RevokeConfirmationCancellation, WorkspaceGrantError>;
}

struct Objc2AppKitWorkspaceRevokeConfirmationBackend {
    app: AppHandle,
}

impl AppKitWorkspaceRevokeConfirmation {
    pub fn new(app: AppHandle) -> Self {
        Self::with_backend(Arc::new(Objc2AppKitWorkspaceRevokeConfirmationBackend {
            app,
        }))
    }

    pub fn with_backend(backend: Arc<dyn AppKitWorkspaceRevokeConfirmationBackend>) -> Self {
        Self { backend }
    }
}

impl RevokeConfirmation for AppKitWorkspaceRevokeConfirmation {
    fn confirm(&self, presentation: &RevokePresentation) -> Result<bool, WorkspaceGrantError> {
        self.confirm_with_cancellation(presentation, &CancellationToken::default())
    }

    fn confirm_cancellable(
        &self,
        presentation: &RevokePresentation,
        cancellation: &CancellationToken,
    ) -> Result<bool, WorkspaceGrantError> {
        self.confirm_with_cancellation(presentation, cancellation)
    }
}

impl AppKitWorkspaceRevokeConfirmation {
    fn confirm_with_cancellation(
        &self,
        presentation: &RevokePresentation,
        cancellation: &CancellationToken,
    ) -> Result<bool, WorkspaceGrantError> {
        if cancellation.is_cancelled() {
            return Ok(false);
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        let cancel_sheet = self.backend.begin_sheet(
            presentation.clone(),
            Box::new(move |result| {
                let _ = sender.send(result);
            }),
        )?;
        let _cancellation = cancellation.subscribe(cancel_sheet);
        receiver
            .recv()
            .map_err(|_| WorkspaceGrantError::PromptUnavailable)?
    }
}

impl AppKitWorkspaceRevokeConfirmationBackend for Objc2AppKitWorkspaceRevokeConfirmationBackend {
    fn begin_sheet(
        &self,
        presentation: RevokePresentation,
        completion: RevokeConfirmationCompletion,
    ) -> Result<RevokeConfirmationCancellation, WorkspaceGrantError> {
        if NSThread::isMainThread_class() {
            return Err(WorkspaceGrantError::PromptUnavailable);
        }
        let window = self
            .app
            .get_webview_window(MAIN_WINDOW_LABEL)
            .ok_or(WorkspaceGrantError::PromptUnavailable)?;
        let scheduled_window = window.clone();
        let session = Arc::new(NativeRevokeConfirmationSession::new(completion));
        let scheduled_session = session.clone();
        if window
            .run_on_main_thread(move || {
                if begin_revoke_sheet(&scheduled_window, &presentation, scheduled_session.clone())
                    .is_err()
                {
                    complete_revoke_sheet(
                        &scheduled_session,
                        Err(WorkspaceGrantError::PromptUnavailable),
                    );
                }
            })
            .is_err()
        {
            complete_revoke_sheet(&session, Err(WorkspaceGrantError::PromptUnavailable));
            return Err(WorkspaceGrantError::PromptUnavailable);
        }
        let app = self.app.clone();
        let session = Arc::downgrade(&session);
        Ok(Box::new(move || {
            let Some(session) = session.upgrade() else {
                return;
            };
            let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
                complete_revoke_sheet(&session, Ok(false));
                return;
            };
            let scheduled_window = window.clone();
            let scheduled_session = session.clone();
            if window
                .run_on_main_thread(move || {
                    cancel_revoke_sheet(&scheduled_window, &scheduled_session);
                })
                .is_err()
            {
                complete_revoke_sheet(&session, Ok(false));
            }
        }))
    }
}

struct NativeRevokeConfirmationSession {
    completion: Mutex<Option<RevokeConfirmationCompletion>>,
    sheet: AtomicPtr<NSWindow>,
}

impl NativeRevokeConfirmationSession {
    fn new(completion: RevokeConfirmationCompletion) -> Self {
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

fn complete_revoke_sheet(
    session: &NativeRevokeConfirmationSession,
    result: Result<bool, WorkspaceGrantError>,
) {
    let callback = match session.completion.lock() {
        Ok(mut callback) => callback.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };
    if let Some(callback) = callback {
        callback(result);
    }
}

fn begin_revoke_sheet(
    window: &tauri::WebviewWindow,
    presentation: &RevokePresentation,
    session: Arc<NativeRevokeConfirmationSession>,
) -> Result<(), WorkspaceGrantError> {
    if !session.is_pending() {
        return Ok(());
    }
    let Some(mtm) = MainThreadMarker::new() else {
        return Err(WorkspaceGrantError::PromptUnavailable);
    };
    let parent = parent_ns_window(window)?;
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Warning);
    alert.setMessageText(&NSString::from_str("Remove Workspace?"));
    alert.setInformativeText(&NSString::from_str(&format!(
        "Remove \"{}\" from Openloop?\n\nFiles and session logs remain on disk.",
        presentation.title
    )));
    alert.addButtonWithTitle(&NSString::from_str("Remove"));
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
        complete_revoke_sheet(
            &completion_session,
            Ok(response == NSAlertFirstButtonReturn),
        );
        drop(retained_alert.clone());
    });
    parent.beginSheet_completionHandler(&sheet, Some(&completion));
    Ok(())
}

fn cancel_revoke_sheet(window: &tauri::WebviewWindow, session: &NativeRevokeConfirmationSession) {
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
    complete_revoke_sheet(session, Ok(false));
}

fn parent_ns_window(window: &tauri::WebviewWindow) -> Result<&NSWindow, WorkspaceGrantError> {
    debug_assert!(NSThread::isMainThread_class());
    let pointer = window
        .ns_window()
        .map_err(|_| WorkspaceGrantError::PromptUnavailable)?;
    if pointer.is_null() {
        return Err(WorkspaceGrantError::PromptUnavailable);
    }
    Ok(unsafe { &*pointer.cast::<NSWindow>() })
}
