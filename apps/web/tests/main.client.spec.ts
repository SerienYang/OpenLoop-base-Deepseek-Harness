// @vitest-environment jsdom
import { act } from '@testing-library/react'
import { createElement } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface EntrySeams {
  readonly brand?: typeof brand
  readonly reactRoot?: Root
}

const entry = vi.hoisted(() => ({
  constructors: [] as Array<{ el: HTMLElement; seams: unknown }>,
  run: vi.fn((_root: Root) => Promise.resolve()),
}))

const reactDom = vi.hoisted(() => ({
  containers: [] as Element[],
  createRoot: vi.fn(),
}))

vi.mock('react-dom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom/client')>()
  reactDom.createRoot.mockImplementation((container: Element | DocumentFragment) => {
    reactDom.containers.push(container as Element)
    return actual.createRoot(container)
  })
  return {
    ...actual,
    createRoot: reactDom.createRoot,
  }
})

vi.mock('@deepseek-ai/dsh-client-web', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-client-web')>()
  const { createRoot } = await import('react-dom/client')
  return {
    ...actual,
    AppWebEntry: class {
      private readonly root: Root

      constructor(el: HTMLElement, seams?: EntrySeams) {
        entry.constructors.push({ el, seams })
        this.root = seams?.reactRoot ?? createRoot(el)
      }

      run(): Promise<void> {
        return entry.run(this.root)
      }
    },
  }
})

const brand = Object.freeze({
  productName: 'Openloop',
  documentSuffix: 'Openloop',
  markAsset: 'data:image/svg+xml;base64,PHN2Zy8+',
  heroTitle: 'Openloop',
  previewLabel: '预览版',
  attribution: 'Built on DeepSeek Harness',
})

interface BootstrapGlobal {
  __DSH_PREBOOT__?: Promise<void>
  __OPENLOOP_BOOTSTRAP__?: Readonly<{
    readonly launchId: string
    readonly coreManifest: Readonly<{ readonly brand: typeof brand }>
    readonly coreManifestSha256: string
  }>
}

function installRoot(): HTMLElement {
  document.body.innerHTML = '<div id="root"></div>'
  return document.getElementById('root') as HTMLElement
}

function installProbe(): HTMLElement {
  const probe = document.createElement('div')
  document.body.append(probe)
  return probe
}

