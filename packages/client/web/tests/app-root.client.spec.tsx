// @vitest-environment jsdom
/**
 * AppRoot boot-gate smoke: loading page until the settled signal flips (status
 * alone never opens the gate), fail-loud entry list + boot failure report,
 * one-pass switch to the real UI. The full browser chain (real module system
 * + vendored Loader + bundles) is the e2e's job; this pins the shell-owned
 * gate semantics. Stores are the kernel-own signals production boot uses
 * (shell self-sufficiency: the loading page depends on no plugin package).
 */
import { readFileSync } from 'node:fs'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useProductBrand } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProductBrand } from '@deepseek-ai/dsh-client-ui-primitives'

import { AppRoot } from '@deepseek-ai/dsh-client-web/src/AppRoot.tsx'
import { DocumentTitle } from '@deepseek-ai/dsh-client-web/src/DocumentTitle.tsx'
import { createLoaderStatusStore, createSignal } from '@deepseek-ai/dsh-client-web/src/loader-status.ts'

const appRootStyles = readFileSync(
  'packages/client/web/src/AppRoot.module.css',
  'utf8',
)
const productLockupStyles = readFileSync(
  'packages/client/ui-primitives/src/ProductLockup.module.css',
  'utf8',
)

afterEach(() => {
  cleanup()
  document.title = ''
})

const openloopBrand: ProductBrand = {
  productName: 'Openloop',
  documentSuffix: 'Openloop',
  markAsset: 'openloop-mark',
  heroTitle: 'Openloop',
  previewLabel: '预览版',
  attribution: 'Built on DeepSeek Harness',
}

const openloopFailureBrand: ProductBrand = {
  productName: 'Openloop',
  documentSuffix: 'Openloop',
  attribution: 'Built on DeepSeek Harness',
}

function SettledBrandProbe() {
  const brand = useProductBrand()
  return <div data-testid="real-ui">{brand.productName}</div>
}

function mount(brand?: ProductBrand, renderApp: () => ReactNode = () => <SettledBrandProbe />) {
  const settled = createSignal(false)
  const error = createSignal<string | undefined>(undefined)
  const status = createLoaderStatusStore()
  let renders = 0
  const utils = render(
    <AppRoot
      settled={settled}
      status={status}
      error={error}
      renderApp={() => {
        renders += 1
        return renderApp()
      }}
      {...brand === undefined ? {} : { brand }}
    />,
  )
  return { settled, status, error, counts: () => renders, ...utils }
}

