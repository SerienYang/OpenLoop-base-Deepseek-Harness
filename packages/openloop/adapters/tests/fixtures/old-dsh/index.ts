export const oldDshFixture = {
  shell: {
    renderApp: (): string => 'old-dsh-shell',
  },
  workspace: {
    items: [{
      workspaceId: 'workspace-old',
      path: '/fixtures/old',
      title: 'Old workspace',
      sessionIds: ['session-old'],
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T01:00:00.000Z',
    }],
  },
  settings: {
    writable: true,
    namespaces: [{
      ns: 'appearance',
      schema: { type: 'object' },
      value: { theme: 'dark' },
      applies: 'live' as const,
      secrets: [],
      revision: 3,
    }],
  },
  desktop: {
    version: '0.0.1',
    cwd: '/fixtures/old',
    provider: 'deepseek',
    model: 'deepseek-chat',
    attachedSessions: 1,
  },
}

export const documentPathDshFixture = {
  settings: {
    writable: true,
    documentPath: '/fixtures/old/settings.yaml',
    namespaces: oldDshFixture.settings.namespaces,
  },
}
