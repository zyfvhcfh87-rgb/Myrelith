/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { cwd } from 'node:process'
import * as ts from 'typescript'
import { describe, expect, test } from 'vitest'
import { CURRENT_TIMELINE_SCHEMA_VERSION } from '../domain/projectFile'

interface ImportEdge {
  from: string
  to: string | null
  specifier: string
  typeOnly: boolean
  line: number
}

const SOURCE_ROOT = resolve(cwd(), 'src')
const MODULE_EXTENSIONS = ['.ts', '.tsx'] as const

function sourceFiles(directory = SOURCE_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return MODULE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
      ? [path]
      : []
  })
}

function moduleName(path: string): string {
  return relative(SOURCE_ROOT, path).split(sep).join('/')
}

function isTestModule(path: string): boolean {
  const name = moduleName(path)
  return name.startsWith('test/')
    || /\.(?:test|spec)\.[^.]+$/.test(name)
    || name.endsWith('.d.ts')
}

function importDeclarationIsTypeOnly(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (!clause) return false
  if (clause.isTypeOnly) return true
  if (clause.name || !clause.namedBindings) return false
  return ts.isNamedImports(clause.namedBindings)
    && clause.namedBindings.elements.length > 0
    && clause.namedBindings.elements.every((element) => element.isTypeOnly)
}

function resolveRelativeModule(
  importer: string,
  specifier: string,
  knownModules: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(importer), specifier)
  const candidates = [
    base,
    ...MODULE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...MODULE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ]
  return candidates.find((candidate) => knownModules.has(candidate)) ?? null
}

function importsFor(
  path: string,
  knownModules: ReadonlySet<string>,
): ImportEdge[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const edges: ImportEdge[] = []

  const addEdge = (
    specifier: string,
    typeOnly: boolean,
    node: ts.Node,
  ): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
    edges.push({
      from: path,
      to: resolveRelativeModule(path, specifier, knownModules),
      specifier,
      typeOnly,
      line: line + 1,
    })
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      addEdge(
        node.moduleSpecifier.text,
        importDeclarationIsTypeOnly(node),
        node,
      )
    } else if (
      ts.isExportDeclaration(node)
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      addEdge(node.moduleSpecifier.text, node.isTypeOnly, node)
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
    ) {
      addEdge(node.arguments[0].text, false, node)
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return edges
}

function area(path: string): string {
  return moduleName(path).split('/')[0]
}

function edgeLabel(edge: ImportEdge): string {
  return `${moduleName(edge.from)}:${edge.line} -> ${edge.specifier}`
}

