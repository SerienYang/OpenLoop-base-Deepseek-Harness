import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const modulePath = './render-update-manifest.mjs'
const scriptPath = resolve(import.meta.dirname, 'render-update-manifest.mjs')
const temporaryRoots: string[] = []
const minisignSignature = `untrusted comment: signature from minisign secret key
RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=
trusted comment: timestamp:1555779966\tfile:test
QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==`
const tauriSignature = Buffer.from(minisignSignature).toString('base64')
const prehashedMinisignSignature = `untrusted comment: signature from minisign secret key
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=
trusted comment: timestamp:1556193335\tfile:test
y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==`
const prehashedTauriSignature = Buffer.from(prehashedMinisignSignature).toString('base64')
const updaterPublicKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgRTc2MjBGMTg0MkI0RTgxRgpSV1FmNkxSQ0dBOWk1M21sWWVjTzRJelQ1MVRHUHB2V3VjTlNDaDFDQk0wUVRhTG43M1k3R0ZPMwo='

interface RendererModule {
  readonly parseUpdateManifestArguments: (args: string[]) => Record<string, string>
  readonly renderUpdateManifest: (
    options: {
      readonly version: string
      readonly artifactUrl: string
      readonly artifact: string
      readonly signature: string
      readonly publicKey: string
      readonly notes: string
      readonly pubDate: string
      readonly out: string
    },
    dependencies?: { readonly trustedRoot: string },
  ) => { readonly bytes: string; readonly manifest: Record<string, unknown> }
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openloop-update-manifest-'))
  temporaryRoots.push(root)
  return root
}

