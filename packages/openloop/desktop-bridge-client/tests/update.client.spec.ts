import { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import * as ApiGatewayClient from '@deepseek-ai/dsh-api-gateway/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import { apply as applyClient } from '../src/client/index.ts'
import {
  OpenloopUpdateRemoteBinding,
  OpenloopUpdateService,
  type OpenloopUpdateRemote,
  type OpenloopUpdateStatus,
} from '../src/client/update.ts'

function ok<T>(value: T): Promise<RemoteResult<T>> {
  return Promise.resolve({ ok: true, value })
}

function deferred<T>() {
  return Promise.withResolvers<T>()
}

function status(
  state: OpenloopUpdateStatus['state'],
  overrides: Partial<OpenloopUpdateStatus> = {},
): OpenloopUpdateStatus {
  return {
    state,
    ...overrides,
  }
}

function remote(
  overrides: Partial<OpenloopUpdateRemote> = {},
): OpenloopUpdateRemote {
  return {
    getUpdateStatus: vi.fn(() => ok(status('idle'))),
    checkForUpdate: vi.fn(() => ok(status('up-to-date', {
      lastCheckedAt: Date.UTC(2026, 7, 30, 12),
    }))),
    installUpdateAndRestart: vi.fn(() => ok('restarting' as const)),
    ...overrides,
  }
}

describe('Openloop browser update facade', () => {
  it('projects only safe Host status into a stable observable UpdateView', async () => {
    const service = new OpenloopUpdateService(remote({
      getUpdateStatus: vi.fn(() => ok(status('available', {
        updateId: 'opaque-update-id',
        version: '1.2.3',
        releaseNotes: 'Security fixes and reliability improvements.',
        lastCheckedAt: Date.UTC(2026, 7, 30, 12, 34, 56),
      }))),
    }))
    const view = service.view
    const listener = vi.fn()
    const unsubscribe = view.subscribe(listener)

    await service.refresh()

    expect(service.view).toBe(view)
    expect(view.getSnapshot()).toEqual({
      phase: 'available',
      lastCheckedAt: '2026-08-30T12:34:56.000Z',
      targetVersion: '1.2.3',
      releaseNotes: 'Security fixes and reliability improvements.',
      actions: {
        check: { enabled: true },
        installAndRestart: { enabled: true },
      },
    })
    expect(view.getSnapshot()).not.toHaveProperty('updateId')
    expect(JSON.stringify(view.getSnapshot())).not.toContain('opaque-update-id')
    expect(listener).toHaveBeenCalledOnce()

    unsubscribe()
  })

  it('shares one in-flight Remote check and resolves every caller with the final status', async () => {
    const pending = deferred<RemoteResult<OpenloopUpdateStatus>>()
    const checkForUpdate = vi.fn(() => pending.promise)
    const service = new OpenloopUpdateService(remote({ checkForUpdate }))

    const first = service.checkForUpdate()
    const second = service.checkForUpdate()
    await Promise.resolve()

    expect(checkForUpdate).toHaveBeenCalledOnce()
    expect(service.view.getSnapshot().phase).toBe('checking')

    pending.resolve({
      ok: true,
      value: status('available', {
        updateId: 'shared-update-id',
        version: '2.0.0',
      }),
    })
    await Promise.all([first, second])

    expect(service.view.getSnapshot()).toMatchObject({
      phase: 'available',
      targetVersion: '2.0.0',
    })
  })

  it('does not let a refresh during a check replace the final check result with checking', async () => {
    const pending = deferred<RemoteResult<OpenloopUpdateStatus>>()
    const getUpdateStatus = vi.fn(() => ok(status('checking')))
    const service = new OpenloopUpdateService(remote({
      getUpdateStatus,
      checkForUpdate: vi.fn(() => pending.promise),
    }))

    const check = service.checkForUpdate()
    const refresh = service.refresh()
    expect(getUpdateStatus).not.toHaveBeenCalled()

    pending.resolve({
      ok: true,
      value: status('up-to-date', {
        lastCheckedAt: Date.UTC(2026, 7, 30, 14),
      }),
    })
    await Promise.all([check, refresh])

    expect(service.view.getSnapshot()).toMatchObject({
      phase: 'up-to-date',
      lastCheckedAt: '2026-08-30T14:00:00.000Z',
    })
  })

  it('keeps the latest status when reads settle in reverse order', async () => {
    const first = deferred<RemoteResult<OpenloopUpdateStatus>>()
    const second = deferred<RemoteResult<OpenloopUpdateStatus>>()
    const service = new OpenloopUpdateService(remote({
      getUpdateStatus: vi.fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    }))

    const stale = service.refresh()
    const latest = service.refresh()
    second.resolve({ ok: true, value: status('downloading', {
      updateId: 'latest-id',
      version: '2.0.0',
      progress: 67,
    }) })
    await latest
    first.resolve({ ok: true, value: status('up-to-date') })
    await stale

    expect(service.view.getSnapshot()).toEqual({
      phase: 'downloading',
      targetVersion: '2.0.0',
      progress: 67,
      actions: {
        check: { enabled: false },
        installAndRestart: { enabled: false, pending: true },
      },
    })
  })

  it('keeps ready-to-install pending and disabled instead of simultaneously enabled', async () => {
    const service = new OpenloopUpdateService(remote({
      getUpdateStatus: vi.fn(() => ok(status('ready-to-install', {
        updateId: 'verified-update-id',
        version: '2.0.0',
        progress: 100,
      }))),
    }))

    await service.refresh()

    expect(service.view.getSnapshot().actions.installAndRestart).toEqual({
      enabled: false,
      pending: true,
    })
  })

  it('uses the latest opaque id for manual install and preserves availability on cancellation', async () => {
    const installUpdateAndRestart = vi.fn(() => ok('cancelled' as const))
    const service = new OpenloopUpdateService(remote({
      getUpdateStatus: vi.fn(() => ok(status('available', {
        updateId: 'host-capability',
        version: '1.2.3',
      }))),
      installUpdateAndRestart,
    }))
    await service.refresh()

    await expect(service.installUpdateAndRestart()).resolves.toBe('cancelled')

    expect(installUpdateAndRestart).toHaveBeenCalledExactlyOnceWith('host-capability')
    expect(service.view.getSnapshot()).toMatchObject({
      phase: 'available',
      targetVersion: '1.2.3',
      actions: {
        check: { enabled: true },
        installAndRestart: { enabled: true },
      },
    })
  })

  it('runs manual checks regardless of prior terminal status and surfaces safe failures', async () => {
    const checkForUpdate = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        value: status('up-to-date', {
          lastCheckedAt: Date.UTC(2026, 7, 30, 13),
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'update_failure', message: 'Update check failed' },
      })
    const service = new OpenloopUpdateService(remote({ checkForUpdate }))

    await service.checkForUpdate()
    expect(service.view.getSnapshot()).toMatchObject({
      phase: 'up-to-date',
      lastCheckedAt: '2026-08-30T13:00:00.000Z',
    })

    await expect(service.checkForUpdate()).rejects.toThrow(
      'Openloop update check failed: update_failure: Update check failed',
    )
    expect(service.view.getSnapshot()).toMatchObject({
      phase: 'failed',
      message: 'Update check failed',
      actions: {
        check: { enabled: true },
        installAndRestart: { enabled: false },
      },
    })
    expect(checkForUpdate).toHaveBeenCalledTimes(2)
  })

  it('does not publish an in-flight response after lifecycle disposal', async () => {
    const pending = deferred<RemoteResult<OpenloopUpdateStatus>>()
    const service = new OpenloopUpdateService(remote({
      getUpdateStatus: vi.fn(() => pending.promise),
    }))
    const refresh = service.refresh()
    const snapshot = service.view.getSnapshot()

    service.close()
    pending.resolve({
      ok: true,
      value: status('available', {
        updateId: 'late-id',
        version: '9.9.9',
      }),
    })
    await refresh

    expect(service.view.getSnapshot()).toBe(snapshot)
    await expect(service.refresh()).rejects.toThrow(/disposed/iu)
  })

  it('rebinds Remote generations and rejects pending work after close', async () => {
    const binding = new OpenloopUpdateRemoteBinding()
    const first = binding.wait()
    binding.fail(new Error('first mount failed'))
    await expect(first).rejects.toThrow('first mount failed')

    const second = binding.wait()
    const unpublish = binding.publish(remote())
    await expect(second).resolves.toBeDefined()
    unpublish()

    const afterUnload = binding.wait()
    binding.close()
    await expect(afterUnload).rejects.toThrow(/disposed/iu)
    await expect(binding.wait()).rejects.toThrow(/disposed/iu)
  })

  it('publishes the update observable before mounting the shared desktop Remote', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    const call = vi.fn<ConnectionHandle['rpc']['call']>(async (
      _path,
      endpoint,
    ) => {
      if (endpoint === 'openloopDesktop/getUpdateStatus') {
        return { ok: true, value: status('idle') }
      }
      throw new Error(`unexpected Remote call ${endpoint}`)
    })
    ctx.provide('connection', { rpc: { call } } as unknown as ConnectionHandle)
    await ctx.plugin(ApiGatewayClient)
    const cleanup = applyClient(ctx)

    const service = ctx.get('openloopUpdates')
    expect(service).toBeInstanceOf(OpenloopUpdateService)
    await service?.refresh()
    expect(service?.view.getSnapshot().phase).toBe('idle')

    await cleanup()
    await expect(service?.refresh()).rejects.toThrow(/disposed/iu)
  })
})
