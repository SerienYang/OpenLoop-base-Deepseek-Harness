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

  it('fails explicitly and force-terminates when close times out', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const fixture = new FixtureProcess({
      spawnFixture: () => child,
      closeTimeoutMs: 5,
    })
    child.stdout.write('OPENLOOP_FIXTURE:{"ready":true,"url":"http://fixture","workspaceCwd":"/tmp/work","activeRows":[]}\n')
    await fixture.ready
    const closing = fixture.close()
    let settled = false
    void closing.then(
      () => { settled = true },
      () => { settled = true },
    )

    await vi.advanceTimersByTimeAsync(5)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(settled).toBe(false)

    child.exit(null, 'SIGKILL')
    await expect(closing).rejects.toThrow('Openloop fixture did not exit within 5ms')
  })
})
