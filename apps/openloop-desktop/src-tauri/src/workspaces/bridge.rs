use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::bridge::server::{BridgeDispatchTables, BridgeHandler, BridgeHandlerError};

use super::journal::{WorkspaceJournal, WorkspaceTransaction, WorkspaceTransactionKind};
use super::{
    confirmation::{RevokeConfirmation, RevokePresentation},
    grants::{reopen_verified_grant, GrantStatus, GrantStore, VerifiedGrant},
    picker::{PendingGrantRegistry, WorkspaceDirectoryPicker},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommitGrantInput {
    pending_grant_id: Uuid,
    workspace_id: String,
    expected_grant_generation: u64,
    operation_id: Uuid,
    expected_canonical_path: Option<PathBuf>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingGrantInput {
    pending_grant_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceGrantMutationInput {
    workspace_id: String,
    expected_grant_generation: u64,
    operation_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceGrantOperationInput {
    workspace_id: String,
    expected_grant_generation: u64,
    operation_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceGrantInput {
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfirmRevokeInput {
    workspace_id: String,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareInput {
    operation_id: Option<Uuid>,
    kind: WorkspaceTransactionKind,
    workspace_id: Option<String>,
    expected_catalog_generation: u64,
    expected_grant_generation: u64,
    stage: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdvanceInput {
    operation_id: Uuid,
    expected_generation: u64,
    expected_stage: String,
    next_stage: String,
    workspace_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinishInput {
    operation_id: Uuid,
    expected_generation: u64,
    expected_stage: String,
}

pub fn install_workspace_authority_handlers(
    tables: &mut BridgeDispatchTables,
    launch_id: Uuid,
    store: GrantStore,
    journal: WorkspaceJournal,
    registry: Arc<Mutex<PendingGrantRegistry>>,
    picker: Arc<dyn WorkspaceDirectoryPicker>,
    confirmation: Arc<dyn RevokeConfirmation>,
) -> Result<(), String> {
    install_workspace_authority_handlers_with_reveal(
        tables,
        launch_id,
        store,
        journal,
        registry,
        picker,
        confirmation,
        Arc::new(reveal_workspace_in_finder),
    )
}

#[doc(hidden)]
pub fn install_workspace_authority_handlers_with_reveal(
    tables: &mut BridgeDispatchTables,
    launch_id: Uuid,
    store: GrantStore,
    journal: WorkspaceJournal,
    registry: Arc<Mutex<PendingGrantRegistry>>,
    picker: Arc<dyn WorkspaceDirectoryPicker>,
    confirmation: Arc<dyn RevokeConfirmation>,
    reveal_workspace: Arc<
        dyn Fn(VerifiedGrant) -> Result<(), BridgeHandlerError> + Send + Sync + 'static,
    >,
) -> Result<(), String> {
    let operation_gate = registry
        .lock()
        .map_err(|_| "Workspace operation gate is unavailable".to_owned())?
        .operation_gate();
    let begin_registry = registry.clone();
    let begin: BridgeHandler = Arc::new(move |payload, cancellation| {
        if !payload.is_null() {
            return Err(BridgeHandlerError::invalid_request());
        }
        let selection = picker
            .pick_cancellable(&cancellation)
            .map_err(|_| BridgeHandlerError::workspace_failure())?;
        let Some(path) = selection else {
            return Ok(json!({ "outcome": "cancelled" }));
        };
        let (pending_grant_id, canonical_path) = cancellation
            .commit_if_active(|| {
                let mut registry = begin_registry
                    .lock()
                    .map_err(|_| BridgeHandlerError::workspace_failure())?;
                let pending_grant_id = registry
                    .begin(&path)
                    .map_err(|_| BridgeHandlerError::workspace_failure())?;
                let canonical_path = registry
                    .candidate(launch_id, pending_grant_id, "_pending")
                    .map_err(|_| BridgeHandlerError::workspace_failure())?
                    .canonical_path;
                Ok((pending_grant_id, canonical_path))
            })
            .ok_or_else(BridgeHandlerError::invalid_request)??;
        let cancellation_registry = Arc::downgrade(&begin_registry);
        let subscription = cancellation.subscribe(move || {
            let Some(registry) = cancellation_registry.upgrade() else {
                return;
            };
            if let Ok(mut registry) = registry.lock() {
                let _ = registry.abort(launch_id, pending_grant_id);
            };
        });
        begin_registry
            .lock()
            .map_err(|_| BridgeHandlerError::workspace_failure())?
            .attach_cancellation(launch_id, pending_grant_id, subscription)
            .map_err(|_| {
                if cancellation.is_cancelled() {
                    BridgeHandlerError::invalid_request()
                } else {
                    BridgeHandlerError::workspace_failure()
                }
            })?;
        Ok(json!({
            "outcome": "pending",
            "pendingGrantId": pending_grant_id,
            "path": canonical_path,
        }))
    });
    tables
        .set_host_handler("beginWorkspaceAuthorization", begin)
        .map_err(|error| error.to_string())?;

    let commit_store = store.clone();
    let commit_journal = journal.clone();
    let commit_registry = registry.clone();
    let commit: BridgeHandler = Arc::new(move |payload, cancellation| {
        let input: CommitGrantInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        if input.workspace_id.is_empty() {
            return Err(BridgeHandlerError::invalid_request());
        }
        cancellation
            .commit_if_active(|| {
                let mut registry = commit_registry
                    .lock()
                    .map_err(|_| BridgeHandlerError::workspace_failure())?;
                let transaction = commit_journal
                    .read()
                    .map_err(|_| BridgeHandlerError::workspace_failure())?
                    .ok_or_else(BridgeHandlerError::workspace_failure)?;
                if transaction.operation_id != input.operation_id {
                    return Err(BridgeHandlerError::invalid_request());
                }
                let mut grant = match (transaction.kind, transaction.stage.as_str()) {
                    (WorkspaceTransactionKind::Add, "registry-committed")
                        if transaction.workspace_id.as_deref() == Some(&input.workspace_id)
                            && transaction.expected_grant_generation
                                == input.expected_grant_generation
                            && input.expected_canonical_path.is_none() =>
                    {
                        registry.candidate(launch_id, input.pending_grant_id, &input.workspace_id)
                    }
                    (WorkspaceTransactionKind::Reauthorize, "reauthorize-prepared")
                        if transaction.workspace_id.as_deref() == Some(&input.workspace_id) =>
                    {
                        let old_grant = commit_store
                            .get(&input.workspace_id)
                            .map_err(|_| BridgeHandlerError::workspace_failure())?;
                        let expected_generation = if old_grant.is_some() {
                            transaction.expected_grant_generation.checked_add(1)
                        } else {
                            Some(transaction.expected_grant_generation)
                        };
                        if expected_generation != Some(input.expected_grant_generation) {
                            return Err(BridgeHandlerError::invalid_request());
                        }
                        registry.reauthorization_candidate(
                            launch_id,
                            input.pending_grant_id,
                            &input.workspace_id,
                            old_grant.as_ref(),
                            input.expected_canonical_path.as_deref(),
                        )
                    }
                    _ => Err(super::grants::WorkspaceGrantError::InvalidPendingGrant),
                }
                .map_err(|_| BridgeHandlerError::workspace_failure())?;
                grant.operation_id = input.operation_id;
                grant.previous_operation_id = None;
                grant.previous_status = None;
                let validated_grant = grant.clone();
                commit_store
                    .commit_validated(grant, input.expected_grant_generation, || {
                        registry.revalidate_candidate(
                            launch_id,
                            input.pending_grant_id,
                            &input.workspace_id,
                            &validated_grant,
                        )
                    })
                    .map_err(|_| BridgeHandlerError::workspace_failure())?;
                registry.promote_validated(input.pending_grant_id, &input.workspace_id);
                Ok(json!({
                    "workspaceId": input.workspace_id,
                    "displayPath": validated_grant.display_path,
                    "state": "ready",
                }))
            })
            .ok_or_else(BridgeHandlerError::invalid_request)?
    });
    tables
        .set_host_handler("commitWorkspaceAuthorization", commit)
        .map_err(|error| error.to_string())?;

    let abort_registry = registry.clone();
    let abort: BridgeHandler = Arc::new(move |payload, cancellation| {
        let input: PendingGrantInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        cancellation
            .commit_if_active(|| {
                abort_registry
                    .lock()
                    .map_err(|_| BridgeHandlerError::workspace_failure())?
                    .abort(launch_id, input.pending_grant_id)
                    .map_err(|_| BridgeHandlerError::workspace_failure())?;
                Ok(Value::Null)
            })
            .ok_or_else(BridgeHandlerError::invalid_request)?
    });
    tables
        .set_host_handler("abortWorkspaceAuthorization", abort)
        .map_err(|error| error.to_string())?;

    let generation_store = store.clone();
    let generation: BridgeHandler = Arc::new(move |payload, _cancellation| {
        if !payload.is_null() {
            return Err(BridgeHandlerError::invalid_request());
        }
        let generation = generation_store
            .load()
            .map_err(|_| BridgeHandlerError::workspace_failure())?
            .generation;
        Ok(json!(generation))
    });
    tables
        .set_host_handler("getWorkspaceGrantGeneration", generation)
        .map_err(|error| error.to_string())?;

    let inspect_store = store.clone();
    let inspect: BridgeHandler = Arc::new(move |payload, _cancellation| {
        let input: WorkspaceGrantInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        if input.workspace_id.is_empty() {
            return Err(BridgeHandlerError::invalid_request());
        }
        let grant = inspect_store
            .get(&input.workspace_id)
            .map_err(|_| BridgeHandlerError::workspace_failure())?;
        Ok(match grant {
            Some(grant) => {
                let (identity_valid, effective_status) = match reopen_verified_grant(&grant) {
                    Ok(_) => (
                        true,
                        match grant.status {
                            GrantStatus::Revoking | GrantStatus::Reauthorizing => {
                                GrantStatus::Ready
                            }
                            status => status,
                        },
                    ),
                    Err(error) => (
                        false,
                        error
                            .status()
                            .ok_or_else(BridgeHandlerError::workspace_failure)?,
                    ),
                };
                json!({
                    "exists": true,
                    "generation": grant.generation,
                    "operationId": grant.operation_id,
                    "identityValid": identity_valid,
                    "displayPath": grant.display_path,
                    "status": grant.status,
                    "effectiveStatus": effective_status,
                })
            }
            None => json!({
                "exists": false,
                "identityValid": false,
                "effectiveStatus": "missing",
            }),
        })
    });
    tables
        .set_host_handler("inspectWorkspaceGrant", inspect)
        .map_err(|error| error.to_string())?;

    let reveal_store = store.clone();
    let reveal_gate = operation_gate.clone();
    let reveal: BridgeHandler = Arc::new(move |payload, cancellation| {
        let input: WorkspaceGrantInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        if input.workspace_id.is_empty() {
            return Err(BridgeHandlerError::invalid_request());
        }
        let _lease = reveal_gate
            .acquire(&input.workspace_id)
            .map_err(|_| BridgeHandlerError::workspace_failure())?;
        let grant = reveal_store
            .get(&input.workspace_id)
            .map_err(|_| BridgeHandlerError::workspace_failure())?
            .ok_or_else(BridgeHandlerError::workspace_failure)?;
        if grant.status != GrantStatus::Ready {
            return Err(BridgeHandlerError::workspace_failure());
        }
        let verified =
            reopen_verified_grant(&grant).map_err(|_| BridgeHandlerError::workspace_failure())?;
        cancellation
            .commit_if_active(|| reveal_workspace(verified))
            .ok_or_else(BridgeHandlerError::invalid_request)??;
        Ok(Value::Null)
    });
    tables
        .set_browser_handler("revealWorkspace", reveal)
        .map_err(|error| error.to_string())?;

    let needs_authorization_store = store.clone();
    let needs_authorization: BridgeHandler = Arc::new(move |payload, cancellation| {
        let input: WorkspaceGrantMutationInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        cancellation
            .commit_if_active(|| {
                let current = needs_authorization_store
                    .get(&input.workspace_id)
                    .map_err(|_| BridgeHandlerError::workspace_failure())?
                    .ok_or_else(BridgeHandlerError::workspace_failure)?;
                let generation = if let Some(operation_id) = input.operation_id {
                    needs_authorization_store.finish_operation(
                        &input.workspace_id,
                        current.status,
                        GrantStatus::NeedsAuthorization,
                        input.expected_grant_generation,
                        operation_id,
                    )
                } else if matches!(
                    current.status,
                    GrantStatus::Revoking | GrantStatus::Reauthorizing
                ) {
                    Err(super::grants::WorkspaceGrantError::InvalidPendingGrant)
                } else {
                    needs_authorization_store.update_status(
                        &input.workspace_id,
                        current.status,
                        GrantStatus::NeedsAuthorization,
                        input.expected_grant_generation,
                    )
                }
                .map_err(|_| BridgeHandlerError::workspace_failure())?;
                Ok(json!(generation))
            })
            .ok_or_else(BridgeHandlerError::invalid_request)?
    });
    tables
        .set_host_handler("markWorkspaceGrantNeedsAuthorization", needs_authorization)
        .map_err(|error| error.to_string())?;

    let restore_store = store.clone();
    let restore_registry = registry.clone();
    let restore_journal = journal.clone();
    let restore: BridgeHandler = Arc::new(move |payload, cancellation| {
        let input: WorkspaceGrantOperationInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        cancellation
            .commit_if_active(|| {
                if restore_registry
                    .lock()
                    .map_err(|_| BridgeHandlerError::workspace_failure())?
                    .committed_descriptor(&input.workspace_id)
                    .is_none()
                {
                    return Err(BridgeHandlerError::workspace_failure());
                }
                let transaction = restore_journal
                    .read()
                    .map_err(|_| BridgeHandlerError::workspace_failure())?
                    .ok_or_else(BridgeHandlerError::workspace_failure)?;
                let expected_status = match (transaction.kind, transaction.stage.as_str()) {
                    (WorkspaceTransactionKind::Revoke, "revoke-prepared")
                    | (WorkspaceTransactionKind::Revoke, "registry-deleted")
                        if transaction.workspace_id.as_deref() == Some(&input.workspace_id)
                            && transaction.operation_id == input.operation_id =>
                    {
                        GrantStatus::Revoking
                    }
                    (WorkspaceTransactionKind::Reauthorize, "reauthorize-prepared")
                        if transaction.workspace_id.as_deref() == Some(&input.workspace_id)
                            && transaction.operation_id == input.operation_id =>
                    {
                        GrantStatus::Reauthorizing
                    }
                    _ => return Err(BridgeHandlerError::invalid_request()),
                };
                let generation = restore_store
                    .rollback_operation(
                        &input.workspace_id,
                        expected_status,
                        input.expected_grant_generation,
                        input.operation_id,
                    )
                    .map_err(|_| BridgeHandlerError::workspace_failure())?;
                Ok(json!(generation))
            })
            .ok_or_else(BridgeHandlerError::invalid_request)?
    });
    tables
        .set_host_handler("restoreWorkspaceGrantReady", restore)
        .map_err(|error| error.to_string())?;

    let confirm: BridgeHandler = Arc::new(move |payload, cancellation| {
        let input: ConfirmRevokeInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        if input.workspace_id.is_empty() || input.title.trim().is_empty() {
            return Err(BridgeHandlerError::invalid_request());
        }
        let confirmed = confirmation
            .confirm_cancellable(
                &RevokePresentation {
                    workspace_id: input.workspace_id,
                    title: input.title,
                },
                &cancellation,
            )
            .map_err(|_| BridgeHandlerError::workspace_failure())?;
        Ok(json!(if confirmed { "confirmed" } else { "cancelled" }))
    });
    tables
        .set_host_handler("confirmWorkspaceRevoke", confirm)
        .map_err(|error| error.to_string())?;

    let revoking_store = store.clone();
    let revoking_journal = journal.clone();
    let revoking_gate = operation_gate.clone();
    let mark_revoking: BridgeHandler = Arc::new(move |payload, cancellation| {
        let input: WorkspaceGrantOperationInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        cancellation
            .commit_if_active(|| {
                let _blocked = revoking_gate
                    .block_new_operations(&input.workspace_id)
                    .map_err(|_| BridgeHandlerError::workspace_failure())?;
                let transaction = revoking_journal
                    .read()
                    .map_err(|_| BridgeHandlerError::workspace_failure())?
                    .ok_or_else(BridgeHandlerError::workspace_failure)?;
                if transaction.kind != WorkspaceTransactionKind::Revoke
                    || transaction.stage != "revoke-prepared"
                    || transaction.workspace_id.as_deref() != Some(&input.workspace_id)
                    || transaction.operation_id != input.operation_id
                    || transaction.expected_grant_generation != input.expected_grant_generation
                {
                    return Err(BridgeHandlerError::invalid_request());
                }
                let current = revoking_store
                    .get(&input.workspace_id)
                    .map_err(|_| BridgeHandlerError::workspace_failure())?
                    .ok_or_else(BridgeHandlerError::workspace_failure)?;
                if matches!(
                    current.status,
                    GrantStatus::Revoking | GrantStatus::Reauthorizing
                ) {
                    return Err(BridgeHandlerError::invalid_request());
                }
                let generation = revoking_store
                    .begin_operation(
                        &input.workspace_id,
                        current.status,
                        GrantStatus::Revoking,
                        input.expected_grant_generation,
                        input.operation_id,
                    )
                    .map_err(|_| BridgeHandlerError::workspace_failure())?;
                Ok(json!(generation))
            })
            .ok_or_else(BridgeHandlerError::invalid_request)?
    });
    tables
        .set_host_handler("markWorkspaceGrantRevoking", mark_revoking)
        .map_err(|error| error.to_string())?;

    let reauthorizing_store = store.clone();
    let reauthorizing_journal = journal.clone();
    let reauthorizing_gate = operation_gate.clone();
    let mark_reauthorizing: BridgeHandler = Arc::new(move |payload, cancellation| {
        let input: WorkspaceGrantOperationInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        cancellation
            .commit_if_active(|| {
                let _blocked = reauthorizing_gate
                    .block_new_operations(&input.workspace_id)
                    .map_err(|_| BridgeHandlerError::workspace_failure())?;
                let transaction = reauthorizing_journal
                    .read()
                    .map_err(|_| BridgeHandlerError::workspace_failure())?
                    .ok_or_else(BridgeHandlerError::workspace_failure)?;
                if transaction.kind != WorkspaceTransactionKind::Reauthorize
                    || transaction.stage != "reauthorize-prepared"
                    || transaction.workspace_id.as_deref() != Some(&input.workspace_id)
                    || transaction.operation_id != input.operation_id
                    || transaction.expected_grant_generation != input.expected_grant_generation
                {
                    return Err(BridgeHandlerError::invalid_request());
                }
                let current = reauthorizing_store
                    .get(&input.workspace_id)
                    .map_err(|_| BridgeHandlerError::workspace_failure())?
                    .ok_or_else(BridgeHandlerError::workspace_failure)?;
                if matches!(
                    current.status,
                    GrantStatus::Revoking | GrantStatus::Reauthorizing
                ) {
                    return Err(BridgeHandlerError::invalid_request());
                }
                let generation = reauthorizing_store
                    .begin_operation(
                        &input.workspace_id,
                        current.status,
                        GrantStatus::Reauthorizing,
                        input.expected_grant_generation,
                        input.operation_id,
                    )
                    .map_err(|_| BridgeHandlerError::workspace_failure())?;
                Ok(json!(generation))
            })
            .ok_or_else(BridgeHandlerError::invalid_request)?
    });
    tables
        .set_host_handler("markWorkspaceGrantReauthorizing", mark_reauthorizing)
        .map_err(|error| error.to_string())?;

    let delete_store = store;
    let delete_registry = registry;
    let delete_journal = journal;
    let delete_gate = operation_gate;
    let delete: BridgeHandler = Arc::new(move |payload, cancellation| {
        let input: WorkspaceGrantMutationInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        cancellation
            .commit_if_active(|| {
                let _blocked = delete_gate
                    .block_new_operations(&input.workspace_id)
                    .map_err(|_| BridgeHandlerError::workspace_failure())?;
                let transaction = delete_journal
                    .read()
                    .map_err(|_| BridgeHandlerError::workspace_failure())?
                    .ok_or_else(BridgeHandlerError::workspace_failure)?;
                if transaction.workspace_id.as_deref() != Some(&input.workspace_id) {
                    return Err(BridgeHandlerError::invalid_request());
                }
                let generation = match (
                    transaction.kind,
                    transaction.stage.as_str(),
                    input.operation_id,
                ) {
                    (WorkspaceTransactionKind::Revoke, "registry-deleted", Some(operation_id))
                        if transaction.operation_id == operation_id =>
                    {
                        delete_store.delete_operation(
                            &input.workspace_id,
                            GrantStatus::Revoking,
                            input.expected_grant_generation,
                            operation_id,
                        )
                    }
                    (WorkspaceTransactionKind::Revoke, "registry-deleted", None)
                        if transaction.expected_grant_generation
                            == input.expected_grant_generation =>
                    {
                        let current = delete_store
                            .get(&input.workspace_id)
                            .map_err(|_| BridgeHandlerError::workspace_failure())?
                            .ok_or_else(BridgeHandlerError::workspace_failure)?;
                        if current.generation != input.expected_grant_generation
                            || matches!(
                                current.status,
                                GrantStatus::Revoking | GrantStatus::Reauthorizing
                            )
                        {
                            return Err(BridgeHandlerError::invalid_request());
                        }
                        delete_store.delete(
                            &input.workspace_id,
                            current.status,
                            input.expected_grant_generation,
                        )
                    }
                    (
                        WorkspaceTransactionKind::Reauthorize,
                        "reauthorize-prepared",
                        Some(operation_id),
                    ) if transaction.operation_id == operation_id
                        && (transaction.expected_grant_generation.checked_add(1)
                            == Some(input.expected_grant_generation)
                            || transaction.expected_grant_generation.checked_add(2)
                                == Some(input.expected_grant_generation)) =>
                    {
                        delete_store.delete_operation(
                            &input.workspace_id,
                            GrantStatus::Ready,
                            input.expected_grant_generation,
                            operation_id,
                        )
                    }
                    (
                        WorkspaceTransactionKind::Reauthorize,
                        "grant-committed",
                        Some(operation_id),
                    ) if transaction.operation_id == operation_id
                        && transaction.expected_grant_generation.checked_add(2)
                            == Some(input.expected_grant_generation) =>
                    {
                        delete_store.delete_operation(
                            &input.workspace_id,
                            GrantStatus::Ready,
                            input.expected_grant_generation,
                            operation_id,
                        )
                    }
                    _ => return Err(BridgeHandlerError::invalid_request()),
                }
                .map_err(|_| BridgeHandlerError::workspace_failure())?;
                delete_registry
                    .lock()
                    .map_err(|_| BridgeHandlerError::workspace_failure())?
                    .revoke_committed(&input.workspace_id);
                Ok(json!(generation))
            })
            .ok_or_else(BridgeHandlerError::invalid_request)?
    });
    tables
        .set_host_handler("deleteWorkspaceGrant", delete)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn reveal_workspace_in_finder(verified: VerifiedGrant) -> Result<(), BridgeHandlerError> {
    let descriptor = verified.descriptor().as_raw_fd();
    let mut command = Command::new("/usr/bin/open");
    command.arg("-R").arg(format!("/dev/fd/{descriptor}"));
    unsafe {
        command.pre_exec(move || {
            let flags = libc::fcntl(descriptor, libc::F_GETFD);
            if flags < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let status = command
        .status()
        .map_err(|_| BridgeHandlerError::workspace_failure())?;
    drop(verified);
    if !status.success() {
        return Err(BridgeHandlerError::workspace_failure());
    }
    Ok(())
}

pub fn install_workspace_transaction_handlers(
    tables: &mut BridgeDispatchTables,
    journal: WorkspaceJournal,
) -> Result<(), String> {
    let journal = Arc::new(journal);
    let read_journal = journal.clone();
    let read: BridgeHandler = Arc::new(move |payload, _cancellation| {
        if !payload.is_null() {
            return Err(BridgeHandlerError::invalid_request());
        }
        serde_json::to_value(
            read_journal
                .read()
                .map_err(|_| BridgeHandlerError::workspace_failure())?,
        )
        .map_err(|_| BridgeHandlerError::workspace_failure())
    });
    tables
        .set_host_handler("readWorkspaceTransaction", read)
        .map_err(|error| error.to_string())?;

    let prepare_journal = journal.clone();
    let prepare: BridgeHandler = Arc::new(move |payload, cancellation| {
        let input: PrepareInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        if !valid_initial_payload(input.kind, &input.stage, input.workspace_id.as_deref()) {
            return Err(BridgeHandlerError::invalid_request());
        }
        cancellation
            .commit_if_active(|| {
                if prepare_journal
                    .read()
                    .map_err(|_| BridgeHandlerError::workspace_failure())?
                    .is_some()
                {
                    return Err(BridgeHandlerError::workspace_failure());
                }
                let transaction = WorkspaceTransaction {
                    version: 1,
                    generation: 1,
                    operation_id: input.operation_id.unwrap_or_else(Uuid::new_v4),
                    kind: input.kind,
                    workspace_id: input.workspace_id,
                    expected_catalog_generation: input.expected_catalog_generation,
                    expected_grant_generation: input.expected_grant_generation,
                    stage: input.stage,
                };
                prepare_journal
                    .write(transaction.clone(), 0)
                    .map_err(|_| BridgeHandlerError::workspace_failure())?;
                transaction_value(&transaction)
            })
            .ok_or_else(BridgeHandlerError::invalid_request)?
    });
    tables
        .set_host_handler("prepareWorkspaceTransaction", prepare)
        .map_err(|error| error.to_string())?;

    let advance_journal = journal.clone();
    let advance: BridgeHandler = Arc::new(move |payload, cancellation| {
        let input: AdvanceInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        cancellation
            .commit_if_active(|| {
                let current = advance_journal
                    .read()
                    .map_err(|_| BridgeHandlerError::workspace_failure())?
                    .ok_or_else(BridgeHandlerError::workspace_failure)?;
                if current.operation_id != input.operation_id
                    || current.generation != input.expected_generation
                    || current.stage != input.expected_stage
                    || !valid_transition(current.kind, &current.stage, &input.next_stage)
                    || !valid_workspace_binding(
                        current.kind,
                        &current.stage,
                        &input.next_stage,
                        current.workspace_id.as_deref(),
                        input.workspace_id.as_deref(),
                    )
                {
                    return Err(BridgeHandlerError::invalid_request());
                }
                let next = WorkspaceTransaction {
                    generation: current.generation + 1,
                    workspace_id: input.workspace_id.or(current.workspace_id),
                    stage: input.next_stage,
                    ..current
                };
                advance_journal
                    .write(next.clone(), next.generation - 1)
                    .map_err(|_| BridgeHandlerError::workspace_failure())?;
                transaction_value(&next)
            })
            .ok_or_else(BridgeHandlerError::invalid_request)?
    });
    tables
        .set_host_handler("advanceWorkspaceTransaction", advance)
        .map_err(|error| error.to_string())?;

    for (method, valid_finish) in [
        (
            "abortWorkspaceTransaction",
            valid_abort_stage as fn(WorkspaceTransactionKind, &str) -> bool,
        ),
        (
            "completeWorkspaceTransaction",
            valid_complete_stage as fn(WorkspaceTransactionKind, &str) -> bool,
        ),
    ] {
        let finish_journal = journal.clone();
        let finish: BridgeHandler = Arc::new(move |payload, cancellation| {
            let input: FinishInput = serde_json::from_value(payload)
                .map_err(|_| BridgeHandlerError::invalid_request())?;
            cancellation
                .commit_if_active(|| {
                    let current = finish_journal
                        .read()
                        .map_err(|_| BridgeHandlerError::workspace_failure())?
                        .ok_or_else(BridgeHandlerError::workspace_failure)?;
                    if current.operation_id != input.operation_id
                        || current.generation != input.expected_generation
                        || current.stage != input.expected_stage
                        || !valid_finish(current.kind, &current.stage)
                    {
                        return Err(BridgeHandlerError::invalid_request());
                    }
                    finish_journal
                        .clear(current.generation)
                        .map_err(|_| BridgeHandlerError::workspace_failure())?;
                    Ok(Value::Null)
                })
                .ok_or_else(BridgeHandlerError::invalid_request)?
        });
        tables
            .set_host_handler(method, finish)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn transaction_value(transaction: &WorkspaceTransaction) -> Result<Value, BridgeHandlerError> {
    Ok(json!({
        "operationId": transaction.operation_id,
        "generation": transaction.generation,
        "stage": transaction.stage,
    }))
}

fn valid_initial_payload(
    kind: WorkspaceTransactionKind,
    stage: &str,
    workspace_id: Option<&str>,
) -> bool {
    match (kind, stage, workspace_id) {
        (WorkspaceTransactionKind::Add, "prepared", Some(workspace_id)) => !workspace_id.is_empty(),
        (WorkspaceTransactionKind::Revoke, "revoke-prepared", Some(workspace_id))
        | (WorkspaceTransactionKind::Reauthorize, "reauthorize-prepared", Some(workspace_id)) => {
            !workspace_id.is_empty()
        }
        _ => false,
    }
}

fn valid_transition(kind: WorkspaceTransactionKind, current: &str, next: &str) -> bool {
    matches!(
        (kind, current, next),
        (
            WorkspaceTransactionKind::Add,
            "prepared",
            "registry-committed"
        ) | (
            WorkspaceTransactionKind::Add,
            "registry-committed",
            "grant-committed"
        ) | (
            WorkspaceTransactionKind::Add,
            "registry-committed",
            "authorization-failed"
        ) | (
            WorkspaceTransactionKind::Revoke,
            "revoke-prepared",
            "registry-deleted"
        ) | (
            WorkspaceTransactionKind::Revoke,
            "registry-deleted",
            "grant-deleted"
        ) | (
            WorkspaceTransactionKind::Reauthorize,
            "reauthorize-prepared",
            "grant-committed"
        )
    )
}

fn valid_abort_stage(kind: WorkspaceTransactionKind, stage: &str) -> bool {
    matches!(
        (kind, stage),
        (WorkspaceTransactionKind::Add, "prepared")
            | (WorkspaceTransactionKind::Revoke, "revoke-prepared")
            | (
                WorkspaceTransactionKind::Reauthorize,
                "reauthorize-prepared"
            )
    )
}

fn valid_workspace_binding(
    kind: WorkspaceTransactionKind,
    current: &str,
    next: &str,
    current_workspace_id: Option<&str>,
    requested_workspace_id: Option<&str>,
) -> bool {
    if matches!(
        (kind, current, next),
        (
            WorkspaceTransactionKind::Add,
            "prepared",
            "registry-committed"
        )
    ) {
        return match current_workspace_id {
            Some(workspace_id) => !workspace_id.is_empty() && requested_workspace_id.is_none(),
            None => requested_workspace_id.is_some_and(|workspace_id| !workspace_id.is_empty()),
        };
    }
    requested_workspace_id.is_none()
}

fn valid_complete_stage(kind: WorkspaceTransactionKind, stage: &str) -> bool {
    matches!(
        (kind, stage),
        (WorkspaceTransactionKind::Add, "grant-committed")
            | (WorkspaceTransactionKind::Add, "authorization-failed")
            | (WorkspaceTransactionKind::Revoke, "grant-deleted")
            | (WorkspaceTransactionKind::Reauthorize, "grant-committed")
    )
}