function fixture(root: string): {
  readonly artifact: string
  readonly signature: string
  readonly out: string
  readonly options: {
    readonly version: string
    readonly artifactUrl: string
    readonly artifact: string
    readonly signature: string
    readonly publicKey: string
    readonly notes: string
    readonly pubDate: string
    readonly out: string
  }
} {
  const artifact = join(root, 'Openloop.app.tar.gz')
  const signature = join(root, 'Openloop.app.tar.gz.sig')
  const out = join(root, 'dist/latest-test-k1.json')
  writeFileSync(artifact, 'test')
  writeFileSync(signature, `${tauriSignature}\n`)
  return {
    artifact,
    signature,
    out,
    options: {
      version: '1.2.3-test.2',
      artifactUrl: 'https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-b-v1.2.3-test.2/Openloop.app.tar.gz',
      artifact,
      signature,
      publicKey: updaterPublicKey,
      notes: 'Task 14A B candidate',
      pubDate: '2026-08-20T12:34:56Z',
      out,
    },
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('signed Tauri update manifest renderer', () => {
  it('writes deterministic canonical Tauri v2 static JSON for darwin-aarch64', async () => {
    const { renderUpdateManifest } = await import(modulePath) as RendererModule
    const root = temporaryRoot()
    const { options, out } = fixture(root)

    const first = renderUpdateManifest(options, { trustedRoot: root })
    const firstBytes = readFileSync(out, 'utf8')
    const second = renderUpdateManifest(options, { trustedRoot: root })

    const expected = {
      version: '1.2.3-test.2',
      notes: 'Task 14A B candidate',
      pub_date: '2026-08-20T12:34:56Z',
      platforms: {
        'darwin-aarch64': {
          url: options.artifactUrl,
          signature: tauriSignature,
        },
      },
    }
    expect(first.manifest).toEqual(expected)
    expect(first.bytes).toBe(`${JSON.stringify(expected, null, 2)}\n`)
    expect(firstBytes).toBe(first.bytes)
    expect(second.bytes).toBe(first.bytes)
    expect(readdirSync(join(root, 'dist'))).toEqual(['latest-test-k1.json'])
  })

  it('parses every required option exactly once and rejects unknown options', async () => {
    const { parseUpdateManifestArguments } = await import(modulePath) as RendererModule
    const args = [
      '--version', '1.2.3',
      '--artifact-url', 'https://example.com/Openloop.app.tar.gz',
      '--artifact', 'Openloop.app.tar.gz',
      '--signature', 'bundle.sig',
      '--public-key', updaterPublicKey,
      '--notes', 'notes',
      '--pub-date', '2026-08-20T00:00:00Z',
      '--out', 'latest-test-k1.json',
    ]

    expect(parseUpdateManifestArguments(args)).toEqual({
      version: '1.2.3',
      artifactUrl: 'https://example.com/Openloop.app.tar.gz',
      artifact: 'Openloop.app.tar.gz',
      signature: 'bundle.sig',
      publicKey: updaterPublicKey,
      notes: 'notes',
      pubDate: '2026-08-20T00:00:00Z',
      out: 'latest-test-k1.json',
    })
    expect(() => parseUpdateManifestArguments([...args, '--version', '2.0.0']))
      .toThrow(/--version.*once/iu)
    expect(() => parseUpdateManifestArguments([...args, '--private-key', 'secret']))
      .toThrow(/unknown option --private-key/iu)
    expect(() => parseUpdateManifestArguments(args.slice(0, -2)))
      .toThrow(/--out is required/iu)
  })

  it.each([
    ['version', '1.2', /semver/iu],
    ['version', '01.2.3', /semver/iu],
    ['version', '1.2.3-01', /semver/iu],
    ['artifactUrl', 'http://example.com/Openloop.app.tar.gz', /HTTPS/iu],
    ['artifactUrl', 'https://user@example.com/Openloop.app.tar.gz', /URL/iu],
    ['artifactUrl', 'https://example.com/Openloop.app.tar.gz#fragment', /URL/iu],
    ['artifactUrl', 'https://example.com/releases/download/openloop-test-b-v1.2.3-test.2/Openloop.app.tar.gz', /GitHub|release/iu],
    ['artifactUrl', 'https://localhost/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-b-v1.2.3-test.2/Openloop.app.tar.gz', /GitHub|release/iu],
    ['artifactUrl', 'https://github.com:443/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-b-v1.2.3-test.2/Openloop.app.tar.gz', /port|GitHub|release/iu],
    ['artifactUrl', 'https://github.com:444/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-b-v1.2.3-test.2/Openloop.app.tar.gz', /port|GitHub|release/iu],
    ['artifactUrl', 'https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-b-v1.2.3-test.2/Openloop.app.tar.gz?redirect=https://example.com', /query|GitHub|release/iu],
    ['artifactUrl', 'https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-b-v1.2.3-test.2/Openloop.app.tar.gz/redirect', /path|GitHub|release/iu],
    ['artifactUrl', 'https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-b-v1.2.3-test.2%2Fignored/Openloop.app.tar.gz', /encoded|tag|GitHub|release/iu],
    ['artifactUrl', 'https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-a-v9.9.9/Openloop.app.tar.gz', /tag|version/iu],
    ['artifactUrl', 'https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-rolling/Openloop.app.tar.gz', /tag|immutable/iu],
    ['notes', '', /notes/iu],
    ['notes', '   ', /notes/iu],
    ['pubDate', '2026-08-20', /RFC3339/iu],
    ['pubDate', '2026-02-30T00:00:00Z', /RFC3339/iu],
  ] as const)('rejects malformed %s values', async (field, value, error) => {
    const { renderUpdateManifest } = await import(modulePath) as RendererModule
    const root = temporaryRoot()
    const { options } = fixture(root)

    expect(() => renderUpdateManifest({ ...options, [field]: value }, { trustedRoot: root }))
      .toThrow(error)
  })

  it('requires a regular .sig file containing a non-empty valid Tauri signature', async () => {
    const { renderUpdateManifest } = await import(modulePath) as RendererModule

    for (const value of ['', ' \n', 'not-base64', Buffer.from('not minisign').toString('base64')]) {
      const root = temporaryRoot()
      const { options, signature } = fixture(root)
      writeFileSync(signature, value)
      expect(() => renderUpdateManifest(options, { trustedRoot: root }))
        .toThrow(/signature/iu)
    }

    const wrongExtensionRoot = temporaryRoot()
    const wrong = fixture(wrongExtensionRoot)
    const textSignature = join(wrongExtensionRoot, 'signature.txt')
    writeFileSync(textSignature, tauriSignature)
    expect(() => renderUpdateManifest(
      { ...wrong.options, signature: textSignature },
      { trustedRoot: wrongExtensionRoot },
    )).toThrow(/\.sig/iu)

    const fifoRoot = temporaryRoot()
    const fifo = fixture(fifoRoot)
    rmSync(fifo.signature)
    execFileSync('mkfifo', [fifo.signature])
    expect(() => renderUpdateManifest(fifo.options, { trustedRoot: fifoRoot }))
      .toThrow(/regular file/iu)
  })

  it('verifies the signature against the exact local archive and current public key', async () => {
    const { renderUpdateManifest } = await import(modulePath) as RendererModule
    const root = temporaryRoot()
    const { options, artifact } = fixture(root)

    writeFileSync(artifact, 'Test')
    expect(() => renderUpdateManifest(options, { trustedRoot: root }))
      .toThrow(/signature|Minisign|verify/iu)
    writeFileSync(artifact, 'test')

    const decodedWrongKey = Buffer.from(updaterPublicKey, 'base64').toString('utf8')
    const [wrongComment, encodedWrongKey] = decodedWrongKey.trimEnd().split('\n')
    const wrongKeyBytes = Buffer.from(encodedWrongKey ?? '', 'base64')
    wrongKeyBytes[10] = (wrongKeyBytes[10] ?? 0) ^ 0xff
    const wrongPublicKey = Buffer.from(
      `${wrongComment ?? 'untrusted comment: wrong key'}\n${wrongKeyBytes.toString('base64')}\n`,
    ).toString('base64')
    expect(() => renderUpdateManifest(
      { ...options, publicKey: wrongPublicKey },
      { trustedRoot: root },
    )).toThrow(/signature|Minisign|key|verify/iu)
  })

  it('uses Tauri Minisign prehashed semantics for ED signatures', async () => {
    const { renderUpdateManifest } = await import(modulePath) as RendererModule
    const root = temporaryRoot()
    const { options, artifact, signature } = fixture(root)
    writeFileSync(signature, `${prehashedTauriSignature}\n`)

    writeFileSync(artifact, 'Test')
    expect(() => renderUpdateManifest(options, { trustedRoot: root }))
      .toThrow(/signature|Minisign|verify/iu)
    writeFileSync(artifact, 'test')
    expect(() => renderUpdateManifest(options, { trustedRoot: root })).not.toThrow()
  })

  it('rejects unsafe, overlapping, symlinked, and special output paths', async () => {
    const { renderUpdateManifest } = await import(modulePath) as RendererModule
    const root = temporaryRoot()
    const { options, signature } = fixture(root)
    const outside = temporaryRoot()

    expect(() => renderUpdateManifest(
      { ...options, out: join(outside, 'latest-test-k1.json') },
      { trustedRoot: root },
    )).toThrow(/trusted root|inside/iu)

    expect(() => renderUpdateManifest(
      { ...options, out: signature },
      { trustedRoot: root },
    )).toThrow(/overlap|input/iu)

    const hardlinkOut = join(root, 'hardlink.json')
    linkSync(signature, hardlinkOut)
    expect(() => renderUpdateManifest(
      { ...options, out: hardlinkOut },
      { trustedRoot: root },
    )).toThrow(/overlap|input/iu)

    const linkedParent = join(root, 'linked')
    symlinkSync(outside, linkedParent, 'dir')
    expect(() => renderUpdateManifest(
      { ...options, out: join(linkedParent, 'latest-test-k1.json') },
      { trustedRoot: root },
    )).toThrow(/symlink/iu)

    const directoryOut = join(root, 'directory.json')
    mkdirSync(directoryOut)
    expect(() => renderUpdateManifest(
      { ...options, out: directoryOut },
      { trustedRoot: root },
    )).toThrow(/file path|regular file/iu)
    expect(existsSync(join(outside, 'latest-test-k1.json'))).toBe(false)
  })

  it('makes the obsolete --test invocation fail with actionable usage instead of fake success', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--test'], { encoding: 'utf8' })

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/--test is not supported/iu)
    expect(result.stderr).toMatch(/--version/iu)
  })
})
