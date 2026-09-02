// @vitest-environment jsdom
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppWebEntry } from '../src/boot.tsx'

const reactDom = vi.hoisted(() => ({
  createRoot: vi.fn(),
  defaultRender: vi.fn(),
  defaultUnmount: vi.fn(),
}))

vi.mock('react-dom/client', () => ({
  createRoot: reactDom.createRoot,
}))

interface BootGlobal {
  __DSH_BOOT__?: unknown
  __DSH_PREBOOT__?: Promise<void>
  __DSH_MODULES__?: unknown
  __ModuleLoader__?: unknown
}

const target = globalThis as BootGlobal

beforeEach(() => {
  reactDom.createRoot.mockReturnValue({
    render: reactDom.defaultRender,
    unmount: reactDom.defaultUnmount,
  })
  target.__DSH_BOOT__ = { rev: 'root-seam', entries: [] }
  target.__DSH_PREBOOT__ = Promise.reject(new Error('stop after mounting'))
})

afterEach(() => {
  delete target.__DSH_BOOT__
  delete target.__DSH_PREBOOT__
  delete target.__DSH_MODULES__
  delete target.__ModuleLoader__
  reactDom.createRoot.mockReset()
  reactDom.defaultRender.mockReset()
  reactDom.defaultUnmount.mockReset()
  vi.restoreAllMocks()
})

describe('AppWebEntry React root ownership', () => {
  it('renders through a trusted caller-provided React root without creating another root', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const el = document.createElement('div')
    const suppliedRender = vi.fn()
    const suppliedRoot = {
      render: suppliedRender,
      unmount: vi.fn(),
    } as unknown as Root

    await new AppWebEntry(el, { reactRoot: suppliedRoot }).run()

    expect(reactDom.createRoot).not.toHaveBeenCalled()
    expect(suppliedRender).toHaveBeenCalledOnce()
  })

  it('creates its own React root when no root seam is provided', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const el = document.createElement('div')

    await new AppWebEntry(el).run()

    expect(reactDom.createRoot).toHaveBeenCalledOnce()
    expect(reactDom.createRoot).toHaveBeenCalledWith(el)
    expect(reactDom.defaultRender).toHaveBeenCalledOnce()
  })
})