describe('AppRoot', () => {
  it('locks the launch brand geometry and disables spinner motion when requested', () => {
    const productLockupRule = appRootStyles.match(/\.productLockup\s*\{([^}]*)\}/u)?.[1]

    expect(appRootStyles).toMatch(
      /\.spinnerSeat\s*\{[^}]*\bwidth:\s*26px;[^}]*\bheight:\s*26px;/u,
    )
    expect(productLockupRule).toMatch(/--dsh-product-lockup-gap:\s*9px;/u)
    expect(productLockupRule).toMatch(/--dsh-product-lockup-font-size:\s*20px;/u)
    expect(productLockupRule).toMatch(/--dsh-product-lockup-font-weight:\s*600;/u)
    expect(productLockupRule).toMatch(/--dsh-product-lockup-line-height:\s*25px;/u)
    expect(productLockupStyles).toMatch(/\.root\s*\{[^}]*\bletter-spacing:\s*0;/u)
    expect(appRootStyles).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.spinner\s*\{[^}]*\btransition:\s*none;[^}]*\banimation:\s*none;[^}]*\}\s*\}/u,
    )
  })

  it('shows the loading page and never calls renderApp before settled', () => {
    const { container, queryByTestId, counts, getByText } = mount()
    expect(getByText('HARNESS').textContent).toBe('HARNESS')
    expect(container.querySelector('[data-product-lockup]')).toBeNull()
    expect(container.querySelector('[data-product-mark]')).toBeNull()
    expect(queryByTestId('real-ui')).toBeNull()
    expect(counts()).toBe(0)
  })

  it('all-active status alone does not open the gate (settled signal is the only key)', () => {
    const { status, queryByTestId } = mount()
    act(() => {
      status.set('a', 'active')
      status.set('b', 'active')
    })
    expect(queryByTestId('real-ui')).toBeNull()
  })

  it('lists failed entries and stays on the loading page', () => {
    const { status, getByText, queryByTestId } = mount()
    act(() => {
      status.set('@deepseek-ai/dsh-client-ui-layout', 'failed')
      status.set('ok', 'active')
    })
    expect(getByText('HARNESS').textContent).toBe('HARNESS')
    expect(getByText('Failed to load plugins')).toBeTruthy()
    expect(getByText('@deepseek-ai/dsh-client-ui-layout')).toBeTruthy()
    expect(queryByTestId('real-ui')).toBeNull()
  })

  it('renders the boot failure report even when no entry projected failed', () => {
    const { error, getByText, queryByTestId } = mount()
    act(() => { error.set('web boot: 1 entry did not activate\nx: pending (waiting for service: y)') })
    expect(getByText('Failed to load plugins')).toBeTruthy()
    expect(getByText(/waiting for service/)).toBeTruthy()
    expect(queryByTestId('real-ui')).toBeNull()
  })

  it('flipping settled switches to the real UI in one pass', () => {
    const { settled, getByTestId, queryByText, counts } = mount()
    act(() => { settled.set(true) })
    expect(getByTestId('real-ui')).toBeTruthy()
    expect(queryByText('HARNESS')).toBeNull()
    expect(counts()).toBe(1)
  })

  it('renders the injected identity throughout loading, failure, and the settled app', () => {
    const {
      container, error, settled, status, getByText, queryByText, getByTestId,
    } = mount(openloopBrand)
    const lockups = container.querySelectorAll('[data-product-lockup]')
    const mark = lockups[0]?.querySelector('[data-product-mark]')
    const spinnerSeat = container.querySelector('[class*="spinnerSeat"]')
    const spinner = spinnerSeat?.firstElementChild
    expect(lockups).toHaveLength(1)
    expect(mark?.getAttribute('style')).toContain(
      '--dsh-product-mark-image: url("openloop-mark")',
    )
    expect(mark?.getAttribute('style')).toContain('--dsh-product-mark-size: 25px')
    expect(getByText('Openloop')).toBeTruthy()
    expect(getByText('Built on DeepSeek Harness')).toBeTruthy()
    expect(spinnerSeat).toBeTruthy()
    expect(spinner?.getAttribute('class')).toContain('spinnerPending')
    expect(queryByText('Loading plugins…')).toBeNull()
    expect(queryByText('HARNESS')).toBeNull()

    act(() => { status.set('brand-fixture', 'loading') })
    expect(container.querySelector('[class*="spinnerSeat"]')?.firstElementChild).toBe(spinner)
    expect(spinner?.getAttribute('class')).not.toContain('spinnerPending')

    act(() => { error.set('brand fixture failure') })
    expect(container.querySelector('[data-product-mark]')).toBe(mark)
    expect(getByText('Openloop')).toBeTruthy()
    expect(queryByText('HARNESS')).toBeNull()

    act(() => { settled.set(true) })
    expect(getByTestId('real-ui').textContent).toBe('Openloop')
  })

  it('renders a non-default product name when its failure brand has no mark asset', () => {
    const { container, error, getByText, queryByText } = mount(openloopFailureBrand)

    expect(getByText('Openloop')).toBeTruthy()
    expect(getByText('Built on DeepSeek Harness')).toBeTruthy()
    expect(container.querySelector('[data-product-lockup]')).toBeNull()
    expect(container.querySelector('[data-product-mark]')).toBeNull()
    expect(queryByText('HARNESS')).toBeNull()

    act(() => { error.set('preboot failed') })
    expect(getByText('Openloop')).toBeTruthy()
    expect(getByText('Built on DeepSeek Harness')).toBeTruthy()
    expect(queryByText('HARNESS')).toBeNull()
  })

  it('projects the Openloop title before settlement and yields to the session title afterward', () => {
    document.title = 'DeepSeek Harness'
    const { error, settled } = mount(openloopBrand, () => (
      <DocumentTitle title="Session one" />
    ))

    expect(document.title).toBe('Openloop')
    act(() => { error.set('boot failed') })
    expect(document.title).toBe('Openloop')

    act(() => { settled.set(true) })
    expect(document.title).toBe('Session one — Openloop')
  })

  it('preserves the default DSH document title throughout loading and failure', () => {
    document.title = 'DeepSeek Harness'
    const { error } = mount()

    expect(document.title).toBe('DeepSeek Harness')
    act(() => { error.set('boot failed') })
    expect(document.title).toBe('DeepSeek Harness')
  })
})
