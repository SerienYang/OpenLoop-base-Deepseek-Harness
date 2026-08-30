import type { ProductBrand } from '@deepseek-ai/dsh-client-ui-primitives'

/** Closed Openloop identity carried by the signed core manifest. */
export interface OpenloopBrand extends ProductBrand {
  readonly productName: 'Openloop'
  readonly documentSuffix: 'Openloop'
  readonly markAsset: string
  readonly heroTitle: 'Openloop'
  readonly previewLabel: '预览版'
  readonly attribution: 'Built on DeepSeek Harness'
}

/** Validate the Host-delivered brand before it crosses into AppWebEntry. */
export function parseOpenloopBrand(value: unknown): OpenloopBrand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Openloop brand must be an object')
  }
  const brand = value as Record<string, unknown>
  const fields = [
    'productName',
    'documentSuffix',
    'markAsset',
    'heroTitle',
    'previewLabel',
    'attribution',
  ]
  if (Object.keys(brand).length !== fields.length
    || fields.some(field => !Object.hasOwn(brand, field))
    || brand.productName !== 'Openloop'
    || brand.documentSuffix !== 'Openloop'
    || typeof brand.markAsset !== 'string'
    || !brand.markAsset.startsWith('data:image/svg+xml;base64,')
    || brand.heroTitle !== 'Openloop'
    || brand.previewLabel !== '预览版'
    || brand.attribution !== 'Built on DeepSeek Harness') {
    throw new TypeError('Openloop brand identity is invalid')
  }
  return Object.freeze(brand) as unknown as OpenloopBrand
}
