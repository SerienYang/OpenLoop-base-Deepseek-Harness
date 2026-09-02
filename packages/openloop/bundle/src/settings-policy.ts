/** Exact write policy for the Openloop Settings facade. */

interface OpenloopSettingsPathOp {
  readonly op: 'set' | 'unset'
  readonly path: readonly string[]
  readonly value?: unknown
}

export interface OpenloopSettingsMutation {
  readonly ns: string
  readonly ops: readonly OpenloopSettingsPathOp[]
  readonly expectedRevision: number
}

const SIMPLE_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  locale: new Set(['preference']),
  'ui-theme': new Set(['preference']),
  'ui-conversation': new Set(['busyEnter']),
  'agent-loop': new Set(['maxParallelToolCalls']),
  shell: new Set(['timeoutMs', 'maxOutputBytes']),
  'web-search-deepseek': new Set(['maxUses']),
  'llm-deepseek': new Set([
    'thinking',
    'reasoningEffort',
    'maxTokens',
    'defaultContextWindow',
    'streamIdleTimeoutMs',
    'retryPolicy',
    'models',
  ]),
  'ui-onboarding': new Set(['welcomeNoticeVersion']),
}

const PI_AI_FIELDS = new Set([
  'displayName',
  'models',
  'modelOverrides',
  'compat',
  'defaultContextWindow',
  'defaultMaxTokens',
  'defaultInput',
  'streamIdleTimeoutMs',
  'retryPolicy',
])

const NAMESPACES = Object.freeze([
  'locale',
  'ui-theme',
  'ui-conversation',
  'agent-loop',
  'shell',
  'web-search-deepseek',
  'llm-deepseek',
  'llm-pi-ai',
  'ui-onboarding',
])

const FORBIDDEN_VALUE_KEYS = new Set([
  'apiKey',
  'apiKeyEnv',
  'baseURL',
  'credential',
  'credentialRef',
  'credentialMode',
  'credentials',
  'endpoint',
  'secret',
])

interface SerializedSchema {
  readonly uid: number
  readonly refs: Readonly<Record<string, unknown>>
}

function denied(): never {
  throw new Error('SETTINGS_POLICY_DENIED')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertSafeJsonValue(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) denied()
    return
  }
  if (typeof value !== 'object') denied()
  if (seen.has(value)) denied()
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) assertSafeJsonValue(item, seen)
    seen.delete(value)
    return
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) denied()
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_VALUE_KEYS.has(key)) denied()
    assertSafeJsonValue(child, seen)
  }
  seen.delete(value)
}

/** Return the only settings namespaces exposed to the Openloop main WebView. */
export function allowedSettingsNamespaces(): readonly string[] {
  return NAMESPACES
}

export function isAllowedSettingsReadPath(
  namespace: string,
  path: readonly string[],
  builtInProviders: ReadonlySet<string>,
): boolean {
  if (path.some(segment => FORBIDDEN_VALUE_KEYS.has(segment))) return false
  if (namespace !== 'llm-pi-ai') {
    const fields = SIMPLE_FIELDS[namespace]
    return fields !== undefined && path.length > 0 && fields.has(path[0] ?? '')
  }
  if (path[0] !== 'providers') return false
  if (path.length === 1) return true
  const provider = path[1] ?? ''
  if (provider !== '*' && !builtInProviders.has(provider)) return false
  return path.length === 2 || PI_AI_FIELDS.has(path[2] ?? '')
}

function serializedSchema(value: unknown): SerializedSchema | undefined {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.uid)
    || !isRecord(value.refs)
    || !isRecord(value.refs[String(value.uid)])) {
    return undefined
  }
  return value as unknown as SerializedSchema
}

function schemaNode(schema: SerializedSchema, uid: number): Record<string, unknown> | undefined {
  const node = schema.refs[String(uid)]
  return isRecord(node) ? node : undefined
}

