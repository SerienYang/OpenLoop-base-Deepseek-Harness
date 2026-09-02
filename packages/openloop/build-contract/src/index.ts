/** Version and artifact identity contracts shared by OpenLoop build tooling. */

import z from '@deepseek-ai/schemastery'

/** Release channel carried by the immutable core build manifest. */
export type OpenloopBuildChannel = 'test' | 'stable'

/** Product identity signed into every Openloop core manifest. */
export interface OpenloopBrandManifest {
  readonly productName: 'Openloop'
  readonly documentSuffix: 'Openloop'
  readonly markAsset: string
  readonly heroTitle: 'Openloop'
  readonly previewLabel: '预览版'
  readonly attribution: 'Built on DeepSeek Harness'
}

/** Identity and compatibility versions that define one OpenLoop core build. */
export interface OpenloopBuildManifest {
  readonly appVersion: string
  readonly channel: OpenloopBuildChannel
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

/** Required build artifacts plus optional release-only products. */
export interface OpenloopArtifacts {
  readonly sidecar: string
  readonly runtimeSbom: string
  readonly web: string
  readonly bundleGraph: string
  readonly app?: string
  readonly dmg?: string
  readonly updater?: string
  readonly ffmpeg?: string
  readonly ffprobe?: string
}

/** Artifact identities bound to the exact bytes of one core manifest. */
export interface OpenloopArtifactManifest {
  readonly coreManifestSha256: string
  readonly artifacts: OpenloopArtifacts
}

const semverPattern = new RegExp(
  '^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)'
  + '(?:-(?:(?:0|[1-9]\\d*)|(?:\\d*[A-Za-z-][0-9A-Za-z-]*))'
  + '(?:\\.(?:(?:0|[1-9]\\d*)|(?:\\d*[A-Za-z-][0-9A-Za-z-]*)))*)?'
  + '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
  'u',
)
const sha256Pattern = /^[0-9a-f]{64}$/u
const dshCommitPattern = /^[0-9a-f]{40}$/u
// This validates transport structure only. Exact mark identity comes from the
// source SVG bytes inside the canonical, hash-bound, signed core manifest.
const svgDataUriPattern = /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/u

const semver = z.string().pattern(semverPattern).required()
const sha256 = z.string().pattern(sha256Pattern).required()
const positiveInteger = z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required()
const nonnegativeInteger = z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).required()
const brandSchema: z<OpenloopBrandManifest> = z.object({
  productName: z.const('Openloop').required(),
  documentSuffix: z.const('Openloop').required(),
  markAsset: z.string().pattern(svgDataUriPattern).required(),
  heroTitle: z.const('Openloop').required(),
  previewLabel: z.const('预览版').required(),
  attribution: z.const('Built on DeepSeek Harness').required(),
})

/** Schemastery schema for the immutable core build manifest. */
export const OpenloopBuildManifestSchema: z<OpenloopBuildManifest> = z.object({
  appVersion: semver,
  channel: z.union(['test', 'stable'] as const).required(),
  dshTag: z.string().min(1).required(),
  dshCommit: z.string().pattern(dshCommitPattern).required(),
  runtimeVersion: positiveInteger,
  bridgeProtocolVersion: positiveInteger,
  uiSdkVersion: semver,
  pluginPackageSpecVersion: semver,
  openloopDataVersion: nonnegativeInteger,
  dshDataVersion: nonnegativeInteger,
  brand: brandSchema.required(),
})

const optionalSha256 = z.string().pattern(sha256Pattern).default(
  undefined as unknown as string,
)

const artifactsSchema: z<OpenloopArtifacts> = z.object({
  sidecar: sha256,
  runtimeSbom: sha256,
  web: sha256,
  bundleGraph: sha256,
  app: optionalSha256,
  dmg: optionalSha256,
  updater: optionalSha256,
  ffmpeg: optionalSha256,
  ffprobe: optionalSha256,
})

/** Schemastery schema for hashes emitted after packaging. */
export const OpenloopArtifactManifestSchema: z<OpenloopArtifactManifest> = z.object({
  coreManifestSha256: sha256,
  artifacts: artifactsSchema.required(),
})

const buildFields = [
  'appVersion',
  'channel',
  'dshTag',
  'dshCommit',
  'runtimeVersion',
  'bridgeProtocolVersion',
  'uiSdkVersion',
  'pluginPackageSpecVersion',
  'openloopDataVersion',
  'dshDataVersion',
  'brand',
] as const
const brandFields = [
  'productName',
  'documentSuffix',
  'markAsset',
  'heroTitle',
  'previewLabel',
  'attribution',
] as const
const artifactFields = [
  'sidecar',
  'runtimeSbom',
  'web',
  'bundleGraph',
  'app',
  'dmg',
  'updater',
  'ffmpeg',
  'ffprobe',
] as const

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const known = new Set(fields)
  const unknown = Object.keys(value).filter(field => !known.has(field))
  if (unknown.length > 0) {
    throw new TypeError(`${label} contains unknown field ${unknown[0]}`)
  }
}

function resolveStrict<T>(schema: z<T>, value: unknown): T {
  return z.resolve(value, schema, {}, true)[0] as T
}

/** Validate unknown input as a closed OpenLoop core build manifest. */
export function parseOpenloopBuildManifest(value: unknown): OpenloopBuildManifest {
  const manifest = record(value, 'build manifest')
  assertExactFields(manifest, buildFields, 'build manifest')
  assertExactFields(record(manifest.brand, 'build manifest brand'), brandFields, 'build manifest brand')
  return resolveStrict(OpenloopBuildManifestSchema, value)
}

/** Validate unknown input as a closed OpenLoop artifact manifest. */
export function parseOpenloopArtifactManifest(value: unknown): OpenloopArtifactManifest {
  const manifest = record(value, 'artifact manifest')
  assertExactFields(manifest, ['coreManifestSha256', 'artifacts'], 'artifact manifest')
  const artifacts = record(manifest.artifacts, 'artifact manifest artifacts')
  assertExactFields(artifacts, artifactFields, 'artifact manifest artifacts')
  return resolveStrict(OpenloopArtifactManifestSchema, value)
}
