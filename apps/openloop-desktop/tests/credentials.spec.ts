import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'
import { describe, expect, test, vi } from 'vitest'
import {
  createCredentialCommands,
  createCredentialSubmitter,
  readPromptToken,
  type CredentialInvoke,
} from '../src/credentials.ts'

const appRoot = path.resolve(import.meta.dirname, '..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

function deferred(): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill
  })
  return { promise, resolve }
}

describe('Openloop credential prompt', () => {
  test('clears secret bytes after synchronous IPC handoff, before its response', async () => {
    const promptToken = '11'.repeat(32)
    let received: Uint8Array | undefined
    let serialized: number[] | undefined
    const gate = deferred()
    const invoke = vi.fn<CredentialInvoke>(async (command, args) => {
      expect(command).toBe('credentials_set')
      expect(args.promptToken).toBe(promptToken)
      if (args.secret === undefined) throw new Error('missing credential bytes')
      received = args.secret
      serialized = [...args.secret]
      await gate.promise
    })
    const input = { value: 'sk-private' }
    const submit = createCredentialSubmitter(promptToken, invoke)

    const pending = submit(input)

    expect(input.value).toBe('')
    expect(received).toBeInstanceOf(Uint8Array)
    expect(received).not.toBeUndefined()
    expect(serialized).toEqual([...new TextEncoder().encode('sk-private')])
    expect([...received!]).toEqual(Array(received!.length).fill(0))

    gate.resolve()
    await expect(pending).resolves.toBe(true)
    expect([...received!]).toEqual(Array(received!.length).fill(0))
  })

  test('prevents double submit while credential IPC is pending', async () => {
    const gate = deferred()
    const invoke = vi.fn<CredentialInvoke>(async () => gate.promise)
    const submit = createCredentialSubmitter('22'.repeat(32), invoke)
    const firstInput = { value: 'first-secret' }
    const secondInput = { value: 'second-secret' }

    const first = submit(firstInput)
    await expect(submit(secondInput)).resolves.toBe(false)

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(firstInput.value).toBe('')
    expect(secondInput.value).toBe('second-secret')
    gate.resolve()
    await expect(first).resolves.toBe(true)
  })

  test('transports the injected prompt token on every credential command', async () => {
    const promptToken = '33'.repeat(32)
    const invoke = vi.fn<CredentialInvoke>(async command =>
      command === 'credentials_status' ? true : undefined)
    const commands = createCredentialCommands(promptToken, invoke)
    const secret = new Uint8Array([1, 2, 3])

    await commands.set(secret)
    await commands.unset()
    await expect(commands.status()).resolves.toBe(true)

    expect(invoke.mock.calls).toEqual([
      ['credentials_set', { promptToken, secret }],
      ['credentials_unset', { promptToken }],
      ['credentials_status', { promptToken }],
    ])
  })

  test('reads only a valid injected prompt token', () => {
    const promptToken = 'ab'.repeat(32)

    expect(readPromptToken({
      __OPENLOOP_CREDENTIAL_PROMPT_TOKEN__: promptToken,
    })).toBe(promptToken)
    expect(() => readPromptToken({})).toThrow(/unavailable/u)
    expect(() => readPromptToken({
      __OPENLOOP_CREDENTIAL_PROMPT_TOKEN__: 'not-a-token',
    })).toThrow(/unavailable/u)
  })

  test('keeps the prompt static, local, and free of persistence or logging APIs', () => {
    const html = read('src/credentials.html')
    const sourceText = read('src/credentials.ts')
    const styles = read('src/credentials.css')
    const source = ts.createSourceFile(
      'credentials.ts',
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const imports = source.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => {
        if (!ts.isStringLiteral(statement.moduleSpecifier)) {
          throw new TypeError('credential imports must use string literals')
        }
        return statement.moduleSpecifier.text
      })

    expect(imports).toEqual(['@tauri-apps/api/core', './credentials.css'])
    expect(html).toContain('<script type="module" src="/src/credentials.ts"></script>')
    expect(html).toMatch(/type="password"/u)
    expect(html).toMatch(/autocomplete="new-password"/u)
    expect(html).toMatch(/<form[^>]*autocomplete="off"/u)
    expect(html).not.toMatch(/(?:src|href|action)=["']https?:/u)
    expect(html).not.toMatch(/<a\b|target=|download=/u)

    const browserSurface = `${html}\n${sourceText}`
    expect(browserSurface).not.toMatch(
      /\b(?:localStorage|sessionStorage|indexedDB|history|fetch|XMLHttpRequest|WebSocket|sendBeacon|window\.open|location\.)\b/u,
    )
    expect(browserSurface).not.toMatch(/\bconsole\s*\./u)
    expect(sourceText).toContain('__OPENLOOP_CREDENTIAL_PROMPT_TOKEN__')
    expect(browserSurface).not.toMatch(
      /@deepseek-ai|@openloop|packages\/|runtime\/|credentials_(?:resolve|open)|keychain_spike/u,
    )

    const visualSurface = `${html}\n${styles}`.toLowerCase()
    expect(visualSurface).not.toMatch(
      /\bcyan\b|#00ffff|#0ff\b|rgb\s*\(\s*0\s*,\s*255\s*,\s*255\s*\)/u,
    )
    expect(visualSurface).not.toMatch(/\b(?:linear|radial|conic)-gradient\s*\(/u)
    expect(visualSurface).not.toMatch(/\borbs?\b|\bcards?\b/u)
  })
})
