import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  CredentialControlAdapter,
  CredentialControlRenderProps,
  CredentialControlStatus,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ShellKey } from './locales.ts'
import styles from './CredentialControl.module.css'

type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown }

/** Browser-safe Openloop Host facade consumed by the credential control. */
export interface OpenloopCredentialRemote {
  describeCredential(reference: string): Promise<RemoteResult<CredentialControlStatus>>
  openCredentialReplacement(reference: string): Promise<RemoteResult<'saved' | 'cancelled'>>
  unsetCredential(reference: string): Promise<RemoteResult<'deleted' | 'cancelled'>>
}

/** Props of {@link CredentialControl}. */
export interface CredentialControlProps extends CredentialControlRenderProps {
  /** Browser-safe Remote facade. */
  remote: OpenloopCredentialRemote
  /** Stable shell-namespace translator. */
  t: (key: ShellKey) => string
}

function sourceLabel(source: string | undefined, t: CredentialControlProps['t']): string {
  if (source === 'keychain') return t('sourceKeychain')
  if (source === 'environment' || source === 'env') return t('sourceEnvironment')
  if (source === 'legacy-file' || source === 'file') return t('sourceLegacyFile')
  return source === undefined ? t('sourceHost') : t('sourceManaged')
}

function valueOf<T>(result: RemoteResult<T>, failure: string): T {
  if (result.ok) return result.value
  throw new Error(failure)
}

/**
 * Value-free browser credential control. Plaintext entry, confirmation, and
 * persistence stay in the native Host sheet.
 */
export function CredentialControl(props: CredentialControlProps): ReactNode {
  const { reference, remote, onChanged, t } = props
  const [status, setStatus] = useState<CredentialControlStatus | undefined>()
  const [reading, setReading] = useState(true)
  const [busy, setBusy] = useState<'replace' | 'delete' | undefined>()
  const [failure, setFailure] = useState<string | undefined>()
  const statusRef = useRef<CredentialControlStatus | undefined>()
  const lifetimeEpoch = useRef(0)
  const readGeneration = useRef(0)
  const initialReadPending = useRef(true)
  const retryPending = useRef(false)

  const readStatus = useCallback(async (kind: 'initial' | 'refresh'): Promise<void> => {
    const lifetime = lifetimeEpoch.current
    const generation = ++readGeneration.current
    setReading(true)
    setFailure(undefined)
    try {
      const next = valueOf(
        await remote.describeCredential(reference),
        'credential status read failed',
      )
      if (lifetimeEpoch.current !== lifetime || readGeneration.current !== generation) return
      statusRef.current = next
      setStatus(next)
    } catch {
      if (lifetimeEpoch.current !== lifetime || readGeneration.current !== generation) return
      setFailure(kind === 'initial'
        ? t('initialReadFailed')
        : t('refreshFailed'))
    } finally {
      if (lifetimeEpoch.current === lifetime && readGeneration.current === generation) {
        setReading(false)
      }
    }
  }, [reference, remote, t])

  useEffect(() => {
    const lifetime = ++lifetimeEpoch.current
    readGeneration.current++
    initialReadPending.current = true
    retryPending.current = false
    statusRef.current = undefined
    setStatus(undefined)
    setReading(true)
    setBusy(undefined)
    setFailure(undefined)
    return () => {
      if (lifetimeEpoch.current === lifetime) lifetimeEpoch.current++
      readGeneration.current++
    }
  }, [reference, remote])

  useEffect(() => {
    const kind = initialReadPending.current ? 'initial' : 'refresh'
    initialReadPending.current = false
    void readStatus(kind)
  }, [props.refreshToken, readStatus])

  const mutate = async (operation: 'replace' | 'delete'): Promise<void> => {
    if (busy !== undefined || reading) return
    const lifetime = lifetimeEpoch.current
    setBusy(operation)
    setFailure(undefined)
    try {
      let outcome: 'saved' | 'deleted' | 'cancelled'
      try {
        const result = operation === 'replace'
          ? await remote.openCredentialReplacement(reference)
          : await remote.unsetCredential(reference)
        outcome = valueOf(
          result,
          operation === 'replace'
            ? 'credential replacement failed'
            : 'credential deletion failed',
        )
      } catch {
        if (lifetimeEpoch.current === lifetime) {
          setFailure(operation === 'replace'
            ? t('replaceFailed')
            : t('deleteFailed'))
        }
        return
      }
      if (outcome === 'cancelled') return
      const confirmationGeneration = lifetimeEpoch.current === lifetime
        ? ++readGeneration.current
        : undefined
      try {
        await onChanged?.()
      } catch {
        // The confirmed Host outcome still needs local convergence below.
      }
      if (confirmationGeneration === undefined || lifetimeEpoch.current !== lifetime) return
      // A newer owner read already covers the confirmed mutation. Otherwise
      // this control owns one follow-up read so standalone usage converges.
      if (readGeneration.current === confirmationGeneration) await readStatus('refresh')
    } finally {
      if (lifetimeEpoch.current === lifetime) setBusy(undefined)
    }
  }

  const retry = (): void => {
    if (retryPending.current) return
    retryPending.current = true
    void readStatus('refresh').finally(() => {
      retryPending.current = false
    })
  }

  const configured = status?.configured === true && status.source === 'keychain'
  const writable = status?.writable === true && props.disabled !== true
  return (
    <div className={styles.control} aria-busy={reading || busy !== undefined || undefined}>
      <div className={styles.summary}>
        <span className={styles.label}>{props.label}</span>
        {status === undefined && !reading
          ? null
          : (
            <span
              className={configured ? styles.configured : styles.missing}
              role="status"
              aria-live="polite"
            >
              {status === undefined
                ? t('credentialReading')
                : configured ? t('credentialConfigured') : t('credentialMissing')}
            </span>
          )}
        {status === undefined
          ? null
          : <span className={styles.source}>{sourceLabel(status.source, t)}</span>}
      </div>
      {status === undefined
        ? failure === undefined || reading
          ? null
          : (
            <div className={styles.actions}>
              <button type="button" className={styles.action} onClick={retry}>
                {t('retry')}
              </button>
            </div>
          )
        : !writable
          ? null
          : (
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.action}
                disabled={busy !== undefined}
                onClick={() => { void mutate('replace') }}
              >
                {busy === 'replace'
                  ? t('replaceOpening')
                  : configured ? t('replace') : t('add')}
              </button>
              {!configured
                ? null
                : (
                  <button
                    type="button"
                    className={styles.deleteAction}
                    disabled={busy !== undefined}
                    onClick={() => { void mutate('delete') }}
                  >
                    {busy === 'delete' ? t('deleteBusy') : t('delete')}
                  </button>
                )}
            </div>
          )}
      {failure === undefined ? null : <p className={styles.error} role="alert">{failure}</p>}
    </div>
  )
}

/** Build the Openloop product adapter around its browser-safe Host facade. */
export function createOpenloopCredentialControlAdapter(
  remote: OpenloopCredentialRemote,
  t: CredentialControlProps['t'],
): CredentialControlAdapter {
  return {
    async describe(reference) {
      return valueOf(
        await remote.describeCredential(reference),
        'credential status is unavailable',
      )
    },
    render: props => <CredentialControl {...props} remote={remote} t={t} />,
    materializeApiKeyEnv: false,
    deleteCredentialWithProfile: false,
  }
}
