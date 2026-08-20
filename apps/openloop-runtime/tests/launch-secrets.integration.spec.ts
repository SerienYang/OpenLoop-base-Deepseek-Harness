import { spawn } from 'node:child_process'
import type { Writable } from 'node:stream'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  encodeLaunchSecretsFrame,
  MAX_LAUNCH_SECRETS_FRAME_BYTES,
} from '../src/launch-secrets.ts'

const sourcePath = fileURLToPath(new URL('../src/launch-secrets.ts', import.meta.url))
const token = 'launch-secret-token-that-must-never-be-logged'
const bridge = 'bridge-secret-that-must-never-be-logged'
const launchId = '8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90'

function runFixture(frame: Buffer, args: string[] = [], envValue = token): Promise<{
  code: number | null
  stdout: string
  stderr: string
  argv: string[]
}> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx/esm', '--input-type=module', '-e', `
      import { readLaunchSecretsFromFd } from ${JSON.stringify(sourcePath)};
      try {
        const first = readLaunchSecretsFromFd(3);
        let secondRead = 'not-attempted';
        try { readLaunchSecretsFromFd(3); } catch { secondRead = 'rejected'; }
        process.stdout.write(JSON.stringify({
          launchId: first.launchId,
          bootstrapLength: first.bootstrapToken.length,
          bridgeLength: first.bridgeSecret.length,
          socketPath: first.socketPath,
          secondRead,
          argv: process.argv.slice(1),
          env: process.env.OPENLOOP_TEST_SECRET,
        }) + '\\n');
      } catch (error) {
        process.stderr.write(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    `, ...args],
    {
      cwd: join(import.meta.dirname, '..', '..', '..'),
      env: { ...process.env, OPENLOOP_TEST_SECRET: envValue },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    },
  )
  const fd = child.stdio[3] as Writable | null
  if (fd === null) throw new Error('fixture fd3 is missing')
  fd.end(frame)
  const stdout = child.stdout
  const stderr = child.stderr
  if (stdout === null || stderr === null) throw new Error('fixture output is missing')
  return new Promise((resolve) => {
    let stdoutText = ''
    let stderrText = ''
    stdout.on('data', (chunk) => { stdoutText += String(chunk) })
    stderr.on('data', (chunk) => { stderrText += String(chunk) })
    child.on('close', (code) => {
      let parsed: { argv?: string[] } = {}
      try { parsed = JSON.parse(stdoutText) as { argv?: string[] } } catch {}
      resolve({ code, stdout: stdoutText, stderr: stderrText, argv: parsed.argv ?? [] })
    })
  })
}

describe('launch secrets inherited pipe', () => {
  test('reads exact secrets once without argv/env/log leakage', async () => {
    const result = await runFixture(encodeLaunchSecretsFrame({
      launchId,
      bootstrapToken: Buffer.from(token),
      bridgeSecret: Buffer.from(bridge),
      socketPath: '/tmp/openloop-runtime.sock',
    }), ['non-secret-argument'], 'ordinary-environment-value')

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(launchId)
    expect(result.stdout).toContain('"secondRead":"rejected"')
    expect(result.stdout).not.toContain(token)
    expect(result.stdout).not.toContain(bridge)
    expect(result.stderr).not.toContain(token)
    expect(result.argv).not.toContain(token)
  })

  test('malformed frame exits before any Cordis-facing work', async () => {
    const malformed = Buffer.from(encodeLaunchSecretsFrame({
      launchId,
      bootstrapToken: Buffer.from(token),
      bridgeSecret: Buffer.from(bridge),
      socketPath: '/tmp/openloop-runtime.sock',
    }))
    malformed.writeUInt16BE(99, 4)
    const result = await runFixture(malformed)

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/protocol|version|launch secret/iu)
    expect(result.stderr).not.toContain(token)
    expect(result.stdout).toBe('')
  })

  test.each([
    ['oversized', Buffer.alloc(MAX_LAUNCH_SECRETS_FRAME_BYTES + 1)],
    ['trailing', Buffer.concat([encodeLaunchSecretsFrame({
      launchId,
      bootstrapToken: Buffer.from(token),
      bridgeSecret: Buffer.from(bridge),
      socketPath: '/tmp/openloop-runtime.sock',
    }), Buffer.from([0xaa])])],
  ])('rejects %s transport frames before boot', async (_label, frame) => {
    const result = await runFixture(frame)

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toContain(token)
    expect(result.stderr).not.toContain(bridge)
  })
})
