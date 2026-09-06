// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import {
  DEFAULT_PRODUCT_BRAND, ProductBrandProvider, ProductLockup, ProductMark,
  useProductBrand,
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
  it('renders a product lockup with its decorative mark and readable product name', () => {
    const markAsset = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E'
    const view = render(
      <ProductLockup
        markAsset={markAsset}
        productName="Openloop"
        className="approved-lockup"
      />,
    )
    const lockup = view.container.querySelector('[data-product-lockup]')
    const marks = lockup?.querySelectorAll('[data-product-mark]')
    const names = lockup?.querySelectorAll('[data-product-lockup-name]')
    const styles = readFileSync(
      'packages/client/ui-primitives/src/ProductLockup.module.css',
      'utf8',
    )

    expect(lockup).toBeTruthy()
    expect(lockup?.getAttribute('class')).toContain('approved-lockup')
    expect(marks?.length).toBe(1)
    expect(marks?.[0]?.getAttribute('style')).toContain(
      `--dsh-product-mark-image: url("${markAsset}")`,
    )
    expect(marks?.[0]?.getAttribute('style')).toContain(
      '--dsh-product-mark-size: 20px',
    )
    expect(names?.length).toBe(1)
    expect(names?.[0]?.textContent).toBe('Openloop')
    expect(styles).toMatch(/var\(--dsh-product-lockup-gap,/u)
    expect(styles).toMatch(/var\(--dsh-product-lockup-font-size,/u)
    expect(styles).toMatch(/var\(--dsh-product-lockup-font-weight,/u)
    expect(styles).toMatch(/var\(--dsh-product-lockup-line-height,/u)
  })

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