function projectDataNode(
  namespace: string,
  value: unknown,
  schema: SerializedSchema | undefined,
  uid: number | undefined,
  path: readonly string[],
  builtInProviders: ReadonlySet<string>,
): unknown {
  if (value === null || typeof value !== 'object') return value
  const node = schema === undefined || uid === undefined ? undefined : schemaNode(schema, uid)
  if (Array.isArray(value)) {
    const inner = typeof node?.inner === 'number' ? node.inner : undefined
    return value.map(entry =>
      projectDataNode(namespace, entry, schema, inner, path, builtInProviders))
  }
  const output: Record<string, unknown> = {}
  const dict = isRecord(node?.dict) ? node.dict : undefined
  const dynamicInner = node?.type === 'dict' && typeof node.inner === 'number'
    ? node.inner
    : undefined
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key]
    if (!isAllowedSettingsReadPath(namespace, childPath, builtInProviders)) continue
    const childUid = dynamicInner
      ?? (typeof dict?.[key] === 'number' ? dict[key] : undefined)
    if (node !== undefined && childUid === undefined) continue
    output[key] = projectDataNode(
      namespace,
      child,
      schema,
      childUid,
      childPath,
      builtInProviders,
    )
  }
  return output
}

/** Project one descriptor data layer to the reviewed readable path matrix. */
export function projectAllowedSettingsData(
  namespace: string,
  value: unknown,
  schemaValue: unknown,
  builtInProviders: ReadonlySet<string>,
): unknown {
  const schema = serializedSchema(schemaValue)
  if (schema === undefined) return {}
  return projectDataNode(
    namespace,
    value,
    schema,
    schema.uid,
    [],
    builtInProviders,
  )
}

/** Project a serialized Schemastery graph to the same readable path matrix. */
export function projectAllowedSettingsSchema(
  namespace: string,
  value: unknown,
  builtInProviders: ReadonlySet<string>,
): unknown {
  const schema = serializedSchema(value)
  if (schema === undefined) return {}
  const refs: Record<string, unknown> = {}
  const visiting = new Set<number>()
  const visit = (uid: number, path: readonly string[]): void => {
    if (visiting.has(uid) || refs[String(uid)] !== undefined) return
    const source = schemaNode(schema, uid)
    if (source === undefined) return
    visiting.add(uid)
    const copy: Record<string, unknown> = { ...source }
    if (isRecord(source.dict)) {
      const dict: Record<string, number> = {}
      for (const [key, child] of Object.entries(source.dict)) {
        const childPath = [...path, key]
        if (typeof child !== 'number'
          || !isAllowedSettingsReadPath(namespace, childPath, builtInProviders)) {
          continue
        }
        dict[key] = child
        visit(child, childPath)
      }
      copy.dict = dict
    }
    if (typeof source.inner === 'number') {
      const childPath = source.type === 'dict' ? [...path, '*'] : path
      visit(source.inner, childPath)
    }
    if (typeof source.sKey === 'number') visit(source.sKey, path)
    if (Array.isArray(source.list)) {
      for (const child of source.list) {
        if (typeof child === 'number') visit(child, path)
      }
    }
    if (isRecord(source.meta) && 'default' in source.meta) {
      copy.meta = {
        ...source.meta,
        default: projectDataNode(
          namespace,
          source.meta.default,
          schema,
          uid,
          path,
          builtInProviders,
        ),
      }
    }
    refs[String(uid)] = copy
    visiting.delete(uid)
  }
  visit(schema.uid, [])
  return { uid: schema.uid, refs }
}

/** Reject any mutation outside the reviewed namespace/path matrix. */
export function assertAllowedSettingsMutation(
  value: OpenloopSettingsMutation,
  builtInProviders: ReadonlySet<string>,
): void {
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) denied()
  const rawOps: unknown = value.ops
  if (!Array.isArray(rawOps) || rawOps.length === 0) denied()

  for (const op of rawOps as unknown[]) {
    if (!isRecord(op)) denied()
    const kind = op['op']
    const rawPath = op['path']
    if ((kind !== 'set' && kind !== 'unset')
      || !Array.isArray(rawPath)
      || rawPath.length === 0
      || rawPath.some(segment => typeof segment !== 'string' || segment.length === 0)) {
      denied()
    }
    const path = rawPath as string[]
    const keys = Object.keys(op).sort()
    if (kind === 'set') {
      if (keys.join(',') !== 'op,path,value') denied()
      assertSafeJsonValue(op['value'])
    } else if (keys.join(',') !== 'op,path') {
      denied()
    }

    if (value.ns === 'llm-pi-ai') {
      if (path.length !== 3
        || path[0] !== 'providers'
        || !builtInProviders.has(path[1] ?? '')
        || !PI_AI_FIELDS.has(path[2] ?? '')) {
        denied()
      }
      continue
    }

    const fields = SIMPLE_FIELDS[value.ns]
    if (fields === undefined || path.length !== 1 || !fields.has(path[0] ?? '')) denied()
  }
}