function boundaryViolations(edges: readonly ImportEdge[]): string[] {
  const violations: string[] = []
  const runtimeAreas = new Set(['engine', 'pipeline', 'workers'])
  const stateForbidden = new Set(['ui', 'engine', 'pipeline', 'workers'])
  const uiForbidden = new Set(['engine', 'pipeline', 'workers'])
  const workerProtocols = new Set([
    'workers/decode-protocol.ts',
    'workers/render-protocol.ts',
  ])

  for (const edge of edges) {
    const fromArea = area(edge.from)
    if (
      runtimeAreas.has(fromArea)
      && (edge.specifier === 'react' || edge.specifier.startsWith('react/'))
    ) {
      violations.push(`${edgeLabel(edge)} imports React from a runtime module`)
    }
    if (!edge.to) continue

    const toArea = area(edge.to)
    const fromName = moduleName(edge.from)
    const toName = moduleName(edge.to)

    if (fromArea === 'domain' && toArea !== 'domain') {
      violations.push(`${edgeLabel(edge)} crosses domain's pure-TS boundary`)
    }
    if (fromArea === 'state' && stateForbidden.has(toArea)) {
      violations.push(`${edgeLabel(edge)} reverses the state dependency direction`)
    }
    if (
      fromArea === 'ui'
      && fromName.endsWith('.tsx')
      && uiForbidden.has(toArea)
    ) {
      violations.push(`${edgeLabel(edge)} bypasses the app controller facade`)
    }
    if (
      runtimeAreas.has(fromArea)
      && new Set(['app', 'state', 'ui']).has(toArea)
    ) {
      violations.push(`${edgeLabel(edge)} couples runtime code to app/UI state`)
    }
    if (
      fromArea === 'codecs'
      && toArea !== 'codecs'
      && toArea !== 'domain'
    ) {
      violations.push(`${edgeLabel(edge)} breaks the codecs leaf boundary`)
    }

    if (workerProtocols.has(toName) && !edge.typeOnly) {
      violations.push(`${edgeLabel(edge)} must import the worker protocol as type-only`)
    }

    if (
      fromName === 'workers/render.worker.ts'
      && toName === 'workers/decode.worker.ts'
      && !edge.typeOnly
    ) {
      violations.push(`${edgeLabel(edge)} would register the decode worker at runtime`)
    }

    if (
      runtimeAreas.has(fromArea)
      && runtimeAreas.has(toArea)
      && fromArea !== toArea
    ) {
      const sanctioned = workerProtocols.has(toName) && edge.typeOnly
        || (
          fromArea === 'workers'
          && toName === 'engine/frame-cache.ts'
        )
        || (
          fromName === 'workers/render.worker.ts'
          && new Set([
            'pipeline/render.ts',
            'pipeline/static-image.ts',
          ]).has(toName)
        )
      if (!sanctioned) {
        violations.push(`${edgeLabel(edge)} is not a sanctioned runtime cross-import`)
      }
    }
  }

  return violations
}

function runtimeCycles(edges: readonly ImportEdge[]): string[] {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    if (!edge.to || edge.typeOnly) continue
    const targets = adjacency.get(edge.from) ?? []
    targets.push(edge.to)
    adjacency.set(edge.from, targets)
  }

  const visited = new Set<string>()
  const active = new Set<string>()
  const stack: string[] = []
  const cycles = new Set<string>()

  const visit = (module: string): void => {
    if (visited.has(module)) return
    active.add(module)
    stack.push(module)

    for (const target of adjacency.get(module) ?? []) {
      if (active.has(target)) {
        const cycleStart = stack.indexOf(target)
        const cycle = [...stack.slice(cycleStart), target]
          .map(moduleName)
          .join(' -> ')
        cycles.add(cycle)
      } else {
        visit(target)
      }
    }

    stack.pop()
    active.delete(module)
    visited.add(module)
  }

  for (const module of adjacency.keys()) visit(module)
  return [...cycles].sort()
}

describe('architecture guard', () => {
  const files = sourceFiles()
  const productionFiles = files.filter((path) => !isTestModule(path))
  const knownModules = new Set(productionFiles.map((path) => resolve(path)))
  const edges = productionFiles.flatMap((path) => importsFor(path, knownModules))

  test('keeps imports inside the documented dependency boundaries', () => {
    expect(boundaryViolations(edges)).toEqual([])
  })

  test('keeps the production runtime import graph acyclic', () => {
    expect(runtimeCycles(edges)).toEqual([])
  })

  test('keeps ordinary test documents on the current timeline schema', () => {
    const staleFixtures: string[] = []
    for (const path of files.filter(isTestModule)) {
      if (moduleName(path) === 'domain/projectFile.test.ts') continue
      const source = readFileSync(path, 'utf8')
      for (const match of source.matchAll(/schemaVersion:\s*(\d+)/g)) {
        if (Number(match[1]) !== CURRENT_TIMELINE_SCHEMA_VERSION) {
          const line = source.slice(0, match.index).split(/\r?\n/).length
          staleFixtures.push(`${moduleName(path)}:${line} uses schema ${match[1]}`)
        }
      }
    }
    expect(staleFixtures).toEqual([])
  })
})
