import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { createHash } from 'node:crypto'
import {
  MAX_CREDENTIAL_CONSUMERS,
  MAX_CREDENTIAL_CONSUMER_FIELD_BYTES,
  MAX_CREDENTIAL_DELETION_PLAN_BYTES,
  openloopCredentialRef,
} from './limits.ts'

export {
  MAX_CREDENTIAL_CONSUMERS,
  MAX_CREDENTIAL_CONSUMER_FIELD_BYTES,
  MAX_CREDENTIAL_DELETION_PLAN_BYTES,
} from './limits.ts'

/** Localization keys owned by the Host credential confirmation UI. */
export const CREDENTIAL_CONSUMER_DISPLAY_KEYS = Object.freeze({
  modelRoute: 'openloop.credentials.consumer.model-route',
  deepseekWebSearch: 'openloop.credentials.consumer.web-search-deepseek',
  mcpServer: 'openloop.credentials.consumer.mcp-server',
})

/** Stable owner id for the built-in DeepSeek model route. */
export const DEEPSEEK_MODEL_OWNER_ID = 'model-route:deepseek-official'
/** Stable owner id for the built-in DeepSeek Web Search plugin. */
export const DEEPSEEK_WEB_SEARCH_OWNER_ID = 'plugin:web-search-deepseek'

const PI_AI_OWNER_PREFIX = 'model-route:pi-ai:sha256:'
const DISPLAY_DIGEST_HEX_LENGTH = 12
const utf8Encoder = new TextEncoder()

/**
 * Return the collision-safe owner id for one pi-ai route.
 * @param routeId - Built-in model route id.
 * @returns Stable registry owner id.
 */
export function piAiModelOwnerId(routeId: string): string {
  const route = requiredIdentity(routeId, 'pi-ai route id')
  return `${PI_AI_OWNER_PREFIX}${createHash('sha256').update(route, 'utf8').digest('hex')}`
}

/**
 * Return the collision-safe owner id for one MCP server instance.
 * @param serverName - Configured MCP server namespace.
 * @returns Stable registry owner id.
 */
export function mcpServerOwnerId(serverName: string): string {
  return `plugin:mcp-client:${encodeURIComponent(requiredIdentity(serverName, 'MCP server name'))}`
}

/** Localizable display descriptor passed to native confirmation. */
export interface CredentialConsumerDisplay {
  readonly key: string
  readonly values: Readonly<Record<string, string>>
}

/** One built-in Host consumer of a credential reference. */
export interface CredentialConsumer {
  readonly ownerId: string
  readonly kind: 'model-route' | 'plugin'
  readonly display: CredentialConsumerDisplay
}

/** Host-derived immutable input to native deletion confirmation. */
export interface CredentialDeletionPlan {
  readonly reference: CredentialRef
  readonly consumers: readonly CredentialConsumer[]
}

interface Registration {
  readonly consumer: CredentialConsumer
  readonly reference: CredentialRef
  readonly token: object
}

/** One pi-ai route/reference pair in an atomic consumer registration. */
export interface PiAiCredentialConsumer {
  readonly routeId: string
  readonly reference: CredentialRef
}

/** Mutable ownership handle for one atomically replaceable consumer batch. */
export interface CredentialConsumerBatchRegistration {
  replace(consumers: readonly PiAiCredentialConsumer[]): void
  dispose(): void
}

/** Mutable ownership handle for one atomically replaceable consumer. */
export interface CredentialConsumerRegistration {
  replace(reference: CredentialRef): void
  dispose(): void
}

