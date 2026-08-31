import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  IconCloseOutline16,
  IconSettingsOutline16,
  Modal,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable,
  InjectFace,
  PropsLocale,
  PropsRenderSlots,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import css from './OpenloopSettings.module.css'

export const OPENLOOP_SETTINGS_SECTION_IDS = [
  'general',
  'models',
  'workspace',
  'plugins',
  'about-update',
] as const

type OpenloopSettingsSectionId = typeof OPENLOOP_SETTINGS_SECTION_IDS[number]

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export interface OpenloopSettingsSection {
  readonly id: string
  readonly order: number
  readonly label: string
}

export interface OpenloopSettingsOnboardingStep {
  readonly id: string
  readonly order: number
}

export interface OpenloopSettingsInjected {
  readonly hooks: {
    readonly sections: HostObservable<readonly OpenloopSettingsSection[]>
    readonly onboardingSteps: HostObservable<readonly OpenloopSettingsOnboardingStep[]>
  }
}

export type OpenloopSettingsProps =
  & PropsRuntime<'sidebar.settings'>
  & PropsRenderSlots<'settings.action' | 'settings.section' | 'settings.onboarding'>
  & InjectFace<OpenloopSettingsInjected>
  & PropsLocale<'openloop.shell'>

function fixedSections(
  rows: readonly OpenloopSettingsSection[],
): readonly OpenloopSettingsSection[] {
  const byId = new Map(rows.map(row => [row.id, row]))
  return OPENLOOP_SETTINGS_SECTION_IDS.flatMap((id) => {
    const row = byId.get(id)
    return row === undefined ? [] : [row]
  })
}

function nextTabIndex(
  key: string,
  current: number,
  length: number,
): number | undefined {
  if (length === 0) return undefined
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  if (key === 'ArrowDown' || key === 'ArrowRight') return (current + 1) % length
  if (key === 'ArrowUp' || key === 'ArrowLeft') return (current - 1 + length) % length
  return undefined
}

function focusableElements(panel: HTMLElement): readonly HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter(element =>
      element.tabIndex >= 0
      && element.closest('[hidden],[aria-hidden="true"]') === null)
}

