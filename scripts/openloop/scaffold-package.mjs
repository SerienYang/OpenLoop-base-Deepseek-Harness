#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dump, load } from 'js-yaml'
import ts from 'typescript'

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
  const normalized = args[0] === '--' ? args.slice(1) : args
  const options = { clientBundle: false }
  for (let index = 0; index < normalized.length; index += 1) {
    const option = normalized[index]
    switch (option) {
      case '--name':
        options.name = optionValue(normalized, index, option)
        index += 1
        break
      case '--face':
        options.face = optionValue(normalized, index, option)
        index += 1
        break
      case '--client-bundle':
        options.clientBundle = true
        break
      case '--bundle-row':
        options.bundleRow = optionValue(normalized, index, option)
        index += 1
        break
      case '--service':
        options.service = optionValue(normalized, index, option)
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

function readJsonConfig(path) {
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'))
  if (parsed.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'))
  }
  return parsed.config
}

function appendAggregateReference(path, reference) {
  const source = readFileSync(path, 'utf8')
  const sourceFile = ts.parseJsonText(path, source)
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0]
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  }
  const statement = sourceFile.statements[0]
  const object = statement !== undefined
    && ts.isExpressionStatement(statement)
    && ts.isObjectLiteralExpression(statement.expression)
    ? statement.expression
    : undefined
  const property = object?.properties.find(property =>
    ts.isPropertyAssignment(property)
      && property.name.getText(sourceFile).replace(/^["']|["']$/gu, '') === 'references')
  if (property === undefined
    || !ts.isPropertyAssignment(property)
    || !ts.isArrayLiteralExpression(property.initializer)) {
    throw new Error(`${path} must contain a references array`)
  }

  const array = property.initializer
  const lineStart = source.lastIndexOf('\n', property.getStart(sourceFile) - 1) + 1
  const indent = source.slice(lineStart, property.getStart(sourceFile))
  const entry = `{ "path": ${JSON.stringify(reference)} }`
  const insertion = array.elements.length === 0
    ? `\n${indent}  ${entry}\n${indent}`
    : `,\n${indent}  ${entry}`
  return `${source.slice(0, array.elements.end)}${insertion}${source.slice(array.elements.end)}`
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`
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
  const expected = readJsonConfig(expectedPath)
  const other = readJsonConfig(otherPath)
  const reference = packageReference(name)
  const expectedCount = (expected.references ?? []).filter(entry => entry.path === reference).length
  const otherCount = (other.references ?? []).filter(entry => entry.path === reference).length

  if (expectedCount > 1 || otherCount > 0) {
    throw new Error(`${reference} must belong to exactly one aggregate`)
  }
  return {
    path: expectedPath,
    content: expectedCount === 0
      ? appendAggregateReference(expectedPath, reference)
      : readFileSync(expectedPath, 'utf8'),
  }
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
    manifest.dsh = {
      client: {
        inject: [],
        platform: 'web',
      },
    }
    manifest.scripts = {
      bundle: 'tsdown',
      watch: 'tsdown --watch',
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

function namespacePlugin(name, description) {
  return [
    `/** ${description} */`,
    "import type { Context } from '@deepseek-ai/cordis'",
    '',
    '/** Stable Cordis plugin name. */',
    `export const name = '${name}'`,
    '',
    '/** Minimal lifecycle entry; add product contributions through this context. */',
    'export function apply(_ctx: Context): void {}',
    '',
  ].join('\n')
}

function servicePlugin(service) {
  const className = `OpenLoop${service
    .split('-')
    .map(part => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join('')}Service`
  return [
    '/** Minimal Cordis Service plugin generated by the OpenLoop scaffolder. */',
    "import { Context, Service } from '@deepseek-ai/cordis'",
    '',
    "declare module '@deepseek-ai/cordis' {",
    '  interface Context {',
    `    '${service}': ${className}`,
    '  }',
    '}',
    '',
    `/** Service registered as ctx[${JSON.stringify(service)}]. */`,
    `export class ${className} extends Service {`,
    '  constructor(ctx: Context) {',
    `    super(ctx, '${service}')`,
    '  }',
    '}',
    '',
    `export default ${className}`,
    '',
  ].join('\n')
}

function packageIndex(name, service, cordisPlugin) {
  if (service !== undefined) return servicePlugin(service)
  if (cordisPlugin) {
    return namespacePlugin(name, `@openloop/${name} Cordis plugin entry.`)
  }
  return `/** @openloop/${name} package entry. */\nexport {}\n`
}

function clientIndex(name) {
  return namespacePlugin(name, `@openloop/${name} browser bundle entry.`)
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

function transactionDirectories(root, outputs) {
  const directories = new Set()
  for (const output of outputs) {
    let current = dirname(output.path)
    while (current !== root) {
      if (!existsSync(current)) directories.add(current)
      const parent = dirname(current)
      if (parent === current) throw new Error(`transaction output escapes root: ${output.path}`)
      current = parent
    }
  }
  return [...directories].sort((left, right) => left.length - right.length)
}

function writeTransaction(root, outputs, dependencies) {
  const rename = dependencies.rename ?? renameSync
  const originals = new Map(outputs.map(output => [
    output.path,
    existsSync(output.path) ? readFileSync(output.path) : undefined,
  ]))
  const directories = transactionDirectories(root, outputs)
  const nonce = `${process.pid}-${Date.now()}`
  const staged = outputs.map((output, index) => ({
    ...output,
    temporary: `${output.path}.openloop-scaffold-${nonce}-${index}.tmp`,
  }))

  try {
    for (const directory of directories) mkdirSync(directory)
    for (const output of staged) writeFileSync(output.temporary, output.content)
    for (const output of staged) rename(output.temporary, output.path)
  } catch (error) {
    const rollbackErrors = []
    for (const output of staged) {
      if (!existsSync(output.temporary)) continue
      try {
        unlinkSync(output.temporary)
      } catch (cleanupError) {
        rollbackErrors.push(cleanupError)
      }
    }
    for (const output of [...outputs].reverse()) {
      const original = originals.get(output.path)
      try {
        if (original === undefined) {
          if (existsSync(output.path)) unlinkSync(output.path)
          continue
        }
        const temporary = `${output.path}.openloop-rollback-${nonce}.tmp`
        writeFileSync(temporary, original)
        renameSync(temporary, output.path)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    for (const directory of [...directories].reverse()) {
      if (!existsSync(directory) || readdirSync(directory).length > 0) continue
      try {
        rmdirSync(directory)
      } catch (cleanupError) {
        rollbackErrors.push(cleanupError)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'scaffold transaction and rollback failed')
    }
    throw error
  }
}

export function scaffoldPackage(options, dependencies = {}) {
  const {
    root: requestedRoot,
    name,
    face,
    clientBundle = false,
    bundleRow,
    service,
  } = options
  if (typeof requestedRoot !== 'string') throw new Error('root is required')
  const root = resolve(requestedRoot)
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
  const outputs = [
    {
      path: join(directory, 'package.json'),
      content: jsonText(packageManifest({ name, face, clientBundle, service, cordisPlugin })),
    },
    {
      path: join(directory, 'src', 'index.ts'),
      content: packageIndex(name, service, cordisPlugin),
    },
  ]
  if (clientBundle) {
    outputs.push(
      {
        path: join(directory, 'src', 'client', 'index.ts'),
        content: clientIndex(name),
      },
      {
        path: join(directory, 'tsdown.config.ts'),
        content: clientBundleConfig(name),
      },
    )
  }
  outputs.push(
    {
      path: join(directory, 'README.md'),
      content: packageReadme(name, face, service),
    },
    {
      path: join(directory, 'tsconfig.json'),
      content: jsonText(packageTsconfig(face, cordisPlugin)),
    },
    {
      path: aggregate.path,
      content: aggregate.content,
    },
  )

  if (bundle !== undefined) {
    outputs.push(
      {
        path: bundle.manifestPath,
        content: jsonText(bundle.manifest),
      },
      {
        path: bundle.patchPath,
        content: dump(bundle.document, { lineWidth: -1, noRefs: true }),
      },
    )
  }

  writeTransaction(root, outputs, dependencies)
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
