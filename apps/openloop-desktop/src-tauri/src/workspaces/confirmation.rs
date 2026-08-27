use super::grants::WorkspaceGrantError;

pub trait RevokeConfirmation: Send + Sync {
    fn confirm(&self, workspace_title: &str) -> Result<bool, WorkspaceGrantError>;
}

pub fn confirm_workspace_revoke(
    confirmation: &dyn RevokeConfirmation,
    committed_workspace_title: &str,
) -> Result<bool, WorkspaceGrantError> {
    if committed_workspace_title.trim().is_empty() {
        return Err(WorkspaceGrantError::Corrupt(
            "committed Workspace title is empty".to_owned(),
        ));
    }
    confirmation.confirm(committed_workspace_title)
}
