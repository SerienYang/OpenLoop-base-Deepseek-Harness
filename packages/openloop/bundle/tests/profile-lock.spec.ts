// Cross-process timing is represented by deterministic filesystem outcomes:
// another owner holds the lock, then our process acquires it after that owner
// has published the manifest.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureOpenloopProfile } from '../src/profile.ts'

type LockOutcome = 'acquired' | 'contended'

const state = vi.hoisted(() => ({
  initCalls: 0,
  initError: undefined as Error | undefined,
  lockAttempts: [] as string[],
  lockOutcomes: [] as LockOutcome[],
  manifestChecks: 0,
  manifestResults: [] as boolean[],
  ownerText: JSON.stringify({
    pid: 41_041,
    createdAt: 1_700_000_000_000,
    token: 'competing-owner',
  }),
  ownerWrites: [] as string[],
  removals: [] as string[],
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync(path: Parameters<typeof actual.existsSync>[0]): boolean {
      if (String(path).endsWith('/profiles/openloop/package.json')) {
        state.manifestChecks += 1
        return state.manifestResults.shift() ?? false
      }
      return actual.existsSync(path)
    },
    lstatSync(path: Parameters<typeof actual.lstatSync>[0], ...args: never[]) {
      if (String(path) === '/virtual/home/profiles') {
        return {
          isDirectory: () => true,
          isSymbolicLink: () => false,
        }
      }
      if (String(path) === '/virtual/home/profiles/.openloop.init.lock') {
        return {
          isDirectory: () => true,
          isSymbolicLink: () => false,
        }
      }
      if (String(path).endsWith('/profiles/openloop')) {
        throw Object.assign(new Error('ENOENT: virtual missing profile'), { code: 'ENOENT' })
      }
      return (actual.lstatSync as (path: unknown, ...rest: never[]) => unknown)(path, ...args)
    },
    mkdirSync(path: Parameters<typeof actual.mkdirSync>[0], options?: Parameters<typeof actual.mkdirSync>[1]) {
      const text = String(path)
      if (text === '/virtual/home/profiles') return undefined
      if (text === '/virtual/home/profiles/.openloop.init.lock') {
        state.lockAttempts.push(text)
        if ((state.lockOutcomes.shift() ?? 'contended') === 'contended') {
          throw Object.assign(new Error(`EEXIST: ${text}`), { code: 'EEXIST' })
        }
        return undefined
      }
      return actual.mkdirSync(path, options as never)
    },
    readFileSync(path: Parameters<typeof actual.readFileSync>[0], options?: Parameters<typeof actual.readFileSync>[1]) {
      if (String(path).endsWith('/.openloop.init.lock/owner.json')) return state.ownerText
      return actual.readFileSync(path, options as never)
    },
    rmSync(path: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]): void {
      if (String(path) === '/virtual/home/profiles/.openloop.init.lock') {
        state.removals.push(String(path))
        return
      }
      actual.rmSync(path, options)
    },
    writeFileSync(
      path: Parameters<typeof actual.writeFileSync>[0],
      data: Parameters<typeof actual.writeFileSync>[1],
      options?: Parameters<typeof actual.writeFileSync>[2],
    ): void {
      if (String(path).endsWith('/.openloop.init.lock/owner.json')) {
        if (typeof data !== 'string') throw new TypeError('lock owner metadata must be text')
        state.ownerText = data
        state.ownerWrites.push(data)
        return
      }
      actual.writeFileSync(path, data, options)
    },
  }
})

vi.mock('@deepseek-ai/dsh-app-boot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-app-boot')>()
  return {
    ...actual,
    initProfile(): void {
      state.initCalls += 1
      if (state.initError !== undefined) throw state.initError
    },
  }
})

beforeEach(() => {
  state.initCalls = 0
  state.initError = undefined
  state.lockAttempts = []
  state.lockOutcomes = []
  state.manifestChecks = 0
  state.manifestResults = []
  state.ownerText = JSON.stringify({
    pid: 41_041,
    createdAt: 1_700_000_000_000,
    token: 'competing-owner',
  })
  state.ownerWrites = []
  state.removals = []
  vi.restoreAllMocks()
})

describe('OpenLoop profile initialization lock', () => {
  it('waits for a competing initializer, then reuses the manifest found after lock acquisition', () => {
    state.manifestResults = [false, true]
    state.lockOutcomes = ['contended', 'acquired']

    expect(ensureOpenloopProfile('/virtual/home'))
      .toBe('/virtual/home/profiles/openloop')

    expect(state.lockAttempts).toEqual([
      '/virtual/home/profiles/.openloop.init.lock',
      '/virtual/home/profiles/.openloop.init.lock',
    ])
    expect(state.manifestChecks).toBe(2)
    expect(state.initCalls).toBe(0)
    expect(state.removals).toEqual(['/virtual/home/profiles/.openloop.init.lock'])
    const owner = JSON.parse(state.ownerWrites[0]!) as Record<string, unknown>
    expect(owner['pid']).toBe(process.pid)
    expect(typeof owner['createdAt']).toBe('number')
    expect(typeof owner['token']).toBe('string')
  })

  it('fails loud on timeout without deleting another process lock', () => {
    state.manifestResults = [false]
    state.lockOutcomes = ['contended']
    let now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 60_000
      return now
    })

    expect(() => ensureOpenloopProfile('/virtual/home'))
      .toThrow(/timed out.*41041.*1700000000000/i)
    expect(state.initCalls).toBe(0)
    expect(state.ownerWrites).toEqual([])
    expect(state.removals).toEqual([])
  })

  it('cleans up its own lock when profile initialization throws', () => {
    state.manifestResults = [false, false]
    state.lockOutcomes = ['acquired']
    state.initError = new Error('injected profile initialization failure')

    expect(() => ensureOpenloopProfile('/virtual/home'))
      .toThrow('injected profile initialization failure')
    expect(state.initCalls).toBe(1)
    expect(state.removals).toEqual(['/virtual/home/profiles/.openloop.init.lock'])
  })
})
