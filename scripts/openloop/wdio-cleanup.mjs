import { existsSync, readFileSync, rmSync } from 'node:fs'

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function readRuntimeAudit(path, expectedRunId) {
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `WDIO runtime audit is invalid: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (value?.runId !== expectedRunId) {
    throw new Error('WDIO runtime audit runId does not match this run')
  }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new Error('WDIO runtime audit PID is invalid')
  }
  return value.pid
}

export async function cleanupWdioRun(options) {
  const {
    root,
    auditPath,
    expectedRunId,
    timeoutMs = 15_000,
    pollMs = 50,
    isProcessAlive = processAlive,
    sleep = delay,
    requireAudit = true,
  } = options
  if (existsSync(auditPath)) {
    const pid = readRuntimeAudit(auditPath, expectedRunId)
    const deadline = Date.now() + timeoutMs
    while (isProcessAlive(pid)) {
      if (Date.now() >= deadline) {
        throw new Error(`WDIO runtime PID ${String(pid)} did not exit within ${String(timeoutMs)}ms`)
      }
      await sleep(pollMs)
    }
  } else if (requireAudit) {
    throw new Error(`WDIO runtime audit is missing: ${auditPath}`)
  }
  rmSync(root, { recursive: true, force: true })
}
