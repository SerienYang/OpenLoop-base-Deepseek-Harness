// @vitest-environment jsdom
/**
 * AppRoot boot-gate smoke: loading page until the settled signal flips (status
 * alone never opens the gate), fail-loud entry list + boot failure report,
 * one-pass switch to the real UI. The full browser chain (real module system
 * + vendored Loader + bundles) is the e2e's job; this pins the shell-owned
 * gate semantics. Stores are the kernel-own signals production boot uses
 * (shell self-sufficiency: the loading page depends on no plugin package).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useProductBrand } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProductBrand } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)
import { AppRoot } from '@deepseek-ai/dsh-client-web/src/AppRoot.tsx'
import { createLoaderStatusStore, createSignal } from '@deepseek-ai/dsh-client-web/src/loader-status.ts'

const openloopBrand: ProductBrand = {
  productName: 'Openloop',
  documentSuffix: 'Openloop',
  markAsset: 'openloop-icon',
  heroTitle: 'Openloop',
  previewLabel: '预览版',
  attribution: 'Built on DeepSeek Harness',
}

function SettledBrandProbe() {
  const brand = useProductBrand()
  return <div data-testid="real-ui">{brand.productName}</div>
}

function mount(brand?: ProductBrand) {
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
        return <SettledBrandProbe />
      }}
      {...brand === undefined ? {} : { brand }}
    />,
  )
  return { settled, status, error, counts: () => renders, ...utils }
}

describe('AppRoot', () => {
  it('shows the loading page and never calls renderApp before settled', () => {
    const { queryByTestId, counts, getByText } = mount()
    expect(getByText('HARNESS').textContent).toBe('HARNESS')
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
    const { container, error, settled, getByText, queryByText, getByTestId } = mount(openloopBrand)
    const mark = container.querySelector('img')
    expect(mark?.getAttribute('src')).toBe('openloop-icon')
    expect(mark?.getAttribute('width')).toBe('24')
    expect(getByText('Openloop')).toBeTruthy()
    expect(getByText('Built on DeepSeek Harness')).toBeTruthy()
    expect(queryByText('HARNESS')).toBeNull()

    act(() => { error.set('brand fixture failure') })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('openloop-icon')
    expect(getByText('Openloop')).toBeTruthy()
    expect(queryByText('HARNESS')).toBeNull()

    act(() => { settled.set(true) })
    expect(getByTestId('real-ui').textContent).toBe('Openloop')
  })
})
