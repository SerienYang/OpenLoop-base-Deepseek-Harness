import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const REQUIRED_VERSION = '=2.11.5'
const REQUIRED_FEATURES = ['unstable', 'macos-proxy']

function parseFeatures(dependencyBody) {
  const match = /features\s*=\s*\[([^\]]*)\]/u.exec(dependencyBody)
  if (match === null) return []
  return [...match[1].matchAll(/"([^"]+)"/gu)].map(value => value[1])
}

export function assertTauriFeatureContract(cargoToml, cargoLock) {
  const dependency = /tauri\s*=\s*\{([^}]*)\}/su.exec(cargoToml)?.[1]
  if (dependency === undefined) {
    throw new Error('Tauri dependency must be declared as an inline table')
  }
  const version = /version\s*=\s*"([^"]+)"/u.exec(dependency)?.[1]
  if (version !== REQUIRED_VERSION) {
    throw new Error(`Tauri version must be pinned to ${REQUIRED_VERSION}`)
  }
  const features = new Set(parseFeatures(dependency))
  for (const required of REQUIRED_FEATURES) {
    if (!features.has(required)) {
      throw new Error(`Tauri dependency must enable ${required}`)
    }
  }
  if (!/\[\[package\]\]\s*name\s*=\s*"tauri"\s*version\s*=\s*"2\.11\.5"/su.test(cargoLock)) {
    throw new Error('Cargo.lock must resolve Tauri 2.11.5')
  }
}

async function main() {
  const root = resolve(import.meta.dirname, '../..')
  const cargoToml = await readFile(resolve(root, 'apps/openloop-desktop/src-tauri/Cargo.toml'), 'utf8')
  const cargoLock = await readFile(resolve(root, 'apps/openloop-desktop/src-tauri/Cargo.lock'), 'utf8')
  assertTauriFeatureContract(cargoToml, cargoLock)
  process.stdout.write('verify-tauri-features: verified tauri 2.11.5 unstable + macos-proxy\n')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main()
}
