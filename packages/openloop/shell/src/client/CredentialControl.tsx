import { useEffect, useRef, useState } from 'react'
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
  const generation = useRef(0)

  useEffect(() => {
    const current = ++generation.current
    setStatus(undefined)
    setBusy(undefined)
    setFailure(undefined)
    void remote.describeCredential(reference).then(
      (result) => {
        if (generation.current !== current || !result.ok) {
          if (generation.current === current && !result.ok) {
            setFailure('无法读取 API 密钥状态，请重试。')
          }
          return
        }
        setStatus(result.value)
      },
      () => {
        if (generation.current === current) setFailure('无法读取 API 密钥状态，请重试。')
      },
    )
    return () => { generation.current++ }
  }, [props.refreshToken, reference, remote])

  const mutate = async (operation: 'replace' | 'delete'): Promise<void> => {
    if (busy !== undefined) return
    const current = generation.current
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
        if (generation.current === current) {
          setFailure(operation === 'replace'
            ? '无法更新 API 密钥，请重试。'
            : '无法删除 API 密钥，请重试。')
        }
        return
      }
      if (outcome === 'cancelled' || generation.current !== current) return
      try {
        await onChanged?.()
        // An awaited owner refresh may have published a new refresh token or
        // unmounted this control. Its effect owns that generation's describe.
        if (generation.current !== current) return
        const refreshed = valueOf(
          await remote.describeCredential(reference),
          'credential refresh failed',
        )
        if (generation.current !== current) return
        setStatus(refreshed)
      } catch {
        if (generation.current === current) {
          setFailure('无法刷新 API 密钥状态，请重试。')
        }
      }
    } finally {
      if (generation.current === current) setBusy(undefined)
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
