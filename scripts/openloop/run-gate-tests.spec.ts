import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

function outsideFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openloop-gate-outside-'))
  roots.push(root)
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

  it('rejects a nonexistent exact Cargo test target', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    write(root, 'native/app/Cargo.toml', '[package]\nname = "openloop"\nversion = "0.1.0"\n')

    await expect(runGateTests(
      ['cargo', '--manifest', 'native/app/Cargo.toml', '--test', 'missing'],
      {
        root,
        runCommand: () => ({
          status: 101,
          stdout: '',
          stderr: 'error: no test target named `missing`',
        }),
      },
    )).rejects.toThrow('Cargo test listing failed:\nerror: no test target named `missing`')
  })

  it('rejects a Cargo target that discovers zero tests', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    write(root, 'native/app/Cargo.toml', '[package]\nname = "openloop"\nversion = "0.1.0"\n')

    await expect(runGateTests(
      ['cargo', '--manifest', 'native/app/Cargo.toml', '--test', 'desktop'],
      {
        root,
        runCommand: () => ({
          status: 0,
          stdout: '0 tests, 0 benchmarks\n',
          stderr: '',
        }),
      },
    )).rejects.toThrow('Cargo discovered zero tests')
  })

  it('rejects an all-skipped Cargo result', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    write(root, 'native/app/Cargo.toml', '[package]\nname = "openloop"\nversion = "0.1.0"\n')
    let invocation = 0

    await expect(runGateTests(
      ['cargo', '--manifest', 'native/app/Cargo.toml', '--test', 'desktop'],
      {
        root,
        runCommand: () => {
          invocation += 1
          if (invocation === 1) {
            return { status: 0, stdout: 'platform_only: test\n', stderr: '' }
          }
          return {
            status: 0,
            stdout: 'test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out\n',
            stderr: '',
          }
        },
      },
    )).rejects.toThrow('Cargo all discovered tests were skipped')
    expect(invocation).toBe(2)
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

  it('rejects a nonexistent exact Vitest file before invoking the runner', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()

    await expect(runGateTests(
      ['vitest', '--files', 'scripts/openloop/missing.spec.ts'],
      {
        root,
        runCommand: () => {
          throw new Error('must not execute')
        },
      },
    )).rejects.toThrow('target does not exist: scripts/openloop/missing.spec.ts')
  })

  it('rejects a test target that resolves outside the repository through a symlink', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    const outside = outsideFixtureRoot()
    write(outside, 'suite.spec.ts', "it('outside', () => {})\n")
    symlinkSync(outside, join(root, 'linked-tests'), 'dir')

    await expect(runGateTests(
      ['vitest', '--files', 'linked-tests/suite.spec.ts'],
      {
        root,
        runCommand: () => {
          throw new Error('must not execute')
        },
      },
    )).rejects.toThrow(
      'target must resolve inside the repository: linked-tests/suite.spec.ts',
    )
  })

  it('rejects a Cargo manifest that resolves outside the repository through a symlink', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    const outside = outsideFixtureRoot()
    write(outside, 'Cargo.toml', '[package]\nname = "outside"\nversion = "0.1.0"\n')
    symlinkSync(outside, join(root, 'linked-native'), 'dir')

    await expect(runGateTests(
      ['cargo', '--manifest', 'linked-native/Cargo.toml', '--test', 'desktop'],
      {
        root,
        runCommand: () => {
          throw new Error('must not execute')
        },
      },
    )).rejects.toThrow(
      'Cargo manifest must resolve inside the repository: linked-native/Cargo.toml',
    )
  })

  it('rejects a WDIO config that resolves outside the repository through a symlink', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    const outside = outsideFixtureRoot()
    write(outside, 'wdio.conf.ts', 'export const config = {}\n')
    symlinkSync(outside, join(root, 'linked-config'), 'dir')
    write(root, 'target/openloop', 'binary')
    write(root, 'tests/window.e2e.ts', "describe('window', () => {})\n")

    await expect(runGateTests([
      'wdio',
      '--config', 'linked-config/wdio.conf.ts',
      '--binary', 'target/openloop',
      '--file', 'tests/window.e2e.ts',
    ], {
      root,
      runCommand: () => {
        throw new Error('must not execute')
      },
    })).rejects.toThrow(
      'WDIO config must resolve inside the repository: linked-config/wdio.conf.ts',
    )
  })

  it('rejects a WDIO binary that resolves outside the repository through a symlink', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    const outside = outsideFixtureRoot()
    write(outside, 'openloop', 'binary')
    symlinkSync(outside, join(root, 'linked-bin'), 'dir')
    write(root, 'wdio.conf.ts', 'export const config = {}\n')
    write(root, 'tests/window.e2e.ts', "describe('window', () => {})\n")

    await expect(runGateTests([
      'wdio',
      '--config', 'wdio.conf.ts',
      '--binary', 'linked-bin/openloop',
      '--file', 'tests/window.e2e.ts',
    ], {
      root,
      runCommand: () => {
        throw new Error('must not execute')
      },
    })).rejects.toThrow(
      'WDIO binary must resolve inside the repository: linked-bin/openloop',
    )
  })

  it('rejects zero discovered Vitest tests', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
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

  it('rejects an all-skipped Vitest result', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    write(root, 'scripts/openloop/platform.spec.ts', "it('platform', () => {})\n")

    await expect(runGateTests(
      ['vitest', '--files', 'scripts/openloop/platform.spec.ts'],
      {
        root,
        runCommand: () => ({
          status: 0,
          stdout: JSON.stringify({ numTotalTests: 2, numPendingTests: 2 }),
          stderr: '',
        }),
      },
    )).rejects.toThrow('Vitest all discovered tests were skipped')
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

  it('ignores focused and skip marker text in strings, templates, and comments', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    const testPath = 'packages/core/example/tests/example.spec.ts'
    write(root, testPath, [
      "const focused = 'test.only('",
      'const chained = `describe.concurrent.only(`',
      "const skipped = '.skip('",
      "const skipChain = 'it.skip.each([1])('",
      '// suite.only(',
      '/* test.skip( */',
      "test('uses marker text', () => 'test.only(')",
    ].join('\n'))

    await expect(runGateTests(['scan-repo'], { root })).resolves.toBeUndefined()
  })

  it.each([
    ["test.only('focused', () => {})", 1],
    ["test['only']('focused', () => {})", 1],
    ["describe.concurrent.only('focused', () => {})", 1],
    ["describe['concurrent']['only']('focused', () => {})", 1],
    ["\n\nit['only'].each([1])('focused', () => {})", 3],
    ["const spec = test\nspec.only('focused', () => {})", 2],
    ["import { test as check } from 'vitest'\ncheck['only']('focused', () => {})", 2],
  ])('rejects focused call expression %s', async (source, line) => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    const testPath = 'packages/core/example/tests/example.spec.ts'
    write(root, testPath, `${source}\n`)

    await expect(runGateTests(['scan-repo'], { root }))
      .rejects.toThrow(`${testPath}:${line}: forbidden focused test marker`)
  })

  it.each([
    "test.skip('platform', () => {})",
    "test['skip']('platform', () => {})",
    "describe.skip.each([1])('platform', () => {})",
    "it['skip'].each([1])('platform', () => {})",
    "suite['todo']('platform', () => {})",
    'test.skip(platformTitle, () => {})',
    'test.todo(`platform ${target}`)',
  ])('rejects unlisted skip call expression %s', async (source) => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    const testPath = 'packages/core/example/tests/platform.spec.ts'
    write(root, testPath, `${source}\n`)

    await expect(runGateTests(['scan-repo'], { root }))
      .rejects.toThrow(`${testPath}:1: skip is not present in the allowlist`)
  })

  it('ignores conditional skips, runtime skips, and skip text in fixtures', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    write(root, 'packages/core/example/tests/platform.spec.ts', [
      "describe.skipIf(process.platform === 'win32')('platform', () => {})",
      'const suite = process.platform === "darwin" ? describe : describe.skip',
      "it('uses a source fixture', () => 'test.skip.each([1])')",
      "it('checks runtime availability', (ctx) => { if (!available) ctx.skip() })",
    ].join('\n'))

    await expect(runGateTests(['scan-repo'], { root })).resolves.toBeUndefined()
  })

  it('requires a matching marker fingerprint and rejects same-line replacements', async () => {
    const { markerFingerprint, runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    const testPath = 'scripts/openloop/platform.spec.ts'
    const source = "it.skip('platform', () => {})"
    write(root, testPath, `${source}\n`)
    const entry = {
      file: testPath,
      line: 1,
      owner: 'desktop-foundation',
      reason: 'Requires the signed test fixture.',
      expires: '2026-09-01',
    }

    write(root, 'scripts/openloop/test-skip-allowlist.json', JSON.stringify({
      version: 1,
      skips: [entry],
    }))
    await expect(runGateTests(['scan-repo'], {
      root,
      now: new Date('2026-08-20T00:00:00Z'),
    })).rejects.toThrow(
      'scripts/openloop/test-skip-allowlist.json: skip entries require file, line, fingerprint, owner, reason, and YYYY-MM-DD expires',
    )

    write(root, 'scripts/openloop/test-skip-allowlist.json', JSON.stringify({
      version: 1,
      skips: [{ ...entry, fingerprint: '0'.repeat(64) }],
    }))
    await expect(runGateTests(['scan-repo'], {
      root,
      now: new Date('2026-08-20T00:00:00Z'),
    })).rejects.toThrow(`${testPath}:1: skip allowlist fingerprint does not match marker`)

    const fingerprint = markerFingerprint({
      kind: 'skip',
      callee: 'it.skip',
      source,
      title: "'platform'",
    })
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(markerFingerprint({
      kind: 'skip',
      callee: 'it.skip',
      source: "it.skip( 'signed fixture', () => {} )",
      title: "'signed fixture'",
    })).toBe(markerFingerprint({
      kind: 'skip',
      callee: 'it.skip',
      source: "it.skip(\n  'signed fixture',\n  () => {}\n)",
      title: "  'signed fixture'  ",
    }))
    expect(markerFingerprint({
      kind: 'skip',
      callee: 'it.skip',
      source: "it.skip('signed fixture', () => {})",
      title: "'signed fixture'",
    })).not.toBe(markerFingerprint({
      kind: 'skip',
      callee: 'it.skip',
      source: "it.skip('signed  fixture', () => {})",
      title: "'signed  fixture'",
    }))
    write(root, 'scripts/openloop/test-skip-allowlist.json', JSON.stringify({
      version: 1,
      skips: [{ ...entry, fingerprint }],
    }))
    await expect(runGateTests(['scan-repo'], {
      root,
      now: new Date('2026-08-20T00:00:00Z'),
    })).resolves.toBeUndefined()

    write(root, testPath, "it.skip('replacement', () => {})\n")
    await expect(runGateTests(['scan-repo'], {
      root,
      now: new Date('2026-08-20T00:00:00Z'),
    })).rejects.toThrow(`${testPath}:1: skip allowlist fingerprint does not match marker`)
  })

  it('rejects unlisted or expired skips and accepts complete future entries', async () => {
    const { markerFingerprint, runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    const testPath = 'scripts/openloop/platform.spec.ts'
    const source = `it${'.skip'}('platform', () => {})`
    const fingerprint = markerFingerprint({
      kind: 'skip',
      callee: 'it.skip',
      source,
      title: "'platform'",
    })
    write(root, testPath, `${source}\n`)
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
        fingerprint,
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
        fingerprint,
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

  it.each([
    "it['skip'].each([1])('platform', () => {})",
    "test.todo('platform')",
  ])('accepts allowlisted skip call expression %s', async (source) => {
    const { markerFingerprint, runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    const testPath = 'scripts/openloop/platform.spec.ts'
    write(root, testPath, `${source}\n`)
    const segments = source.startsWith("it['skip']")
      ? { kind: 'skip', callee: 'it.skip.each' }
      : { kind: 'todo', callee: 'test.todo' }
    write(root, 'scripts/openloop/test-skip-allowlist.json', JSON.stringify({
      version: 1,
      skips: [{
        file: testPath,
        line: 1,
        fingerprint: markerFingerprint({
          ...segments,
          source,
          title: "'platform'",
        }),
        owner: 'desktop-foundation',
        reason: 'Requires the signed test fixture.',
        expires: '2026-09-01',
      }],
    }))

    await expect(runGateTests(['scan-repo'], {
      root,
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
        fingerprint: '0'.repeat(64),
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

  it('rejects a nonexistent exact Playwright file before invoking the runner', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()

    await expect(runGateTests(['playwright', '--file', 'tests/missing.spec.ts'], {
      root,
      runCommand: () => {
        throw new Error('must not execute')
      },
    })).rejects.toThrow('target does not exist: tests/missing.spec.ts')
  })

  it('rejects a nonexistent exact WDIO file before invoking the runner', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    write(root, 'wdio.conf.ts', 'export const config = {}\n')
    write(root, 'target/openloop', 'binary')

    await expect(runGateTests([
      'wdio',
      '--config', 'wdio.conf.ts',
      '--binary', 'target/openloop',
      '--file', 'tests/missing.e2e.ts',
    ], {
      root,
      runCommand: () => {
        throw new Error('must not execute')
      },
    })).rejects.toThrow('target does not exist: tests/missing.e2e.ts')
  })

  it('rejects an all-skipped Playwright result', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    write(root, 'tests/app.spec.ts', "test('app', () => {})\n")

    await expect(runGateTests(['playwright', '--file', 'tests/app.spec.ts'], {
      root,
      runCommand: () => ({
        status: 0,
        stdout: JSON.stringify({
          stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 2 },
        }),
        stderr: '',
      }),
    })).rejects.toThrow('Playwright all discovered tests were skipped')
  })

  it('rejects an all-skipped WDIO result', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    write(root, 'wdio.conf.ts', 'export const config = {}\n')
    write(root, 'target/openloop', 'binary')
    write(root, 'tests/window.e2e.ts', "describe('window', () => {})\n")

    await expect(runGateTests([
      'wdio',
      '--config', 'wdio.conf.ts',
      '--binary', 'target/openloop',
      '--file', 'tests/window.e2e.ts',
    ], {
      root,
      runCommand: () => ({
        status: 0,
        stdout: '0 passed, 0 failed, 2 skipped\n',
        stderr: '',
      }),
    })).rejects.toThrow('WDIO all discovered tests were skipped')
  })

  it('validates both Playwright and WDIO zero-execution summaries', async () => {
    const { runGateTests } = await import(gateModulePath)
    const root = fixtureRoot()
    write(root, 'tests/app.spec.ts', "test('app', () => {})\n")
    write(root, 'wdio.conf.ts', 'export const config = {}\n')
    write(root, 'target/openloop', 'binary')
    write(root, 'tests/window.e2e.ts', "describe('window', () => {})\n")

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

    await expect(runGateTests([
      'wdio',
      '--config', 'wdio.conf.ts',
      '--binary', 'target/openloop',
      '--file', 'tests/window.e2e.ts',
    ], {
      root,
      runCommand: () => ({
        status: 0,
        stdout: '0 passed, 0 failed, 0 skipped\n',
        stderr: '',
      }),
    })).rejects.toThrow('WDIO executed zero tests')
  })
})
