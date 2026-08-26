import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import LlmRuntime, { INVALID_CREDENTIAL_CODE } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const NS = settingsNamespace('llm-deepseek')
const KEY_REF = credentialRef('DEEPSEEK_API_KEY')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-dynamic-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

interface Harness {
  ctx: Context
  settingsFiber: { dispose(): Promise<void> }
}

/**
 * Real dynamic composition: llm + settings-file + credentials-local +
 * llm-deepseek over one temp harness home. `watch: false` keeps every change
 * flowing through the in-process write path, which is deterministic; external
 * file watching is the providers' own covered concern.
 */
async function boot(
  dir: string,
  config: object,
  credentialConsumers?: object,
): Promise<Harness> {
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)
  const settingsFiber = ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await settingsFiber
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  if (credentialConsumers !== undefined) {
    ctx.provide('credentialConsumers', credentialConsumers as never)
  }
  await ctx.plugin(LlmDeepSeek, config)
  return { ctx, settingsFiber }
}

function prompt(ctx: Context, model = 'deepseek-v4-flash') {
  return assemble(ctx, { model, messages: [] })
}

describe('request-level dynamic configuration', () => {
  it('redacts malformed credential references at startup without retaining a cause', async () => {
    const privateReference = 'sk-live-deepseek-startup-P1/secret'
    const ctx = new Context()
    cleanups.push(async () => {
      await ctx.fiber.dispose()
    })
    await ctx.plugin(LlmRuntime)
    const logged: unknown[][] = []
    ctx.logger.error = ((...args: unknown[]) => { logged.push(args) }) as typeof ctx.logger.error

    const failure = await ctx.plugin(LlmDeepSeek, {
      apiKeyEnv: privateReference,
      baseURL: 'http://127.0.0.1:1',
    }).then(() => undefined, (error: unknown) => error)

    expect(failure).toBeInstanceOf(TypeError)
    expect((failure as Error).message).toBe('llm-deepseek: invalid credential reference')
    expect(Object.hasOwn(failure as object, 'cause')).toBe(false)
    const evidence = inspect([failure, logged], { depth: null, showHidden: true })
    expect(evidence).not.toContain(privateReference)
    expect(evidence).not.toContain('sk-live-deepseek-startup-P1')
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('redacts a malformed dynamic reference and retains the accepted generation and consumer', async () => {
    const privateReference = 'sk-live-deepseek-dynamic-P1/secret'
    const dir = await home()
    const accepted = await mockServer([
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
    ])
    const rotated = await mockServer([{ kind: 'sse', events: textEvents }])
    await writeFile(
      join(dir, '.credentials.yaml'),
      'DEEPSEEK_ACTIVE_KEY: old-key\nDEEPSEEK_ROTATED_KEY: rotated-key\n',
      { mode: 0o600 },
    )
    let activeReference = credentialRef('DEEPSEEK_ACTIVE_KEY')
    const replace = vi.fn((reference: ReturnType<typeof credentialRef>) => {
      activeReference = reference
    })
    const { ctx } = await boot(
      dir,
      { apiKeyEnv: 'DEEPSEEK_ACTIVE_KEY', baseURL: accepted.url },
      {
        registerDeepSeekModel(reference: ReturnType<typeof credentialRef>) {
          activeReference = reference
          return { replace, dispose: vi.fn() }
        },
      },
    )
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)

    await ctx.settings.update(NS, {
      apiKeyEnv: privateReference,
      baseURL: rotated.url,
    })
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalled()
    })

    expect(activeReference).toBe(credentialRef('DEEPSEEK_ACTIVE_KEY'))
    expect(replace).not.toHaveBeenCalled()
    await prompt(ctx)
    expect(accepted.requests).toHaveLength(1)
    expect(rotated.requests).toHaveLength(0)
    const evidence = inspect(logged.mock.calls, { depth: null, showHidden: true })
    expect(evidence).not.toContain(privateReference)
    expect(evidence).not.toContain('sk-live-deepseek-dynamic-P1')
    expect(evidence).not.toContain('cause')

    await ctx.settings.replace(NS, {
      apiKeyEnv: 'DEEPSEEK_ROTATED_KEY',
      baseURL: rotated.url,
    })
    expect(activeReference).toBe(credentialRef('DEEPSEEK_ROTATED_KEY'))
    await prompt(ctx)
    expect(rotated.headers[0]?.authorization).toBe('Bearer rotated-key')
  })

  it('routes the next request with the freshly resolved base URL and credential', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), 'DEEPSEEK_API_KEY: first-key\n', { mode: 0o600 })
    const serverA = await mockServer([{ kind: 'sse', events: textEvents }])
    const serverB = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx } = await boot(dir, { baseURL: serverA.url })

    await prompt(ctx)
    expect(serverA.headers[0]?.authorization).toBe('Bearer first-key')

    await ctx.settings.update(NS, { baseURL: serverB.url })
    await ctx.credentials.set(KEY_REF, 'second-key')

    await prompt(ctx)
    // No restart, no re-registration: the next request resolved both facts.
    expect(serverA.requests).toHaveLength(1)
    expect(serverB.headers[0]?.authorization).toBe('Bearer second-key')
  })

  it('starts keyless and serves the next request once the key arrives', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await home()
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx } = await boot(dir, { baseURL: server.url })

    const keyless = await prompt(ctx)
    expect(keyless.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    await expect(access(join(dir, '.anonymous-user-id'))).rejects.toMatchObject({ code: 'ENOENT' })
    await ctx.credentials.set(KEY_REF, 'sk-arrived')
    await prompt(ctx)
    expect(server.headers[0]?.authorization).toBe('Bearer sk-arrived')
    await expect(access(join(dir, '.anonymous-user-id'))).resolves.toBeUndefined()
  })

  it('rejects a stored credential no header can carry, never echoing it in the failure', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })
    const secret = 'sk-\u{1F600}supersecret'

    // The real credentials seam (the path the web Models page writes through),
    // not a hand-built stub: this package's own dynamic-config harness already
    // boots one, and round-tripping the value through its actual store/read
    // path is stronger evidence than a canned in-memory return would be.
    await ctx.credentials.set(KEY_REF, secret)
    const result = await prompt(ctx)
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: INVALID_CREDENTIAL_CODE } })
    if (result.finish.kind !== 'error') throw new Error('expected an error finish')
    expect(result.finish.failure.message).not.toContain(secret)
    expect(result.finish.failure.message).not.toContain('supersecret')
    expect(result.finish.failure.message).not.toContain('ByteString')
    expect(result.finish.failure.message).not.toContain(String(KEY_REF))
  })

  it('advertises a live settings catalog without re-registration', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })

    await expect(ctx.llm.listModels('deepseek-official')).resolves.toHaveLength(2)
    await ctx.settings.update(NS, { models: [{ id: 'settings-model', name: 'From Settings' }] })
    await expect(ctx.llm.listModels('deepseek-official')).resolves.toEqual([
      { provider: 'deepseek-official', id: 'settings-model', name: 'From Settings', inputModalities: ['text'] },
    ])
  })

  it('re-registers the route in place when the captured retry policy changes, without an empty-registry window', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })

    // Observing the topology event, not just the end state: disposing and
    // re-registering also lands on the right final registry, but publishes an
    // empty route set in between, so an observer sees the provider disappear.
    const observed: string[][] = []
    ctx.on('llm/adapters-updated', () => {
      observed.push(ctx.llm.listProviders().map(provider => provider.id))
    })

    await ctx.settings.update(NS, {
      retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
    })
    expect(ctx.llm.providerRetryPolicy('deepseek-official')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek-official', name: 'DeepSeek' }])
    expect(observed).toEqual([['deepseek-official']])
  })

  it('keeps the accepted serving generation after a refused consumer replacement and advances after revert', async () => {
    const dir = await home()
    const accepted = await mockServer([
      { kind: 'sse', events: textEvents },
    ])
    const desired = await mockServer([
      { kind: 'sse', events: textEvents },
    ])
    await writeFile(
      join(dir, '.credentials.yaml'),
      'DEEPSEEK_ACTIVE_KEY: old-key\nDEEPSEEK_REJECTED_KEY: new-key\n',
      { mode: 0o600 },
    )
    let activeReference = credentialRef('DEEPSEEK_ACTIVE_KEY')
    let rejectReplacement = true
    const replace = vi.fn((reference: ReturnType<typeof credentialRef>) => {
      if (reference === 'DEEPSEEK_REJECTED_KEY' && rejectReplacement) {
        throw new Error('consumer capacity exceeded')
      }
      activeReference = reference
    })
    const { ctx } = await boot(
      dir,
      {
        apiKeyEnv: 'DEEPSEEK_ACTIVE_KEY',
        baseURL: accepted.url,
        models: [{ id: 'served-model', name: 'Accepted', maxTokens: 111 }],
        retryPolicy: { mode: 'normal', maxRetries: 0 },
      },
      {
        registerDeepSeekModel(reference: ReturnType<typeof credentialRef>) {
          activeReference = reference
          return { replace, dispose: vi.fn() }
        },
      },
    )

    const desiredConfig = {
      apiKeyEnv: 'DEEPSEEK_REJECTED_KEY',
      baseURL: desired.url,
      models: [{ id: 'served-model', name: 'Desired', maxTokens: 222 }],
      retryPolicy: { mode: 'normal' as const, maxRetries: 4 },
    }
    await ctx.settings.replace(NS, desiredConfig)
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1)
    })

    expect(activeReference).toBe(credentialRef('DEEPSEEK_ACTIVE_KEY'))
    expect(ctx.llm.providerRetryPolicy('deepseek-official')).toMatchObject({
      mode: 'normal',
      maxRetries: 0,
    })
    await expect(ctx.llm.listModels('deepseek-official')).resolves.toMatchObject([
      { id: 'served-model', name: 'Accepted' },
    ])
    await prompt(ctx, 'served-model')
    expect(accepted.headers[0]?.authorization).toBe('Bearer old-key')
    expect(accepted.requests[0]).toMatchObject({ model: 'served-model', max_tokens: 111 })
    expect(desired.requests).toHaveLength(0)

    await ctx.settings.replace(NS, {})
    expect(activeReference).toBe(credentialRef('DEEPSEEK_ACTIVE_KEY'))
    expect(replace).toHaveBeenCalledTimes(1)

    rejectReplacement = false
    await ctx.settings.replace(NS, desiredConfig)
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(2)
    })

    expect(activeReference).toBe(credentialRef('DEEPSEEK_REJECTED_KEY'))
    expect(ctx.llm.providerRetryPolicy('deepseek-official')).toMatchObject({
      mode: 'normal',
      maxRetries: 4,
    })
    await expect(ctx.llm.listModels('deepseek-official')).resolves.toMatchObject([
      { id: 'served-model', name: 'Desired' },
    ])
    await prompt(ctx, 'served-model')
    expect(desired.headers[0]?.authorization).toBe('Bearer new-key')
    expect(desired.requests[0]).toMatchObject({ model: 'served-model', max_tokens: 222 })
    expect(replace).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good options when a settings snapshot fails beyond-schema validation', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })

    // Schema-valid but resolver-invalid: duplicate catalog ids pass the array
    // schema and fail the explicit resolve step.
    await ctx.settings.update(NS, { models: [{ id: 'dup' }, { id: 'dup' }] })
    await expect(ctx.llm.listModels('deepseek-official')).resolves.toHaveLength(2)
    await ctx.settings.update(NS, { models: [{ id: 'recovered' }] })
    await expect(ctx.llm.listModels('deepseek-official')).resolves.toEqual([
      { provider: 'deepseek-official', id: 'recovered', name: 'recovered', inputModalities: ['text'] },
    ])
  })

  it('keeps the whole last-good snapshot when a rejected one changed the URL', async () => {
    const dir = await home()
    const good = await mockServer([{ kind: 'sse', events: textEvents }])
    const rejected = await mockServer([{ kind: 'sse', events: textEvents }])
    vi.stubEnv('DEEPSEEK_API_KEY', 'good-key')
    const { ctx } = await boot(dir, { baseURL: good.url })

    // One snapshot moves the endpoint and fails the resolve step beyond the
    // schema (duplicate catalog ids).
    await ctx.settings.update(NS, {
      baseURL: rejected.url,
      models: [{ id: 'dup' }, { id: 'dup' }],
    })

    await prompt(ctx)
    // The rejected generation contributes nothing: not its endpoint, and — the
    // regression this pins — not its key either.
    expect(rejected.requests).toHaveLength(0)
    expect(good.requests).toHaveLength(1)
    expect(good.headers[0]?.authorization).toBe('Bearer good-key')
  })

  it('falls back to the composition entry when settings detach', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), 'DEEPSEEK_API_KEY: steady-key\n', { mode: 0o600 })
    const serverA = await mockServer([{ kind: 'sse', events: textEvents }])
    const serverB = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx, settingsFiber } = await boot(dir, { baseURL: serverA.url })

    await ctx.settings.update(NS, { baseURL: serverB.url })
    await prompt(ctx)
    expect(serverB.requests).toHaveLength(1)

    await settingsFiber.dispose()
    await prompt(ctx)
    expect(serverA.requests).toHaveLength(1)
    expect(serverA.headers[0]?.authorization).toBe('Bearer steady-key')
  })
})
