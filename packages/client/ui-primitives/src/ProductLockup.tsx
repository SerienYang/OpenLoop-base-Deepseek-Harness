import css from './ProductLockup.module.css'
import { ProductMark } from './ProductMark.tsx'

export interface ProductLockupProps {
  readonly markAsset: string
  readonly productName: string
  readonly markSize?: number | undefined
  readonly className?: string | undefined
}

/** Render a product mark and name as a single brand lockup. */
export function ProductLockup({
  markAsset,
  productName,
  markSize = 20,
  className,
}: ProductLockupProps) {
  return (
    <span
      className={className === undefined ? css.root : `${css.root} ${className}`}
      data-product-lockup=""
    >
      <ProductMark src={markAsset} size={markSize} />
      <span className={css.name} data-product-lockup-name="">
        {productName}
      </span>
    </span>
  )
}