afterEach(() => {
  const target = globalThis as BootstrapGlobal
  delete target.__DSH_PREBOOT__
  delete target.__OPENLOOP_BOOTSTRAP__
  entry.constructors.length = 0
  entry.run.mockClear()
  reactDom.containers.length = 0
  reactDom.createRoot.mockClear()
  document.body.innerHTML = ''
  document.title = ''
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('web application entry', () => {
  it('shows the Openloop loading surface while Host preboot is pending, then passes its frozen brand to AppWebEntry', async () => {
    const consoleError = vi.spyOn(console, 'error')
    const root = installRoot()
    document.title = 'DeepSeek Harness'
    let release!: () => void
    const target = globalThis as BootstrapGlobal
    target.__DSH_PREBOOT__ = new Promise<void>((resolve) => { release = resolve })
    const coreManifest = Object.freeze({ brand })
    Object.defineProperty(target, '__OPENLOOP_BOOTSTRAP__', {
      value: Object.freeze({
        launchId: 'launch-id',
        coreManifest,
        coreManifestSha256: 'a'.repeat(64),
      }),
      configurable: true,
      writable: false,
    })

    const loading = import('../src/main.ts')
    await loading

    expect(root.textContent).toContain('Openloop')
    expect(root.textContent).toContain('Built on DeepSeek Harness')
    expect(root.textContent).toContain('Loading plugins')
    expect(document.title).toBe('Openloop')
    expect(entry.constructors).toEqual([])

    release()
    await vi.waitFor(() => { expect(entry.run).toHaveBeenCalledOnce() })
    const seams = entry.constructors[0]?.seams as EntrySeams | undefined
    const handedOffRoot = entry.run.mock.calls[0]?.[0]
    expect(entry.constructors[0]?.el).toBe(root)
    expect(seams?.brand).toBe(brand)
    expect(seams?.reactRoot).toBe(handedOffRoot)
    expect(root.textContent).toContain('Openloop')
    expect(root.textContent).toContain('Loading plugins')
    expect(reactDom.containers).toEqual([root])
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('createRoot() on a container that has already been passed to createRoot()'),
    )

    act(() => {
      handedOffRoot?.render(createElement('main', null, 'App ready'))
    })
    expect(root.textContent).toBe('App ready')
  })

  it('preserves the default DSH entry when no Openloop preboot exists', async () => {
    const root = installRoot()

    await import('../src/main.ts')

    expect(entry.constructors).toEqual([{ el: root, seams: undefined }])
    expect(entry.run).toHaveBeenCalledOnce()
    expect(reactDom.containers).toEqual([root])
  })

  it('keeps the trusted brand when preboot rejects after publishing identity', async () => {
    const root = installRoot()
    const target = globalThis as BootstrapGlobal
    target.__DSH_PREBOOT__ = Promise.reject(new Error('completion failed'))
    Object.defineProperty(target, '__OPENLOOP_BOOTSTRAP__', {
      value: Object.freeze({
        launchId: 'launch-id',
        coreManifest: Object.freeze({ brand }),
        coreManifestSha256: 'a'.repeat(64),
      }),
      configurable: true,
      writable: false,
    })

    await import('../src/main.ts')
    await vi.waitFor(() => { expect(entry.run).toHaveBeenCalledOnce() })

    const seams = entry.constructors[0]?.seams as EntrySeams | undefined
    expect(entry.constructors[0]?.el).toBe(root)
    expect(seams?.brand).toBe(brand)
    expect(seams?.reactRoot).toBe(entry.run.mock.calls[0]?.[0])
    expect(reactDom.containers).toEqual([root])
  })

  it('uses an immutable Openloop failure brand when preboot rejects before publishing identity', async () => {
    const root = installRoot()
    const target = globalThis as BootstrapGlobal
    target.__DSH_PREBOOT__ = Promise.reject(new Error('bootstrap unavailable'))

    await import('../src/main.ts')
    await vi.waitFor(() => { expect(entry.run).toHaveBeenCalledOnce() })

    const seams = entry.constructors[0]?.seams as EntrySeams | undefined
    expect(entry.constructors[0]?.el).toBe(root)
    expect(seams?.brand).toMatchObject({
      productName: 'Openloop',
      documentSuffix: 'Openloop',
      attribution: 'Built on DeepSeek Harness',
    })
    expect(seams?.brand?.markAsset).toBeUndefined()
    expect(Object.isFrozen(seams?.brand)).toBe(true)
    expect(seams?.reactRoot).toBe(entry.run.mock.calls[0]?.[0])
    expect(entry.constructors).toHaveLength(1)
    expect(reactDom.containers).toEqual([root])
  })

  it.each([
    ['missing', undefined, 'web app: Openloop bootstrap is invalid'],
    ['mutable', {
      launchId: 'launch-id',
      coreManifest: { brand },
      coreManifestSha256: 'a'.repeat(64),
    }, 'web app: Openloop bootstrap identity is not frozen'],
  ])('shows branded failure and resolves for %s bootstrap identity', async (
    _label,
    bootstrap,
    message,
  ) => {
    installRoot()
    const probe = installProbe()
    const target = globalThis as BootstrapGlobal
    target.__DSH_PREBOOT__ = Promise.resolve()
    if (bootstrap === undefined) delete target.__OPENLOOP_BOOTSTRAP__
    else target.__OPENLOOP_BOOTSTRAP__ = bootstrap

    const { startWebApp } = await import('../src/main.ts')

    await expect(startWebApp(probe)).resolves.toBeUndefined()
    expect(probe.textContent).toContain('Openloop')
    expect(probe.textContent).toContain('Built on DeepSeek Harness')
    expect(probe.textContent).toContain(message)
    expect(entry.constructors).toEqual([])
    expect(entry.run).not.toHaveBeenCalled()
    expect(reactDom.containers).toContain(probe)
  })

  it('restores branded failure when AppWebEntry rejects immediately after Openloop handoff', async () => {
    installRoot()
    const probe = installProbe()
    const target = globalThis as BootstrapGlobal
    target.__DSH_PREBOOT__ = Promise.resolve()
    Object.defineProperty(target, '__OPENLOOP_BOOTSTRAP__', {
      value: Object.freeze({
        launchId: 'launch-id',
        coreManifest: Object.freeze({ brand }),
        coreManifestSha256: 'a'.repeat(64),
      }),
      configurable: true,
      writable: false,
    })
    entry.run.mockRejectedValue(new Error('entry failed after handoff'))

    const { startWebApp } = await import('../src/main.ts')

    await expect(startWebApp(probe)).resolves.toBeUndefined()
    expect(probe.textContent).toContain('Openloop')
    expect(probe.textContent).toContain('Built on DeepSeek Harness')
    expect(probe.textContent).toContain('entry failed after handoff')
    expect(reactDom.containers).toContain(probe)
    expect(reactDom.containers.filter(container => container === probe)).toHaveLength(1)
  })
})
