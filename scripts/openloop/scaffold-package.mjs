#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dump, load } from 'js-yaml'

const faces = new Set(['host', 'client', 'pure'])
const packageNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ownedPaths = ['package.json', 'src', 'README.md', 'tsconfig.json']
const cordisPackage = '@deepseek-ai/cordis'

function optionValue(args, index, option) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return value
}

export function parseScaffoldArguments(args) {
  const options = { clientBundle: false }
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    switch (option) {
      case '--name':
        options.name = optionValue(args, index, option)
        index += 1
        break
      case '--face':
        options.face = optionValue(args, index, option)
        index += 1
        break
      case '--client-bundle':
        options.clientBundle = true
        break
      case '--bundle-row':
        options.bundleRow = optionValue(args, index, option)
        index += 1
        break
      case '--service':
        options.service = optionValue(args, index, option)
        index += 1
        break
      default:
        throw new Error(`unknown option ${option}`)
    }
  }
  if (options.name === undefined) throw new Error('--name is required')
  if (options.face === undefined) throw new Error('--face is required')
  return options
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function validateName(value, option) {
  if (!packageNamePattern.test(value)) {
    throw new Error(`${option} must be a lowercase kebab-case name`)
  }
}

function aggregatePath(root, face) {
  return join(root, face === 'client' ? 'tsconfig.client.json' : 'tsconfig.host.json')
}

function packageReference(name) {
  return `./packages/openloop/${name}`
}

function prepareAggregate(root, name, face) {
  const expectedPath = aggregatePath(root, face)
  const otherPath = aggregatePath(root, face === 'client' ? 'host' : 'client')
  const expected = readJson(expectedPath)
  const other = readJson(otherPath)
  const reference = packageReference(name)
  const expectedCount = (expected.references ?? []).filter(entry => entry.path === reference).length
  const otherCount = (other.references ?? []).filter(entry => entry.path === reference).length

  if (expectedCount > 1 || otherCount > 0) {
    throw new Error(`${reference} must belong to exactly one aggregate`)
  }
  if (expectedCount === 0) {
    expected.references = [...(expected.references ?? []), { path: reference }]
  }
  return { path: expectedPath, config: expected }
}

function bundleRows(document) {
  if (!Array.isArray(document)) return []
  return document.flatMap(item => {
    if (typeof item !== 'object' || item === null || !Array.isArray(item.insert)) return []
    return item.insert
  })
}

function prepareBundle(root, bundleName, packageName, rowId) {
  validateName(bundleName, '--bundle-row')
  const directory = join(root, 'packages', 'openloop', bundleName)
  const manifestPath = join(directory, 'package.json')
  const patchPath = join(directory, 'cordis.patch.yml')
  if (!existsSync(manifestPath) || !existsSync(patchPath)) {
    throw new Error(`bundle ${bundleName} must contain package.json and cordis.patch.yml`)
  }

  const manifest = readJson(manifestPath)
  const document = load(readFileSync(patchPath, 'utf8')) ?? []
  if (!Array.isArray(document)) {
    throw new Error(`bundle ${bundleName} cordis.patch.yml must contain a list`)
  }
  if (bundleRows(document).some(row => row?.id === rowId || row?.name === packageName)) {
    throw new Error(`bundle ${bundleName} already contains row ${rowId}`)
  }

  const existingRange = manifest.dependencies?.[packageName]
  if (existingRange !== undefined && existingRange !== 'workspace:*') {
    throw new Error(`bundle ${bundleName} dependency ${packageName} already uses ${existingRange}`)
  }
  manifest.dependencies = {
    ...(manifest.dependencies ?? {}),
    [packageName]: 'workspace:*',
  }
  document.push({ insert: [{ id: rowId, name: packageName }] })
  return { manifestPath, manifest, patchPath, document }
}

function packageManifest({ name, face, clientBundle, service, cordisPlugin }) {
  const packageName = `@openloop/${name}`
  const manifest = {
    name: packageName,
    private: true,
    type: 'module',
    main: 'lib/index.js',
    types: 'lib/types/index.d.ts',
    exports: {
      '.': {
        types: './lib/types/index.d.ts',
        default: './lib/index.js',
      },
    },
    openloop: {
      face,
      ...(cordisPlugin ? { cordisPlugin: true } : {}),
      ...(service === undefined ? {} : { service }),
    },
  }
  if (clientBundle) {
    manifest.exports['./client'] = {
      types: './lib/types/client/index.d.ts',
      default: './lib/client.js',
    }
  }
  if (cordisPlugin) {
    manifest.peerDependencies = { [cordisPackage]: 'workspace:^' }
    manifest.devDependencies = { [cordisPackage]: 'workspace:^' }
  }
  return manifest
}

