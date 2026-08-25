import type { BrowserApiPolicy } from '@deepseek-ai/dsh-client-connection'

interface PayloadRule {
  readonly required: readonly string[]
  readonly optional: readonly string[]
}

interface TransportRoute {
  readonly method: string
  readonly path: string
}

/** Parsed form of the reviewed OpenLoop browser API manifest. */
export interface BrowserApiPolicyManifest {
  readonly version: 1
  readonly default: 'deny'
  readonly legacyRpcMethods: readonly string[]
  readonly typertRemoteEndpoints: readonly string[]
  readonly payloadRules: Readonly<Record<string, PayloadRule>>
  readonly transportRoutes: readonly TransportRoute[]
}

const TOP_LEVEL_FIELDS = [
  'version',
  'default',
  'legacyRpcMethods',
  'typertRemoteEndpoints',
  'payloadRules',
  'transportRoutes',
] as const
const PAYLOAD_RULE_FIELDS = ['required', 'optional'] as const
const TRANSPORT_ROUTE_FIELDS = ['method', 'path'] as const
const LEGACY_METHOD = /^[A-Za-z0-9_$-]+\.[A-Za-z0-9_$-]+$/u
const TYPERT_ENDPOINT = /^[A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+$/u
const TRANSPORT_PATH = /^\/api\/[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/u
const TRANSPORT_METHODS = new Set(['GET', 'HEAD', 'POST'])

/** Validate and detach an untrusted browser API manifest. */
export function parseBrowserApiPolicyManifest(source: unknown): BrowserApiPolicyManifest {
  const manifest = record(source, 'browser API manifest')
  assertExactFields(manifest, TOP_LEVEL_FIELDS, 'browser API manifest')
  if (manifest.version !== 1) throw new TypeError('browser API manifest version must equal 1')
  if (manifest.default !== 'deny') throw new TypeError('browser API manifest default must equal "deny"')

  const legacyRpcMethods = stringList(manifest.legacyRpcMethods, 'legacyRpcMethods', LEGACY_METHOD)
  const typertRemoteEndpoints = stringList(
    manifest.typertRemoteEndpoints,
    'typertRemoteEndpoints',
    TYPERT_ENDPOINT,
  )
  const legacySet = new Set(legacyRpcMethods)
  const payloadRulesSource = record(manifest.payloadRules, 'payloadRules')
  const payloadRules: Record<string, PayloadRule> = {}
  for (const [method, rawRule] of Object.entries(payloadRulesSource)) {
    if (!legacySet.has(method)) {
      throw new TypeError(`payloadRules contains unknown legacy method ${JSON.stringify(method)}`)
    }
    const rule = record(rawRule, `payloadRules.${method}`)
    assertExactFields(rule, PAYLOAD_RULE_FIELDS, `payloadRules.${method}`)
    const required = stringList(rule.required, `payloadRules.${method}.required`)
    const optional = stringList(rule.optional, `payloadRules.${method}.optional`)
    const overlap = required.find(field => optional.includes(field))
    if (overlap !== undefined) {
      throw new TypeError(`payloadRules.${method} repeats field ${JSON.stringify(overlap)}`)
    }
    payloadRules[method] = Object.freeze({ required, optional })
  }

  if (!Array.isArray(manifest.transportRoutes)) {
    throw new TypeError('transportRoutes must be an array')
  }
  const transportRoutes = manifest.transportRoutes.map((rawRoute, index) => {
    const route = record(rawRoute, `transportRoutes[${String(index)}]`)
    assertExactFields(route, TRANSPORT_ROUTE_FIELDS, `transportRoutes[${String(index)}]`)
    if (typeof route.method !== 'string' || !TRANSPORT_METHODS.has(route.method)) {
      throw new TypeError(`transportRoutes[${String(index)}].method is invalid`)
    }
    if (typeof route.path !== 'string' || !TRANSPORT_PATH.test(route.path)) {
      throw new TypeError(`transportRoutes[${String(index)}].path is invalid`)
    }
    return Object.freeze({ method: route.method, path: route.path })
  })
  assertUnique(
    transportRoutes.map(route => `${route.method} ${route.path}`),
    'transportRoutes',
  )

  return Object.freeze({
    version: 1,
    default: 'deny',
    legacyRpcMethods,
    typertRemoteEndpoints,
    payloadRules: Object.freeze(payloadRules),
    transportRoutes: Object.freeze(transportRoutes),
  })
}

/** Build the immutable deny-by-default policy consumed by every browser boundary. */
export function createBrowserApiPolicy(source: unknown): BrowserApiPolicy {
  const manifest = parseBrowserApiPolicyManifest(source)
  const allowed = new Set([
    ...manifest.legacyRpcMethods,
    ...manifest.typertRemoteEndpoints,
    ...manifest.transportRoutes.map(route => `${route.method} ${route.path}`),
  ])

  return Object.freeze({
    version: 1,
    allowsTarget(method: string): boolean {
      return allowed.has(method)
    },
    allows(method: string, payload: unknown): boolean {
      if (!allowed.has(method)) return false
      const rule = manifest.payloadRules[method]
      if (rule === undefined) return true
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false
      const actual = Reflect.ownKeys(payload)
      if (actual.some(key => typeof key !== 'string')) return false
      const expected = new Set([...rule.required, ...rule.optional])
      if (actual.some(key => !expected.has(key as string))) return false
      return rule.required.every(key => Object.hasOwn(payload, key))
    },
  })
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertExactFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  label: string,
): void {
  const expected = new Set(fields)
  const actual = Reflect.ownKeys(value)
  const unknown = actual.find(key => typeof key !== 'string' || !expected.has(key))
  if (unknown !== undefined) throw new TypeError(`${label} contains unknown field ${JSON.stringify(String(unknown))}`)
  const missing = fields.find(field => !Object.hasOwn(value, field))
  if (missing !== undefined) throw new TypeError(`${label} is missing required field ${JSON.stringify(missing)}`)
}

function stringList(value: unknown, label: string, pattern?: RegExp): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  const entries: string[] = []
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string'
      || entry.length === 0
      || (pattern !== undefined && !pattern.test(entry))) {
      throw new TypeError(`${label} must contain canonical non-empty strings`)
    }
    entries.push(entry)
  }
  assertUnique(entries, label)
  return Object.freeze(entries)
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} must not contain duplicate entries`)
  }
}
