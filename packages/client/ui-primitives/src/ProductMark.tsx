import type { CSSProperties } from 'react'
import css from './ProductMark.module.css'

export interface ProductMarkProps {
  readonly src: string
  readonly size?: number
  readonly className?: string
}

/** Render a product-provided silhouette in the surrounding text color. */
export function ProductMark({ src, size = 24, className }: ProductMarkProps) {
  const style = {
    '--dsh-product-mark-image': `url("${src}")`,
    '--dsh-product-mark-size': `${size}px`,
  } as CSSProperties

  return (
    <span
      aria-hidden="true"
      className={className === undefined ? css.root : `${css.root} ${className}`}
      data-product-mark=""
      style={style}
    />
  )
}
