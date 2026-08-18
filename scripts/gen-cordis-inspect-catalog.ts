/** Generate model-visible Host/Client Service and Event inspect catalogs. */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { projectCordisCatalog } from '@deepseek-ai/dsh-typert-generator'
import type { CordisCatalogModel, ServiceMethodEntry } from '@deepseek-ai/dsh-typert-generator'
import {
  CORDIS_CONTEXT_SCAN_EXEMPTIONS,
  CORDIS_EVENT_SCAN_EXEMPTIONS,
  CORDIS_INSPECT_POLICY,
} from './cordis-inspect-policy.ts'
import {
  cordisProjectionProblems,
  scanCordisDeclarations,
} from './cordis-inspect-scan.ts'

const root = resolve(import.meta.dirname, '..')
const HOST_OUT = 'packages/extensions/tool-cordis/src/api-catalog.ts'
const CLIENT_OUT = 'packages/extensions/cordis-client-runner/src/client/api-catalog.ts'

const CLIENT_SERVICES: Readonly<Record<string, readonly string[]>> = {
  layout: ['toggleSidebar', 'openDetails', 'closeDetails'],
  locale: ['getLocale', 'getSnapshot', 'subscribe', 'setLocale', 'register', 'bind'],
  sessions: ['open', 'openSubagent', 'setSubagentCatalogOpen', 'refreshSubagents', 'search', 'fork', 'scope', 'binding'],
  slots: ['register', 'inject'],
  theme: ['getTheme', 'setTheme', 'register', 'overrideTokens'],
  workspaces: [
    'connectWorkspace', 'startSession', 'create', 'pickDirectory', 'listDirectory', 'createDirectory',
    'openPath', 'rename', 'delete', 'insertSessionBefore', 'archiveSession',
  ],
}

const CLIENT_EVENTS = new Set([
  'connection/reset',
  'locale/change',
  'slots/changed',
  'theme/change',
])

function methodName(method: ServiceMethodEntry): string | undefined {
  return /^(?:declare\s+)?(?:readonly\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)/.exec(method.signature)?.[1]
}

function clientModel(model: CordisCatalogModel): CordisCatalogModel {
  const problems: string[] = []
  for (const [key, expectedMethods] of Object.entries(CLIENT_SERVICES)) {
    const service = model.services.find(candidate => candidate.key === key)
    if (service === undefined) {
      problems.push(`client service ctx.${key} is absent from the Typert projection.`)
      continue
    }
    const projectedMethods = new Set(
      service.methods.flatMap(method => methodName(method) ?? []),
    )
    for (const method of expectedMethods) {
      if (!projectedMethods.has(method)) {
        problems.push(`client service ctx.${key}.${method} is absent from the Typert projection.`)
      }
    }
  }
  for (const event of CLIENT_EVENTS) {
    if (!model.events.some(candidate => candidate.name === event)) {
      problems.push(`client event '${event}' is absent from the Typert projection.`)
    }
  }
  if (problems.length > 0) {
    throw new Error(`gen-cordis-inspect-catalog: ${problems.length} Client catalog completeness violation(s):\n${problems.map(problem => `  ${problem}`).join('\n')}`)
  }

  return {
    services: model.services.flatMap((service) => {
      const allowed = CLIENT_SERVICES[service.key]
      if (allowed === undefined) return []
      const names = new Set(allowed)
      return [{ ...service, methods: service.methods.filter(method => names.has(methodName(method) ?? '')) }]
    }),
    events: model.events.filter(event => CLIENT_EVENTS.has(event.name)),
  }
}

function hostSource(): string {
  const { projector, model } = projectCordisCatalog(root, CORDIS_INSPECT_POLICY, 'host')
  const problems = cordisProjectionProblems(
    model,
    scanCordisDeclarations(root),
    {
      contextKeys: CORDIS_CONTEXT_SCAN_EXEMPTIONS,
      eventNames: CORDIS_EVENT_SCAN_EXEMPTIONS,
    },
  )
  if (problems.length > 0) {
    throw new Error(`gen-cordis-inspect-catalog: ${problems.length} Host catalog completeness violation(s):\n${problems.map(problem => `  ${problem}`).join('\n')}`)
  }
  return projector.renderRuntimeApi(model)
}

function clientSource(): string {
  const { projector, model } = projectCordisCatalog(root, CORDIS_INSPECT_POLICY, 'client')
  return projector.renderRuntimeApi(clientModel(model))
    .replaceAll('@deepseek-ai/dsh-tool-cordis/api-catalog', '@deepseek-ai/dsh-cordis-client-runner/client/api-catalog')
}

function main(): void {
  const outputs = [
    [HOST_OUT, hostSource()],
    [CLIENT_OUT, clientSource()],
  ] as const

  if (process.argv.includes('--check')) {
    const stale = outputs
      .filter(([path, source]) => {
        try {
          return readFileSync(resolve(root, path), 'utf8') !== source
        } catch {
          return true
        }
      })
      .map(([path]) => path)

    if (stale.length > 0) {
      console.error(`gen-cordis-inspect-catalog: stale runtime catalog(s): ${stale.join(', ')}`)
      process.exitCode = 1
      return
    }
    console.log(`gen-cordis-inspect-catalog: ${outputs.length} runtime catalog(s) are up to date`)
    return
  }

  for (const [path, source] of outputs) {
    const destination = resolve(root, path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, source)
  }
  console.log(`gen-cordis-inspect-catalog: wrote ${outputs.length} runtime catalog(s)`)
}

main()
