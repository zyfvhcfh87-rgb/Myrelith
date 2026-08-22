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
  dynamic: boolean
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
    dynamic: boolean,
    node: ts.Node,
  ): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
    edges.push({
      from: path,
      to: resolveRelativeModule(path, specifier, knownModules),
      specifier,
      typeOnly,
      dynamic,
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
        false,
        node,
      )
    } else if (
      ts.isExportDeclaration(node)
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      addEdge(node.moduleSpecifier.text, node.isTypeOnly, false, node)
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
    ) {
      addEdge(node.arguments[0].text, false, true, node)
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
  const workerTypeModules = new Set([
    'workers/decode-types.ts',
    'workers/decode-protocol.ts',
    'workers/render-legacy-protocol.ts',
    'workers/render-protocol.ts',
  ])
  const currentRenderClosure = new Set([
    'engine/render-bridge.ts',
    'engine/render-legacy-bridge.ts',
    'workers/render-legacy.ts',
    'workers/render.worker.ts',
    'workers/renderWorker/core.ts',
  ])
  const renderWorkerPipelineImports = new Map<string, ReadonlySet<string>>([
    ['workers/render.worker.ts', new Set([
      'pipeline/lensRemapWebgl.ts',
      'pipeline/static-image.ts',
    ])],
    ['workers/renderWorker/core.ts', new Set([
      'pipeline/lensRemap.ts',
      'pipeline/lensRemapWebgl.ts',
      'pipeline/render.ts',
      'pipeline/static-image.ts',
    ])],
  ])
  const renderWorkerPipelineTypeImports = new Map<string, ReadonlySet<string>>([
    ['workers/renderWorker/contracts.ts', new Set([
      'pipeline/lensRemapWebgl.ts',
      'pipeline/render.ts',
      'pipeline/static-image.ts',
    ])],
    ['workers/renderWorker/state.ts', new Set([
      'pipeline/render.ts',
      'pipeline/static-image.ts',
    ])],
  ])
  const retiredDecodeImplementations = new Set([
    'engine/worker-bridge.ts',
    'pipeline/decode.ts',
    'workers/decode.worker.ts',
  ])
  const devImportAllowances = new Map<string, ReadonlySet<string>>([
    ['dev/ProxyEditingBenchmarkPanel.tsx', new Set(['app', 'domain', 'state'])],
    ['dev/issue77/pluginAcceptanceGate.ts', new Set(['app'])],
    ['dev/issue77/pluginLifecycleEvidence.ts', new Set(['app'])],
    ['dev/issue108/motionAnalysisFoundation.ts', new Set(['app', 'domain', 'pipeline'])],
    ['dev/issue109/videoStabilizationGate.ts', new Set(['app', 'domain', 'state'])],
    ['dev/issue110/motionTrackingGate.ts', new Set(['app', 'domain', 'state'])],
    ['dev/issue111/lensRemapContract.ts', new Set(['domain'])],
    ['dev/issue111/lensRemapCore.ts', new Set(['domain'])],
    ['dev/issue111/lensRemapWebgl.ts', new Set(['pipeline'])],
    ['dev/issue111/lens-remap.worker.ts', new Set(['domain'])],
    ['dev/performance/fixture.ts', new Set(['domain'])],
    ['dev/performance/framePlanningBenchmark.ts', new Set(['domain'])],
    ['dev/performance/runtime.ts', new Set(['app', 'domain', 'state'])],
    ['dev/performance/PerformanceBenchmarkApp.tsx', new Set(['ui'])],
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

    if (fromArea === 'dev' && toArea !== 'dev') {
      const allowedAreas = devImportAllowances.get(fromName)
      if (!allowedAreas?.has(toArea)) {
        violations.push(
          `${edgeLabel(edge)} is outside the narrow documented dev exception`,
        )
      }
    }
    if (
      toArea === 'dev'
      && fromArea !== 'dev'
      && !(
        (
          fromName === 'main.tsx'
          && toName === 'dev/performance/PerformanceBenchmarkApp.tsx'
        )
        || (
          fromName === 'app/EditorShell.tsx'
          && toName === 'dev/ProxyEditingBenchmarkPanel.tsx'
          && edge.dynamic
        )
      )
    ) {
      violations.push(`${edgeLabel(edge)} imports a dev module outside the gated entry route`)
    }

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

    if (workerTypeModules.has(toName) && !edge.typeOnly) {
      violations.push(`${edgeLabel(edge)} must import worker contracts as type-only`)
    }

    if (
      currentRenderClosure.has(fromName)
      && retiredDecodeImplementations.has(toName)
    ) {
      violations.push(`${edgeLabel(edge)} bypasses the legacy compatibility boundary`)
    }

    if (
      runtimeAreas.has(fromArea)
      && runtimeAreas.has(toArea)
      && fromArea !== toArea
    ) {
      const sanctioned = workerTypeModules.has(toName) && edge.typeOnly
        || (
          fromName === 'engine/render-bridge.ts'
          && toName === 'workers/plugin-effect-bridge-protocol.ts'
        )
        || (
          fromArea === 'workers'
          && toName === 'engine/frame-cache.ts'
        )
        || renderWorkerPipelineImports.get(fromName)?.has(toName)
        || (
          edge.typeOnly
          && renderWorkerPipelineTypeImports.get(fromName)?.has(toName)
        )
        || (
          fromName === 'workers/motion-analysis.worker.ts'
          && new Set([
            'pipeline/motionAnalysisDecode.ts',
            'pipeline/motionAnalysisProtocol.ts',
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

function eagerRuntimeClosure(
  entryNames: readonly string[],
  edges: readonly ImportEdge[],
): Set<string> {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    if (!edge.to || edge.typeOnly || edge.dynamic) continue
    const targets = adjacency.get(edge.from) ?? []
    targets.push(edge.to)
    adjacency.set(edge.from, targets)
  }
  const visited = new Set<string>()
  const pending = entryNames.map((name) => resolve(SOURCE_ROOT, name))
  while (pending.length > 0) {
    const module = pending.pop()!
    if (visited.has(module)) continue
    visited.add(module)
    pending.push(...(adjacency.get(module) ?? []))
  }
  return new Set([...visited].map(moduleName))
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

  test('keeps editor and secondary surfaces outside their eager entry graphs', () => {
    const launcherClosure = eagerRuntimeClosure(['main.tsx'], edges)
    expect(launcherClosure).toContain('app/App.tsx')
    expect(launcherClosure).toContain('ui/ProjectLaunch.tsx')
    expect(launcherClosure).not.toContain('app/EditorShell.tsx')
    expect(launcherClosure).not.toContain('ui/Toolbar.tsx')
    expect(launcherClosure).not.toContain('ui/Inspector.tsx')

    const editorClosure = eagerRuntimeClosure(['app/EditorShell.tsx'], edges)
    expect(editorClosure).not.toContain('ui/ExportDialog.tsx')
    expect(editorClosure).not.toContain('ui/CaptionEditor.tsx')
    expect(editorClosure).not.toContain('ui/TextOverlayDialog.tsx')
    expect(editorClosure).not.toContain('ui/AnimationCurveEditor.tsx')
  })

  test('limits privileged composition imports to the documented dev files', () => {
    const privilegedImporters = new Set(edges
      .filter((edge) => edge.to && area(edge.from) === 'dev')
      .filter((edge) => new Set(['app', 'state', 'ui']).has(area(edge.to!)))
      .map((edge) => moduleName(edge.from)))
    const expectedPrivilegedImporters = new Set([
      'dev/ProxyEditingBenchmarkPanel.tsx',
      'dev/issue108/motionAnalysisFoundation.ts',
      'dev/issue109/videoStabilizationGate.ts',
      'dev/issue110/motionTrackingGate.ts',
      'dev/performance/PerformanceBenchmarkApp.tsx',
      'dev/performance/runtime.ts',
    ])
    for (const issue77Importer of [
      'dev/issue77/pluginAcceptanceGate.ts',
      'dev/issue77/pluginLifecycleEvidence.ts',
    ]) {
      if (productionFiles.some((path) => moduleName(path) === issue77Importer)) {
        expectedPrivilegedImporters.add(issue77Importer)
      }
    }
    expect(privilegedImporters).toEqual(expectedPrivilegedImporters)
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
