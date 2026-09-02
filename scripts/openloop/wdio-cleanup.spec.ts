import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

interface CleanupOptions {
  readonly root: string
  readonly auditPath: string
  readonly expectedRunId: string
  readonly timeoutMs?: number
  readonly pollMs?: number
  readonly isProcessAlive?: (pid: number) => boolean
  readonly sleep?: (milliseconds: number) => Promise<void>
}

interface CleanupModule {
  readonly cleanupWdioRun: (options: CleanupOptions) => Promise<void>
}

const roots: string[] = []

async function cleanupWdioRun(options: CleanupOptions): Promise<void> {
  const modulePath: string = './wdio-cleanup.mjs'
  const module = await import(modulePath) as CleanupModule
  await module.cleanupWdioRun(options)
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openloop-wdio-cleanup-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Openloop WDIO cleanup', () => {
  it('waits only for the audited runtime PID before removing this run root', async () => {
    const root = fixtureRoot()
    const auditPath = join(root, 'runtime-process.json')
    const observed: number[] = []
    let checks = 0
    writeFileSync(auditPath, JSON.stringify({ runId: 'run-a', pid: 1234 }))

    await cleanupWdioRun({
      root,
      auditPath,
      expectedRunId: 'run-a',
      timeoutMs: 100,
      pollMs: 1,
      isProcessAlive(pid) {
        observed.push(pid)
        checks += 1
        return checks < 3
      },
      sleep: async () => {},
    })

    expect(observed).toEqual([1234, 1234, 1234])
    expect(() => readFileSync(auditPath)).toThrow()
  })

  it('does not remove the run root when its audited runtime remains alive', async () => {
    const root = fixtureRoot()
    const auditPath = join(root, 'runtime-process.json')
    mkdirSync(root, { recursive: true })
    writeFileSync(auditPath, JSON.stringify({ runId: 'run-b', pid: 4321 }))

    await expect(cleanupWdioRun({
      root,
      auditPath,
      expectedRunId: 'run-b',
      timeoutMs: 0,
      pollMs: 1,
      isProcessAlive: () => true,
      sleep: async () => {},
    })).rejects.toThrow('runtime PID 4321 did not exit')

    expect(JSON.parse(readFileSync(auditPath, 'utf8'))).toEqual({
      runId: 'run-b',
      pid: 4321,
    })
  })

  it('rejects an audit from another run without inspecting its PID', async () => {
    const root = fixtureRoot()
    const auditPath = join(root, 'runtime-process.json')
    const observed: number[] = []
    writeFileSync(auditPath, JSON.stringify({ runId: 'parallel-run', pid: 9876 }))

    await expect(cleanupWdioRun({
      root,
      auditPath,
      expectedRunId: 'current-run',
      isProcessAlive(pid) {
        observed.push(pid)
        return false
      },
    })).rejects.toThrow('runtime audit runId does not match')

    expect(observed).toEqual([])
  })
})
