import { invoke } from '@tauri-apps/api/core'
import openloopIcon from '../../../assets/brand/openloop-icon.svg'
import './styles.css'

export interface OpenloopBrandManifest {
  readonly productName: string
  readonly documentSuffix: string
  readonly markAsset: string
  readonly heroTitle: string
  readonly previewLabel: string
  readonly attribution: string
}

export interface OpenloopBuildManifest {
  readonly appVersion: string
  readonly channel: 'test' | 'stable'
  readonly dshTag: string
  readonly dshCommit: string
  readonly runtimeVersion: number
  readonly bridgeProtocolVersion: number
  readonly uiSdkVersion: string
  readonly pluginPackageSpecVersion: string
  readonly openloopDataVersion: number
  readonly dshDataVersion: number
  readonly brand: OpenloopBrandManifest
}

const root = document.querySelector<HTMLDivElement>('#app')
if (root === null) throw new Error('Openloop bootstrap root is missing')

root.innerHTML = `
  <main class="bootstrap" aria-labelledby="bootstrap-title">
    <img class="brand-mark" src="${openloopIcon}" alt="" aria-hidden="true">
    <header>
      <p class="eyebrow">Desktop foundation</p>
      <h1 id="bootstrap-title">Openloop bootstrap</h1>
      <p id="bootstrap-status" class="status" role="status" aria-live="polite">
        Reading embedded build manifest
      </p>
    </header>
    <dl class="build-facts" aria-label="Embedded build identity">
      <div>
        <dt>Version</dt>
        <dd id="build-version">Pending</dd>
      </div>
      <div>
        <dt>Channel</dt>
        <dd id="build-channel">Pending</dd>
      </div>
      <div>
        <dt>DSH SHA</dt>
        <dd id="build-sha">Pending</dd>
      </div>
    </dl>
  </main>
`

interface E2eActionResult {
  readonly state: string
  readonly version?: string
  readonly name?: string
  readonly windowLabel?: string
}

function text(id: string, value: string): void {
  const element = document.querySelector<HTMLElement>(`#${id}`)
  if (element === null) throw new Error(`Openloop bootstrap element is missing: ${id}`)
  element.textContent = value
}

function e2eElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector)
  if (element === null) throw new Error(`Openloop E2E element is missing: ${selector}`)
  return element
}

async function e2eAction(action: string): Promise<E2eActionResult> {
  return await invoke<E2eActionResult>('openloop_e2e_action', { action })
}

async function installE2eControls(): Promise<void> {
  await Promise.all([
    import('@wdio/tauri-plugin'),
    import('./e2e.css'),
  ])
  e2eElement('#app').insertAdjacentHTML('beforeend', `
    <section class="e2e-controls" aria-label="Openloop desktop E2E">
      <h2>Desktop flows</h2>
      <p data-e2e="update-status">Ready to check</p>
      <p data-e2e="update-version"></p>
      <button type="button" data-e2e="check-update">Check for updates</button>
      <button type="button" data-e2e="install-update">Install and restart</button>
      <button type="button" data-e2e="replace-credential">Replace credential</button>
      <button type="button" data-e2e="add-workspace">Add Workspace</button>
      <p data-e2e="workspace-entry"></p>
      <div role="dialog" aria-label="Replace credential" hidden>
        <p>Credential sheet attached to main window</p>
        <button type="button" data-e2e="cancel-credential">Cancel</button>
      </div>
    </section>
  `)
  e2eElement('[data-e2e="check-update"]').addEventListener('click', () => {
    void e2eAction('check-update').then((result) => {
      e2eElement('[data-e2e="update-status"]').textContent = 'Update available'
      e2eElement('[data-e2e="update-version"]').textContent = result.version ?? ''
    })
  })
  e2eElement('[data-e2e="install-update"]').addEventListener('click', () => {
    void e2eAction('install-update').then((result) => {
      if (result.windowLabel !== 'main') throw new Error('install confirmation left main window')
      e2eElement('[data-e2e="update-status"]').textContent = result.state === 'cancelled'
        ? 'Installation cancelled'
        : result.state
    })
  })
  e2eElement('[data-e2e="replace-credential"]').addEventListener('click', () => {
    void e2eAction('replace-credential').then((result) => {
      if (result.windowLabel !== 'main') throw new Error('credential sheet left main window')
      e2eElement('[role="dialog"][aria-label="Replace credential"]').hidden = false
    })
  })
  e2eElement('[data-e2e="cancel-credential"]').addEventListener('click', () => {
    e2eElement('[role="dialog"][aria-label="Replace credential"]').hidden = true
  })
  e2eElement('[data-e2e="add-workspace"]').addEventListener('click', () => {
    void e2eAction('add-workspace').then((result) => {
      if (result.windowLabel !== 'main') throw new Error('Workspace picker left main window')
      e2eElement('[data-e2e="workspace-entry"]').textContent = result.name ?? ''
    })
  })
}

async function bootstrap(): Promise<void> {
  try {
    const manifest = await invoke<OpenloopBuildManifest>('build_manifest')
    text('build-version', manifest.appVersion)
    text('build-channel', manifest.channel)
    text('build-sha', manifest.dshCommit)
    text('bootstrap-status', 'Embedded build manifest ready')
  } catch {
    text('build-version', 'Unavailable')
    text('build-channel', 'Unavailable')
    text('build-sha', 'Unavailable')
    text('bootstrap-status', 'Build manifest unavailable')
    document.documentElement.dataset.bootstrap = 'failed'
  }
}

if (import.meta.env.MODE === 'e2e') void installE2eControls()
void bootstrap()
