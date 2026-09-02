import { describe, expect, it } from 'vitest'
import {
  assertAllowedSettingsMutation,
  allowedSettingsNamespaces,
  projectAllowedSettingsData,
  projectAllowedSettingsSchema,
} from '../src/settings-policy.ts'

describe('Openloop settings policy', () => {
  it('allows the reviewed General and plugin fields', () => {
    expect(() => {
      assertAllowedSettingsMutation({
        ns: 'locale',
        ops: [{ op: 'set', path: ['preference'], value: 'en' }],
        expectedRevision: 3,
      }, new Set())
    }).not.toThrow()
    expect(() => {
      assertAllowedSettingsMutation({
        ns: 'agent-loop',
        ops: [{ op: 'set', path: ['maxParallelToolCalls'], value: 4 }],
        expectedRevision: 1,
      }, new Set())
    }).not.toThrow()
    expect(() => {
      assertAllowedSettingsMutation({
        ns: 'web-search-deepseek',
        ops: [{ op: 'set', path: ['maxUses'], value: 8 }],
        expectedRevision: 2,
      }, new Set())
    }).not.toThrow()
  })

  it('allows model metadata only below a registered built-in provider', () => {
    expect(() => {
      assertAllowedSettingsMutation({
        ns: 'llm-pi-ai',
        ops: [{
          op: 'set',
          path: ['providers', 'volcengine-plan', 'models'],
          value: [{ id: 'doubao-seed-code', input: ['text', 'image'] }],
        }],
        expectedRevision: 7,
      }, new Set(['volcengine-plan']))
    }).not.toThrow()
  })

  it.each([
    { ns: 'unknown', path: ['value'] },
    { ns: 'locale', path: [] },
    { ns: 'locale', path: ['unknown'] },
    { ns: 'web-search-deepseek', path: ['baseURL'] },
    { ns: 'web-search-deepseek', path: ['apiKey'] },
    { ns: 'web-search-deepseek', path: ['apiKeyEnv'] },
    { ns: 'llm-deepseek', path: ['baseURL'] },
    { ns: 'llm-pi-ai', path: ['providers', 'custom', 'models'] },
    { ns: 'llm-pi-ai', path: ['providers', 'volcengine-plan', 'apiKeyEnv'] },
    { ns: 'llm-pi-ai', path: ['providers', 'volcengine-plan', 'credentialMode'] },
  ])('rejects $ns:$path', ({ ns, path }) => {
    expect(() => {
      assertAllowedSettingsMutation({
        ns,
        ops: [{ op: 'set', path, value: 'sentinel' }],
        expectedRevision: 1,
      }, new Set(['volcengine-plan']))
    }).toThrow('SETTINGS_POLICY_DENIED')
  })

  it('requires a finite non-negative revision and a non-empty operation list', () => {
    expect(() => {
      assertAllowedSettingsMutation({
        ns: 'locale',
        ops: [],
        expectedRevision: 0,
      }, new Set())
    }).toThrow('SETTINGS_POLICY_DENIED')
    expect(() => {
      assertAllowedSettingsMutation({
        ns: 'locale',
        ops: [{ op: 'unset', path: ['preference'] }],
        expectedRevision: Number.NaN,
      }, new Set())
    }).toThrow('SETTINGS_POLICY_DENIED')
  })

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    new Date('2026-09-02T00:00:00Z'),
    { nested: undefined },
    1n,
  ])('rejects a non-JSON set value %#', (value) => {
    expect(() => {
      assertAllowedSettingsMutation({
        ns: 'locale',
        ops: [{ op: 'set', path: ['preference'], value }],
        expectedRevision: 1,
      }, new Set())
    }).toThrow('SETTINGS_POLICY_DENIED')
  })

  it('rejects secret-bearing fields attached beside an otherwise allowed operation', () => {
    expect(() => {
      assertAllowedSettingsMutation({
        ns: 'web-search-deepseek',
        ops: [{
          op: 'set',
          path: ['maxUses'],
          value: 7,
          apiKey: 'must-not-cross-the-facade',
        } as never],
        expectedRevision: 1,
      }, new Set())
    }).toThrow('SETTINGS_POLICY_DENIED')
  })

  it('publishes only the reviewed namespace names', () => {
    expect(allowedSettingsNamespaces()).toEqual([
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
  })

  it('recursively projects data to reviewed paths and schema-declared descendants', () => {
    const schema = {
      uid: 6,
      refs: {
        0: { type: 'string', meta: {} },
        1: { type: 'string', meta: {} },
        2: { type: 'object', meta: {}, dict: { id: 0, endpoint: 1 } },
        3: { type: 'array', meta: {}, inner: 2 },
        4: { type: 'object', meta: {}, dict: { models: 3, baseURL: 1, apiKeyEnv: 1 } },
        5: { type: 'dict', meta: {}, inner: 4 },
        6: { type: 'object', meta: {}, dict: { providers: 5, credentials: 1 } },
      },
    }
    const projectedSchema = projectAllowedSettingsSchema(
      'llm-pi-ai',
      schema,
      new Set(['openai']),
    )
    const projectedData = projectAllowedSettingsData(
      'llm-pi-ai',
      {
        providers: {
          openai: {
            models: [{ id: 'gpt-test', endpoint: 'https://secret.invalid', unknown: true }],
            baseURL: 'https://secret.invalid',
            apiKeyEnv: 'OPENAI_API_KEY',
            unknown: true,
          },
          custom: { models: [{ id: 'custom' }] },
        },
        credentials: { token: 'secret' },
      },
      schema,
      new Set(['openai']),
    )

    expect(JSON.stringify(projectedSchema)).not.toMatch(/baseURL|endpoint|credentials|apiKeyEnv/u)
    expect(projectedData).toEqual({
      providers: {
        openai: {
          models: [{ id: 'gpt-test' }],
        },
      },
    })
  })

  it('fails closed when descriptor data has no valid serialized schema', () => {
    expect(projectAllowedSettingsData(
      'llm-pi-ai',
      { providers: { openai: { models: [{ internalEndpoint: 'https://secret.invalid' }] } } },
      {},
      new Set(['openai']),
    )).toEqual({})
  })
})
