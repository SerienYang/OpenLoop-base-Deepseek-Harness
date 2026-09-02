import { useEffect, useRef } from 'react'
import {
  DEFAULT_PRODUCT_BRAND, useProductBrand,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Props for the shell-owned browser title projection. */
export interface DocumentTitleProps {
  /** Durable title of the selected session, or undefined for the product title. */
  title?: string
}

/**
 * Project the selected durable session title into the browser title and
 * restore the shell's original product title when unmounted.
 * @param props - selected session title projection.
 * @returns no rendered content.
 */
export function DocumentTitle({ title }: DocumentTitleProps): null {
  const original = useRef(document.title)
  const brand = useProductBrand()
  const suffix = brand === DEFAULT_PRODUCT_BRAND ? original.current : brand.documentSuffix
  useEffect(() => {
    document.title = title === undefined ? suffix : `${title} — ${suffix}`
    return () => { document.title = original.current }
  }, [suffix, title])
  return null
}
