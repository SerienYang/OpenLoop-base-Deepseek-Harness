/**
 * Web application entry: thin bootstrap over the shell library. Everything —
 * loader holding, module-table seeding, AppRoot gate, plugin assembly — lives
 * in @deepseek-ai/dsh-client-web; this file only finds the mount point.
 */
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import type { ProductBrand } from '@deepseek-ai/dsh-client-ui-primitives'

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

/** Start only after Host preboot so one trusted brand spans every app state. */
export async function startWebApp(root: HTMLElement = rootElement): Promise<void> {
  const target = globalThis as BootstrapWindow
  const preboot = target.__DSH_PREBOOT__
  if (preboot === undefined) {
    await new AppWebEntry(root).run()
    return
  }

  try {
    await preboot
  } catch {
    if (target.__OPENLOOP_BOOTSTRAP__ === undefined) {
      await new AppWebEntry(root).run()
      return
    }
    // A published identity remains authoritative while AppWebEntry renders the failure.
  }
  const brand = openloopBrand(target.__OPENLOOP_BOOTSTRAP__)
  await new AppWebEntry(root, { brand }).run()
}

void startWebApp()
