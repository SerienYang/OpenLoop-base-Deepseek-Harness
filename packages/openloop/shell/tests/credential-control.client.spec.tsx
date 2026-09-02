// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOpenloopCredentialControlAdapter,
  CredentialControl as CredentialControlComponent,
  type OpenloopCredentialRemote,
} from '../src/client/CredentialControl.tsx'

afterEach(cleanup)

const zhT = (key: string): string => ({
  credentialReading: '正在读取凭据状态…',
  credentialConfigured: 'API 密钥已安全保存',
  credentialMissing: '尚未配置 API 密钥',
  sourceKeychain: 'macOS 钥匙串 · 不显示已保存内容',
  sourceEnvironment: '环境变量',
  sourceLegacyFile: '旧版凭据文件',
  sourceHost: '由 Openloop Host 管理',
  sourceManaged: '受管凭据来源',
  replaceOpening: '正在打开…',
  replace: '替换 API 密钥',
  add: '添加 API 密钥',
  deleteBusy: '正在删除…',
  delete: '删除 API 密钥',
  initialReadFailed: '无法读取 API 密钥状态，请重试。',
  refreshFailed: '无法刷新 API 密钥状态，请重试。',
  replaceFailed: '无法更新 API 密钥，请重试。',
  deleteFailed: '无法删除 API 密钥，请重试。',
  retry: '重试',
} as Record<string, string>)[key] ?? key

const enT = (key: string): string => ({
  credentialReading: 'Reading credential status…',
  credentialConfigured: 'API key is securely stored',
  credentialMissing: 'API key is not configured',
  sourceKeychain: 'macOS Keychain · saved value is never shown',
  sourceEnvironment: 'Environment variable',
  sourceLegacyFile: 'Legacy credential file',
  sourceHost: 'Managed by the Openloop Host',
  sourceManaged: 'Managed credential source',
  replaceOpening: 'Opening…',
  replace: 'Replace API key',
  add: 'Add API key',
  deleteBusy: 'Deleting…',
  delete: 'Delete API key',
  initialReadFailed: 'Unable to read API key status. Try again.',
  refreshFailed: 'Unable to refresh API key status. Try again.',
  replaceFailed: 'Unable to update the API key. Try again.',
  deleteFailed: 'Unable to delete the API key. Try again.',
  retry: 'Retry',
} as Record<string, string>)[key] ?? key

function CredentialControl(
  props: Omit<ComponentProps<typeof CredentialControlComponent>, 't'>,
) {
  const localized = { ...props, t: zhT } as ComponentProps<typeof CredentialControlComponent>
  return <CredentialControlComponent {...localized} />
}

function ok<T>(value: T) {
  return Promise.resolve({ ok: true as const, value })
}

function remote(overrides: Partial<OpenloopCredentialRemote> = {}): OpenloopCredentialRemote {
  return {
    describeCredential: vi.fn(() => ok({
      configured: true,
      source: 'keychain',
      writable: true,
    })),
    openCredentialReplacement: vi.fn(() => ok('cancelled' as const)),
    unsetCredential: vi.fn(() => ok('cancelled' as const)),
    ...overrides,
  }
}

