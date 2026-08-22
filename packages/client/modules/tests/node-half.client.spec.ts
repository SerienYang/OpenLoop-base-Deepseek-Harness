/** Node-half composition diagnostics for package metadata and built client bundles. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebServer, WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { ClientModuleRegistry } from '../src/index.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** Create a resolvable package whose client export points at the returned path. */
function writePackage(
  packageName: string,
  metadata: Record<string, unknown> = { dsh: { client: { platform: 'web' } } },
): string {
  root ??= realpathSync(mkdtempSync(join(tmpdir(), 'dsh-client-modules-')))
  return writePackageAt(root, packageName, metadata)
}

function writePackageAt(
  moduleRoot: string,
  packageName: string,
  metadata: Record<string, unknown> = { dsh: { client: { platform: 'web' } } },
): string {
  const pkgRoot = join(moduleRoot, 'node_modules', ...packageName.split('/'))
  const clientPath = join(pkgRoot, 'lib', 'client.js')
  mkdirSync(pkgRoot, { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
    name: packageName,
    exports: {
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    ...metadata,
  }))
  return clientPath
}

/** Construct the node-half service and capture its plugin-bundle route. */
function constructWithRoute(
  packageNames: string[],
  installationBaseUrl?: string,
): { service: ClientModuleRegistry; route: WebRoute } {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root!).href + '/'
  ctx.provide('loader', {
    *entries() {
      for (const packageName of packageNames) {
        yield { options: { name: packageName }, fiber: {}, disabled: false }
      }
    },
  })
  let route: WebRoute | undefined
  const webServer: Pick<WebServer, 'port' | 'register' | 'tapIndex'> = {
    port: 0,
    register: (candidate) => {
      if (candidate.path === '/plugins') route = candidate
      return () => {}
    },
    tapIndex: () => () => {},
  }
  ctx.provide('webServer', webServer as WebServer)
  const service = new ClientModuleRegistry(ctx, installationBaseUrl)
  if (route === undefined) throw new Error('client bundle route was not registered')
  return { service, route }
}

/** Construct the node-half service over the enabled fixture entries. */
function construct(packageNames: string[], installationBaseUrl?: string): ClientModuleRegistry {
  return constructWithRoute(packageNames, installationBaseUrl).service
}

describe('client bundle activation', () => {
  it('falls back to installation metadata when the profile cannot resolve an in-box package', () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-client-modules-profile-')))
    const installationRoot = join(root, 'installation')
    const packageName = '@fixture/installation-client'
    const clientPath = writePackageAt(installationRoot, packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const profileRequire = createRequire(pathToFileURL(root).href + '/')
    const installationBaseUrl = pathToFileURL(join(installationRoot, 'anchor.js')).href

    expect(() => profileRequire.resolve(`${packageName}/package.json`)).toThrow()
    expect(construct([packageName], installationBaseUrl).graph().entries.map(entry => entry.id))
      .toEqual([packageName])
  })

  it('prefers profile metadata when both anchors contain the same package', () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-client-modules-profile-')))
    const installationRoot = join(root, 'installation')
    const packageName = '@fixture/profile-override'
    const profileClientPath = writePackageAt(root, packageName)
    writePackageAt(installationRoot, packageName, {
      dsh: { client: { platform: 'node' } },
    })
    mkdirSync(dirname(profileClientPath), { recursive: true })
    writeFileSync(profileClientPath, 'module.exports = {}\n')
    const installationBaseUrl = pathToFileURL(join(installationRoot, 'anchor.js')).href

    expect(construct([packageName], installationBaseUrl).graph().entries.map(entry => entry.id))
      .toEqual([packageName])
  })

  it('keeps an entry out when neither anchor can resolve its package', () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-client-modules-profile-')))
    const installationRoot = join(root, 'installation')
    mkdirSync(installationRoot)
    const installationBaseUrl = pathToFileURL(join(installationRoot, 'anchor.js')).href

    expect(construct(['@fixture/missing'], installationBaseUrl).graph().entries).toEqual([])
  })

  it('allows sibling dsh roles', () => {
    const currentName = '@fixture/current-client-field'
    const clientPath = writePackage(currentName, {
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
        profile: { bundles: [] },
      },
    })
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    expect(construct([currentName]).graph().entries.map(entry => entry.id)).toEqual([currentName])
  })

  it('groups missing bundles under one source-build instruction with a package/path list', () => {
    const firstName = '@fixture/missing-first'
    const secondName = '@fixture/missing-second'
    const firstPath = writePackage(firstName)
    const secondPath = writePackage(secondName)
    expect(() => construct([firstName, secondName])).toThrow([
      'client-modules: 2 client packages failed to compose:',
      '  client bundles not found; run `pnpm run build` before launch:',
      `    - package: ${firstName}`,
      `      path: ${firstPath}`,
      `    - package: ${secondName}`,
      `      path: ${secondPath}`,
    ].join('\n'))
  })

  it('does not report other bundle read failures as missing builds', () => {
    const packageName = '@fixture/unreadable-client'
    const clientPath = writePackage(packageName)
    mkdirSync(clientPath, { recursive: true })
    let thrown: unknown
    try {
      construct([packageName])
    } catch (error) {
      thrown = error
    }
    expect(String(thrown)).toContain('client-modules: 1 client package failed to compose:')
    expect(String(thrown)).toContain('  other failures:')
    expect(String(thrown)).toContain('EISDIR')
    expect(String(thrown)).not.toContain('pnpm run build')
  })

  it('serves the source map beside a registered client bundle', async () => {
    const packageName = '@fixture/source-map'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const map = '{"version":3,"sources":["src/client/index.tsx"]}\n'
    writeFileSync(`${clientPath}.map`, map)
    const { route } = constructWithRoute([packageName])
    let status = 0
    let headers: Record<string, string> | undefined
    let body = ''
    const response = {
      writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
        status = nextStatus
        headers = nextHeaders
        return response
      },
      end(chunk?: Uint8Array) {
        body = chunk === undefined ? '' : Buffer.from(chunk).toString('utf8')
        return response
      },
    } as unknown as ServerResponse

    await route.handler({
      method: 'GET',
      url: `/plugins/${packageName}/client.js.map`,
    } as IncomingMessage, response)

    expect(status).toBe(200)
    expect(headers).toEqual({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
    })
    expect(body).toBe(map)
  })
})
