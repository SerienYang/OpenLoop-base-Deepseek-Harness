import { invoke } from '@tauri-apps/api/core'
import openloopMark from '../../../assets/brand/openloop-mark.svg?no-inline'
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

root.style.setProperty('--openloop-brand-mark', `url("${openloopMark}")`)
root.innerHTML = `
  <main class="bootstrap" aria-labelledby="bootstrap-title">
    <span class="brand-mark" aria-hidden="true"></span>
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

function text(id: string, value: string): void {
  const element = document.querySelector<HTMLElement>(`#${id}`)
  if (element === null) throw new Error(`Openloop bootstrap element is missing: ${id}`)
  element.textContent = value
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

void bootstrap()
