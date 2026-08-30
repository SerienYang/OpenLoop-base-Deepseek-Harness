// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOpenloopCredentialControlAdapter,
  CredentialControl,
  type OpenloopCredentialRemote,
} from '../src/client/CredentialControl.tsx'

afterEach(cleanup)

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
    expect(describeCredential).toHaveBeenCalledTimes(1)
    expect(screen.getByText('尚未配置 API 密钥')).toBeTruthy()

    replacement.resolve({ ok: true, value: 'saved' })
    expect(await screen.findByText('API 密钥已安全保存')).toBeTruthy()
    expect(openCredentialReplacement).toHaveBeenCalledWith('DEEPSEEK_API_KEY')
    expect(describeCredential).toHaveBeenCalledTimes(2)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('keeps the previous status and does not refresh on cancellation or failure', async () => {
    const describeCredential = vi.fn(() => ok({
      configured: true,
      source: 'keychain',
      writable: true,
    }))
    const openCredentialReplacement = vi.fn()
      .mockReturnValueOnce(ok('cancelled' as const))
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
    expect(describeCredential).toHaveBeenCalledTimes(1)
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
    const adapter = createOpenloopCredentialControlAdapter(host)

    await expect(adapter.describe('DEEPSEEK_API_KEY')).resolves.toEqual({
      configured: false,
      writable: true,
    })
    expect(adapter.materializeApiKeyEnv).toBe(true)
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
})
