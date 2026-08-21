import { invoke } from '@tauri-apps/api/core'
import './credentials.css'

type CredentialCommand =
  | 'credentials_set'
  | 'credentials_unset'
  | 'credentials_status'

interface CredentialInvokeArguments extends Record<string, unknown> {
  readonly promptToken: string
  readonly secret?: Uint8Array
}

export type CredentialInvoke = (
  command: CredentialCommand,
  args: CredentialInvokeArguments,
) => Promise<unknown>

interface SecretInput {
  value: string
}

interface PromptTokenSource {
  readonly __OPENLOOP_CREDENTIAL_PROMPT_TOKEN__?: unknown
}

declare global {
  interface Window {
    readonly __OPENLOOP_CREDENTIAL_PROMPT_TOKEN__?: unknown
  }
}

interface CredentialCommands {
  readonly set: (secret: Uint8Array) => Promise<unknown>
  readonly unset: () => Promise<unknown>
  readonly status: () => Promise<boolean>
}

const tauriInvoke: CredentialInvoke = (command, args) => invoke(command, args)

function requirePromptToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error('Credential prompt is unavailable')
  }
  return value
}

export function readPromptToken(source: PromptTokenSource): string {
  return requirePromptToken(source.__OPENLOOP_CREDENTIAL_PROMPT_TOKEN__)
}

export function createCredentialCommands(
  token: string,
  invokeCredential: CredentialInvoke = tauriInvoke,
): CredentialCommands {
  const promptToken = requirePromptToken(token)
  return {
    set: secret => invokeCredential('credentials_set', { promptToken, secret }),
    unset: () => invokeCredential('credentials_unset', { promptToken }),
    status: async () => {
      const configured = await invokeCredential('credentials_status', { promptToken })
      if (typeof configured !== 'boolean') {
        throw new TypeError('Credential status is unavailable')
      }
      return configured
    },
  }
}

export function createCredentialSubmitter(
  promptToken: string,
  invokeCredential: CredentialInvoke = tauriInvoke,
): (input: SecretInput) => Promise<boolean> {
  const commands = createCredentialCommands(promptToken, invokeCredential)
  let submitting = false

  return async (input: SecretInput): Promise<boolean> => {
    if (submitting) return false
    submitting = true
    const secret = new TextEncoder().encode(input.value)
    input.value = ''
    try {
      await commands.set(secret)
      return true
    } finally {
      secret.fill(0)
      submitting = false
    }
  }
}

function requiredElement<T extends Element>(
  selector: string,
  elementType: { new(): T },
): T {
  const element = document.querySelector(selector)
  if (element === null || !(element instanceof elementType)) {
    throw new Error('Credential prompt is unavailable')
  }
  return element
}

function initializePrompt(): void {
  const form = requiredElement('#credentials-form', HTMLFormElement)
  const input = requiredElement('#credential-secret', HTMLInputElement)
  const save = requiredElement('#credential-save', HTMLButtonElement)
  const remove = requiredElement('#credential-remove', HTMLButtonElement)
  const status = requiredElement('#credential-status', HTMLOutputElement)
  const promptToken = readPromptToken(window)
  const commands = createCredentialCommands(promptToken)
  const submit = createCredentialSubmitter(promptToken)
  let busy = false

  const setBusy = (value: boolean): void => {
    busy = value
    save.disabled = value
    remove.disabled = value
    input.disabled = value
  }
  const showStatus = (value: string, failed = false): void => {
    status.value = value
    status.dataset.failed = String(failed)
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    showStatus('Saving')
    void submit(input)
      .then((submitted) => {
        if (submitted) showStatus('Saved')
      })
      .catch(() => {
        showStatus('Unable to save', true)
        setBusy(false)
        input.focus()
      })
  })

  remove.addEventListener('click', () => {
    if (busy) return
    setBusy(true)
    input.value = ''
    showStatus('Removing')
    void commands.unset().catch(() => {
      showStatus('Unable to remove', true)
      setBusy(false)
      input.focus()
    })
  })

  void commands.status()
    .then((configured) => {
      showStatus(configured ? 'Configured' : 'Not configured')
    })
    .catch(() => {
      showStatus('Status unavailable', true)
    })
}

if (typeof document !== 'undefined') initializePrompt()
