import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  CredentialControlAdapter,
  CredentialControlRenderProps,
  CredentialControlStatus,
} from '@deepseek-ai/dsh-client-ui-settings/client'
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
}

function sourceLabel(source: string | undefined): string {
  if (source === 'keychain') return 'macOS 钥匙串 · 不显示已保存内容'
  if (source === 'environment' || source === 'env') return '环境变量'
  if (source === 'legacy-file' || source === 'file') return '旧版凭据文件'
  return source === undefined ? '由 Openloop Host 管理' : '受管凭据来源'
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
  const { reference, remote, onChanged } = props
  const [status, setStatus] = useState<CredentialControlStatus | undefined>()
  const [busy, setBusy] = useState<'replace' | 'delete' | undefined>()
  const [failure, setFailure] = useState<string | undefined>()
  const statusRef = useRef<CredentialControlStatus | undefined>()
  const lifetimeEpoch = useRef(0)
  const readGeneration = useRef(0)
  const initialReadPending = useRef(true)

  const readStatus = useCallback(async (kind: 'initial' | 'refresh'): Promise<void> => {
    const lifetime = lifetimeEpoch.current
    const generation = ++readGeneration.current
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
        ? '无法读取 API 密钥状态，请重试。'
        : '无法刷新 API 密钥状态，请重试。')
    }
  }, [reference, remote])

  useEffect(() => {
    const lifetime = ++lifetimeEpoch.current
    readGeneration.current++
    initialReadPending.current = true
    statusRef.current = undefined
    setStatus(undefined)
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
    if (busy !== undefined) return
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
            ? '无法更新 API 密钥，请重试。'
            : '无法删除 API 密钥，请重试。')
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

  const configured = status?.configured === true
  const writable = status?.writable === true && props.disabled !== true
  return (
    <div className={styles.control}>
      <div className={styles.summary}>
        <span className={styles.label}>{props.label}</span>
        <span className={configured ? styles.configured : styles.missing}>
          {status === undefined
            ? '正在读取凭据状态…'
            : configured ? 'API 密钥已安全保存' : '尚未配置 API 密钥'}
        </span>
        {status === undefined ? null : <span className={styles.source}>{sourceLabel(status.source)}</span>}
      </div>
      {status === undefined || !writable
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
                ? '正在打开…'
                : configured ? '替换 API 密钥' : '添加 API 密钥'}
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
                  {busy === 'delete' ? '正在删除…' : '删除 API 密钥'}
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
): CredentialControlAdapter {
  return {
    async describe(reference) {
      return valueOf(
        await remote.describeCredential(reference),
        'credential status is unavailable',
      )
    },
    render: props => <CredentialControl {...props} remote={remote} />,
    materializeApiKeyEnv: true,
    deleteCredentialWithProfile: false,
  }
}
