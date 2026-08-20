/** Independent AST inventory used to keep Cordis runtime catalogs fail-closed. */

import { globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { CordisCatalogModel } from '@deepseek-ai/dsh-typert-generator'
import ts from 'typescript'

const MERGE_HEAD = /declare module ['"]@deepseek-ai\/cordis['"]/

export interface CordisDeclarations {
  readonly contextKeys: ReadonlyMap<string, string>
  readonly eventNames: ReadonlyMap<string, string>
}

export interface CordisScanExemptions {
  readonly contextKeys: Readonly<Record<string, string>>
  readonly eventNames: Readonly<Record<string, string>>
}

/** Read every package-owned Cordis Context and Events declaration. */
export function scanCordisDeclarations(scanRoot: string): CordisDeclarations {
  const contextKeys = new Map<string, string>()
  const eventNames = new Map<string, string>()
  const files = globSync([
    'packages/*/*/src/**/*.ts',
    'packages/*/*/src/**/*.tsx',
  ], { cwd: scanRoot }).map(path => path.split(sep).join('/')).sort()

  for (const file of files) {
    const source = readFileSync(resolve(scanRoot, file), 'utf8')
    if (!MERGE_HEAD.test(source)) continue
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)

    for (const statement of sourceFile.statements) {
      if (!ts.isModuleDeclaration(statement)
        || !ts.isStringLiteral(statement.name)
        || statement.name.text !== '@deepseek-ai/cordis'
        || statement.body === undefined
        || !ts.isModuleBlock(statement.body)) continue

      for (const declaration of statement.body.statements) {
        if (!ts.isInterfaceDeclaration(declaration)) continue
        if (declaration.name.text === 'Context') {
          for (const member of declaration.members) {
            if (!ts.isPropertySignature(member)) continue
            const key = member.name.getText(sourceFile).replace(/^['"]|['"]$/g, '')
            if (!contextKeys.has(key)) contextKeys.set(key, file)
          }
        }
        if (declaration.name.text === 'Events') {
          for (const member of declaration.members) {
            if (member.name === undefined) continue
            const name = member.name.getText(sourceFile).replace(/^['"]|['"]$/g, '')
            if (!eventNames.has(name)) eventNames.set(name, file)
          }
        }
      }
    }
  }

  return { contextKeys, eventNames }
}

/**
 * Compare Typert output with an independent declaration inventory.
 * Unprojected declarations require named exemptions, and stale exemptions fail.
 */
export function cordisProjectionProblems(
  model: CordisCatalogModel,
  declarations: CordisDeclarations,
  exemptions: CordisScanExemptions,
): string[] {
  const problems: string[] = []
  const projectedContextKeys = new Set(model.services.map(service => service.key))
  const projectedEventNames = new Set(model.events.map(event => event.name))

  compareInventory(
    'ctx.',
    projectedContextKeys,
    declarations.contextKeys,
    exemptions.contextKeys,
    problems,
  )
  compareInventory(
    'event ',
    projectedEventNames,
    declarations.eventNames,
    exemptions.eventNames,
    problems,
  )
  return problems
}

function compareInventory(
  label: string,
  projected: ReadonlySet<string>,
  declared: ReadonlyMap<string, string>,
  exemptions: Readonly<Record<string, string>>,
  problems: string[],
): void {
  for (const [name, file] of declared) {
    const visible = projected.has(name)
    const exempt = Object.hasOwn(exemptions, name)
    const subject = `${label}${name}`
    if (!visible && !exempt) {
      problems.push(`${subject} (${file}) is declared but invisible to the Cordis runtime projection; make it projectable or add a named scan exemption.`)
    }
    if (visible && exempt) {
      problems.push(`${subject} is projected but still has a scan exemption; remove the stale exemption.`)
    }
  }

  for (const name of Object.keys(exemptions)) {
    if (!declared.has(name)) {
      problems.push(`${label}${name} has a scan exemption but no declaration; remove the stale exemption.`)
    }
  }
  for (const name of projected) {
    if (!declared.has(name)) {
      problems.push(`${label}${name} is projected but the independent AST scan finds no declaration; fix the scanner blind spot.`)
    }
  }
}
