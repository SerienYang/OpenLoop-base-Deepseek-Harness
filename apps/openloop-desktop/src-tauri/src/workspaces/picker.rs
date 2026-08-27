use std::{
    collections::HashMap,
    fs,
    os::{
        fd::{AsRawFd, OwnedFd, RawFd},
        unix::fs::{MetadataExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use uuid::Uuid;

use super::grants::{
    reopen_verified_grant, FileIdentity, GrantStatus, WorkspaceGrant, WorkspaceGrantError,
};

struct PendingGrant {
    grant: WorkspaceGrant,
    _descriptor: OwnedFd,
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
                _descriptor: descriptor,
            },
        );
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
            .map(|grant| grant._descriptor.as_raw_fd())
    }

    pub fn revoke_committed(&mut self, workspace_id: &str) {
        self.committed.remove(workspace_id);
    }
}
