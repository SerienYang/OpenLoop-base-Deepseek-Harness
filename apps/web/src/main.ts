/**
 * Web application entry: holds an Openloop-branded AppRoot through Host
 * preboot, then hands the mount point to the shared shell library. Loader
 * holding, module-table seeding, the real AppRoot gate, and plugin assembly
 * remain in @deepseek-ai/dsh-client-web.
 */
import {
  AppRoot,
  AppWebEntry,
  createLoaderStatusStore,
  createSignal,
} from '@deepseek-ai/dsh-client-web'
import type { ProductBrand } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'

const el = document.getElementById('root')
if (el === null) throw new Error('web app: missing #root')
const rootElement = el

interface BootstrapWindow {
  readonly __DSH_PREBOOT__?: Promise<void>
  readonly __OPENLOOP_BOOTSTRAP__?: unknown
}

const BRAND_FIELDS = [
  'productName',
  'documentSuffix',
  'markAsset',
  'heroTitle',
  'previewLabel',
  'attribution',
] as const

const OPENLOOP_FAILURE_BRAND: ProductBrand = Object.freeze({
  productName: 'Openloop',
  documentSuffix: 'Openloop',
  heroTitle: 'Openloop',
  previewLabel: '预览版',
  attribution: 'Built on DeepSeek Harness',
})

function mountOpenloopPreboot(root: HTMLElement) {
  const error = createSignal<string | undefined>(undefined)
  const loadingRoot = createRoot(root)
  flushSync(() => {
    loadingRoot.render(createElement(AppRoot, {
      settled: createSignal(false),
      status: createLoaderStatusStore(),
      error,
      renderApp: () => null,
      brand: OPENLOOP_FAILURE_BRAND,
    }))
  })
  return {
    fail(reason: unknown): void {
      flushSync(() => {
        error.set(reason instanceof Error ? reason.message : String(reason))
      })
    },
    handoff(brand: ProductBrand): void {
      flushSync(() => {
        loadingRoot.unmount()
      })
      document.title = brand.documentSuffix
    },
  }
}

function openloopBrand(value: unknown): ProductBrand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('web app: Openloop bootstrap is invalid')
  }
  const bootstrap = value as Record<string, unknown>
  const coreManifest = bootstrap.coreManifest
  const brand = typeof coreManifest === 'object'
    && coreManifest !== null
    && !Array.isArray(coreManifest)
    ? (coreManifest as Record<string, unknown>).brand
    : undefined
  if (!Object.isFrozen(bootstrap)
    || !Object.isFrozen(coreManifest)
    || !Object.isFrozen(brand)
    || typeof brand !== 'object'
    || brand === null
    || Array.isArray(brand)) {
    throw new Error('web app: Openloop bootstrap identity is not frozen')
  }
  const record = brand as unknown as Record<string, unknown>
  if (Object.keys(record).length !== BRAND_FIELDS.length
    || BRAND_FIELDS.some(field => !Object.hasOwn(record, field))
    || record.productName !== 'Openloop'
    || record.documentSuffix !== 'Openloop'
    || typeof record.markAsset !== 'string'
    || !record.markAsset.startsWith('data:image/svg+xml;base64,')
    || record.heroTitle !== 'Openloop'
    || record.previewLabel !== '预览版'
    || record.attribution !== 'Built on DeepSeek Harness') {
    throw new Error('web app: Openloop brand identity is invalid')
  }
  return brand as ProductBrand
}

async function runOpenloopEntry(
  root: HTMLElement,
  loading: ReturnType<typeof mountOpenloopPreboot>,
  brand: ProductBrand,
): Promise<void> {
  loading.handoff(brand)
  try {
    await new AppWebEntry(root, { brand }).run()
  } catch (reason) {
    mountOpenloopPreboot(root).fail(reason)
  }
}

/** Start only after Host preboot so one trusted brand spans every app state. */
export async function startWebApp(root: HTMLElement = rootElement): Promise<void> {
  const target = globalThis as BootstrapWindow
  const preboot = target.__DSH_PREBOOT__
  if (preboot === undefined) {
    await new AppWebEntry(root).run()
    return
  }

  const loading = mountOpenloopPreboot(root)
  try {
    await preboot
  } catch {
    if (target.__OPENLOOP_BOOTSTRAP__ === undefined) {
      await runOpenloopEntry(root, loading, OPENLOOP_FAILURE_BRAND)
      return
    }
    // A published identity remains authoritative while AppWebEntry renders the failure.
  }
  let brand: ProductBrand
  try {
    brand = openloopBrand(target.__OPENLOOP_BOOTSTRAP__)
  } catch (reason) {
    loading.fail(reason)
    return
  }
  await runOpenloopEntry(root, loading, brand)
}

void startWebApp()
