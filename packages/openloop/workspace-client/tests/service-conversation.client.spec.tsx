// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import {
  createSnapshotStore,
  EMPTY_CHAT_SNAPSHOT,
  EMPTY_CONVERSATION_VIEWS,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationSnapshot,
  SessionId,
  SessionListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { OpenloopWorkspaceService } from '@openloop/desktop-bridge-client/client'
import type {
  OpenloopWorkspaceRemote,
  OpenloopWorkspaceSessions,
} from '@openloop/desktop-bridge-client/client'
import { ConversationRoot } from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/ConversationRoot.tsx'
import type {
  ComposerBarOwnerProps,
  ConversationSlotProps,
} from '@deepseek-ai/dsh-client-ui-conversation/src/client/contract/slots.ts'
import type {
  InputActions,
  InputState,
} from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/contract.ts'

const SID = 'session-ready' as SessionId

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Openloop Workspace service and ConversationRoot contract', () => {
  it('makes a ready blank Workspace session routable before ConversationRoot renders it', async () => {
    const remote: OpenloopWorkspaceRemote = {
      listWorkspaceGrants: vi.fn(async () => ({
        ok: true as const,
        value: [{
          workspaceId: 'workspace-1',
          name: 'Project Alpha',
          displayPath: '~/Project Alpha',
          state: 'ready' as const,
          sessionIds: [SID],
        }],
      })),
      authorizeWorkspace: vi.fn(async () => ({ ok: true as const, value: 'cancelled' as const })),
      reauthorizeWorkspace: vi.fn(async () => ({ ok: true as const, value: 'cancelled' as const })),
      renameWorkspace: vi.fn(async () => ({
        ok: true as const,
        value: {
          workspaceId: 'workspace-1',
          name: 'Project Alpha',
          displayPath: '~/Project Alpha',
          state: 'ready' as const,
          sessionIds: [SID],
        },
      })),
      revokeWorkspace: vi.fn(async () => ({ ok: true as const, value: 'cancelled' as const })),
      revealWorkspace: vi.fn(async () => ({ ok: true as const, value: undefined })),
    }
    const sessionPort: OpenloopWorkspaceSessions = {
      create: vi.fn(async () => SID),
      open: vi.fn(),
      clear: vi.fn(),
    }
    const service = new OpenloopWorkspaceService(remote, sessionPort)
    await service.refresh()

    const session = createSnapshotStore<ConversationSnapshot>({
      sessionId: SID,
      views: EMPTY_CONVERSATION_VIEWS,
      chat: EMPTY_CHAT_SNAPSHOT,
      nodes: [],
      turnTimings: new Map(),
      turnEnds: new Map(),
      partial: null,
      runningCalls: [],
      pending: [],
      queue: [],
      running: false,
      composerPhase: 'blank',
      removed: false,
      openState: 'open',
      openError: null,
      hasMore: false,
      loadingOlder: false,
      promptError: null,
      blank: true,
      subagent: null,
      lastAgentError: null,
    })
    const sessions = createSnapshotStore<SessionListState>({
      ids: [SID],
      byId: {
        [SID]: {
          id: SID,
          displayTitle: 'Blank session',
          running: false,
          blank: true,
          updatedAt: 1,
        },
      },
      current: SID,
      phase: 'ready',
      subagentsByParent: {},
      jobsBySession: {},
      currentAddress: undefined,
    })
    const input = createSnapshotStore<InputState>({
      draft: '',
      imageIds: [],
      draftRev: 0,
      phase: 'plain',
      occurrences: [],
      queue: [],
    })
    const inputActions: InputActions = {
      setDraft: vi.fn(),
      addImages: vi.fn(() => true),
      removeImage: vi.fn(),
      pruneImages: vi.fn(),
      submit: vi.fn(),
    }
    const renderSlot = ((key: string, owner: object) => {
      if (key === 'conversation.composer.bar') {
        const bar = owner as ComposerBarOwnerProps
        return (
          <textarea
            aria-label="composer"
            readOnly={bar.disabled === true}
            disabled={bar.blocked !== undefined}
            placeholder={bar.placeholder}
          />
        )
      }
      return null
    }) as ConversationSlotProps['renderSlot']
    const renderSlotChain = ((_key, _owner, options) =>
      options?.fallback ?? null) as ConversationSlotProps['renderSlotChain']
    const props: ConversationSlotProps = {
      sessionId: SID,
      SessionProvider: ({ children }) => children(SID),
      useSession: bindSnapshotSelector(session),
      useSessions: bindSnapshotSelector(sessions),
      useWorkspaces: bindSnapshotSelector(service.list),
      useProjection: () => undefined,
      useComposerBlock: select => select(undefined),
      useInput: bindSnapshotSelector(input),
      inputActions,
      renderSlot,
      renderSlotChain,
      selectWorkspace: vi.fn(async () => {}),
      t: key => key,
    }

    const view = render(<ConversationRoot {...props} />)
    const composer = view.getByRole('textbox', { name: 'composer' }) as HTMLTextAreaElement
    expect(view.getByText('Project Alpha')).toBeTruthy()
    expect(composer.readOnly).toBe(false)
    expect(composer.disabled).toBe(false)
  })
})
