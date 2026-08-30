// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import {
  DEFAULT_PRODUCT_BRAND, ProductBrandProvider, useProductBrand,
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