/** Optional structural seam consumed by built-in DSH Host plugins. */
export interface CredentialConsumerRegistryLike {
  /**
   * Register the built-in DeepSeek model route as a credential consumer.
   * @param reference - Credential reference used by the route.
   * @returns Atomic replacement and lifecycle handle.
   */
  registerDeepSeekModel(reference: CredentialRef): CredentialConsumerRegistration
  /**
   * Register one pi-ai model route without exposing credential values.
   * @param routeId - Exact model route identifier.
   * @param reference - Credential reference used by the route.
   * @returns Lifecycle disposer.
   */
  registerPiAiModel(routeId: string, reference: CredentialRef): () => void
  /**
   * Register a validated pi-ai route set as one replaceable unit.
   * @param consumers - Complete route-to-reference ownership set.
   * @returns Atomic replacement and lifecycle handle.
   */
  registerPiAiModels(consumers: readonly PiAiCredentialConsumer[]): CredentialConsumerBatchRegistration
  /**
   * Register the built-in DeepSeek Web Search plugin as a credential consumer.
   * @param reference - Credential reference used by the plugin.
   * @returns Atomic replacement and lifecycle handle.
   */
  registerDeepSeekWebSearch(reference: CredentialRef): CredentialConsumerRegistration
  /**
   * Register one named MCP server as a credential consumer.
   * @param serverName - Configured MCP server namespace.
   * @param reference - Credential reference used by the server.
   * @returns Lifecycle disposer.
   */
  registerMcpServer(serverName: string, reference: CredentialRef): () => void
}

/** Host-owned credential usage table. Browser code has no registration surface. */
export class CredentialConsumerRegistry implements CredentialConsumerRegistryLike {
  readonly #registrations = new Map<string, Registration>()

