use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::bridge::server::{BridgeDispatchTables, BridgeHandler, BridgeHandlerError};

use super::journal::{WorkspaceJournal, WorkspaceTransaction, WorkspaceTransactionKind};
use super::{
    confirmation::{RevokeConfirmation, RevokePresentation},
    grants::{GrantStatus, GrantStore},
    picker::{PendingGrantRegistry, WorkspaceDirectoryPicker},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommitGrantInput {
    pending_grant_id: Uuid,
    workspace_id: String,
    expected_grant_generation: u64,
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
    let begin_registry = registry.clone();
    let begin: BridgeHandler = Arc::new(move |payload, cancellation| {
        if !payload.is_null() {
            return Err(BridgeHandlerError::invalid_request());
        }
        let selection = picker
            .pick()
            .map_err(|_| BridgeHandlerError::workspace_failure())?;
        let Some(path) = selection else {
            return Ok(json!({ "outcome": "cancelled" }));
        };
        cancellation
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
                Ok(json!({
                    "outcome": "pending",
                    "pendingGrantId": pending_grant_id,
                    "path": canonical_path,
                }))
            })
            .ok_or_else(BridgeHandlerError::invalid_request)?
    });
    tables
        .set_host_handler("beginWorkspaceAuthorization", begin)
        .map_err(|error| error.to_string())?;

    let commit_store = store.clone();
    let commit_journal = journal;
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
                let grant = match (transaction.kind, transaction.stage.as_str()) {
                    (WorkspaceTransactionKind::Add, "registry-committed")
                        if transaction.workspace_id.as_deref() == Some(&input.workspace_id)
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
                commit_store
                    .commit(grant, input.expected_grant_generation)
                    .map_err(|_| BridgeHandlerError::workspace_failure())?;
                registry
                    .commit(launch_id, input.pending_grant_id, &input.workspace_id)
                    .map_err(|_| BridgeHandlerError::workspace_failure())?;
                Ok(json!({
                    "workspaceId": input.workspace_id,
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
    let inspect_registry = registry.clone();
    let inspect: BridgeHandler = Arc::new(move |payload, _cancellation| {
        let input: WorkspaceGrantInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        if input.workspace_id.is_empty() {
            return Err(BridgeHandlerError::invalid_request());
        }
        let grant = inspect_store
            .get(&input.workspace_id)
            .map_err(|_| BridgeHandlerError::workspace_failure())?;
        let identity_valid = inspect_registry
            .lock()
            .map_err(|_| BridgeHandlerError::workspace_failure())?
            .committed_descriptor(&input.workspace_id)
            .is_some();
        Ok(match grant {
            Some(grant) => json!({
                "exists": true,
                "generation": grant.generation,
                "identityValid": identity_valid,
                "status": grant.status,
            }),
            None => json!({
                "exists": false,
                "identityValid": false,
            }),
        })
    });
    tables
        .set_host_handler("inspectWorkspaceGrant", inspect)
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
                let generation = needs_authorization_store
                    .update_status(
                        &input.workspace_id,
                        current.status,
                        GrantStatus::NeedsAuthorization,
                        input.expected_grant_generation,
                    )
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
    let restore: BridgeHandler = Arc::new(move |payload, cancellation| {
        let input: WorkspaceGrantMutationInput =
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
                let current = restore_store
                    .get(&input.workspace_id)
                    .map_err(|_| BridgeHandlerError::workspace_failure())?
                    .ok_or_else(BridgeHandlerError::workspace_failure)?;
                let generation = restore_store
                    .update_status(
                        &input.workspace_id,
                        current.status,
                        GrantStatus::Ready,
                        input.expected_grant_generation,
                    )
                    .map_err(|_| BridgeHandlerError::workspace_failure())?;
                Ok(json!(generation))
            })
            .ok_or_else(BridgeHandlerError::invalid_request)?
    });
    tables
        .set_host_handler("restoreWorkspaceGrantReady", restore)
        .map_err(|error| error.to_string())?;

    let confirm_store = store.clone();
    let confirm: BridgeHandler = Arc::new(move |payload, _cancellation| {
        let input: ConfirmRevokeInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        if input.workspace_id.is_empty()
            || input.title.trim().is_empty()
            || confirm_store
                .get(&input.workspace_id)
                .map_err(|_| BridgeHandlerError::workspace_failure())?
                .is_none()
        {
            return Err(BridgeHandlerError::invalid_request());
        }
        let confirmed = confirmation
            .confirm(&RevokePresentation {
                workspace_id: input.workspace_id,
                title: input.title,
            })
            .map_err(|_| BridgeHandlerError::workspace_failure())?;
        Ok(json!(if confirmed { "confirmed" } else { "cancelled" }))
    });
    tables
        .set_host_handler("confirmWorkspaceRevoke", confirm)
        .map_err(|error| error.to_string())?;

    let revoking_store = store.clone();
    let mark_revoking: BridgeHandler = Arc::new(move |payload, cancellation| {
        let input: WorkspaceGrantMutationInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        cancellation
            .commit_if_active(|| {
                let current = revoking_store
                    .get(&input.workspace_id)
                    .map_err(|_| BridgeHandlerError::workspace_failure())?
                    .ok_or_else(BridgeHandlerError::workspace_failure)?;
                let generation = revoking_store
                    .update_status(
                        &input.workspace_id,
                        current.status,
                        GrantStatus::Revoking,
                        input.expected_grant_generation,
                    )
                    .map_err(|_| BridgeHandlerError::workspace_failure())?;
                Ok(json!(generation))
            })
            .ok_or_else(BridgeHandlerError::invalid_request)?
    });
    tables
        .set_host_handler("markWorkspaceGrantRevoking", mark_revoking)
        .map_err(|error| error.to_string())?;

    let delete_store = store;
    let delete_registry = registry;
    let delete: BridgeHandler = Arc::new(move |payload, cancellation| {
        let input: WorkspaceGrantMutationInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        cancellation
            .commit_if_active(|| {
                let generation = delete_store
                    .delete(
                        &input.workspace_id,
                        GrantStatus::Revoking,
                        input.expected_grant_generation,
                    )
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
                    operation_id: Uuid::new_v4(),
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
        (WorkspaceTransactionKind::Add, "prepared", None) => true,
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
        return current_workspace_id.is_none()
            && requested_workspace_id.is_some_and(|workspace_id| !workspace_id.is_empty());
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
