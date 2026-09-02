import { appendFileSync } from 'node:fs'

interface WdioTestResult {
  readonly error?: Error
  readonly passed: boolean
  readonly skipped: boolean
}

export function writeWdioResultAudit(
  audit: string,
  title: string,
  result: WdioTestResult,
): void {
  const state = result.skipped
    ? 'skipped'
    : result.passed && result.error === undefined ? 'passed' : 'failed'
  appendFileSync(audit, `${JSON.stringify({ state, title })}\n`)
}
