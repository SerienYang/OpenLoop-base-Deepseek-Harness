import { useLayoutEffect, useRef, useState } from 'react'
import { defineStore, type SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { computeOpenloopColumns } from './columns.ts'
import css from './OpenloopFrame.module.css'

const SIDEBAR_COLLAPSED_WIDTH = 56
const SIDEBAR_AUTO_COLLAPSE = 1024
const THREE_COLUMN_MIN_WIDTH = 1220

interface ShellState {
  sidebarOpen: boolean
  detailsOpen: boolean
  narrow: boolean
  narrowExpanded: boolean
}

interface ShellActions {
  toggleSidebar: (draft: ShellState) => void
  setNarrow: (draft: ShellState, narrow: boolean) => void
  openDetails: (draft: ShellState) => void
  closeDetails: (draft: ShellState) => void
}

/** Root-scoped panel state behind the established DSH layout action contract. */
export function createOpenloopShellStore() {
  return defineStore({
    init: (): ShellState => ({
      sidebarOpen: true,
      detailsOpen: false,
      narrow: false,
      narrowExpanded: false,
    }),
    actions: {
      toggleSidebar: (draft) => {
        if (draft.narrow) draft.narrowExpanded = !draft.narrowExpanded
        else draft.sidebarOpen = !draft.sidebarOpen
      },
      setNarrow: (draft, narrow) => {
        if (draft.narrow === narrow) return
        draft.narrow = narrow
        draft.narrowExpanded = false
      },
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

function isOpenloopNarrow(viewport: number, detailsOpen: boolean): boolean {
  const available = Math.max(0, Math.round(viewport))
  return available < SIDEBAR_AUTO_COLLAPSE
    || (detailsOpen && available < THREE_COLUMN_MIN_WIDTH)
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

  const detailsOpen = session !== undefined && state.detailsOpen
  const narrow = isOpenloopNarrow(viewport, detailsOpen)
  useLayoutEffect(() => { actions.setNarrow(narrow) }, [actions, narrow])
  const sidebarOpen = narrow ? state.narrowExpanded : state.sidebarOpen
  const columns = computeOpenloopColumns(
    viewport,
    sidebarOpen,
    detailsOpen,
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
