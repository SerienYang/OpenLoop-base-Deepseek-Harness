import { describe, expect, it } from 'vitest'
import { parseOpenloopBrand } from '../src/client/brand.ts'

const brand = {
  productName: 'Openloop',
  documentSuffix: 'Openloop',
  markAsset: 'data:image/svg+xml;base64,PHN2Zy8+',
  heroTitle: 'Openloop',
  previewLabel: '预览版',
  attribution: 'Built on DeepSeek Harness',
} as const

describe('Openloop brand contract', () => {
  it('accepts only the signed preview label from the approved brand contract', () => {
    expect(parseOpenloopBrand(brand)).toEqual(brand)
    expect(() => parseOpenloopBrand({
      ...brand,
      previewLabel: 'Preview',
    })).toThrow(/brand identity/iu)
  })
})