  /**
   * Register the built-in DeepSeek model route.
   * @param reference - Credential reference consumed by the route.
   * @returns Atomic replacement and lifecycle handle.
   */
  registerDeepSeekModel(reference: CredentialRef): CredentialConsumerRegistration {
    return this.#registerReplaceable(reference, {
      ownerId: DEEPSEEK_MODEL_OWNER_ID,
      kind: 'model-route',
      display: display(CREDENTIAL_CONSUMER_DISPLAY_KEYS.modelRoute, {
        routeId: 'deepseek-official',
      }),
    })
  }

  /**
   * Register one pi-ai model route.
   * @param routeId - Exact route id.
   * @param reference - Credential reference consumed by the route.
   * @returns Lifecycle disposer.
   */
  registerPiAiModel(routeId: string, reference: CredentialRef): () => void {
    const route = requiredIdentity(routeId, 'pi-ai route id')
    return this.#register(reference, {
      ownerId: piAiModelOwnerId(route),
      kind: 'model-route',
      display: display(CREDENTIAL_CONSUMER_DISPLAY_KEYS.modelRoute, {
        routeId: boundedDisplayIdentity(route),
      }),
    })
  }

  /**
   * Register all credential-bearing pi-ai routes as one replaceable unit.
   * Every candidate is validated before the live map changes.
   * @param consumers - Complete desired route/reference set.
   * @returns Atomic replacement and lifecycle handle.
   */
  registerPiAiModels(
    consumers: readonly PiAiCredentialConsumer[],
  ): CredentialConsumerBatchRegistration {
    const token = {}
    let keys = new Set<string>()
    let active = true
    const replace = (next: readonly PiAiCredentialConsumer[]): void => {
      if (!active) throw new Error('credential consumer batch is disposed')
      const candidates = new Map<string, Registration>()
      for (const { routeId, reference } of next) {
        const route = requiredIdentity(routeId, 'pi-ai route id')
        const consumer = detachedConsumer({
          ownerId: piAiModelOwnerId(route),
          kind: 'model-route',
          display: display(CREDENTIAL_CONSUMER_DISPLAY_KEYS.modelRoute, {
            routeId: boundedDisplayIdentity(route),
          }),
        })
        const key = consumer.ownerId
        if (candidates.has(key)) {
          throw new Error(`credential consumer ${JSON.stringify(key)} is duplicated`)
        }
        const existing = this.#registrations.get(key)
        if (existing !== undefined && existing.token !== token) {
          throw new Error(`credential consumer ${JSON.stringify(key)} is already registered`)
        }
        candidates.set(key, {
          reference: openloopCredentialRef(reference),
          consumer,
          token,
        })
      }
      const candidateState = new Map(this.#registrations)
      for (const key of keys) {
        if (candidateState.get(key)?.token === token) candidateState.delete(key)
      }
      for (const [key, registration] of candidates) {
        candidateState.set(key, registration)
      }
      validateRegistryState(candidateState)
      for (const key of keys) {
        if (this.#registrations.get(key)?.token === token) this.#registrations.delete(key)
      }
      for (const [key, registration] of candidates) {
        this.#registrations.set(key, registration)
      }
      keys = new Set(candidates.keys())
    }
    replace(consumers)
    return {
      replace,
      dispose: () => {
        if (!active) return
        active = false
        for (const key of keys) {
          if (this.#registrations.get(key)?.token === token) this.#registrations.delete(key)
        }
        keys.clear()
      },
    }
  }

  /**
   * Register the built-in DeepSeek Web Search plugin.
   * @param reference - Credential reference consumed by search.
   * @returns Atomic replacement and lifecycle handle.
   */
  registerDeepSeekWebSearch(reference: CredentialRef): CredentialConsumerRegistration {
    return this.#registerReplaceable(reference, {
      ownerId: DEEPSEEK_WEB_SEARCH_OWNER_ID,
      kind: 'plugin',
      display: display(CREDENTIAL_CONSUMER_DISPLAY_KEYS.deepseekWebSearch),
    })
  }

  /**
   * Register one HTTP MCP server.
   * @param serverName - Exact configured server namespace.
   * @param reference - Credential reference consumed by its HTTP headers.
   * @returns Lifecycle disposer.
   */
  registerMcpServer(serverName: string, reference: CredentialRef): () => void {
    const server = requiredIdentity(serverName, 'MCP server name')
    return this.#register(reference, {
      ownerId: mcpServerOwnerId(server),
      kind: 'plugin',
      display: display(CREDENTIAL_CONSUMER_DISPLAY_KEYS.mcpServer, { serverName: server }),
    })
  }

  /**
   * Derive a fresh deterministic snapshot for native confirmation.
   * @param reference - Credential reference selected by the browser action.
   * @returns Frozen plan containing only Host-registered consumers.
   */
  planDeletion(reference: CredentialRef): CredentialDeletionPlan {
    return deletionPlan(this.#registrations, openloopCredentialRef(reference))
  }

  #registerReplaceable(
    reference: CredentialRef,
    source: CredentialConsumer,
  ): CredentialConsumerRegistration {
    const consumer = detachedConsumer(source)
    const key = consumer.ownerId
    const token = {}
    let active = true
    const replace = (next: CredentialRef): void => {
      if (!active) throw new Error('credential consumer registration is disposed')
      const existing = this.#registrations.get(key)
      if (existing !== undefined && existing.token !== token) {
        throw new Error(`credential consumer ${JSON.stringify(key)} is already registered`)
      }
      const registration = {
        reference: openloopCredentialRef(next),
        consumer,
        token,
      }
      const candidateState = new Map(this.#registrations)
      candidateState.set(key, registration)
      validateRegistryState(candidateState)
      this.#registrations.set(key, registration)
    }
    replace(reference)
    return {
      replace,
      dispose: () => {
        if (!active) return
        active = false
        if (this.#registrations.get(key)?.token === token) this.#registrations.delete(key)
      },
    }
  }

  #register(reference: CredentialRef, consumer: CredentialConsumer): () => void {
    const ref = openloopCredentialRef(reference)
    const key = consumer.ownerId
    if (this.#registrations.has(key)) {
      throw new Error(`credential consumer ${JSON.stringify(consumer.ownerId)} is already registered`)
    }
    const token = {}
    const registration = {
      reference: ref,
      consumer: detachedConsumer(consumer),
      token,
    }
    const candidateState = new Map(this.#registrations)
    candidateState.set(key, registration)
    validateRegistryState(candidateState)
    this.#registrations.set(key, registration)
    return () => {
      if (this.#registrations.get(key)?.token === token) this.#registrations.delete(key)
    }
  }
}

function display(
  key: string,
  values: Readonly<Record<string, string>> = {},
): CredentialConsumerDisplay {
  return Object.freeze({ key, values: Object.freeze({ ...values }) })
}

function detachedConsumer(consumer: CredentialConsumer): CredentialConsumer {
  return Object.freeze({
    ownerId: consumer.ownerId,
    kind: consumer.kind,
    display: display(consumer.display.key, consumer.display.values),
  })
}

function deletionPlan(
  registrations: ReadonlyMap<string, Registration>,
  reference: CredentialRef,
): CredentialDeletionPlan {
  const consumers = [...registrations.values()]
    .filter(registration => registration.reference === reference)
    .map(registration => detachedConsumer(registration.consumer))
    .sort((left, right) => left.ownerId < right.ownerId ? -1 : left.ownerId > right.ownerId ? 1 : 0)
  return Object.freeze({
    reference,
    consumers: Object.freeze(consumers),
  })
}

function validateRegistryState(registrations: ReadonlyMap<string, Registration>): void {
  const references = new Set<CredentialRef>()
  for (const registration of registrations.values()) references.add(registration.reference)
  for (const reference of references) {
    const plan = deletionPlan(registrations, reference)
    if (plan.consumers.length > MAX_CREDENTIAL_CONSUMERS
      || plan.consumers.some(consumer => !nativeCompatibleConsumer(consumer))
      || utf8Encoder.encode(JSON.stringify(plan)).byteLength > MAX_CREDENTIAL_DELETION_PLAN_BYTES) {
      throw new Error('credential consumer registry capacity exceeded')
    }
  }
}

function nativeCompatibleConsumer(consumer: CredentialConsumer): boolean {
  if (!boundedField(consumer.ownerId) || !/^[\x20-\x7e]+$/u.test(consumer.ownerId)) return false
  const entries = Object.entries(consumer.display.values)
  switch (consumer.display.key) {
    case CREDENTIAL_CONSUMER_DISPLAY_KEYS.modelRoute:
      if (entries.length !== 1 || entries[0]?.[0] !== 'routeId') return false
      break
    case CREDENTIAL_CONSUMER_DISPLAY_KEYS.deepseekWebSearch:
      if (entries.length !== 0) return false
      break
    case CREDENTIAL_CONSUMER_DISPLAY_KEYS.mcpServer:
      if (entries.length !== 1 || entries[0]?.[0] !== 'serverName') return false
      break
    default:
      return false
  }
  return entries.every(([, value]) => boundedField(value) && !/\p{Cc}/u.test(value))
}

function boundedField(value: string): boolean {
  return value.length > 0
    && value.isWellFormed()
    && utf8Encoder.encode(value).byteLength <= MAX_CREDENTIAL_CONSUMER_FIELD_BYTES
}

function requiredIdentity(value: string, label: string): string {
  if (value.length === 0 || value.length > 256 || !value.isWellFormed() || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

/**
 * Preserve a Host display identity exactly when it fits the native deletion
 * plan, or retain a readable prefix plus a route-specific digest when UTF-8
 * expansion would exceed the shared byte limit.
 */
function boundedDisplayIdentity(value: string): string {
  if (utf8Encoder.encode(value).byteLength <= MAX_CREDENTIAL_CONSUMER_FIELD_BYTES) return value
  const suffix = `...#${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, DISPLAY_DIGEST_HEX_LENGTH)}`
  const prefixBudget = MAX_CREDENTIAL_CONSUMER_FIELD_BYTES - suffix.length
  let prefix = ''
  let prefixBytes = 0
  for (const character of value) {
    const characterBytes = utf8Encoder.encode(character).byteLength
    if (prefixBytes + characterBytes > prefixBudget) break
    prefix += character
    prefixBytes += characterBytes
  }
  return `${prefix}${suffix}`
}
