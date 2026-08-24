import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(resolve(import.meta.dirname, '../../../..', path), 'utf8')

describe('transcript-only zoom styles', () => {
  it('maps the Openloop scale into the chat column', () => {
    const css = read('packages/client/ui-conversation/src/client/chat/ChatView.module.css')
    expect(css).toContain('--dsh-chat-text-scale: var(--openloop-chat-text-scale, 1)')
  })

  it('scales message prose without scaling message action controls', () => {
    const assistant = read('packages/client/ui-conversation/src/client/chat/AssistantMarkdown.module.css')
    const message = read('packages/client/ui-conversation/src/client/chat/MessageItem.module.css')
    const actions = read('packages/client/ui-conversation/src/client/chat/MessageIconActions.module.css')
    expect(assistant).toContain('calc(16px * var(--dsh-chat-text-scale, 1))')
    expect(message).toContain('calc(16px * var(--dsh-chat-text-scale, 1))')
    expect(actions).not.toContain('--dsh-chat-text-scale')
  })

  it('scales Markdown tokens only under the chat-local variable', () => {
    const css = read('packages/client/ui-conversation/src/client/chat/ChatView.module.css')
    expect(css).toContain('--dsw-font-markdown-base:')
    expect(css).toContain('--dsw-font-markdown-code-block:')
    expect(css).not.toContain('.copyButton')
  })

  it('allows scaled reasoning rows to grow without changing shared disclosure chrome', () => {
    const reasoning = read('packages/client/ui-conversation/src/client/chat/ReasoningRow.module.css')
    const shared = read('packages/client/ui-primitives/src/DisclosureRow.module.css')
    expect(reasoning).toMatch(/\.row\s*\{[^}]*height:\s*auto;[^}]*min-height:\s*24px;/su)
    expect(reasoning).toContain('calc(14px * var(--dsh-chat-text-scale, 1))')
    expect(shared).not.toContain('--dsh-chat-text-scale')
  })
})
