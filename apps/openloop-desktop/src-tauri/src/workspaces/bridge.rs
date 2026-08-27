use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::bridge::server::{BridgeDispatchTables, BridgeHandler, BridgeHandlerError};

use super::journal::{WorkspaceJournal, WorkspaceTransaction, WorkspaceTransactionKind};

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
    expected_stage: String,
    next_stage: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinishInput {
    operation_id: Uuid,
    expected_stage: String,
}

pub fn install_workspace_transaction_handlers(
    tables: &mut BridgeDispatchTables,
    journal: WorkspaceJournal,
) -> Result<(), String> {
    let journal = Arc::new(journal);
    let prepare_journal = journal.clone();
    let prepare: BridgeHandler = Arc::new(move |payload, cancellation| {
        let input: PrepareInput =
            serde_json::from_value(payload).map_err(|_| BridgeHandlerError::invalid_request())?;
        if !valid_initial_stage(input.kind, &input.stage)
            || input.workspace_id.as_deref().is_some_and(str::is_empty)
        {
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
                    || current.stage != input.expected_stage
                    || !valid_transition(current.kind, &current.stage, &input.next_stage)
                {
                    return Err(BridgeHandlerError::invalid_request());
                }
                let next = WorkspaceTransaction {
                    generation: current.generation + 1,
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

    for method in ["abortWorkspaceTransaction", "completeWorkspaceTransaction"] {
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
                        || current.stage != input.expected_stage
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

fn valid_initial_stage(kind: WorkspaceTransactionKind, stage: &str) -> bool {
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
