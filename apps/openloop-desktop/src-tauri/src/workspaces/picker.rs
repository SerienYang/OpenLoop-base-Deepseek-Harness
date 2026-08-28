use std::{
    collections::HashMap,
    fs,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::fs::{MetadataExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    ptr,
    sync::{
        atomic::{AtomicPtr, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use block2::RcBlock;
use objc2_app_kit::{NSModalResponseOK, NSOpenPanel, NSWindow};
use objc2_foundation::{MainThreadMarker, NSThread};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::bridge::server::{CancellationSubscription, CancellationToken};

use super::grants::{
    reopen_verified_grant, FileIdentity, GrantStatus, LaunchGrant, WorkspaceGrant,
    WorkspaceGrantError,
};

struct PendingGrant {
    grant: WorkspaceGrant,
    descriptor: OwnedFd,
    cancellation: Option<CancellationSubscription>,
}

pub trait WorkspaceDirectoryPicker: Send + Sync {
    fn pick(&self) -> Result<Option<PathBuf>, WorkspaceGrantError>;

    fn pick_cancellable(
        &self,
        _cancellation: &CancellationToken,
    ) -> Result<Option<PathBuf>, WorkspaceGrantError> {
        self.pick()
    }
}

pub type DirectoryPickerCompletion =
    Box<dyn FnOnce(Result<Option<PathBuf>, WorkspaceGrantError>) + Send + 'static>;
pub type DirectoryPickerCancellation = Box<dyn FnOnce() + Send + 'static>;

pub trait AppKitWorkspaceDirectoryPickerBackend: Send + Sync {
    fn begin_sheet(
        &self,
        completion: DirectoryPickerCompletion,
    ) -> Result<DirectoryPickerCancellation, WorkspaceGrantError>;
}

#[derive(Clone)]
pub struct AppKitWorkspaceDirectoryPicker {
    backend: Arc<dyn AppKitWorkspaceDirectoryPickerBackend>,
}

struct Objc2AppKitWorkspaceDirectoryPickerBackend {
    app: AppHandle,
}

impl AppKitWorkspaceDirectoryPicker {
    pub fn new(app: AppHandle) -> Self {
        Self::with_backend(Arc::new(Objc2AppKitWorkspaceDirectoryPickerBackend { app }))
    }

    pub fn with_backend(backend: Arc<dyn AppKitWorkspaceDirectoryPickerBackend>) -> Self {
        Self { backend }
    }
}

impl WorkspaceDirectoryPicker for AppKitWorkspaceDirectoryPicker {
    fn pick(&self) -> Result<Option<PathBuf>, WorkspaceGrantError> {
        self.pick_with_cancellation(&CancellationToken::default())
    }

    fn pick_cancellable(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Option<PathBuf>, WorkspaceGrantError> {
        self.pick_with_cancellation(cancellation)
    }
}

impl AppKitWorkspaceDirectoryPicker {
    fn pick_with_cancellation(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Option<PathBuf>, WorkspaceGrantError> {
        if cancellation.is_cancelled() {
            return Ok(None);
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        let cancel_sheet = self.backend.begin_sheet(Box::new(move |result| {
            let _ = sender.send(result);
        }))?;
        let _cancellation = cancellation.subscribe(cancel_sheet);
        receiver
            .recv()
            .map_err(|_| WorkspaceGrantError::PromptUnavailable)?
    }
}

impl AppKitWorkspaceDirectoryPickerBackend for Objc2AppKitWorkspaceDirectoryPickerBackend {
    fn begin_sheet(
        &self,
        completion: DirectoryPickerCompletion,
    ) -> Result<DirectoryPickerCancellation, WorkspaceGrantError> {
        if NSThread::isMainThread_class() {
            return Err(WorkspaceGrantError::PromptUnavailable);
        }
        let window = self
            .app
            .get_webview_window("main")
            .ok_or(WorkspaceGrantError::PromptUnavailable)?;
        let scheduled_window = window.clone();
        let session = Arc::new(NativeDirectoryPickerSession::new(completion));
        let scheduled_session = session.clone();
        if window
            .run_on_main_thread(move || {
                if begin_directory_sheet(&scheduled_window, scheduled_session.clone()).is_err() {
                    complete_directory_sheet(
                        &scheduled_session,
                        Err(WorkspaceGrantError::PromptUnavailable),
                    );
                }
            })
            .is_err()
        {
            complete_directory_sheet(&session, Err(WorkspaceGrantError::PromptUnavailable));
            return Err(WorkspaceGrantError::PromptUnavailable);
        }
        let app = self.app.clone();
        let session = Arc::downgrade(&session);
        Ok(Box::new(move || {
            let Some(session) = session.upgrade() else {
                return;
            };
            let Some(window) = app.get_webview_window("main") else {
                complete_directory_sheet(&session, Ok(None));
                return;
            };
            let scheduled_session = session.clone();
            if window
                .run_on_main_thread(move || {
                    cancel_directory_sheet(&scheduled_session);
                })
                .is_err()
            {
                complete_directory_sheet(&session, Ok(None));
            }
        }))
    }
}

struct NativeDirectoryPickerSession {
    completion: Mutex<Option<DirectoryPickerCompletion>>,
    panel: AtomicPtr<NSOpenPanel>,
}

impl NativeDirectoryPickerSession {
    fn new(completion: DirectoryPickerCompletion) -> Self {
        Self {
            completion: Mutex::new(Some(completion)),
            panel: AtomicPtr::new(ptr::null_mut()),
        }
    }

    fn is_pending(&self) -> bool {
        match self.completion.lock() {
            Ok(completion) => completion.is_some(),
            Err(poisoned) => poisoned.into_inner().is_some(),
        }
    }
}

fn complete_directory_sheet(
    session: &NativeDirectoryPickerSession,
    result: Result<Option<PathBuf>, WorkspaceGrantError>,
) {
    let callback = match session.completion.lock() {
        Ok(mut callback) => callback.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };
    if let Some(callback) = callback {
        callback(result);
    }
}

fn begin_directory_sheet(
    window: &tauri::WebviewWindow,
    session: Arc<NativeDirectoryPickerSession>,
) -> Result<(), WorkspaceGrantError> {
    if !session.is_pending() {
        return Ok(());
    }
    let Some(mtm) = MainThreadMarker::new() else {
        return Err(WorkspaceGrantError::PromptUnavailable);
    };
    let parent = parent_ns_window(window)?;
    let panel = NSOpenPanel::openPanel(mtm);
    panel.setCanChooseDirectories(true);
    panel.setCanChooseFiles(false);
    panel.setAllowsMultipleSelection(false);
    let retained_panel = panel.clone();
    session.panel.store(
        (&*panel as *const NSOpenPanel).cast_mut(),
        Ordering::Release,
    );
    let completion_session = session.clone();
    let completion = RcBlock::new(move |response| {
        completion_session
            .panel
            .store(ptr::null_mut(), Ordering::Release);
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
        complete_directory_sheet(&completion_session, result);
        drop(retained_panel.clone());
    });
    panel.beginSheetModalForWindow_completionHandler(parent, &completion);
    Ok(())
}

fn cancel_directory_sheet(session: &NativeDirectoryPickerSession) {
    debug_assert!(NSThread::isMainThread_class());
    if !session.is_pending() {
        return;
    }
    let panel = session.panel.swap(ptr::null_mut(), Ordering::AcqRel);
    if !panel.is_null() {
        // SAFETY: the pointer belongs to the retained NSOpenPanel and all
        // access is serialized on the AppKit main thread.
        unsafe { (&*panel).cancel(None) };
    }
    complete_directory_sheet(session, Ok(None));
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
        self.pending.insert(
            pending_id,
            PendingGrant {
                grant,
                descriptor,
                cancellation: None,
            },
        );
        Ok(pending_id)
    }

    pub(crate) fn attach_cancellation(
        &mut self,
        launch_id: Uuid,
        pending_id: Uuid,
        cancellation: CancellationSubscription,
    ) -> Result<(), WorkspaceGrantError> {
        if launch_id != self.launch_id {
            return Err(WorkspaceGrantError::LaunchMismatch);
        }
        let pending = self
            .pending
            .get_mut(&pending_id)
            .ok_or(WorkspaceGrantError::InvalidPendingGrant)?;
        pending.cancellation = Some(cancellation);
        Ok(())
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
        let pending = self
            .pending
            .get(&pending_id)
            .ok_or(WorkspaceGrantError::InvalidPendingGrant)?;
        if workspace_id.is_empty() {
            return Err(WorkspaceGrantError::InvalidPendingGrant);
        }
        verify_pending_grant(pending)?;
        let mut grant = pending.grant.clone();
        grant.workspace_id = workspace_id.to_owned();
        self.promote_validated(pending_id, workspace_id);
        Ok(grant)
    }

    pub(crate) fn revalidate_candidate(
        &self,
        launch_id: Uuid,
        pending_id: Uuid,
        workspace_id: &str,
        expected: &WorkspaceGrant,
    ) -> Result<(), WorkspaceGrantError> {
        let current = self.candidate(launch_id, pending_id, workspace_id)?;
        if current.canonical_path != expected.canonical_path
            || current.identity != expected.identity
            || current.display_path != expected.display_path
        {
            return Err(WorkspaceGrantError::InvalidPendingGrant);
        }
        Ok(())
    }

    pub(crate) fn promote_validated(&mut self, pending_id: Uuid, workspace_id: &str) {
        let mut pending = self
            .pending
            .remove(&pending_id)
            .expect("validated pending Workspace grant must remain registered");
        pending.cancellation = None;
        pending.grant.workspace_id = workspace_id.to_owned();
        self.committed.insert(workspace_id.to_owned(), pending);
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
        verify_pending_grant(pending)?;
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

    pub fn duplicate_committed_descriptor(
        &self,
        workspace_id: &str,
    ) -> Result<OwnedFd, WorkspaceGrantError> {
        let descriptor = self
            .committed
            .get(workspace_id)
            .ok_or_else(|| WorkspaceGrantError::MissingWorkspaceGrant(workspace_id.to_owned()))?
            .descriptor
            .as_raw_fd();
        let duplicated = unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, 0) };
        if duplicated < 0 {
            return Err(WorkspaceGrantError::Io(
                "duplicate committed Workspace descriptor",
                std::io::Error::last_os_error(),
            ));
        }
        Ok(unsafe { OwnedFd::from_raw_fd(duplicated) })
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
                PendingGrant {
                    grant,
                    descriptor,
                    cancellation: None,
                },
            );
        }
    }
}

fn verify_pending_grant(pending: &PendingGrant) -> Result<(), WorkspaceGrantError> {
    let reopened = reopen_verified_grant(&pending.grant)?;
    if reopened.grant().identity != pending.grant.identity {
        return Err(WorkspaceGrantError::InvalidPendingGrant);
    }
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(pending.descriptor.as_raw_fd(), metadata.as_mut_ptr()) } < 0 {
        return Err(WorkspaceGrantError::Io(
            "inspect pending Workspace descriptor",
            std::io::Error::last_os_error(),
        ));
    }
    let metadata = unsafe { metadata.assume_init() };
    if metadata.st_mode as u32 & libc::S_IFMT as u32 != libc::S_IFDIR as u32
        || (FileIdentity {
            volume_id: metadata.st_dev as u64,
            file_id: metadata.st_ino,
        }) != pending.grant.identity
        || metadata.st_uid != unsafe { libc::geteuid() }
        || metadata.st_mode as u32 & 0o002 != 0
    {
        return Err(WorkspaceGrantError::InvalidPendingGrant);
    }
    Ok(())
}
