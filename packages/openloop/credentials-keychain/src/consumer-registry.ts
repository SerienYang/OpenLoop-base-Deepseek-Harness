import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'

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

/**
 * Return the collision-safe owner id for one pi-ai route.
 * @param routeId - Built-in model route id.
 * @returns Stable registry owner id.
 */
export function piAiModelOwnerId(routeId: string): string {
  return `model-route:pi-ai:${encodeURIComponent(requiredIdentity(routeId, 'pi-ai route id'))}`
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

/** Optional structural seam consumed by built-in DSH Host plugins. */
export interface CredentialConsumerRegistryLike {
  registerDeepSeekModel(reference: CredentialRef): () => void
  registerPiAiModel(routeId: string, reference: CredentialRef): () => void
  registerDeepSeekWebSearch(reference: CredentialRef): () => void
  registerMcpServer(serverName: string, reference: CredentialRef): () => void
}

/** Host-owned credential usage table. Browser code has no registration surface. */
export class CredentialConsumerRegistry implements CredentialConsumerRegistryLike {
  readonly #registrations = new Map<string, Registration>()

  /**
   * Register the built-in DeepSeek model route.
   * @param reference - Credential reference consumed by the route.
   * @returns Lifecycle disposer.
   */
  registerDeepSeekModel(reference: CredentialRef): () => void {
    return this.#register(reference, {
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
      display: display(CREDENTIAL_CONSUMER_DISPLAY_KEYS.modelRoute, { routeId: route }),
    })
  }

  /**
   * Register the built-in DeepSeek Web Search plugin.
   * @param reference - Credential reference consumed by search.
   * @returns Lifecycle disposer.
   */
  registerDeepSeekWebSearch(reference: CredentialRef): () => void {
    return this.#register(reference, {
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
    const ref = credentialRef(reference)
    const consumers = [...this.#registrations.values()]
      .filter(registration => registration.reference === ref)
      .map(registration => detachedConsumer(registration.consumer))
      .sort((left, right) => left.ownerId < right.ownerId ? -1 : left.ownerId > right.ownerId ? 1 : 0)
    return Object.freeze({
      reference: ref,
      consumers: Object.freeze(consumers),
    })
  }

  #register(reference: CredentialRef, consumer: CredentialConsumer): () => void {
    const ref = credentialRef(reference)
    const key = consumer.ownerId
    if (this.#registrations.has(key)) {
      throw new Error(`credential consumer ${JSON.stringify(consumer.ownerId)} is already registered`)
    }
    const token = {}
    this.#registrations.set(key, {
      reference: ref,
      consumer: detachedConsumer(consumer),
      token,
    })
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

function requiredIdentity(value: string, label: string): string {
  if (value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}
