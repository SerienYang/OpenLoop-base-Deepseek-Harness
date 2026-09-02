import { describe, expect, it } from 'vitest'
import {
  assertAllowedSettingsMutation,
  allowedSettingsNamespaces,
} from '../src/settings-policy.ts'

describe('Openloop settings policy', () => {
  it('allows the reviewed General and plugin fields', () => {
    expect(() => assertAllowedSettingsMutation({
      ns: 'locale',
      ops: [{ op: 'set', path: ['preference'], value: 'en' }],
      expectedRevision: 3,
    }, new Set())).not.toThrow()
    expect(() => assertAllowedSettingsMutation({
      ns: 'agent-loop',
      ops: [{ op: 'set', path: ['maxParallelToolCalls'], value: 4 }],
      expectedRevision: 1,
    }, new Set())).not.toThrow()
    expect(() => assertAllowedSettingsMutation({
      ns: 'web-search-deepseek',
      ops: [{ op: 'set', path: ['maxUses'], value: 8 }],
      expectedRevision: 2,
    }, new Set())).not.toThrow()
  })

  it('allows model metadata only below a registered built-in provider', () => {
    expect(() => assertAllowedSettingsMutation({
      ns: 'llm-pi-ai',
      ops: [{
        op: 'set',
        path: ['providers', 'volcengine-plan', 'models'],
        value: [{ id: 'doubao-seed-code', input: ['text', 'image'] }],
      }],
      expectedRevision: 7,
    }, new Set(['volcengine-plan']))).not.toThrow()
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
    expect(() => assertAllowedSettingsMutation({
      ns,
      ops: [{ op: 'set', path, value: 'sentinel' }],
      expectedRevision: 1,
    }, new Set(['volcengine-plan']))).toThrow('SETTINGS_POLICY_DENIED')
  })

  it('requires a finite non-negative revision and a non-empty operation list', () => {
    expect(() => assertAllowedSettingsMutation({
      ns: 'locale',
      ops: [],
      expectedRevision: 0,
    }, new Set())).toThrow('SETTINGS_POLICY_DENIED')
    expect(() => assertAllowedSettingsMutation({
      ns: 'locale',
      ops: [{ op: 'unset', path: ['preference'] }],
      expectedRevision: Number.NaN,
    }, new Set())).toThrow('SETTINGS_POLICY_DENIED')
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
})
