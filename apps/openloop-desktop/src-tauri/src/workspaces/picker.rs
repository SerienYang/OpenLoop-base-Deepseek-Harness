use std::{
    collections::HashMap,
    fs,
    os::{
        fd::{AsRawFd, OwnedFd, RawFd},
        unix::fs::{MetadataExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    sync::mpsc,
    time::{SystemTime, UNIX_EPOCH},
};

use block2::RcBlock;
use objc2_app_kit::{NSModalResponseOK, NSOpenPanel, NSWindow};
use objc2_foundation::{MainThreadMarker, NSThread};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::grants::{
    reopen_verified_grant, FileIdentity, GrantStatus, LaunchGrant, WorkspaceGrant,
    WorkspaceGrantError,
};

struct PendingGrant {
    grant: WorkspaceGrant,
    descriptor: OwnedFd,
}

pub trait WorkspaceDirectoryPicker: Send + Sync {
    fn pick(&self) -> Result<Option<PathBuf>, WorkspaceGrantError>;
}

#[derive(Clone)]
pub struct AppKitWorkspaceDirectoryPicker {
    app: AppHandle,
}

impl AppKitWorkspaceDirectoryPicker {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl WorkspaceDirectoryPicker for AppKitWorkspaceDirectoryPicker {
    fn pick(&self) -> Result<Option<PathBuf>, WorkspaceGrantError> {
        if NSThread::isMainThread_class() {
            return Err(WorkspaceGrantError::PromptUnavailable);
        }
        let window = self
            .app
            .get_webview_window("main")
            .ok_or(WorkspaceGrantError::PromptUnavailable)?;
        let scheduled_window = window.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        window
            .run_on_main_thread(move || {
                let result = begin_directory_sheet(&scheduled_window, sender);
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

type PickerSender = mpsc::SyncSender<Result<Option<PathBuf>, WorkspaceGrantError>>;

fn begin_directory_sheet(
    window: &tauri::WebviewWindow,
    sender: PickerSender,
) -> Result<(), (PickerSender, WorkspaceGrantError)> {
    let Some(mtm) = MainThreadMarker::new() else {
        return Err((sender, WorkspaceGrantError::PromptUnavailable));
    };
    let parent = match parent_ns_window(window) {
        Ok(parent) => parent,
        Err(error) => return Err((sender, error)),
    };
    let panel = NSOpenPanel::openPanel(mtm);
    panel.setCanChooseDirectories(true);
    panel.setCanChooseFiles(false);
    panel.setAllowsMultipleSelection(false);
    let retained_panel = panel.clone();
    let completion = RcBlock::new(move |response| {
        let result = if response == NSModalResponseOK {
            retained_panel
                .URLs()
                .firstObject()
                .and_then(|url| url.path())
                .map(|path| PathBuf::from(path.to_string()))
                .ok_or(WorkspaceGrantError::PromptUnavailable)
                .map(Some)
        } else {
            Ok(None)
        };
        let _ = sender.send(result);
        drop(retained_panel.clone());
    });
    panel.beginSheetModalForWindow_completionHandler(parent, &completion);
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

pub struct PendingGrantRegistry {
    launch_id: Uuid,
    pending: HashMap<Uuid, PendingGrant>,
    committed: HashMap<String, PendingGrant>,
}

impl PendingGrantRegistry {
    pub fn new(launch_id: Uuid) -> Self {
        Self {
            launch_id,
            pending: HashMap::new(),
            committed: HashMap::new(),
        }
    }

    pub fn begin(&mut self, path: &Path) -> Result<Uuid, WorkspaceGrantError> {
        let metadata = fs::symlink_metadata(path)
            .map_err(|source| WorkspaceGrantError::Io("inspect selected Workspace", source))?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o002 != 0
        {
            return Err(WorkspaceGrantError::UnsafePath(
                "selected Workspace must be an owned real directory".to_owned(),
            ));
        }
        let canonical = fs::canonicalize(path)
            .map_err(|source| WorkspaceGrantError::Io("canonicalize selected Workspace", source))?;
        let candidate = WorkspaceGrant {
            version: 1,
            generation: 0,
            operation_id: Uuid::new_v4(),
            previous_operation_id: None,
            previous_status: None,
            workspace_id: String::new(),
            canonical_path: canonical.clone(),
            display_path: PathBuf::from(path),
            identity: FileIdentity::from_metadata(&metadata),
            status: GrantStatus::Ready,
            authorized_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        };
        let verified = reopen_verified_grant(&candidate)?;
        let (grant, descriptor) = verified.into_parts();
        let pending_id = Uuid::new_v4();
        self.pending
            .insert(pending_id, PendingGrant { grant, descriptor });
        Ok(pending_id)
    }

    pub fn commit(
        &mut self,
        launch_id: Uuid,
        pending_id: Uuid,
        workspace_id: &str,
    ) -> Result<WorkspaceGrant, WorkspaceGrantError> {
        if launch_id != self.launch_id {
            return Err(WorkspaceGrantError::LaunchMismatch);
        }
        let mut pending = self
            .pending
            .remove(&pending_id)
            .ok_or(WorkspaceGrantError::InvalidPendingGrant)?;
        if workspace_id.is_empty() {
            return Err(WorkspaceGrantError::InvalidPendingGrant);
        }
        pending.grant.workspace_id = workspace_id.to_owned();
        let grant = pending.grant.clone();
        self.committed.insert(workspace_id.to_owned(), pending);
        Ok(grant)
    }

    pub fn candidate(
        &self,
        launch_id: Uuid,
        pending_id: Uuid,
        workspace_id: &str,
    ) -> Result<WorkspaceGrant, WorkspaceGrantError> {
        if launch_id != self.launch_id {
            return Err(WorkspaceGrantError::LaunchMismatch);
        }
        if workspace_id.is_empty() {
            return Err(WorkspaceGrantError::InvalidPendingGrant);
        }
        let pending = self
            .pending
            .get(&pending_id)
            .ok_or(WorkspaceGrantError::InvalidPendingGrant)?;
        let mut grant = pending.grant.clone();
        grant.workspace_id = workspace_id.to_owned();
        Ok(grant)
    }

    pub fn reauthorization_candidate(
        &self,
        launch_id: Uuid,
        pending_id: Uuid,
        workspace_id: &str,
        old_grant: Option<&WorkspaceGrant>,
        expected_canonical_path: Option<&Path>,
    ) -> Result<WorkspaceGrant, WorkspaceGrantError> {
        let candidate = self.candidate(launch_id, pending_id, workspace_id)?;
        let matches_authority = match old_grant {
            Some(old_grant) => candidate.identity == old_grant.identity,
            None => {
                expected_canonical_path.is_some_and(|expected| candidate.canonical_path == expected)
            }
        };
        if !matches_authority {
            return Err(WorkspaceGrantError::InvalidPendingGrant);
        }
        Ok(candidate)
    }

    pub fn abort(&mut self, launch_id: Uuid, pending_id: Uuid) -> Result<(), WorkspaceGrantError> {
        if launch_id != self.launch_id {
            return Err(WorkspaceGrantError::LaunchMismatch);
        }
        self.pending.remove(&pending_id);
        Ok(())
    }

    pub fn committed_descriptor(&self, workspace_id: &str) -> Option<RawFd> {
        self.committed
            .get(workspace_id)
            .map(|grant| grant.descriptor.as_raw_fd())
    }

    pub fn revoke_committed(&mut self, workspace_id: &str) {
        self.committed.remove(workspace_id);
    }

    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    pub fn inject_launch_grants(&mut self, grants: Vec<LaunchGrant>) {
        for launch_grant in grants {
            let Some((grant, descriptor)) = launch_grant.into_verified_parts() else {
                continue;
            };
            self.committed.insert(
                grant.workspace_id.clone(),
                PendingGrant { grant, descriptor },
            );
        }
    }
}
