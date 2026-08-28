use std::{
    collections::HashMap,
    sync::{Arc, Condvar, Mutex},
};

#[derive(Default)]
pub struct WorkspaceOperationGate {
    state: Mutex<HashMap<String, WorkspaceOperationState>>,
    wake: Condvar,
}

#[derive(Default)]
struct WorkspaceOperationState {
    active: usize,
    blocking: bool,
}

pub struct WorkspaceOperationLease {
    gate: Arc<WorkspaceOperationGate>,
    workspace_id: String,
}

pub struct WorkspaceOperationBlock {
    gate: Arc<WorkspaceOperationGate>,
    workspace_id: String,
}

impl WorkspaceOperationGate {
    pub fn acquire(self: &Arc<Self>, workspace_id: &str) -> Result<WorkspaceOperationLease, ()> {
        let mut states = self.state.lock().map_err(|_| ())?;
        let state = states.entry(workspace_id.to_owned()).or_default();
        if state.blocking {
            return Err(());
        }
        state.active = state.active.checked_add(1).ok_or(())?;
        Ok(WorkspaceOperationLease {
            gate: self.clone(),
            workspace_id: workspace_id.to_owned(),
        })
    }

    pub fn block_new_operations(
        self: &Arc<Self>,
        workspace_id: &str,
    ) -> Result<WorkspaceOperationBlock, ()> {
        let mut states = self.state.lock().map_err(|_| ())?;
        let state = states.entry(workspace_id.to_owned()).or_default();
        if state.blocking {
            return Err(());
        }
        state.blocking = true;
        while states
            .get(workspace_id)
            .is_some_and(|state| state.active != 0)
        {
            states = self.wake.wait(states).map_err(|_| ())?;
        }
        Ok(WorkspaceOperationBlock {
            gate: self.clone(),
            workspace_id: workspace_id.to_owned(),
        })
    }

    pub fn is_blocking(&self, workspace_id: &str) -> bool {
        self.state
            .lock()
            .map(|states| states.get(workspace_id).is_some_and(|state| state.blocking))
            .unwrap_or(true)
    }
}

impl Drop for WorkspaceOperationLease {
    fn drop(&mut self) {
        let Ok(mut states) = self.gate.state.lock() else {
            return;
        };
        let Some(state) = states.get_mut(&self.workspace_id) else {
            return;
        };
        state.active = state.active.saturating_sub(1);
        if state.active == 0 {
            self.gate.wake.notify_all();
            if !state.blocking {
                states.remove(&self.workspace_id);
            }
        }
    }
}

impl Drop for WorkspaceOperationBlock {
    fn drop(&mut self) {
        let Ok(mut states) = self.gate.state.lock() else {
            return;
        };
        if let Some(state) = states.get_mut(&self.workspace_id) {
            state.blocking = false;
            if state.active == 0 {
                states.remove(&self.workspace_id);
            }
        }
        self.gate.wake.notify_all();
    }
}
