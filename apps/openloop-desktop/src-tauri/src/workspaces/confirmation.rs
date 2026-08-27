use std::sync::mpsc;

use block2::RcBlock;
use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSWindow};
use objc2_foundation::{MainThreadMarker, NSString, NSThread};
use tauri::{AppHandle, Manager};

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
    app: AppHandle,
}

impl AppKitWorkspaceRevokeConfirmation {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl RevokeConfirmation for AppKitWorkspaceRevokeConfirmation {
    fn confirm(&self, presentation: &RevokePresentation) -> Result<bool, WorkspaceGrantError> {
        if NSThread::isMainThread_class() {
            return Err(WorkspaceGrantError::PromptUnavailable);
        }
        let window = self
            .app
            .get_webview_window(MAIN_WINDOW_LABEL)
            .ok_or(WorkspaceGrantError::PromptUnavailable)?;
        let scheduled_window = window.clone();
        let scheduled = presentation.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        window
            .run_on_main_thread(move || {
                let result = begin_revoke_sheet(&scheduled_window, &scheduled, sender);
                if let Err((sender, error)) = result {
                    let _ = sender.send(Err(error));
                }
            })
            .map_err(|_| WorkspaceGrantError::PromptUnavailable)?;
        receiver
            .recv()
            .map_err(|_| WorkspaceGrantError::PromptUnavailable)?
    }
}

type ConfirmationSender = mpsc::SyncSender<Result<bool, WorkspaceGrantError>>;

fn begin_revoke_sheet(
    window: &tauri::WebviewWindow,
    presentation: &RevokePresentation,
    sender: ConfirmationSender,
) -> Result<(), (ConfirmationSender, WorkspaceGrantError)> {
    let Some(mtm) = MainThreadMarker::new() else {
        return Err((sender, WorkspaceGrantError::PromptUnavailable));
    };
    let parent = match parent_ns_window(window) {
        Ok(parent) => parent,
        Err(error) => return Err((sender, error)),
    };
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
    let completion = RcBlock::new(move |response| {
        let _ = sender.send(Ok(response == NSAlertFirstButtonReturn));
        drop(retained_alert.clone());
    });
    parent.beginSheet_completionHandler(&sheet, Some(&completion));
    Ok(())
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