describe('Openloop CredentialControl', () => {
  it('shows value-free Keychain status and never renders a secret input', async () => {
    const host = remote()

    render(<CredentialControl reference="DEEPSEEK_API_KEY" label="API 密钥" remote={host} />)

    expect(await screen.findByText('API 密钥已安全保存')).toBeTruthy()
    expect(screen.getByText('macOS 钥匙串 · 不显示已保存内容')).toBeTruthy()
    expect(document.querySelector('input')).toBeNull()
    expect(JSON.stringify(document.body.textContent)).not.toContain('DEEPSEEK_API_KEY')
  })

  it('refreshes only after the Host confirms a saved replacement', async () => {
    const replacement = Promise.withResolvers<{
      ok: true
      value: 'saved' | 'cancelled'
    }>()
    const describeCredential = vi.fn()
      .mockReturnValueOnce(ok({ configured: false, writable: true }))
      .mockReturnValueOnce(ok({ configured: true, source: 'keychain', writable: true }))
    const openCredentialReplacement = vi.fn(() => replacement.promise)
    const onChanged = vi.fn()
    const host = remote({ describeCredential, openCredentialReplacement })

    render(
      <CredentialControl
        reference="DEEPSEEK_API_KEY"
        label="API 密钥"
        remote={host}
        onChanged={onChanged}
      />,
    )
    await screen.findByText('尚未配置 API 密钥')
    fireEvent.click(screen.getByRole('button', { name: '添加 API 密钥' }))

    expect(screen.getByRole('button', { name: '正在打开…' })).toHaveProperty('disabled', true)
    expect(screen.getByText('API 密钥').parentElement?.parentElement?.getAttribute('aria-busy'))
      .toBe('true')
    expect(describeCredential).toHaveBeenCalledTimes(1)
    expect(screen.getByText('尚未配置 API 密钥')).toBeTruthy()

    replacement.resolve({ ok: true, value: 'saved' })
    expect(await screen.findByText('API 密钥已安全保存')).toBeTruthy()
    expect(screen.getByText('API 密钥').parentElement?.parentElement?.getAttribute('aria-busy'))
      .toBeNull()
    expect(openCredentialReplacement).toHaveBeenCalledWith('DEEPSEEK_API_KEY')
    expect(describeCredential).toHaveBeenCalledTimes(2)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('offers one localized retry after an initial read failure and recovers', async () => {
    const initial = Promise.withResolvers<never>()
    const retry = Promise.withResolvers<{
      ok: true
      value: { configured: true; source: string; writable: true }
    }>()
    const describeCredential = vi.fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(retry.promise)
    const host = remote({ describeCredential })

    render(<CredentialControl reference="DEEPSEEK_API_KEY" label="API 密钥" remote={host} />)

    const loading = screen.getByRole('status')
    expect(loading.textContent).toBe('正在读取凭据状态…')
    expect(loading.getAttribute('aria-live')).toBe('polite')
    expect(screen.getByText('API 密钥').parentElement?.parentElement?.getAttribute('aria-busy'))
      .toBe('true')

    await act(async () => { initial.reject(new Error('offline')) })

    expect(screen.getByRole('alert').textContent).toBe('无法读取 API 密钥状态，请重试。')
    const retryButton = screen.getByRole('button', { name: '重试' })
    expect(screen.queryByText('正在读取凭据状态…')).toBeNull()

    fireEvent.click(retryButton)
    fireEvent.click(retryButton)
    expect(describeCredential).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status').textContent).toBe('正在读取凭据状态…')

    retry.resolve({
      ok: true,
      value: { configured: true, source: 'keychain', writable: true },
    })

    expect(await screen.findByText('API 密钥已安全保存')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('renders all credential-control copy in English through its injected translator', async () => {
    const host = remote()

    render(
      <CredentialControlComponent
        reference="DEEPSEEK_API_KEY"
        label="API key"
        remote={host}
        t={enT}
      />,
    )

    expect(await screen.findByText('API key is securely stored')).toBeTruthy()
    expect(screen.getByText('macOS Keychain · saved value is never shown')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Replace API key' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete API key' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('密钥')
  })

  it('notifies the owner after a saved replacement even when the follow-up status read rejects', async () => {
    const describeCredential = vi.fn()
      .mockReturnValueOnce(ok({ configured: false, writable: true }))
      .mockRejectedValueOnce(new Error('DEEPSEEK_API_KEY sk-private refresh failure'))
    const onChanged = vi.fn()
    const host = remote({
      describeCredential,
      openCredentialReplacement: vi.fn(() => ok('saved' as const)),
    })

    render(
      <CredentialControl
        reference="DEEPSEEK_API_KEY"
        label="API 密钥"
        remote={host}
        onChanged={onChanged}
      />,
    )
    await screen.findByText('尚未配置 API 密钥')

    fireEvent.click(screen.getByRole('button', { name: '添加 API 密钥' }))

    await waitFor(() => { expect(onChanged).toHaveBeenCalledOnce() })
    expect(await screen.findByText('无法刷新 API 密钥状态，请重试。')).toBeTruthy()
    expect(screen.getByText('尚未配置 API 密钥')).toBeTruthy()
    expect(screen.queryByText('无法更新 API 密钥，请重试。')).toBeNull()
    expect(document.body.textContent).not.toContain('DEEPSEEK_API_KEY')
    expect(document.body.textContent).not.toContain('sk-private')
  })

  it('notifies the owner after a confirmed deletion even when the follow-up status read rejects', async () => {
    const describeCredential = vi.fn()
      .mockReturnValueOnce(ok({ configured: true, source: 'keychain', writable: true }))
      .mockRejectedValueOnce(new Error('DEEPSEEK_API_KEY sk-private refresh failure'))
    const onChanged = vi.fn()
    const host = remote({
      describeCredential,
      unsetCredential: vi.fn(() => ok('deleted' as const)),
    })

    render(
      <CredentialControl
        reference="DEEPSEEK_API_KEY"
        label="API 密钥"
        remote={host}
        onChanged={onChanged}
      />,
    )
    await screen.findByText('API 密钥已安全保存')

    fireEvent.click(screen.getByRole('button', { name: '删除 API 密钥' }))

    await waitFor(() => { expect(onChanged).toHaveBeenCalledOnce() })
    expect(await screen.findByText('无法刷新 API 密钥状态，请重试。')).toBeTruthy()
    expect(screen.getByText('API 密钥已安全保存')).toBeTruthy()
    expect(screen.queryByText('无法删除 API 密钥，请重试。')).toBeNull()
  })

  it('waits for the owner refresh before starting its follow-up status read', async () => {
    const ownerRefresh = Promise.withResolvers<undefined>()
    const describeCredential = vi.fn()
      .mockReturnValueOnce(ok({ configured: false, writable: true }))
      .mockReturnValueOnce(ok({ configured: true, source: 'keychain', writable: true }))
    const onChanged = vi.fn(() => ownerRefresh.promise)
    const host = remote({
      describeCredential,
      openCredentialReplacement: vi.fn(() => ok('saved' as const)),
    })

    render(
      <CredentialControl
        reference="DEEPSEEK_API_KEY"
        label="API 密钥"
        remote={host}
        onChanged={onChanged}
      />,
    )
    await screen.findByText('尚未配置 API 密钥')
    fireEvent.click(screen.getByRole('button', { name: '添加 API 密钥' }))

    await waitFor(() => { expect(onChanged).toHaveBeenCalledOnce() })
    expect(describeCredential).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '正在打开…' })).toHaveProperty('disabled', true)

    ownerRefresh.resolve(undefined)

    expect(await screen.findByText('API 密钥已安全保存')).toBeTruthy()
    expect(describeCredential).toHaveBeenCalledTimes(2)
  })

  it('keeps the previous status and does not notify on cancellation or mutation failure', async () => {
    const describeCredential = vi.fn(() => ok({
      configured: true,
      source: 'keychain',
      writable: true,
    }))
    const openCredentialReplacement = vi.fn()
      .mockReturnValueOnce(ok('cancelled' as const))
      .mockResolvedValueOnce({ ok: false, error: new Error('sk-private refused') })
      .mockRejectedValueOnce(new Error('DEEPSEEK_API_KEY sk-private transport failure'))
    const onChanged = vi.fn()
    const host = remote({ describeCredential, openCredentialReplacement })

    render(
      <CredentialControl
        reference="DEEPSEEK_API_KEY"
        label="API 密钥"
        remote={host}
        onChanged={onChanged}
      />,
    )
    await screen.findByText('API 密钥已安全保存')

    fireEvent.click(screen.getByRole('button', { name: '替换 API 密钥' }))
    await waitFor(() => { expect(openCredentialReplacement).toHaveBeenCalledTimes(1) })
    expect(describeCredential).toHaveBeenCalledTimes(1)
    expect(onChanged).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '替换 API 密钥' }))
    expect(await screen.findByText('无法更新 API 密钥，请重试。')).toBeTruthy()
    expect(onChanged).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '替换 API 密钥' }))
    await waitFor(() => { expect(openCredentialReplacement).toHaveBeenCalledTimes(3) })
    expect(describeCredential).toHaveBeenCalledTimes(1)
    expect(onChanged).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('DEEPSEEK_API_KEY')
    expect(document.body.textContent).not.toContain('sk-private')
  })

  it('refreshes only after confirmed deletion and keeps configured state when cancelled', async () => {
    const describeCredential = vi.fn()
      .mockReturnValueOnce(ok({ configured: true, source: 'keychain', writable: true }))
      .mockReturnValueOnce(ok({ configured: false, writable: true }))
    const unsetCredential = vi.fn()
      .mockReturnValueOnce(ok('cancelled' as const))
      .mockReturnValueOnce(ok('deleted' as const))
    const host = remote({ describeCredential, unsetCredential })

    render(<CredentialControl reference="DEEPSEEK_API_KEY" label="API 密钥" remote={host} />)
    await screen.findByText('API 密钥已安全保存')

    fireEvent.click(screen.getByRole('button', { name: '删除 API 密钥' }))
    await waitFor(() => { expect(unsetCredential).toHaveBeenCalledTimes(1) })
    expect(describeCredential).toHaveBeenCalledTimes(1)
    expect(screen.getByText('API 密钥已安全保存')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '删除 API 密钥' }))
    expect(await screen.findByText('尚未配置 API 密钥')).toBeTruthy()
    expect(unsetCredential).toHaveBeenCalledWith('DEEPSEEK_API_KEY')
    expect(describeCredential).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['environment', '环境变量'],
    ['legacy-file', '旧版凭据文件'],
  ])('renders %s as read-only and offers no mutation actions', async (source, label) => {
    const host = remote({
      describeCredential: vi.fn(() => ok({
        configured: true,
        source,
        writable: false,
      })),
    })

    render(<CredentialControl reference="READ_ONLY_KEY" label="API 密钥" remote={host} />)

    expect(await screen.findByText(label)).toBeTruthy()
    expect(screen.getByText('尚未配置 API 密钥')).toBeTruthy()
    expect(screen.queryByText('API 密钥已安全保存')).toBeNull()
    expect(screen.queryByRole('button', { name: '替换 API 密钥' })).toBeNull()
    expect(screen.queryByRole('button', { name: '删除 API 密钥' })).toBeNull()
  })

  it('exposes a value-free reusable adapter with Openloop profile policy', async () => {
    const host = remote({
      describeCredential: vi.fn(() => ok({
        configured: false,
        writable: true,
      })),
    })
    const adapter = createOpenloopCredentialControlAdapter(host, zhT)

    await expect(adapter.describe('DEEPSEEK_API_KEY')).resolves.toEqual({
      configured: false,
      writable: true,
    })
    expect(adapter.materializeApiKeyEnv).toBe(false)
    expect(adapter.deleteCredentialWithProfile).toBe(false)

    render(adapter.render({ reference: 'DEEPSEEK_API_KEY', label: 'API 密钥' }))
    expect(await screen.findByText('尚未配置 API 密钥')).toBeTruthy()
    expect(document.querySelector('input')).toBeNull()
  })

  it('re-reads when its owning surface publishes a new credential snapshot', async () => {
    const describeCredential = vi.fn()
      .mockReturnValueOnce(ok({ configured: false, writable: true }))
      .mockReturnValueOnce(ok({ configured: true, source: 'keychain', writable: true }))
    const host = remote({ describeCredential })
    const view = render(
      <CredentialControl
        reference="DEEPSEEK_API_KEY"
        label="API 密钥"
        remote={host}
        refreshToken={0}
      />,
    )
    await screen.findByText('尚未配置 API 密钥')

    view.rerender(
      <CredentialControl
        reference="DEEPSEEK_API_KEY"
        label="API 密钥"
        remote={host}
        refreshToken={1}
      />,
    )

    expect(await screen.findByText('API 密钥已安全保存')).toBeTruthy()
    expect(describeCredential).toHaveBeenCalledTimes(2)
  })

  it.each([
    {
      operation: 'replacement',
      initial: { configured: false, writable: true },
      button: '添加 API 密钥',
      outcome: 'saved' as const,
      confirmed: { configured: true, source: 'keychain', writable: true },
      confirmedText: 'API 密钥已安全保存',
    },
    {
      operation: 'deletion',
      initial: { configured: true, source: 'keychain', writable: true },
      button: '删除 API 密钥',
      outcome: 'deleted' as const,
      confirmed: { configured: false, writable: true },
      confirmedText: '尚未配置 API 密钥',
    },
  ])('invalidates an in-flight refresh and follows up after confirmed $operation', async ({
    initial,
    button,
    outcome,
    confirmed,
    confirmedText,
  }) => {
    const mutation = Promise.withResolvers<{
      ok: true
      value: 'saved' | 'deleted'
    }>()
    const ownerRead = Promise.withResolvers<{
      ok: true
      value: { configured: boolean; source?: string; writable: boolean }
    }>()
    const confirmedRead = Promise.withResolvers<{
      ok: true
      value: { configured: boolean; source?: string; writable: boolean }
    }>()
    const describeCredential = vi.fn()
      .mockReturnValueOnce(ok(initial))
      .mockReturnValueOnce(ownerRead.promise)
      .mockReturnValueOnce(confirmedRead.promise)
    const onChanged = vi.fn()
    const host = remote({
      describeCredential,
      openCredentialReplacement: vi.fn(() => mutation.promise as never),
      unsetCredential: vi.fn(() => mutation.promise as never),
    })
    const view = render(
      <CredentialControl
        reference="DEEPSEEK_API_KEY"
        label="API 密钥"
        remote={host}
        refreshToken={0}
        onChanged={onChanged}
      />,
    )
    await screen.findByRole('button', { name: button })
    fireEvent.click(screen.getByRole('button', { name: button }))

    view.rerender(
      <CredentialControl
        reference="DEEPSEEK_API_KEY"
        label="API 密钥"
        remote={host}
        refreshToken={1}
        onChanged={onChanged}
      />,
    )
    await waitFor(() => { expect(describeCredential).toHaveBeenCalledTimes(2) })

    await act(async () => { mutation.resolve({ ok: true, value: outcome }) })

    await waitFor(() => { expect(onChanged).toHaveBeenCalledOnce() })
    await waitFor(() => { expect(describeCredential).toHaveBeenCalledTimes(3) })
    await act(async () => { confirmedRead.resolve({ ok: true, value: confirmed }) })
    expect(await screen.findByText(confirmedText)).toBeTruthy()
    await act(async () => {
      ownerRead.resolve({ ok: true, value: initial })
      await ownerRead.promise
    })
    expect(screen.getByText(confirmedText)).toBeTruthy()
  })

  it('keeps the last status and reports a refresh failure when a refresh-token read rejects', async () => {
    const describeCredential = vi.fn()
      .mockReturnValueOnce(ok({ configured: true, source: 'keychain', writable: true }))
      .mockRejectedValueOnce(new Error('offline'))
    const host = remote({ describeCredential })
    const view = render(
      <CredentialControl
        reference="DEEPSEEK_API_KEY"
        label="API 密钥"
        remote={host}
        refreshToken={0}
      />,
    )
    await screen.findByText('API 密钥已安全保存')

    view.rerender(
      <CredentialControl
        reference="DEEPSEEK_API_KEY"
        label="API 密钥"
        remote={host}
        refreshToken={1}
      />,
    )

    expect(await screen.findByText('无法刷新 API 密钥状态，请重试。')).toBeTruthy()
    expect(screen.getByText('API 密钥已安全保存')).toBeTruthy()
    expect(screen.getByText('macOS 钥匙串 · 不显示已保存内容')).toBeTruthy()
    expect(screen.queryByText('正在读取凭据状态…')).toBeNull()
    expect(screen.queryByText('无法读取 API 密钥状态，请重试。')).toBeNull()
  })

  it('reports a token-triggered retry as a refresh even when the initial read failed', async () => {
    const describeCredential = vi.fn(() => Promise.reject(new Error('offline')))
    const host = remote({ describeCredential })
    const view = render(
      <CredentialControl
        reference="DEEPSEEK_API_KEY"
        label="API 密钥"
        remote={host}
        refreshToken={0}
      />,
    )
    await screen.findByText('无法读取 API 密钥状态，请重试。')

    view.rerender(
      <CredentialControl
        reference="DEEPSEEK_API_KEY"
        label="API 密钥"
        remote={host}
        refreshToken={1}
      />,
    )

    expect(await screen.findByText('无法刷新 API 密钥状态，请重试。')).toBeTruthy()
    expect(screen.queryByText('无法读取 API 密钥状态，请重试。')).toBeNull()
  })

  it('ignores a stale initial response after the credential reference changes', async () => {
    const stale = Promise.withResolvers<{
      ok: true
      value: { configured: boolean; source: string; writable: boolean }
    }>()
    const describeCredential = vi.fn()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(ok({ configured: false, writable: true }))
    const host = remote({ describeCredential })
    const view = render(
      <CredentialControl reference="OLD_KEY" label="API 密钥" remote={host} />,
    )

    view.rerender(
      <CredentialControl reference="NEW_KEY" label="API 密钥" remote={host} />,
    )
    await screen.findByText('尚未配置 API 密钥')
    stale.resolve({
      ok: true,
      value: { configured: true, source: 'keychain', writable: false },
    })
    await act(async () => { await stale.promise })

    expect(screen.getByText('尚未配置 API 密钥')).toBeTruthy()
    expect(screen.queryByText('API 密钥已安全保存')).toBeNull()
  })

  it.each(['reference change', 'unmount'])(
    'notifies after a confirmed mutation outlives a %s',
    async (endLifetime) => {
      const mutation = Promise.withResolvers<{
        ok: true
        value: 'saved'
      }>()
      const onChanged = vi.fn()
      const describeCredential = vi.fn(() => ok({ configured: false, writable: true }))
      const host = remote({
        describeCredential,
        openCredentialReplacement: vi.fn(() => mutation.promise),
      })
      const view = render(
        <CredentialControl
          reference="DEEPSEEK_API_KEY"
          label="API 密钥"
          remote={host}
          onChanged={onChanged}
        />,
      )
      await screen.findByRole('button', { name: '添加 API 密钥' })
      fireEvent.click(screen.getByRole('button', { name: '添加 API 密钥' }))

      if (endLifetime === 'unmount') {
        view.unmount()
      } else {
        view.rerender(
          <CredentialControl
            reference="OTHER_KEY"
            label="API 密钥"
            remote={host}
            onChanged={onChanged}
          />,
        )
      }
      await act(async () => { mutation.resolve({ ok: true, value: 'saved' }) })

      expect(onChanged).toHaveBeenCalledOnce()
      expect(describeCredential).toHaveBeenCalledTimes(endLifetime === 'unmount' ? 1 : 2)
      if (endLifetime === 'reference change') {
        expect(screen.getByText('尚未配置 API 密钥')).toBeTruthy()
        expect(screen.queryByRole('alert')).toBeNull()
      }
    },
  )

  it('does not duplicate a follow-up describe when the owner starts one', async () => {
    const describeCredential = vi.fn()
      .mockReturnValueOnce(ok({ configured: false, writable: true }))
      .mockReturnValueOnce(ok({ configured: true, source: 'keychain', writable: true }))
    const host = remote({
      describeCredential,
      openCredentialReplacement: vi.fn(() => ok('saved' as const)),
    })
    let refreshToken = 0
    const view: { current?: ReturnType<typeof render> } = {}
    const onChanged = vi.fn(async () => {
      refreshToken++
      view.current?.rerender(
        <CredentialControl
          reference="DEEPSEEK_API_KEY"
          label="API 密钥"
          remote={host}
          refreshToken={refreshToken}
          onChanged={onChanged}
        />,
      )
      await Promise.resolve()
    })
    view.current = render(
      <CredentialControl
        reference="DEEPSEEK_API_KEY"
        label="API 密钥"
        remote={host}
        refreshToken={refreshToken}
        onChanged={onChanged}
      />,
    )
    await screen.findByText('尚未配置 API 密钥')

    fireEvent.click(screen.getByRole('button', { name: '添加 API 密钥' }))

    expect(await screen.findByText('API 密钥已安全保存')).toBeTruthy()
    expect(onChanged).toHaveBeenCalledOnce()
    expect(describeCredential).toHaveBeenCalledTimes(2)
  })

  it.each(['throw', 'reject'])(
    'converges locally without a mutation error when onChanged %s',
    async (failureMode) => {
      const describeCredential = vi.fn()
        .mockReturnValueOnce(ok({ configured: false, writable: true }))
        .mockReturnValueOnce(ok({ configured: true, source: 'keychain', writable: true }))
      const onChanged = failureMode === 'throw'
        ? vi.fn(() => { throw new Error('owner refresh failed') })
        : vi.fn(() => Promise.reject(new Error('owner refresh failed')))
      const host = remote({
        describeCredential,
        openCredentialReplacement: vi.fn(() => ok('saved' as const)),
      })

      render(
        <CredentialControl
          reference="DEEPSEEK_API_KEY"
          label="API 密钥"
          remote={host}
          onChanged={onChanged}
        />,
      )
      await screen.findByText('尚未配置 API 密钥')

      fireEvent.click(screen.getByRole('button', { name: '添加 API 密钥' }))

      expect(await screen.findByText('API 密钥已安全保存')).toBeTruthy()
      expect(onChanged).toHaveBeenCalledOnce()
      expect(describeCredential).toHaveBeenCalledTimes(2)
      expect(screen.queryByText('无法更新 API 密钥，请重试。')).toBeNull()
    },
  )
})
