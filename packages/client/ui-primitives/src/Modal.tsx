// Modal: controlled full-viewport dialog (create-workspace and similar).
// The overlay portals to this document's body so ancestor stacking contexts
// cannot leave sticky page controls above the mask. This is still an in-page
// WebUI dialog; it never creates or targets another browser/native window.

import { createContext, useContext, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { IconCloseOutline16 } from './icons/index.tsx'
import css from './Modal.module.css'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')
const ModalDepth = createContext(0)
interface ModalRegistration {
  depth: number
  sequence: number
  previousFocus: HTMLElement | undefined
}
const openModals = new Map<HTMLElement, ModalRegistration>()
let modalSequence = 0

function topmostModal(): HTMLElement | undefined {
  return [...openModals]
    .sort(([, left], [, right]) =>
      left.depth - right.depth || left.sequence - right.sequence)
    .at(-1)
    ?.[0]
}

function focusableElements(dialog: HTMLElement): readonly HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter(element =>
      element.tabIndex >= 0
      && element.closest('[hidden],[aria-hidden="true"]') === null)
}

/**
 * Render a centered modal over a blurred page mask.
 * @param props.open - whether the dialog is showing.
 * @param props.onClose - Escape or mask click.
 * @param props.title - dialog heading (aria-label in every mode).
 * @param props.closeLabel - accessible close-button label.
 * @param props.description - optional supporting sentence under the title.
 * @param props.children - body (inputs, etc.).
 * @param props.footer - action row (Cancel / Create).
 * @param props.contentClassName - optional class for a scrollable content region.
 * @param props.headless - render children directly in the card (no default
 * header/close/body chrome) for dialogs whose figma frame owns its own
 * header structure; mask, card, Escape, and aria-label remain.
 * @param props.closeLabel - close-button aria label; the owner passes
 * localized copy (this package is cordis-free, so copy arrives via props).
 * @returns null when closed; otherwise the overlay tree.
 */
export function Modal({
  open, onClose, title, closeLabel = 'Close', description, children, footer, className, contentClassName, headless = false,
}: {
  open: boolean
  onClose: () => void
  title: string
  closeLabel?: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  className?: string
  contentClassName?: string
  headless?: boolean
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  const sequenceRef = useRef<number>()
  if (sequenceRef.current === undefined) sequenceRef.current = ++modalSequence
  onCloseRef.current = onClose
  const depth = useContext(ModalDepth)

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (dialog === null) return
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined
    openModals.set(dialog, {
      depth,
      sequence: sequenceRef.current ?? 0,
      previousFocus,
    })
    const onKeyDown = (e: KeyboardEvent) => {
      if (topmostModal() !== dialog) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const focusable = focusableElements(dialog)
      const first = focusable[0]
      const last = focusable.at(-1)
      if (first === undefined || last === undefined) {
        e.preventDefault()
        dialog.focus()
        return
      }
      if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      const registration = openModals.get(dialog)
      const restoreFocus = topmostModal() === dialog
      if (!restoreFocus && registration?.previousFocus !== undefined) {
        for (const candidate of openModals.values()) {
          if (candidate.depth > registration.depth
            && candidate.previousFocus !== undefined
            && dialog.contains(candidate.previousFocus)) {
            candidate.previousFocus = registration.previousFocus
          }
        }
      }
      openModals.delete(dialog)
      document.removeEventListener('keydown', onKeyDown)
      if (restoreFocus && registration?.previousFocus?.isConnected === true) {
        registration.previousFocus.focus()
      }
    }
  }, [depth, open])

  if (!open) return null

  return createPortal((
    <ModalDepth.Provider value={depth + 1}>
      <div className={css.root} role="presentation">
        <div className={css.mask} aria-hidden="true" onClick={onClose} />
        <div
          ref={dialogRef}
          className={clsx(css.dialog, className)}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          data-dsh-modal-depth={depth}
          tabIndex={-1}
        >
          {headless
            ? children
            : (
              <>
                <div className={clsx(css.content, contentClassName)}>
                  <div className={css.header}>
                    <h2 className={css.title}>{title}</h2>
                    <button type="button" className={css.close} aria-label={closeLabel} onClick={onClose}>
                      <IconCloseOutline16 size={14} />
                    </button>
                  </div>
                  {description !== undefined && description !== '' && (
                    <p className={css.description}>{description}</p>
                  )}
                  {children !== undefined && <div className={css.body}>{children}</div>}
                </div>
                {footer !== undefined && <div className={css.footer}>{footer}</div>}
              </>
            )}
        </div>
      </div>
    </ModalDepth.Provider>
  ), document.body)
}
