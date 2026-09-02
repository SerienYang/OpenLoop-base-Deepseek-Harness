import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FixtureProcess,
  type FixtureChild,
} from './openloop-fixture-process.ts'

afterEach(() => {
  vi.useRealTimers()
})

class FakeChild extends EventEmitter implements FixtureChild {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly signals: NodeJS.Signals[] = []

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    return true
  }

  fail(error: Error): void {
    this.emit('error', error)
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

describe('Openloop Web fixture process', () => {
  it('captures stderr and rejects readiness on a nonzero exit', async () => {
    const child = new FakeChild()
    const fixture = new FixtureProcess({ spawnFixture: () => child })
    child.stderr.write('scaffold exploded\n')
    child.exit(7)

    await expect(fixture.ready).rejects.toThrow(
      'Openloop fixture exited before ready (exit 7):\nscaffold exploded',
    )
  })

  it('rejects every pending command when the child exits', async () => {
    const child = new FakeChild()
    const fixture = new FixtureProcess({ spawnFixture: () => child })
    child.stdout.write('OPENLOOP_FIXTURE:{"ready":true,"url":"http://fixture","workspaceCwd":"/tmp/work","activeRows":[]}\n')
    await fixture.ready
    const first = fixture.command('calls')
    const second = fixture.command('calls')
    child.stderr.write('late failure\n')
    child.exit(9)

    await expect(first).rejects.toThrow('Openloop fixture exited (exit 9):\nlate failure')
    await expect(second).rejects.toThrow('Openloop fixture exited (exit 9):\nlate failure')
  })

  it('requires a clean exit when close terminates the fixture', async () => {
    const child = new FakeChild()
    const fixture = new FixtureProcess({ spawnFixture: () => child })
    child.stdout.write('OPENLOOP_FIXTURE:{"ready":true,"url":"http://fixture","workspaceCwd":"/tmp/work","activeRows":[]}\n')
    await fixture.ready
    const closed = fixture.close()
    child.stderr.write('cleanup failed\n')
    child.exit(1)

    await expect(closed).rejects.toThrow('Openloop fixture cleanup failed (exit 1):\ncleanup failed')
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('bounds cleanup and rejects pending commands after error without exit', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const fixture = new FixtureProcess({
      spawnFixture: () => child,
      closeTimeoutMs: 5,
    })
    child.stdout.write('OPENLOOP_FIXTURE:{"ready":true,"url":"http://fixture","workspaceCwd":"/tmp/work","activeRows":[]}\n')
    await fixture.ready
    const command = fixture.command('calls')
    const commandResult = command.catch((error: unknown) => error)
    const closingResult = fixture.close().catch((error: unknown) => error)
    child.fail(new Error('process handle failed'))

    await vi.advanceTimersByTimeAsync(10)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    await expect(commandResult).resolves.toEqual(new Error('process handle failed'))
    await expect(closingResult).resolves.toEqual(
      new Error('Openloop fixture did not exit within 10ms after SIGTERM and SIGKILL'),
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reaps an exit during the bounded SIGKILL grace period', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const fixture = new FixtureProcess({
      spawnFixture: () => child,
      closeTimeoutMs: 5,
    })
    child.stdout.write('OPENLOOP_FIXTURE:{"ready":true,"url":"http://fixture","workspaceCwd":"/tmp/work","activeRows":[]}\n')
    await fixture.ready
    const closing = fixture.close()
    const closingResult = closing.catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(5)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    await vi.advanceTimersByTimeAsync(4)
    child.exit(null, 'SIGKILL')
    await expect(closingResult).resolves.toEqual(
      new Error('Openloop fixture did not exit within 5ms'),
    )
    expect(vi.getTimerCount()).toBe(0)
  })
})
