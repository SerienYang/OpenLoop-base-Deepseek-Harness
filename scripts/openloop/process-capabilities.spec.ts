import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectOpenLoopProcessProfileViolations } from '../check-workspace-constraints.ts'

const roots: string[] = []
const repositoryRoot = resolve(import.meta.dirname, '../..')

function write(root: string, path: string, content: string): void {
  const target = join(root, path)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content)
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'openloop-process-profile-'))
  roots.push(root)
  write(root, 'packages/bundle/base/cordis.patch.yml', [
    '- insert:',
    '    - id: subprocess',
    "      name: '@deepseek-ai/dsh-subprocess-local'",
    '    - id: agent-presets',
    "      name: '@deepseek-ai/dsh-agent-presets'",
    '',
  ].join('\n'))
  write(root, 'packages/bundle/web-app/cordis.patch.yml', '[]\n')
  write(root, 'packages/openloop/bundle/cordis.patch.yml', [
    '- id: subprocess',
    '  disabled: true',
    '- id: agent-presets',
    '  config:',
    '    default: standard',
    '    allowedPresetIds: [standard]',
    '    includeUserRoot: false',
    '    patches:',
    '      - id: tool-bash',
    '        disabled: true',
    '',
  ].join('\n'))
  write(root, 'apps/cli/config/agent-presets/standard/agent.cordis.yml', [
    '- id: tool-bash',
    "  name: '@deepseek-ai/dsh-tool-bash'",
    '',
  ].join('\n'))
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Openloop process profile constraints', () => {
  it('accepts the checked-in fail-closed profile and allowed presets', () => {
    expect(collectOpenLoopProcessProfileViolations(repositoryRoot)).toEqual([])
  })

  it('rejects an enabled Host process provider', () => {
    const root = fixture()
    write(root, 'packages/openloop/bundle/cordis.patch.yml', [
      '- id: agent-presets',
      '  config:',
      '    default: standard',
      '    allowedPresetIds: [standard]',
      '    includeUserRoot: false',
      '    patches:',
      '      - id: tool-bash',
      '        disabled: true',
      '',
    ].join('\n'))

    expect(collectOpenLoopProcessProfileViolations(root))
      .toContain('Openloop profile: process row "subprocess" (@deepseek-ai/dsh-subprocess-local) must be disabled')
  })

  it('fails closed when a required profile patch is missing', () => {
    const root = fixture()
    rmSync(join(root, 'packages/openloop/bundle/cordis.patch.yml'))

    expect(collectOpenLoopProcessProfileViolations(root)).toEqual([
      'packages/openloop/bundle/cordis.patch.yml: required Openloop process-policy input is missing',
    ])
  })

  it('rejects a renamed process tool in an allowed preset', () => {
    const root = fixture()
    write(root, 'apps/cli/config/agent-presets/standard/agent.cordis.yml', [
      '- id: renamed-shell',
      "  name: '@deepseek-ai/dsh-tool-bash'",
      '',
    ].join('\n'))

    expect(collectOpenLoopProcessProfileViolations(root))
      .toContain('Openloop preset "standard": process row "renamed-shell" (@deepseek-ai/dsh-tool-bash) must be disabled')
  })
})
