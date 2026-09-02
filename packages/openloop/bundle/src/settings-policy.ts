/** Exact write policy for the Openloop Settings facade. */

export interface OpenloopSettingsPathOp {
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
  'credentialMode',
  'secret',
])

function denied(): never {
  throw new Error('SETTINGS_POLICY_DENIED')
}

function assertNoForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenKeys(item)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_VALUE_KEYS.has(key)) denied()
    assertNoForbiddenKeys(child)
  }
}

/** Return the only settings namespaces exposed to the Openloop main WebView. */
export function allowedSettingsNamespaces(): readonly string[] {
  return NAMESPACES
}

/** Reject any mutation outside the reviewed namespace/path matrix. */
export function assertAllowedSettingsMutation(
  value: OpenloopSettingsMutation,
  builtInProviders: ReadonlySet<string>,
): void {
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) denied()
  if (!Array.isArray(value.ops) || value.ops.length === 0) denied()

  for (const op of value.ops) {
    if ((op.op !== 'set' && op.op !== 'unset')
      || !Array.isArray(op.path)
      || op.path.length === 0
      || op.path.some(segment => typeof segment !== 'string' || segment.length === 0)) {
      denied()
    }
    if (op.op === 'set') assertNoForbiddenKeys(op.value)

    if (value.ns === 'llm-pi-ai') {
      if (op.path.length !== 3
        || op.path[0] !== 'providers'
        || !builtInProviders.has(op.path[1] ?? '')
        || !PI_AI_FIELDS.has(op.path[2] ?? '')) {
        denied()
      }
      continue
    }

    const fields = SIMPLE_FIELDS[value.ns]
    if (fields === undefined || op.path.length !== 1 || !fields.has(op.path[0] ?? '')) denied()
  }
}
