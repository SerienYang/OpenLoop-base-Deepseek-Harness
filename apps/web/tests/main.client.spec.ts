// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const entry = vi.hoisted(() => ({
  constructors: [] as Array<{ el: HTMLElement; seams: unknown }>,
  run: vi.fn(() => Promise.resolve()),
}))

vi.mock('@deepseek-ai/dsh-client-web', () => ({
  AppWebEntry: class {
    constructor(el: HTMLElement, seams?: unknown) {
      entry.constructors.push({ el, seams })
    }

    run(): Promise<void> {
      return entry.run()
    }
  },
}))

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

afterEach(() => {
  const target = globalThis as BootstrapGlobal
  delete target.__DSH_PREBOOT__
  delete target.__OPENLOOP_BOOTSTRAP__
  entry.constructors.length = 0
  entry.run.mockClear()
  document.body.innerHTML = ''
  vi.resetModules()
})

describe('web application entry', () => {
  it('waits for Host preboot and passes its frozen brand to AppWebEntry', async () => {
    const root = installRoot()
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
    await Promise.resolve()
    expect(entry.constructors).toEqual([])

    release()
    await loading
    expect(entry.constructors).toEqual([{ el: root, seams: { brand } }])
    expect(entry.run).toHaveBeenCalledOnce()
  })

  it('preserves the default DSH entry when no Openloop preboot exists', async () => {
    const root = installRoot()

    await import('../src/main.ts')

    expect(entry.constructors).toEqual([{ el: root, seams: undefined }])
    expect(entry.run).toHaveBeenCalledOnce()
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

    expect(entry.constructors).toEqual([{ el: root, seams: { brand } }])
  })

  it('uses an immutable Openloop failure brand when preboot rejects before publishing identity', async () => {
    const root = installRoot()
    const target = globalThis as BootstrapGlobal
    target.__DSH_PREBOOT__ = Promise.reject(new Error('bootstrap unavailable'))

    await import('../src/main.ts')
    await vi.waitFor(() => { expect(entry.run).toHaveBeenCalledOnce() })

    const seams = entry.constructors[0]?.seams as { brand?: typeof brand } | undefined
    expect(entry.constructors[0]?.el).toBe(root)
    expect(seams?.brand).toMatchObject({
      productName: 'Openloop',
      documentSuffix: 'Openloop',
      attribution: 'Built on DeepSeek Harness',
    })
    expect(seams?.brand?.markAsset).toBeUndefined()
    expect(Object.isFrozen(seams?.brand)).toBe(true)
    expect(entry.constructors).toHaveLength(1)
  })
})
