use std::{
    ffi::CString,
    os::fd::{AsRawFd, OwnedFd},
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::update::channel::ReleaseChannel;

use super::grants::{
    atomic_write_json_at, c_name, lock_workspace_root, open_private_root, read_owner_file_at,
    remove_file_at, WorkspaceGrantError,
};

const MAX_JOURNAL_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceTransactionKind {
    Add,
    Revoke,
    Reauthorize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceTransaction {
    pub version: u8,
    pub generation: u64,
    pub operation_id: Uuid,
    pub kind: WorkspaceTransactionKind,
    pub workspace_id: Option<String>,
    pub expected_catalog_generation: u64,
    pub expected_grant_generation: u64,
    pub stage: String,
}

#[derive(Debug, Clone)]
pub struct WorkspaceJournal {
    path: PathBuf,
    root: Arc<OwnedFd>,
    filename: CString,
}

impl WorkspaceJournal {
    pub fn open(root: &Path, channel: ReleaseChannel) -> Result<Self, WorkspaceGrantError> {
        let root_descriptor = open_private_root(root)?;
        let suffix = match channel {
            ReleaseChannel::Test => "test",
            ReleaseChannel::Stable => "stable",
        };
        let filename = c_name(&format!(".openloop-workspace-transaction.{suffix}.v1.json"))?;
        let _lock = lock_workspace_root(root_descriptor.as_raw_fd())?;
        Ok(Self {
            path: root.join(
                filename.to_str().map_err(|_| {
                    WorkspaceGrantError::UnsafePath("invalid journal name".to_owned())
                })?,
            ),
            root: Arc::new(root_descriptor),
            filename,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn read(&self) -> Result<Option<WorkspaceTransaction>, WorkspaceGrantError> {
        let _lock = lock_workspace_root(self.root.as_raw_fd())?;
        self.read_locked()
    }

    fn read_locked(&self) -> Result<Option<WorkspaceTransaction>, WorkspaceGrantError> {
        let Some(bytes) =
            read_owner_file_at(self.root.as_raw_fd(), &self.filename, MAX_JOURNAL_BYTES)?
        else {
            return Ok(None);
        };
        let value: WorkspaceTransaction = serde_json::from_slice(&bytes).map_err(|source| {
            WorkspaceGrantError::Corrupt(format!("invalid Workspace journal: {source}"))
        })?;
        if value.version != 1 {
            return Err(WorkspaceGrantError::Corrupt(
                "Workspace journal version is unsupported".to_owned(),
            ));
        }
        Ok(Some(value))
    }

    pub fn write(
        &self,
        transaction: WorkspaceTransaction,
        expected_generation: u64,
    ) -> Result<(), WorkspaceGrantError> {
        let _lock = lock_workspace_root(self.root.as_raw_fd())?;
        let actual = self.read_locked()?.map_or(0, |current| current.generation);
        if actual != expected_generation {
            return Err(WorkspaceGrantError::GenerationConflict {
                expected: expected_generation,
                actual,
            });
        }
        if transaction.version != 1 || transaction.generation != actual + 1 {
            return Err(WorkspaceGrantError::Corrupt(
                "Workspace transaction generation is invalid".to_owned(),
            ));
        }
        atomic_write_json_at(self.root.as_raw_fd(), &self.filename, &transaction)
    }

    pub fn clear(&self, expected_generation: u64) -> Result<(), WorkspaceGrantError> {
        let _lock = lock_workspace_root(self.root.as_raw_fd())?;
        let actual = self.read_locked()?.map_or(0, |current| current.generation);
        if actual != expected_generation {
            return Err(WorkspaceGrantError::GenerationConflict {
                expected: expected_generation,
                actual,
            });
        }
        remove_file_at(self.root.as_raw_fd(), &self.filename)
    }
}
