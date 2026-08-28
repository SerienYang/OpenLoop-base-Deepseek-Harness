/** Openloop browser runtime assembly and Desktop Bridge Remote mount. */

import type { Context } from '@deepseek-ai/cordis'
import desktopRemote from '@openloop/desktop-bridge-host/remote'
import { OpenloopWorkspaceRuntimeAdapter } from './workspaces.ts'

export {
  OpenloopWorkspaceRuntimeAdapter,
  OpenloopWorkspaceService,
} from './workspaces.ts'
export type {
  OpenloopWorkspaceListState,
  OpenloopWorkspaceRemote,
  OpenloopWorkspaceSessions,
} from './workspaces.ts'

export const inject = ['remote']

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(desktopRemote)
  const adapter = new OpenloopWorkspaceRuntimeAdapter(ctx.remote.openloopDesktop)
  const removeAdapter = ctx.reflect.provide('workspaceRuntimeAdapter', adapter)
  return async () => {
    await removeAdapter()
    await disposeRemote()
  }
}
