import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { assertTauriFeatureContract } from './verify-tauri-features.mjs'

const cargoPath = 'apps/openloop-desktop/src-tauri/Cargo.toml'
const lockPath = 'apps/openloop-desktop/src-tauri/Cargo.lock'

describe('Tauri child WebView feature contract', () => {
  test('accepts the pinned macOS proxy feature set', () => {
    expect(() => {
      assertTauriFeatureContract(
        readFileSync(cargoPath, 'utf8'),
        readFileSync(lockPath, 'utf8'),
      )
    }).not.toThrow()
  })

  test('rejects a floating Tauri version or missing required feature', () => {
    const cargo = readFileSync(cargoPath, 'utf8')
      .replace('version = "=2.11.5"', 'version = "2.11.5"')
      .replace('features = []', 'features = ["unstable"]')
    expect(() => {
      assertTauriFeatureContract(cargo, readFileSync(lockPath, 'utf8'))
    }).toThrow(/Tauri version must be pinned|macos-proxy/iu)
  })
})