function SettingsPanel({
  rows,
  activeId,
  renderSlot,
  onSelect,
  onClose,
  t,
}: {
  readonly rows: readonly OpenloopSettingsSection[]
  readonly activeId: string | undefined
  readonly renderSlot: OpenloopSettingsProps['renderSlot']
  readonly onSelect: (id: OpenloopSettingsSectionId) => void
  readonly onClose: () => void
  readonly t: OpenloopSettingsProps['t']
}) {
  const tabs = useRef(new Map<string, HTMLButtonElement>())
  const titleBar = useRef<HTMLDivElement | null>(null)
  const close = useRef<HTMLButtonElement | null>(null)
  const active = rows.find(row => row.id === activeId) ?? rows[0]

  useEffect(() => {
    const appRoot = document.getElementById('root')
    const previousInert = appRoot?.inert
    if (appRoot !== null) appRoot.inert = true
    const dialog = titleBar.current?.parentElement
    const modalRoot = dialog?.parentElement
    const mask = dialog?.previousElementSibling
    if (mask instanceof HTMLElement) {
      mask.dataset.testid = 'openloop-settings-mask'
      mask.tabIndex = -1
    }
    if (dialog !== undefined) {
      dialog.style.gap = '0'
      dialog.style.padding = '0'
    }
    if (modalRoot !== undefined) modalRoot.style.padding = '0'
    return () => {
      if (appRoot !== null) appRoot.inert = previousInert ?? false
    }
  }, [])

  useEffect(() => {
    const activeTab = active === undefined ? undefined : tabs.current.get(active.id)
    ;(activeTab ?? close.current)?.focus()
  }, [active?.id])

  const move = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = nextTabIndex(event.key, index, rows.length)
    if (next === undefined) return
    event.preventDefault()
    const row = rows[next]
    if (row === undefined) return
    onSelect(row.id as OpenloopSettingsSectionId)
    tabs.current.get(row.id)?.focus()
  }

  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const dialog = titleBar.current?.parentElement
    if (event.key !== 'Tab' || dialog === undefined) return
    const focusable = focusableElements(dialog)
    const first = focusable[0]
    const last = focusable.at(-1)
    if (first === undefined || last === undefined) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <Modal
      open
      title={t('settings')}
      closeLabel={t('settingsDismiss')}
      onClose={onClose}
      className={css.panel as string}
      headless
    >
      <div ref={titleBar} className={css.titleBar} onKeyDown={trapFocus}>
        <h2 id="openloop-settings-title">{t('settings')}</h2>
        <div className={css.actions}>{renderSlot('settings.action', {})}</div>
        <button
          ref={close}
          type="button"
          className={css.close}
          aria-label={t('settingsClose')}
          onClick={onClose}
        >
          <IconCloseOutline16 size={16} />
        </button>
      </div>
      <div className={css.body} onKeyDown={trapFocus}>
        <nav className={css.nav} aria-label={t('settings')}>
          <div
            className={css.navScroll}
            data-testid="openloop-settings-nav-scroll"
            role="tablist"
            aria-label={t('settings')}
            aria-orientation="vertical"
          >
            {rows.map((row, index) => {
              const selected = row.id === active?.id
              return (
                <button
                  key={row.id}
                  ref={(element) => {
                    if (element === null) tabs.current.delete(row.id)
                    else tabs.current.set(row.id, element)
                  }}
                  id={`openloop-settings-tab-${row.id}`}
                  type="button"
                  role="tab"
                  className={css.tab}
                  aria-selected={selected}
                  aria-controls={`openloop-settings-panel-${row.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => { onSelect(row.id as OpenloopSettingsSectionId) }}
                  onKeyDown={(event) => { move(event, index) }}
                >
                  {row.label}
                </button>
              )
            })}
          </div>
        </nav>
        <div
          id={active === undefined ? undefined : `openloop-settings-panel-${active.id}`}
          className={css.content}
          data-testid="openloop-settings-content-scroll"
          role="tabpanel"
          aria-labelledby={active === undefined
            ? undefined
            : `openloop-settings-tab-${active.id}`}
          tabIndex={0}
        >
          {active !== undefined
            && renderSlot('settings.section', { close: onClose }, { only: active.id })}
        </div>
      </div>
    </Modal>
  )
}

/** Openloop-owned Settings trigger, dialog, navigation, and onboarding coordinator. */
export function OpenloopSettings({
  wide,
  useSections,
  useOnboardingSteps,
  useSessions,
  renderSlot,
  t,
}: OpenloopSettingsProps) {
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<OpenloopSettingsSectionId>('general')
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const trigger = useRef<HTMLButtonElement | null>(null)
  const restoreFocus = useRef(false)
  const rows = fixedSections(useSections(rows => rows))
  const onboardingSteps = useOnboardingSteps(steps => steps)
  const onboardingActive = useSessions(state =>
    state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))
  const onboardingStep = onboardingActive
    ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
    : undefined

  useEffect(() => {
    if (open || !restoreFocus.current) return
    restoreFocus.current = false
    trigger.current?.focus()
  }, [open])

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  const close = useCallback(() => {
    restoreFocus.current = true
    setOpen(false)
    setActiveId('general')
  }, [])
  const openSection = useCallback((id: string) => {
    if (OPENLOOP_SETTINGS_SECTION_IDS.includes(id as OpenloopSettingsSectionId)) {
      setActiveId(id as OpenloopSettingsSectionId)
    } else {
      setActiveId('general')
    }
    setOpen(true)
  }, [])
  const completeOnboarding = useCallback((id: string) => {
    setCompletedOnboarding(previous =>
      previous.has(id) ? previous : new Set([...previous, id]))
  }, [])

  return (
    <>
      <Tooltip label={() => t('settings')} disabled={wide}>
        <button
          ref={trigger}
          type="button"
          className={css.trigger}
          aria-label={wide ? undefined : t('settings')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(true) }}
        >
          <IconSettingsOutline16 size={wide ? 16 : 18} />
          {wide && <span>{t('settings')}</span>}
        </button>
      </Tooltip>
      {open && (
        <SettingsPanel
          rows={rows}
          activeId={activeId}
          renderSlot={renderSlot}
          onSelect={setActiveId}
          onClose={close}
          t={t}
        />
      )}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboarding(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
    </>
  )
}
