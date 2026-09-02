// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ProductBrandProvider } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProductBrand } from '@deepseek-ai/dsh-client-ui-primitives'
import { DocumentTitle } from '../src/DocumentTitle.tsx'

const openloopBrand: ProductBrand = {
  productName: 'Openloop',
  documentSuffix: 'Openloop',
  markAsset: 'openloop-icon',
  heroTitle: 'Openloop',
  previewLabel: '预览版',
  attribution: 'Built on DeepSeek Harness',
}

afterEach(() => {
  cleanup()
  document.title = ''
})

describe('DocumentTitle', () => {
  it('preserves the product title without a durable title and restores it on unmount', () => {
    document.title = 'DeepSeek Harness'
    const mounted = render(<DocumentTitle />)
    expect(document.title).toBe('DeepSeek Harness')

    mounted.rerender(<DocumentTitle title="First title" />)
    expect(document.title).toBe('First title — DeepSeek Harness')

    mounted.rerender(<DocumentTitle title="Revised title" />)
    expect(document.title).toBe('Revised title — DeepSeek Harness')

    mounted.rerender(<DocumentTitle />)
    expect(document.title).toBe('DeepSeek Harness')
    mounted.unmount()
    expect(document.title).toBe('DeepSeek Harness')
  })

  it('uses the injected product suffix without a DeepSeek product title', () => {
    document.title = 'DeepSeek Harness'
    const mounted = render(
      <ProductBrandProvider brand={openloopBrand}>
        <DocumentTitle title="Branded session" />
      </ProductBrandProvider>,
    )
    expect(document.title).toBe('Branded session — Openloop')

    mounted.rerender(
      <ProductBrandProvider brand={openloopBrand}>
        <DocumentTitle />
      </ProductBrandProvider>,
    )
    expect(document.title).toBe('Openloop')
  })
})
