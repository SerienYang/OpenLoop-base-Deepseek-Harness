import { useLayoutEffect, useRef, useState } from 'react'
import { defineStore, type SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { computeOpenloopColumns } from './columns.ts'
import css from './OpenloopFrame.module.css'

const SIDEBAR_COLLAPSED_WIDTH = 56

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
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)

  useLayoutEffect(() => {
    if (session !== undefined
      && previousSession.current !== undefined
      && previousSession.current !== session) {
      actions.closeDetails()
    }
    if (session !== undefined) previousSession.current = session
  }, [actions, session])

  useLayoutEffect(() => {
    const frame = frameRef.current
    if (frame === null) return
    const updateViewport = () => {
      const width = frame.getBoundingClientRect().width
      if (width > 0) setViewport(width)
    }
    const observer = new ResizeObserver(updateViewport)
    observer.observe(frame)
    updateViewport()
    return () => { observer.disconnect() }
  }, [])

  const columns = computeOpenloopColumns(
    viewport,
    state.sidebarOpen,
    session !== undefined && state.detailsOpen,
  )
  const sidebarCollapsed = columns.sidebar === SIDEBAR_COLLAPSED_WIDTH

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{ gridTemplateColumns: `${columns.sidebar}px minmax(0, 1fr) ${columns.details}px` }}
      data-sidebar-collapsed={sidebarCollapsed ? '' : undefined}
      data-details-collapsed={columns.details === 0 ? '' : undefined}
    >
      <aside className={css.sidebar}>
        {renderSlot('sidebar', {
          collapsed: sidebarCollapsed,
          width: columns.sidebar,
        })}
      </aside>
      <div className={css.workspace} data-openloop-workspace>
        <main className={css.conversation}>
          {renderSlot('conversation', {})}
        </main>
        <section className={css.workbench} data-openloop-workbench>
          {renderSlot('workbench', {}, {
            fallback: <span data-openloop-workbench-empty />,
          })}
        </section>
      </div>
      <aside className={css.details}>
        {renderSlot('details', {})}
      </aside>
      <div className={css.overlay} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
    </div>
  )
}
