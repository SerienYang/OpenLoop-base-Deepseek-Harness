use std::{
    fs, io,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::update::channel::ReleaseChannel;

use super::grants::{atomic_write_json, validate_private_root, WorkspaceGrantError};

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
    root: PathBuf,
    path: PathBuf,
}

impl WorkspaceJournal {
    pub fn open(root: &Path, channel: ReleaseChannel) -> Result<Self, WorkspaceGrantError> {
        validate_private_root(root)?;
        let suffix = match channel {
            ReleaseChannel::Test => "test",
            ReleaseChannel::Stable => "stable",
        };
        Ok(Self {
            root: root.to_owned(),
            path: root.join(format!(".openloop-workspace-transaction.{suffix}.v1.json")),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn read(&self) -> Result<Option<WorkspaceTransaction>, WorkspaceGrantError> {
        let metadata = match fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(source) => {
                return Err(WorkspaceGrantError::Io("inspect Workspace journal", source))
            }
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(WorkspaceGrantError::UnsafePath(
                "Workspace journal must be an owner-only regular file".to_owned(),
            ));
        }
        let bytes = fs::read(&self.path)
            .map_err(|source| WorkspaceGrantError::Io("read Workspace journal", source))?;
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
        let actual = self.read()?.map_or(0, |current| current.generation);
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
        atomic_write_json(&self.root, &self.path, &transaction)
    }

    pub fn clear(&self, expected_generation: u64) -> Result<(), WorkspaceGrantError> {
        let actual = self.read()?.map_or(0, |current| current.generation);
        if actual != expected_generation {
            return Err(WorkspaceGrantError::GenerationConflict {
                expected: expected_generation,
                actual,
            });
        }
        match fs::remove_file(&self.path) {
            Ok(()) => {
                let root = fs::File::open(&self.root)
                    .map_err(|source| WorkspaceGrantError::Io("open Workspace root", source))?;
                root.sync_all()
                    .map_err(|source| WorkspaceGrantError::Io("sync Workspace root", source))
            }
            Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(WorkspaceGrantError::Io("remove Workspace journal", source)),
        }
    }
}
