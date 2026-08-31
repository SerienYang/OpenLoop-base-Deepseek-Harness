/** Openloop browser runtime assembly and Desktop Bridge Remote mount. */

import type { Context } from '@deepseek-ai/cordis'
import desktopRemote from '@openloop/desktop-bridge-host/remote'
import {
  OpenloopUpdateRemoteBinding,
  OpenloopUpdateService,
} from './update.ts'
import type { OpenloopUpdateRemote } from './update.ts'
import { OpenloopWorkspaceRuntimeAdapter } from './workspaces.ts'
import type { OpenloopWorkspaceRemote } from './workspaces.ts'

export {
  OpenloopUpdateRemoteBinding,
  OpenloopUpdateService,
} from './update.ts'
export type {
  OpenloopUpdateRemote,
  OpenloopUpdateRemoteSource,
  OpenloopUpdateState,
  OpenloopUpdateStatus,
  UpdateActionView,
  UpdateView,
} from './update.ts'
export {
  OpenloopWorkspaceRuntimeAdapter,
  OpenloopWorkspaceService,
} from './workspaces.ts'
export type {
  OpenloopWorkspaceListState,
  OpenloopWorkspaceRemote,
  OpenloopWorkspaceRemoteSource,
  OpenloopWorkspaceSessions,
} from './workspaces.ts'

export const inject: string[] = []

interface RemoteDeferred {
  readonly promise: Promise<OpenloopWorkspaceRemote>
  readonly resolve: (value: OpenloopWorkspaceRemote) => void
  readonly reject: (reason: unknown) => void
}

function remoteDeferred(): RemoteDeferred {
  const value = Promise.withResolvers<OpenloopWorkspaceRemote>()
  void value.promise.catch(() => {})
  return value
}

/** Generation-aware Remote binding for Cordis service replacement and HMR. */
export class OpenloopWorkspaceRemoteBinding {
  private current = remoteDeferred()
  private closed: Error | undefined

  wait(): Promise<OpenloopWorkspaceRemote> {
    return this.closed === undefined
      ? this.current.promise
      : Promise.reject(this.closed)
  }

  publish(remote: OpenloopWorkspaceRemote): () => void {
    if (this.closed !== undefined) return () => {}
    const generation = this.current
    generation.resolve(remote)
    let active = true
    return () => {
      if (!active || this.closed !== undefined || this.current !== generation) return
      active = false
      this.current = remoteDeferred()
    }
  }

  fail(reason: unknown): void {
    if (this.closed !== undefined) return
    const generation = this.current
    this.current = remoteDeferred()
    generation.reject(reason)
  }

  close(): void {
    if (this.closed !== undefined) return
    this.closed = new Error('Openloop Workspace Remote binding was disposed')
    this.current.reject(this.closed)
  }
}

export function apply(ctx: Context): () => Promise<void> {
  const binding = new OpenloopWorkspaceRemoteBinding()
  const updateBinding = new OpenloopUpdateRemoteBinding()
  const updates = new OpenloopUpdateService(() => updateBinding.wait())
  const adapter = new OpenloopWorkspaceRuntimeAdapter(() => binding.wait())
  const removeAdapter = ctx.reflect.provide('workspaceRuntimeAdapter', adapter)
  const removeUpdates = ctx.reflect.provide('openloopUpdates', updates)
  const remoteFiber = ctx.inject(['remote'], async (remoteCtx) => {
    try {
      const disposeRemote = await remoteCtx.remote.$mount(desktopRemote)
      const namespaceFiber = remoteCtx.inject(
        ['remote', 'remote.openloopDesktop'],
        (namespaceCtx) => {
          const remote = namespaceCtx.remote.openloopDesktop as unknown as
            OpenloopWorkspaceRemote & OpenloopUpdateRemote
          const disposeWorkspace = binding.publish(remote)
          const disposeUpdate = updateBinding.publish(remote)
          return () => {
            disposeUpdate()
            disposeWorkspace()
          }
        },
      )
      return async () => {
        await namespaceFiber.dispose()
        await disposeRemote()
      }
    } catch (error) {
      binding.fail(error)
      updateBinding.fail(error)
      throw error
    }
  })
  return async () => {
    await removeAdapter()
    await removeUpdates()
    updates.close()
    updateBinding.close()
    binding.close()
    await remoteFiber.dispose()
  }
}
