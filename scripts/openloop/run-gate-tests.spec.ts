import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const gateModulePath: string = './run-gate-tests.mjs'

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openloop-gate-'))
  roots.push(root)
  write(root, 'scripts/openloop/test-skip-allowlist.json', JSON.stringify({
    version: 1,
    skips: [],
  }))
  return root
}

function write(root: string, path: string, content = ''): string {
  const absolute = join(root, path)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content)
  return absolute
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('OpenLoop focused test gate', () => {
  it('parses every exact-target mode', async () => {
    const { parseGateArguments } = await import(gateModulePath)

    expect(parseGateArguments(['vitest', '--files', 'a.spec.ts', 'b.spec.ts'])).toEqual({
      mode: 'vitest',
      files: ['a.spec.ts', 'b.spec.ts'],
    })
    expect(parseGateArguments([
      'cargo', '--manifest', 'native/app/Cargo.toml', '--test', 'desktop',
    ])).toEqual({
      mode: 'cargo',
      manifest: 'native/app/Cargo.toml',
      test: 'desktop',
    })
    expect(parseGateArguments(['playwright', '--file', 'tests/app.spec.ts'])).toEqual({
      mode: 'playwright',
      file: 'tests/app.spec.ts',
    })
    expect(parseGateArguments([
      'wdio',
      '--config', 'wdio.conf.ts',
      '--binary', 'target/openloop',
      '--file', 'tests/window.e2e.ts',
    ])).toEqual({
      mode: 'wdio',
      config: 'wdio.conf.ts',
      binary: 'target/openloop',
      file: 'tests/window.e2e.ts',
    })
    expect(parseGateArguments(['scan-repo'])).toEqual({ mode: 'scan-repo' })
  })

  it('accepts the separator forwarded by the root pnpm command', async () => {
    const { parseGateArguments } = await import(gateModulePath)

    expect(parseGateArguments(['--', 'scan-repo'])).toEqual({ mode: 'scan-repo' })
  })

  it('runs exact Vitest files and requires a nonzero executed count', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    write(root, 'scripts/openloop/a.spec.ts', "it('a', () => {})\n")
    write(root, 'scripts/openloop/b.spec.ts', "it('b', () => {})\n")
    const commands: Array<{ command: string; args: string[] }> = []

    await runGateTests(
      ['vitest', '--files', 'scripts/openloop/a.spec.ts', 'scripts/openloop/b.spec.ts'],
      {
        root,
        runCommand(command: string, args: string[]) {
          commands.push({ command, args })
          return {
            status: 0,
            stdout: JSON.stringify({
              numTotalTests: 2,
              numPassedTests: 2,
              numPendingTests: 0,
            }),
            stderr: '',
          }
        },
      },
    )

    expect(commands).toEqual([{
      command: 'pnpm',
      args: [
        'exec', 'vitest', 'run',
        'scripts/openloop/a.spec.ts',
        'scripts/openloop/b.spec.ts',
        '--reporter=json',
      ],
    }])
  })

  it('lists a Cargo target before running it', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    write(root, 'native/app/Cargo.toml', '[package]\nname = "openloop"\nversion = "0.1.0"\n')
    const commands: string[][] = []

    await runGateTests(
      ['cargo', '--manifest', 'native/app/Cargo.toml', '--test', 'desktop'],
      {
        root,
        runCommand(command: string, args: string[]) {
          commands.push([command, ...args])
          if (args.includes('--list')) {
            return { status: 0, stdout: 'opens_window: test\n', stderr: '' }
          }
          return {
            status: 0,
            stdout: 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n',
            stderr: '',
          }
        },
      },
    )

    expect(commands).toEqual([
      [
        'cargo', 'test', '--manifest-path', 'native/app/Cargo.toml',
        '--test', 'desktop', '--', '--list',
      ],
      [
        'cargo', 'test', '--manifest-path', 'native/app/Cargo.toml',
        '--test', 'desktop',
      ],
    ])
  })

  it('passes the exact binary to WDIO and rejects a missing binary', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    write(root, 'wdio.conf.ts', 'export const config = {}\n')
    write(root, 'tests/window.e2e.ts', "describe('window', () => {})\n")

    await expect(runGateTests([
      'wdio',
      '--config', 'wdio.conf.ts',
      '--binary', 'target/openloop',
      '--file', 'tests/window.e2e.ts',
    ], {
      root,
      runCommand: () => {
        throw new Error('must not execute')
      },
    })).rejects.toThrow('WDIO binary does not exist: target/openloop')

    write(root, 'target/openloop', 'binary')
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
    await runGateTests([
      'wdio',
      '--config', 'wdio.conf.ts',
      '--binary', 'target/openloop',
      '--file', 'tests/window.e2e.ts',
    ], {
      root,
      runCommand(_command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) {
        calls.push({
          args,
          ...(options?.env === undefined ? {} : { env: options.env }),
        })
        return { status: 0, stdout: '1 passed, 0 failed, 0 skipped\n', stderr: '' }
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual([
      'exec', 'wdio', 'run', 'wdio.conf.ts', '--spec', 'tests/window.e2e.ts',
    ])
    expect(calls[0]?.env?.OPENLOOP_WDIO_BINARY).toBe(join(root, 'target/openloop'))
  })

  it('rejects nonexistent focused targets and zero discovered tests', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()

    await expect(runGateTests(
      ['vitest', '--files', 'scripts/openloop/missing.spec.ts'],
      { root, runCommand: () => ({ status: 0, stdout: '{}', stderr: '' }) },
    )).rejects.toThrow('target does not exist: scripts/openloop/missing.spec.ts')

    write(root, 'scripts/openloop/empty.spec.ts', 'export {}\n')
    await expect(runGateTests(
      ['vitest', '--files', 'scripts/openloop/empty.spec.ts'],
      {
        root,
        runCommand: () => ({
          status: 0,
          stdout: JSON.stringify({ numTotalTests: 0, numPendingTests: 0 }),
          stderr: '',
        }),
      },
    )).rejects.toThrow('Vitest discovered zero tests')
  })

  it('performs a repository-wide focused-marker scan in every mode', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    write(root, 'packages/core/example/tests/example.spec.ts', `it${'.only'}('focused', () => {})\n`)

    await expect(runGateTests(['scan-repo'], {
      root,
      runCommand: () => {
        throw new Error('must not execute')
      },
    })).rejects.toThrow('packages/core/example/tests/example.spec.ts:1: forbidden focused test marker')
  })

  it.each([
    'test.concurrent' + '.only',
    'describe.concurrent' + '.only',
    'it.concurrent' + '.only',
    'suite.concurrent' + '.only',
  ])('rejects chained focused marker %s', async (marker) => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    const testPath = 'packages/core/example/tests/example.spec.ts'
    write(root, testPath, `${marker}('focused', () => {})\n`)

    await expect(runGateTests(['scan-repo'], { root }))
      .rejects.toThrow(`${testPath}:1: forbidden focused test marker`)
  })

  it.each([
    'test' + '.skip.each',
    'describe' + '.skip.each',
    'it' + '.skip.each',
    'suite' + '.skip.each',
  ])('rejects chained skip marker %s', async (marker) => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    const testPath = 'scripts/openloop/platform.spec.ts'
    write(root, testPath, `${marker}([1])('platform', () => {})\n`)

    await expect(runGateTests(['scan-repo'], { root }))
      .rejects.toThrow(`${testPath}:1: skip is not present in the allowlist`)
  })

  it('rejects unlisted or expired skips and accepts complete future entries', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    const testPath = 'scripts/openloop/platform.spec.ts'
    write(root, testPath, `it${'.skip'}('platform', () => {})\n`)
    const commandResult = {
      status: 0,
      stdout: JSON.stringify({ numTotalTests: 2, numPassedTests: 1, numPendingTests: 1 }),
      stderr: '',
    }

    await expect(runGateTests(['vitest', '--files', testPath], {
      root,
      runCommand: () => commandResult,
      now: new Date('2026-08-20T00:00:00Z'),
    })).rejects.toThrow(`${testPath}:1: skip is not present in the allowlist`)

    write(root, 'scripts/openloop/test-skip-allowlist.json', JSON.stringify({
      version: 1,
      skips: [{
        file: testPath,
        line: 1,
        owner: 'desktop-foundation',
        reason: 'Requires the signed test fixture.',
        expires: '2026-08-19',
      }],
    }))
    await expect(runGateTests(['vitest', '--files', testPath], {
      root,
      runCommand: () => commandResult,
      now: new Date('2026-08-20T00:00:00Z'),
    })).rejects.toThrow(`${testPath}:1: skip allowlist entry is expired`)

    write(root, 'scripts/openloop/test-skip-allowlist.json', JSON.stringify({
      version: 1,
      skips: [{
        file: testPath,
        line: 1,
        owner: 'desktop-foundation',
        reason: 'Requires the signed test fixture.',
        expires: '2026-09-01',
      }],
    }))
    await expect(runGateTests(['vitest', '--files', testPath], {
      root,
      runCommand: () => commandResult,
      now: new Date('2026-08-20T00:00:00Z'),
    })).resolves.toBeUndefined()
  })

  it('rejects an impossible ISO calendar expiry', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    const testPath = 'scripts/openloop/platform.spec.ts'
    write(root, testPath, `it${'.skip'}('platform', () => {})\n`)
    write(root, 'scripts/openloop/test-skip-allowlist.json', JSON.stringify({
      version: 1,
      skips: [{
        file: testPath,
        line: 1,
        owner: 'desktop-foundation',
        reason: 'Requires the signed test fixture.',
        expires: '2026-99-99',
      }],
    }))

    await expect(runGateTests(['scan-repo'], {
      root,
      now: new Date('2026-08-20T00:00:00Z'),
    })).rejects.toThrow(
      'scripts/openloop/test-skip-allowlist.json: skip expiry must be a real YYYY-MM-DD calendar date',
    )
  })

  it('validates Playwright and WDIO nonzero result summaries', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    write(root, 'tests/app.spec.ts', "test('app', () => {})\n")

    await expect(runGateTests(['playwright', '--file', 'tests/app.spec.ts'], {
      root,
      runCommand: () => ({
        status: 0,
        stdout: JSON.stringify({
          stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
        }),
        stderr: '',
      }),
    })).rejects.toThrow('Playwright executed zero tests')
  })
})
