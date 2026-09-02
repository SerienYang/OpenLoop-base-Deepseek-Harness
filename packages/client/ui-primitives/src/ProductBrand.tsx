import { createContext, useContext, type ReactNode } from 'react'

/**
 * Product-owned identity projected into the generic DSH client surfaces.
 * Optional presentation fields preserve each surface's existing DSH fallback.
 */
export interface ProductBrand {
  readonly productName: string
  readonly documentSuffix: string
  readonly markAsset?: string
  readonly heroTitle?: string
  readonly previewLabel?: string
  readonly attribution?: string
}

/** Default identity for the standalone DeepSeek Harness profile. */
export const DEFAULT_PRODUCT_BRAND: ProductBrand = Object.freeze({
  productName: 'DeepSeek Harness',
  documentSuffix: 'DeepSeek Harness',
})

const ProductBrandContext = createContext<ProductBrand>(DEFAULT_PRODUCT_BRAND)

/** Props for the immutable bootstrap brand provider. */
export interface ProductBrandProviderProps {
  readonly brand: ProductBrand
  readonly children: ReactNode
}

/** Provide one product identity to all DSH-owned client surfaces. */
export function ProductBrandProvider({ brand, children }: ProductBrandProviderProps) {
  return (
    <ProductBrandContext.Provider value={brand}>
      {children}
    </ProductBrandContext.Provider>
  )
}

/** Read the current product identity, falling back to the DSH profile. */
export function useProductBrand(): ProductBrand {
  return useContext(ProductBrandContext)
}
