import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Workspace.module.css'

export interface ActionState {
  readonly pending: string | null
  readonly error: string | null
  run(key: string, action: () => Promise<unknown>): void
  clearError(): void
}

export function useActionState(): ActionState {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  return {
    pending,
    error,
    run(key, action) {
      if (inFlight.current) return
      inFlight.current = true
      setPending(key)
      setError(null)
      void action().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      }).finally(() => {
        inFlight.current = false
        setPending(null)
      })
    },
    clearError() {
      setError(null)
    },
  }
}

export function ActionError({
  children,
  closeLabel,
  onClose,
  className,
}: {
  children: ReactNode
  closeLabel?: string | undefined
  onClose?: (() => void) | undefined
  className?: string | undefined
}) {
  return (
    <div className={[css.error, className].filter(Boolean).join(' ')} role="alert">
      <span>{children}</span>
      {onClose !== undefined && (
        <button type="button" aria-label={closeLabel} onClick={onClose}>
          {closeLabel}
        </button>
      )}
    </div>
  )
}

export function RailActionError({
  error,
  closeLabel,
  onClose,
}: {
  error: string
  closeLabel: string
  onClose: () => void
}) {
  return (
    <div
      className={css.railError}
      role="alert"
      data-workspace-rail-error="true"
    >
      <span className={css.visuallyHidden}>{error}</span>
      <Tooltip label={error}>
        <button
          type="button"
          className={css.railErrorButton}
          aria-label={closeLabel}
          onClick={onClose}
        >
          <span aria-hidden="true">!</span>
        </button>
      </Tooltip>
    </div>
  )
}
