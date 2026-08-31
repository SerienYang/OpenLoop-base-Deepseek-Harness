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

  it('lets refresh take over an existing Host check through its final status', async () => {
    const pending = deferred<RemoteResult<OpenloopUpdateStatus>>()
    const checkForUpdate = vi.fn(() => pending.promise)
    const service = new OpenloopUpdateService(remote({
      getUpdateStatus: vi.fn(() => ok(status('checking'))),
      checkForUpdate,
    }))

    const refresh = service.refresh()
    await vi.waitFor(() => {
      expect(checkForUpdate).toHaveBeenCalledOnce()
    })
    expect(service.view.getSnapshot().phase).toBe('checking')

    pending.resolve({
      ok: true,
      value: status('available', {
        updateId: 'host-owned-update-id',
        version: '2.1.0',
      }),
    })
    await refresh

    expect(service.view.getSnapshot()).toMatchObject({
      phase: 'available',
      targetVersion: '2.1.0',
      actions: {
        check: { enabled: true },
        installAndRestart: { enabled: true },
      },
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

  it('does not let a refresh started before install republish availability', async () => {
    const staleStatus = deferred<RemoteResult<OpenloopUpdateStatus>>()
    const installResult = deferred<RemoteResult<'restarting' | 'cancelled'>>()
    const getUpdateStatus = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        value: status('available', {
          updateId: 'install-id',
          version: '2.0.0',
        }),
      })
      .mockReturnValueOnce(staleStatus.promise)
    const service = new OpenloopUpdateService(remote({
      getUpdateStatus,
      installUpdateAndRestart: vi.fn(() => installResult.promise),
    }))
    await service.refresh()

    const staleRefresh = service.refresh()
    const install = service.installUpdateAndRestart()
    staleStatus.resolve({
      ok: true,
      value: status('available', {
        updateId: 'stale-id',
        version: '1.9.0',
      }),
    })
    await staleRefresh

    expect(service.view.getSnapshot()).toMatchObject({
      phase: 'installing',
      actions: {
        check: { enabled: false },
        installAndRestart: { enabled: false, pending: true },
      },
    })

    installResult.resolve({ ok: true, value: 'cancelled' })
    await install
  })

  it('does not start or publish a new refresh during install', async () => {
    const installResult = deferred<RemoteResult<'restarting' | 'cancelled'>>()
    const getUpdateStatus = vi.fn(() => ok(status('available', {
      updateId: 'install-id',
      version: '2.0.0',
    })))
    const service = new OpenloopUpdateService(remote({
      getUpdateStatus,
      installUpdateAndRestart: vi.fn(() => installResult.promise),
    }))
    await service.refresh()

    const install = service.installUpdateAndRestart()
    const refresh = service.refresh()
    await Promise.resolve()

    expect(getUpdateStatus).toHaveBeenCalledOnce()
    expect(service.view.getSnapshot().phase).toBe('installing')

    installResult.resolve({ ok: true, value: 'cancelled' })
    await Promise.all([install, refresh])
    expect(getUpdateStatus).toHaveBeenCalledOnce()
  })

  it('coalesces double-click installs and restores cancellation once', async () => {
    const installResult = deferred<RemoteResult<'restarting' | 'cancelled'>>()
    const installUpdateAndRestart = vi.fn(() => installResult.promise)
    const service = new OpenloopUpdateService(remote({
      getUpdateStatus: vi.fn(() => ok(status('available', {
        updateId: 'single-flight-id',
        version: '2.0.0',
      }))),
      installUpdateAndRestart,
    }))
    await service.refresh()
    const listener = vi.fn()
    const unsubscribe = service.view.subscribe(listener)

    const first = service.installUpdateAndRestart()
    const second = service.installUpdateAndRestart()
    await Promise.resolve()

    expect(installUpdateAndRestart).toHaveBeenCalledExactlyOnceWith('single-flight-id')
    installResult.resolve({ ok: true, value: 'cancelled' })
    await expect(Promise.all([first, second])).resolves.toEqual([
      'cancelled',
      'cancelled',
    ])
    expect(listener).toHaveBeenCalledTimes(2)
    expect(service.view.getSnapshot()).toMatchObject({
      phase: 'available',
      actions: {
        check: { enabled: true },
        installAndRestart: { enabled: true },
      },
    })

    unsubscribe()
  })

  it('keeps install ownership when an older refresh errors before cancellation', async () => {
    const staleStatus = deferred<RemoteResult<OpenloopUpdateStatus>>()
    const installResult = deferred<RemoteResult<'restarting' | 'cancelled'>>()
    const getUpdateStatus = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        value: status('available', {
          updateId: 'install-id',
          version: '2.0.0',
        }),
      })
      .mockReturnValueOnce(staleStatus.promise)
    const service = new OpenloopUpdateService(remote({
      getUpdateStatus,
      installUpdateAndRestart: vi.fn(() => installResult.promise),
    }))
    await service.refresh()

    const staleRefresh = service.refresh()
    const install = service.installUpdateAndRestart()
    staleStatus.resolve({
      ok: false,
      error: {
        code: 'update_failure',
        message: 'stale status failed',
        details: {},
      },
    })
    await expect(staleRefresh).rejects.toThrow('stale status failed')
    expect(service.view.getSnapshot()).toMatchObject({
      phase: 'installing',
      actions: {
        check: { enabled: false },
        installAndRestart: { enabled: false, pending: true },
      },
    })

    installResult.resolve({ ok: true, value: 'cancelled' })
    await expect(install).resolves.toBe('cancelled')
    expect(service.view.getSnapshot()).toMatchObject({
      phase: 'available',
      actions: {
        check: { enabled: true },
        installAndRestart: { enabled: true },
      },
    })
  })

  it('projects a rolled-back Host terminal state while preserving install error propagation', async () => {
    const getUpdateStatus = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        value: status('available', {
          updateId: 'rollback-update-id',
          version: '3.0.0',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: status('rolled-back', {
          version: '3.0.0',
          message: 'The previous version was restored',
        }),
      })
    const service = new OpenloopUpdateService(remote({
      getUpdateStatus,
      installUpdateAndRestart: vi.fn(() => Promise.resolve({
        ok: false as const,
        error: {
          code: 'update_failure',
          message: 'desktop update operation failed',
          details: {},
        },
      })),
    }))
    await service.refresh()

    await expect(service.installUpdateAndRestart()).rejects.toThrow(
      'Openloop update install failed: update_failure: desktop update operation failed',
    )

    expect(getUpdateStatus).toHaveBeenCalledTimes(2)
    expect(service.view.getSnapshot()).toEqual({
      phase: 'rolled-back',
      targetVersion: '3.0.0',
      message: 'The previous version was restored',
      actions: {
        check: { enabled: true },
        installAndRestart: { enabled: false },
      },
    })
  })

  it('lets install failure recovery own the terminal status while refresh waits', async () => {
    const getUpdateStatus = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        value: status('available', {
          updateId: 'racing-update-id',
          version: '3.1.0',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: status('rolled-back', {
          version: '3.1.0',
          message: 'The previous version was restored',
        }),
      })
    const installResult = deferred<RemoteResult<'restarting' | 'cancelled'>>()
    const service = new OpenloopUpdateService(remote({
      getUpdateStatus,
      installUpdateAndRestart: vi.fn(() => installResult.promise),
    }))
    await service.refresh()

    const install = service.installUpdateAndRestart()
    const refresh = service.refresh()
    await Promise.resolve()
    expect(getUpdateStatus).toHaveBeenCalledOnce()
    installResult.resolve({
      ok: false,
      error: {
        code: 'update_failure',
        message: 'desktop update operation failed',
        details: {},
      },
    })

    await expect(install).rejects.toThrow(
      'Openloop update install failed: update_failure: desktop update operation failed',
    )
    await refresh
    expect(getUpdateStatus).toHaveBeenCalledTimes(2)
    expect(service.view.getSnapshot().phase).toBe('rolled-back')

    expect(service.view.getSnapshot()).toEqual({
      phase: 'rolled-back',
      targetVersion: '3.1.0',
      message: 'The previous version was restored',
      actions: {
        check: { enabled: true },
        installAndRestart: { enabled: false },
      },
    })
  })

  it('does not publish install recovery status after lifecycle disposal', async () => {
    const recoveryStatus = deferred<RemoteResult<OpenloopUpdateStatus>>()
    const getUpdateStatus = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        value: status('available', {
          updateId: 'closing-update-id',
          version: '3.2.0',
        }),
      })
      .mockReturnValueOnce(recoveryStatus.promise)
    const service = new OpenloopUpdateService(remote({
      getUpdateStatus,
      installUpdateAndRestart: vi.fn(() => Promise.resolve({
        ok: false as const,
        error: {
          code: 'update_failure',
          message: 'desktop update operation failed',
          details: {},
        },
      })),
    }))
    await service.refresh()

    const install = service.installUpdateAndRestart()
    await vi.waitFor(() => {
      expect(getUpdateStatus).toHaveBeenCalledTimes(2)
    })
    const snapshot = service.view.getSnapshot()
    service.close()
    recoveryStatus.resolve({
      ok: true,
      value: status('rolled-back', {
        version: '3.2.0',
        message: 'The previous version was restored',
      }),
    })

    await expect(install).rejects.toThrow(
      'Openloop update install failed: update_failure: desktop update operation failed',
    )
    expect(service.view.getSnapshot()).toBe(snapshot)
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
