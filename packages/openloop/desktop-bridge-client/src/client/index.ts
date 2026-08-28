/** Openloop browser runtime assembly and Desktop Bridge Remote mount. */

import type { Context } from '@deepseek-ai/cordis'
import desktopRemote from '@openloop/desktop-bridge-host/remote'
import { OpenloopWorkspaceRuntimeAdapter } from './workspaces.ts'
import type { OpenloopWorkspaceRemote } from './workspaces.ts'

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

export function apply(ctx: Context): () => Promise<void> {
  const ready = Promise.withResolvers<OpenloopWorkspaceRemote>()
  void ready.promise.catch(() => {})
  const adapter = new OpenloopWorkspaceRuntimeAdapter(() => ready.promise)
  const removeAdapter = ctx.reflect.provide('workspaceRuntimeAdapter', adapter)
  const remoteFiber = ctx.inject(['remote'], async (remoteCtx) => {
    try {
      const disposeRemote = await remoteCtx.remote.$mount(desktopRemote)
      ready.resolve(remoteCtx.remote.openloopDesktop)
      return disposeRemote
    } catch (error) {
      ready.reject(error)
      throw error
    }
  })
  return async () => {
    await removeAdapter()
    await remoteFiber.dispose()
  }
}