function packageTsconfig(face, cordisPlugin) {
  return {
    extends: face === 'client'
      ? '../../../tsconfig.base.client.json'
      : '../../../tsconfig.base.json',
    compilerOptions: {
      rootDir: 'src',
      outDir: 'lib/types',
    },
    include: ['src'],
    ...(cordisPlugin
      ? { references: [{ path: '../../../vendor/cordis' }] }
      : {}),
  }
}

function packageReadme(name, face, service) {
  const serviceLine = service === undefined
    ? 'This package does not declare a Cordis service.'
    : `Cordis service key: \`${service}\`.`
  return [
    `# @openloop/${name}`,
    '',
    `Private OpenLoop package on the \`${face}\` compiler face.`,
    '',
    serviceLine,
    '',
  ].join('\n')
}

function packageIndex(name) {
  return `/** @openloop/${name} package entry. */\nexport {}\n`
}

function clientIndex(name) {
  return `/** @openloop/${name} browser bundle entry. */\nexport {}\n`
}

function clientBundleConfig(name) {
  return [
    "import { clientBundle } from '../../client/tsdown.client.ts'",
    '',
    `export default clientBundle('@openloop/${name}', ['lib/types/index.js'])`,
    '',
  ].join('\n')
}

function validateTargetDirectory(root, name) {
  const directory = join(root, 'packages', 'openloop', name)
  if (!existsSync(directory)) return directory

  for (const ownedPath of ownedPaths) {
    if (existsSync(join(directory, ownedPath))) {
      throw new Error(`refusing to overwrite packages/openloop/${name}/${ownedPath}`)
    }
  }
  const unexpected = readdirSync(directory).filter(entry => entry !== 'tests')
  if (unexpected.length > 0) {
    throw new Error(`packages/openloop/${name} must be absent or contain only tests`)
  }
  return directory
}

export function scaffoldPackage(options) {
  const {
    root,
    name,
    face,
    clientBundle = false,
    bundleRow,
    service,
  } = options
  if (typeof root !== 'string') throw new Error('root is required')
  validateName(name, '--name')
  if (!faces.has(face)) throw new Error('--face must be host, client, or pure')
  if (clientBundle && face !== 'client') {
    throw new Error('--client-bundle requires --face client')
  }
  if (service !== undefined) validateName(service, '--service')

  const directory = validateTargetDirectory(root, name)
  const aggregate = prepareAggregate(root, name, face)
  const fullPackageName = `@openloop/${name}`
  const rowId = service ?? name
  const bundle = bundleRow === undefined
    ? undefined
    : prepareBundle(root, bundleRow, fullPackageName, rowId)
  const cordisPlugin = clientBundle || service !== undefined || bundle !== undefined

  mkdirSync(join(directory, 'src'), { recursive: true })
  writeJson(
    join(directory, 'package.json'),
    packageManifest({ name, face, clientBundle, service, cordisPlugin }),
  )
  writeFileSync(join(directory, 'src', 'index.ts'), packageIndex(name))
  if (clientBundle) {
    mkdirSync(join(directory, 'src', 'client'), { recursive: true })
    writeFileSync(join(directory, 'src', 'client', 'index.ts'), clientIndex(name))
    writeFileSync(join(directory, 'tsdown.config.ts'), clientBundleConfig(name))
  }
  writeFileSync(join(directory, 'README.md'), packageReadme(name, face, service))
  writeJson(join(directory, 'tsconfig.json'), packageTsconfig(face, cordisPlugin))
  writeJson(aggregate.path, aggregate.config)

  if (bundle !== undefined) {
    writeJson(bundle.manifestPath, bundle.manifest)
    writeFileSync(bundle.patchPath, dump(bundle.document, { lineWidth: -1, noRefs: true }))
  }

  return relative(root, directory)
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    const options = parseScaffoldArguments(process.argv.slice(2))
    const root = resolve(import.meta.dirname, '../..')
    console.log(scaffoldPackage({ root, ...options }))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
