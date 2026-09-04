// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import {
  DEFAULT_PRODUCT_BRAND, ProductBrandProvider, ProductMark, useProductBrand,
} from '../src/index.ts'
import type { ProductBrand } from '../src/index.ts'

const openloopBrand: ProductBrand = {
  productName: 'Openloop',
  documentSuffix: 'Openloop',
  markAsset: 'openloop-icon',
  heroTitle: 'Openloop',
  previewLabel: '预览版',
  attribution: 'Built on DeepSeek Harness',
}

function BrandProbe() {
  return <output>{JSON.stringify(useProductBrand())}</output>
}

afterEach(cleanup)

describe('ProductBrand', () => {
  it('renders an injected mark as a current-color mask with stable dimensions', () => {
    const view = render(<ProductMark src="openloop-mark" size={24} />)
    const mark = view.container.querySelector('[data-product-mark]')
    const styles = readFileSync(
      'packages/client/ui-primitives/src/ProductMark.module.css',
      'utf8',
    )

    expect(mark?.getAttribute('aria-hidden')).toBe('true')
    expect(mark?.getAttribute('style')).toContain(
      '--dsh-product-mark-image: url("openloop-mark")',
    )
    expect(mark?.getAttribute('style')).toContain(
      '--dsh-product-mark-size: 24px',
    )
    expect(styles).toMatch(/background:\s*currentColor/u)
    expect(styles).toMatch(/-webkit-mask-image:\s*var\(--dsh-product-mark-image\)/u)
    expect(styles).toMatch(/mask-image:\s*var\(--dsh-product-mark-image\)/u)
  })

  it('exposes the immutable DeepSeek Harness defaults without a provider override', () => {
    const view = render(<BrandProbe />)
    expect(Object.isFrozen(DEFAULT_PRODUCT_BRAND)).toBe(true)
    expect(view.getByText(JSON.stringify({
      productName: 'DeepSeek Harness',
      documentSuffix: 'DeepSeek Harness',
    }))).toBeTruthy()
  })

  it('provides the exact immutable bootstrap brand value', () => {
    let observed: ProductBrand | undefined
    function IdentityProbe() {
      observed = useProductBrand()
      return null
    }

    render(
      <ProductBrandProvider brand={openloopBrand}>
        <IdentityProbe />
      </ProductBrandProvider>,
    )

    expect(observed).toBe(openloopBrand)
  })
})
