const shell = {
  renderApp: (): string => 'current-dsh-shell',
}

const workspace = {
  items: [{
    workspaceId: 'workspace-current',
    path: '/fixtures/current',
    title: 'Current workspace',
    sessionIds: ['session-current'],
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T01:00:00.000Z',
  }],
  archivedSessionIds: ['session-archived'],
}

const settings = {
  writable: false,
  hasDocument: true,
  namespaces: [{
    ns: 'appearance',
    schema: { type: 'object' },
    value: { theme: 'system' },
    user: { theme: 'system' },
    applies: 'restart' as const,
    secrets: [{ path: ['token'], set: true }],
    revision: 7,
  }],
}

const desktop = {
  version: '0.1.0-rc.7',
  cwd: '/fixtures/current',
  attachedSessions: 2,
  canOpenPath: true,
}

export const currentDshFixture = {
  shell,
  workspace,
  settings,
  desktop,
}
