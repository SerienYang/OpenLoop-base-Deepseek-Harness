/** Openloop browser root shell. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { createOpenloopShellStore, OpenloopFrame } from './OpenloopFrame.tsx'

export { OpenloopFrame } from './OpenloopFrame.tsx'
export { parseOpenloopBrand } from './brand.ts'
export type { OpenloopBrand } from './brand.ts'

type ShellActions = BoundActions<ReturnType<typeof createOpenloopShellStore>>

class OpenloopLayoutController implements ILayout {
  private actions: ShellActions | undefined

  attach(actions: ShellActions): void {
    this.actions = actions
  }

  toggleSidebar(): void {
    this.requireActions().toggleSidebar()
  }

  openDetails(): void {
    this.requireActions().openDetails()
  }

  closeDetails(): void {
    this.requireActions().closeDetails()
  }

  private requireActions(): ShellActions {
    if (this.actions === undefined) {
      throw new Error('Openloop shell panel actions are not wired')
    }
    return this.actions
  }
}

class ThemeDocumentPresenter {
  private appliedTokens: string[] = []
  private readonly meta = document.createElement('meta')

  constructor() {
    this.meta.name = 'theme-color'
  }

  apply(snapshot: ThemeSnapshot): void {
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    if (scheme === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
    else document.body.removeAttribute('data-ds-dark-theme')
    for (const token of this.appliedTokens) document.body.style.removeProperty(token)
    this.appliedTokens = Object.keys(snapshot.active.tokens)
    for (const [token, value] of Object.entries(snapshot.active.tokens)) {
      document.body.style.setProperty(token, value)
    }
    this.meta.content = getComputedStyle(document.body).backgroundColor
    if (!this.meta.isConnected) document.head.append(this.meta)
  }

  dispose(): void {
    document.documentElement.style.removeProperty('color-scheme')
    document.body.removeAttribute('data-ds-dark-theme')
    for (const token of this.appliedTokens) document.body.style.removeProperty(token)
    this.appliedTokens = []
    this.meta.remove()
  }
}

export const name = 'shell'
export const inject = ['slots', 'theme']

/** Register exactly one Openloop root owner and the established DSH shell seats. */
export function apply(ctx: ClientContext): void {
  const layout = new OpenloopLayoutController()
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'details': { kind: 'single', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
      store: createOpenloopShellStore,
      inject: (actions: ShellActions) => {
        layout.attach(actions)
        return {}
      },
    }, OpenloopFrame)
    return () => {
      disposeRegistration()
      void disposeService()
    }
  }, 'openloop-shell: layout service + root registration')

  ctx.effect(() => {
    const presenter = new ThemeDocumentPresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'openloop-shell: theme presenter')
}
