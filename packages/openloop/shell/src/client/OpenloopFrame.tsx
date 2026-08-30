import { useLayoutEffect, useRef } from 'react'
import { defineStore, type SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import css from './OpenloopFrame.module.css'

const SIDEBAR_WIDTH = 280
const SIDEBAR_COLLAPSED_WIDTH = 56
const DETAILS_WIDTH = 360

interface ShellState {
  sidebarOpen: boolean
  detailsOpen: boolean
}

interface ShellActions {
  toggleSidebar: (draft: ShellState) => void
  openDetails: (draft: ShellState) => void
  closeDetails: (draft: ShellState) => void
}

/** Root-scoped panel state behind the established DSH layout action contract. */
export function createOpenloopShellStore() {
  return defineStore({
    init: (): ShellState => ({ sidebarOpen: true, detailsOpen: false }),
    actions: {
      toggleSidebar: (draft) => { draft.sidebarOpen = !draft.sidebarOpen },
      openDetails: (draft) => { draft.detailsOpen = true },
      closeDetails: (draft) => { draft.detailsOpen = false },
    } satisfies ShellActions,
  })
}

export type OpenloopFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'workbench' | 'details' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createOpenloopShellStore>>

function currentConversation(state: SessionListState): string | undefined {
  const current = state.current
  return current !== undefined && state.byId[current]?.blank === false ? current : undefined
}

/** Openloop's operational frame; existing DSH session surfaces remain Slot-owned. */
export function OpenloopFrame({
  actions,
  renderSlot,
  useSessions,
  useStore,
}: OpenloopFrameProps) {
  const state = useStore(value => value)
  const session = useSessions(currentConversation)
  const previousSession = useRef(session)

  useLayoutEffect(() => {
    if (session !== undefined
      && previousSession.current !== undefined
      && previousSession.current !== session) {
      actions.closeDetails()
    }
    previousSession.current = session
  }, [actions, session])

  const sidebarWidth = state.sidebarOpen ? SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH
  const detailsWidth = session !== undefined && state.detailsOpen ? DETAILS_WIDTH : 0

  return (
    <div
      className={css.frame}
      style={{
        gridTemplateColumns:
          `${sidebarWidth}px minmax(0, 1fr) minmax(320px, 42%) ${detailsWidth}px`,
      }}
      data-sidebar-collapsed={state.sidebarOpen ? undefined : ''}
      data-details-collapsed={detailsWidth === 0 ? '' : undefined}
    >
      <aside className={css.sidebar}>
        {renderSlot('sidebar', {
          collapsed: !state.sidebarOpen,
          width: sidebarWidth,
        })}
      </aside>
      <main className={css.conversation}>
        {renderSlot('conversation', {})}
      </main>
      <section className={css.workbench} data-openloop-workbench>
        {renderSlot('workbench', {})}
      </section>
      <aside className={css.details}>
        {renderSlot('details', {})}
      </aside>
      <div className={css.overlay} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
    </div>
  )
}
