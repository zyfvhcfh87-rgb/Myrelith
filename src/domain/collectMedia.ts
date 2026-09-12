/**
 * Browser-free collect-media archive contract.
 *
 * Portable `.myrelith` files stay edit-only. This module plans a separate,
 * versioned local package: collision-safe relative paths, an auditable
 * manifest, and completeness that cannot be inferred from a partial copy.
 */

import type { PortableAssetDescriptor } from './projectFile'
import {
  hasSupportedProjectFileExtension,
  PROJECT_FILE_EXTENSION,
} from './projectFile'
import type { SequenceProject } from './projectSequences'
import { isSupportedTextFontFamily } from './textOverlay'

export const COLLECT_MEDIA_MANIFEST_FORMAT = 'myrelith-collect-media' as const
export const COLLECT_MEDIA_MANIFEST_VERSION = 1 as const
export const COLLECT_MEDIA_MANIFEST_FILE = 'myrelith-collect-manifest.json' as const
export const COLLECT_MEDIA_INCOMPLETE_MARKER = 'COLLECT-INCOMPLETE.txt' as const

export const COLLECT_MEDIA_FOLDERS = ['media', 'proxies', 'templates'] as const
export type CollectMediaFolder = (typeof COLLECT_MEDIA_FOLDERS)[number]

export const COLLECT_MEDIA_LIMITS = Object.freeze({
  maxItems: 50_000,
  maxErrors: 1_024,
  maxFileNameCharacters: 180,
  maxRelativePathCharacters: 4_096,
  maxReasonCharacters: 512,
  maxSerializedCharacters: 2_000_000,
  maxIdCharacters: 256,
})

export type CollectMediaItemKind = 'asset' | 'proxy' | 'font' | 'template'
export type CollectMediaDisposition =
  | 'included'
  | 'excluded'
  | 'offline'
  | 'unresolved'

export interface CollectMediaInclusionPolicy {
  readonly includeProxies: boolean
  readonly includeTitleTemplates: boolean
}

export const DEFAULT_COLLECT_MEDIA_POLICY: CollectMediaInclusionPolicy = {
  includeProxies: false,
  includeTitleTemplates: false,
}

export type CollectMediaFingerprintAlgorithm = 'sha256-sampled-v1'

export interface CollectMediaFingerprint {
  readonly algorithm: CollectMediaFingerprintAlgorithm
  readonly digest: string
}

export interface CollectMediaSourceFact {
  readonly id: string
  readonly kind: CollectMediaItemKind
  readonly displayName: string
  readonly originalFileName: string | null
  readonly size: number | null
  readonly lastModified: number | null
  readonly mimeType: string | null
  readonly available: boolean
  readonly referenced: boolean
}

export interface CollectMediaPreflightItem {
  readonly id: string
  readonly kind: CollectMediaItemKind
  readonly disposition: CollectMediaDisposition
  readonly reason: string
  readonly originalFileName: string | null
  readonly plannedRelativePath: string | null
  readonly size: number | null
  readonly lastModified: number | null
  readonly mimeType: string | null
}

export interface CollectMediaPreflight {
  readonly inclusionPolicy: CollectMediaInclusionPolicy
  readonly items: readonly CollectMediaPreflightItem[]
  readonly includedCount: number
  readonly excludedCount: number
  readonly offlineCount: number
  readonly unresolvedCount: number
}

export interface CollectMediaManifestItem {
  readonly id: string
  readonly kind: CollectMediaItemKind
  readonly disposition: CollectMediaDisposition
  readonly originalFileName: string | null
  readonly collectedRelativePath: string | null
  readonly size: number | null
  readonly lastModified: number | null
  readonly mimeType: string | null
  readonly fingerprint: CollectMediaFingerprint | null
  readonly reason: string
  readonly error: string | null
}

export interface CollectMediaManifest {
  readonly format: typeof COLLECT_MEDIA_MANIFEST_FORMAT
  readonly formatVersion: typeof COLLECT_MEDIA_MANIFEST_VERSION
  readonly status: 'complete' | 'partial'
  readonly createdAt: number
  readonly projectFileName: string
  readonly inclusionPolicy: CollectMediaInclusionPolicy
  readonly items: readonly CollectMediaManifestItem[]
  readonly errors: readonly string[]
}

export class CollectMediaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CollectMediaError'
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$|clock\$)(?:\.|$)/i
const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const FINGERPRINT_ALGORITHMS = new Set<CollectMediaFingerprintAlgorithm>([
  'sha256-sampled-v1',
])
const ITEM_KINDS = new Set<CollectMediaItemKind>([
  'asset',
  'proxy',
  'font',
  'template',
])
const DISPOSITIONS = new Set<CollectMediaDisposition>([
  'included',
  'excluded',
  'offline',
  'unresolved',
])
const FOLDERS = new Set<string>(COLLECT_MEDIA_FOLDERS)
const ALLOWED_RETRY_ENTRIES = new Set<string>([
  COLLECT_MEDIA_MANIFEST_FILE,
  COLLECT_MEDIA_INCOMPLETE_MARKER,
  ...COLLECT_MEDIA_FOLDERS,
])
const IGNORABLE_DESTINATION_ENTRIES = new Set<string>([
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
])

function isIgnorableCollectDestinationEntry(name: string): boolean {
  return IGNORABLE_DESTINATION_ENTRIES.has(name.toLowerCase())
}

function fail(path: string, problem: string): never {
  throw new CollectMediaError(`${path}: ${problem}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown field')
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(path, `missing field ${key}`)
    }
  }
}

function hasUnsafePathCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32
      || code === 127
      || '<>:"/\\|?*'.includes(character)
  })
}

/** One path segment that can never walk above the chosen archive root. */
export function isSafeCollectPathSegment(value: string): boolean {
  if (value.length === 0 || value.length > COLLECT_MEDIA_LIMITS.maxFileNameCharacters) {
    return false
  }
  if (value === '.' || value === '..') return false
  if (value.endsWith('.') || value.endsWith(' ')) return false
  if (hasUnsafePathCharacter(value)) return false
  if (WINDOWS_RESERVED.test(value)) return false
  return true
}

export function sanitizeCollectFileName(fileName: string): string {
  const posixName = fileName.replaceAll('\\', '/')
  const baseName = posixName.slice(posixName.lastIndexOf('/') + 1)
  const trimmed = baseName.trim()
  const lastDot = trimmed.lastIndexOf('.')
  const extension = lastDot > 0 ? trimmed.slice(lastDot).toLowerCase() : ''
  const stemSource = lastDot > 0 ? trimmed.slice(0, lastDot) : trimmed
  let stem = stemSource.replace(/[<>:"/\\|?*]/g, '-')
  stem = Array.from(stem, (character) => (
    character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? '-' : character
  )).join('')
  stem = stem.replace(/[. ]+$/g, '').replace(/^\.+/g, '')
  stem = Array.from(stem).slice(0, 80).join('').replace(/[. ]+$/g, '')
  if (!stem || WINDOWS_RESERVED.test(stem + extension)) stem = 'media'
  const candidate = `${stem}${extension}`
  return isSafeCollectPathSegment(candidate) ? candidate : 'media.bin'
}

function appendNameSuffix(fileName: string, suffix: string): string {
  const lastDot = fileName.lastIndexOf('.')
  if (lastDot <= 0) {
    const combined = `${fileName}-${suffix}`
    return isSafeCollectPathSegment(combined)
      ? combined
      : sanitizeCollectFileName(combined)
  }
  const combined = `${fileName.slice(0, lastDot)}-${suffix}${fileName.slice(lastDot)}`
  return isSafeCollectPathSegment(combined)
    ? combined
    : sanitizeCollectFileName(combined)
}

function identitySuffix(id: string): string {
  const lastToken = id.split(/[^A-Za-z0-9]+/).filter(Boolean).at(-1)
  const compact = (lastToken ?? id).replace(/[^A-Za-z0-9]/g, '').slice(0, 8)
  return compact.length > 0 ? compact.toLowerCase() : 'item'
}

/**
 * Assign one POSIX-style path under media/, proxies/, or templates/.
 * Occupancy is case-insensitive so Windows-style collisions stay deterministic.
 */
export function assignCollectedRelativePath(
  originalFileName: string | null,
  id: string,
  folder: CollectMediaFolder,
  usedLower: Set<string>,
): string {
  if (!FOLDERS.has(folder)) {
    throw new CollectMediaError('Unsupported collect-media folder')
  }
  const fallback = `${folder}-${identitySuffix(id)}`
  let name = originalFileName && originalFileName.trim().length > 0
    ? sanitizeCollectFileName(originalFileName)
    : sanitizeCollectFileName(fallback)
  let attempt = 0
  while (usedLower.has(`${folder}/${name.toLowerCase()}`)) {
    attempt += 1
    const suffix = attempt === 1 ? identitySuffix(id) : String(attempt)
    name = appendNameSuffix(
      originalFileName && originalFileName.trim().length > 0
        ? sanitizeCollectFileName(originalFileName)
        : sanitizeCollectFileName(fallback),
      suffix,
    )
  }
  const relativePath = `${folder}/${name}`
  usedLower.add(relativePath.toLowerCase())
  return relativePath
}

export function collectMediaPathSegments(relativePath: string): readonly string[] {
  if (relativePath.length === 0) fail('$.path', 'must not be empty')
  if (relativePath.length > COLLECT_MEDIA_LIMITS.maxRelativePathCharacters) {
    fail('$.path', `exceeds ${COLLECT_MEDIA_LIMITS.maxRelativePathCharacters} characters`)
  }
  if (
    relativePath.startsWith('/')
    || relativePath.endsWith('/')
    || relativePath.includes('\\')
    || relativePath.includes('\0')
    || relativePath.includes('//')
  ) {
    fail('$.path', 'must be a relative POSIX path inside the archive')
  }
  const segments = relativePath.split('/')
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    fail('$.path', 'must be a relative POSIX path inside the archive')
  }
  if (segments.length !== 2) {
    fail('$.path', 'must be folder/file inside the archive')
  }
  const [folder, fileName] = segments
  if (!FOLDERS.has(folder)) fail('$.path', 'folder is not a collect-media directory')
  if (!isSafeCollectPathSegment(fileName)) {
    fail('$.path', 'file name is not a safe archive segment')
  }
  return segments
}

export function assertCollectedRelativePath(relativePath: string): string {
  collectMediaPathSegments(relativePath)
  return relativePath
}

export function isCollectArchiveProjectFileName(fileName: string): boolean {
  return isSafeCollectPathSegment(fileName)
    && hasSupportedProjectFileExtension(fileName)
}

export type CollectArchiveDestinationKind =
  | 'empty'
  | 'incomplete'
  | 'complete'
  | 'occupied'

export function collectArchiveDestinationKind(
  entryNames: readonly string[],
  manifestStatus: 'complete' | 'partial' | null,
  hasIncompleteMarker: boolean,
): CollectArchiveDestinationKind {
  const relevantNames = entryNames.filter((name) => (
    !isIgnorableCollectDestinationEntry(name)
  ))
  if (relevantNames.length === 0) return 'empty'
  const unexpected = relevantNames.filter((name) => (
    !ALLOWED_RETRY_ENTRIES.has(name)
    && !isCollectArchiveProjectFileName(name)
  ))
  if (unexpected.length > 0) return 'occupied'
  if (hasIncompleteMarker || manifestStatus === 'partial') return 'incomplete'
  if (manifestStatus === 'complete') return 'complete'
  return 'occupied'
}

export function collectMediaPreflightCounts(
  items: readonly Pick<CollectMediaPreflightItem, 'disposition'>[],
): Pick<
  CollectMediaPreflight,
  'includedCount' | 'excludedCount' | 'offlineCount' | 'unresolvedCount'
> {
  let includedCount = 0
  let excludedCount = 0
  let offlineCount = 0
  let unresolvedCount = 0
  for (const item of items) {
    if (item.disposition === 'included') includedCount += 1
    else if (item.disposition === 'excluded') excludedCount += 1
    else if (item.disposition === 'offline') offlineCount += 1
    else unresolvedCount += 1
  }
  return { includedCount, excludedCount, offlineCount, unresolvedCount }
}

function planCopyItem(
  fact: CollectMediaSourceFact,
  folder: CollectMediaFolder,
  usedLower: Set<string>,
  includedReason: string,
  unavailableDisposition: CollectMediaDisposition,
  unavailableReason: string,
): CollectMediaPreflightItem {
  if (!fact.available) {
    return {
      id: fact.id,
      kind: fact.kind,
      disposition: unavailableDisposition,
      reason: unavailableReason,
      originalFileName: fact.originalFileName,
      plannedRelativePath: null,
      size: fact.size,
      lastModified: fact.lastModified,
      mimeType: fact.mimeType,
    }
  }
  return {
    id: fact.id,
    kind: fact.kind,
    disposition: 'included',
    reason: includedReason,
    originalFileName: fact.originalFileName,
    plannedRelativePath: assignCollectedRelativePath(
      fact.originalFileName ?? fact.displayName,
      fact.id,
      folder,
      usedLower,
    ),
    size: fact.size,
    lastModified: fact.lastModified,
    mimeType: fact.mimeType,
  }
}

export function planCollectMediaPreflight(
  facts: readonly CollectMediaSourceFact[],
  inclusionPolicy: CollectMediaInclusionPolicy,
): CollectMediaPreflight {
  if (facts.length > COLLECT_MEDIA_LIMITS.maxItems) {
    throw new CollectMediaError(
      `Collect-media preflight exceeds ${COLLECT_MEDIA_LIMITS.maxItems} items`,
    )
  }
  const usedLower = new Set<string>()
  const items = facts.map((fact) => {
    if (fact.kind === 'font') {
      const portable = isSupportedTextFontFamily(fact.displayName)
      return {
        id: fact.id,
        kind: fact.kind,
        disposition: portable ? 'excluded' : 'unresolved',
        reason: portable
          ? 'Generic families travel with the project; no font file is copied.'
          : 'This named font is not a portable generic family and has no collectable file.',
        originalFileName: null,
        plannedRelativePath: null,
        size: null,
        lastModified: null,
        mimeType: null,
      } satisfies CollectMediaPreflightItem
    }
    if (fact.kind === 'proxy') {
      if (!inclusionPolicy.includeProxies) {
        return {
          id: fact.id,
          kind: fact.kind,
          disposition: 'excluded',
          reason: 'Editing proxies are omitted by the current collect policy.',
          originalFileName: fact.originalFileName,
          plannedRelativePath: null,
          size: fact.size,
          lastModified: fact.lastModified,
          mimeType: fact.mimeType,
        } satisfies CollectMediaPreflightItem
      }
      return planCopyItem(
        fact,
        'proxies',
        usedLower,
        'Fresh editing proxy will be copied beside the originals.',
        'excluded',
        'No fresh editing proxy is available for this source.',
      )
    }
    if (fact.kind === 'template') {
      if (!inclusionPolicy.includeTitleTemplates) {
        return {
          id: fact.id,
          kind: fact.kind,
          disposition: 'excluded',
          reason: 'Origin-local title templates are omitted; titles already live in the project file.',
          originalFileName: fact.originalFileName,
          plannedRelativePath: null,
          size: fact.size,
          lastModified: fact.lastModified,
          mimeType: fact.mimeType,
        } satisfies CollectMediaPreflightItem
      }
      return planCopyItem(
        fact,
        'templates',
        usedLower,
        'Origin-local title template will be copied as JSON for audit.',
        'unresolved',
        'This title template could not be read from local storage.',
      )
    }
    return planCopyItem(
      fact,
      'media',
      usedLower,
      'Original source will be copied into the archive.',
      'offline',
      'This source is offline or unreadable in this session.',
    )
  })
  return {
    inclusionPolicy: { ...inclusionPolicy },
    items,
    ...collectMediaPreflightCounts(items),
  }
}

export function referencedFontFacts(project: SequenceProject): CollectMediaSourceFact[] {
  const seen = new Set<string>()
  const facts: CollectMediaSourceFact[] = []
  const add = (family: string): void => {
    if (!family.trim() || seen.has(family)) return
    seen.add(family)
    facts.push({
      id: `font:${family}`,
      kind: 'font',
      displayName: family,
      originalFileName: null,
      size: null,
      lastModified: null,
      mimeType: null,
      available: isSupportedTextFontFamily(family),
      referenced: true,
    })
  }
  for (const sequence of project.sequences) {
    for (const track of sequence.tracks) {
      for (const clip of track.clips) {
        if (clip.text?.fontFamily) add(clip.text.fontFamily)
        const title = clip.title
        if (title && title.version === 1 && Array.isArray(title.elements)) {
          for (const element of title.elements) {
            if (
              element
              && typeof element === 'object'
              && 'kind' in element
              && element.kind === 'text'
              && 'font' in element
              && element.font
              && typeof element.font === 'object'
              && 'family' in element.font
              && typeof element.font.family === 'string'
            ) {
              add(element.font.family)
            }
          }
        }
      }
    }
    for (const captionTrack of sequence.captionTracks ?? []) {
      const family = captionTrack.style?.params.fontFamily
      if (typeof family === 'string') add(family)
    }
  }
  return facts
}

export function assetFactsFromDescriptors(
  descriptors: readonly PortableAssetDescriptor[],
  availableIds: ReadonlySet<string>,
): CollectMediaSourceFact[] {
  return descriptors.map((descriptor) => ({
    id: descriptor.id,
    kind: 'asset' as const,
    displayName: descriptor.fileName,
    originalFileName: descriptor.fileName,
    size: descriptor.size,
    lastModified: descriptor.lastModified,
    mimeType: descriptor.mimeType,
    available: availableIds.has(descriptor.id),
    referenced: true,
  }))
}

function readPolicy(
  value: unknown,
  path: string,
): CollectMediaInclusionPolicy {
  if (!isRecord(value)) fail(path, 'expected an object')
  exactKeys(value, ['includeProxies', 'includeTitleTemplates'], [], path)
  if (typeof value.includeProxies !== 'boolean') {
    fail(`${path}.includeProxies`, 'expected a boolean')
  }
  if (typeof value.includeTitleTemplates !== 'boolean') {
    fail(`${path}.includeTitleTemplates`, 'expected a boolean')
  }
  return {
    includeProxies: value.includeProxies,
    includeTitleTemplates: value.includeTitleTemplates,
  }
}

function readFingerprint(
  value: unknown,
  path: string,
): CollectMediaFingerprint | null {
  if (value === null) return null
  if (!isRecord(value)) fail(path, 'expected an object or null')
  exactKeys(value, ['algorithm', 'digest'], [], path)
  if (
    typeof value.algorithm !== 'string'
    || !FINGERPRINT_ALGORITHMS.has(value.algorithm as CollectMediaFingerprintAlgorithm)
  ) {
    fail(`${path}.algorithm`, 'unsupported fingerprint algorithm')
  }
  if (typeof value.digest !== 'string' || !DIGEST_PATTERN.test(value.digest)) {
    fail(`${path}.digest`, 'expected a 64-character lowercase hex digest')
  }
  return {
    algorithm: value.algorithm as CollectMediaFingerprintAlgorithm,
    digest: value.digest,
  }
}

function readNullableString(
  value: unknown,
  path: string,
  maxLength: number,
): string | null {
  if (value === null) return null
  if (typeof value !== 'string') fail(path, 'expected a string or null')
  if (value.length > maxLength) fail(path, `exceeds ${maxLength} characters`)
  if (value.trim().length === 0) fail(path, 'must not be empty')
  return value
}

function readNullableInteger(
  value: unknown,
  path: string,
  minimum: number,
): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(path, `expected a safe integer >= ${minimum} or null`)
  }
  return value as number
}

function readItem(
  value: unknown,
  path: string,
): CollectMediaManifestItem {
  if (!isRecord(value)) fail(path, 'expected an object')
  exactKeys(value, [
    'id',
    'kind',
    'disposition',
    'originalFileName',
    'collectedRelativePath',
    'size',
    'lastModified',
    'mimeType',
    'fingerprint',
    'reason',
    'error',
  ], [], path)
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > COLLECT_MEDIA_LIMITS.maxIdCharacters) {
    fail(`${path}.id`, 'invalid identity')
  }
  if (typeof value.kind !== 'string' || !ITEM_KINDS.has(value.kind as CollectMediaItemKind)) {
    fail(`${path}.kind`, 'unsupported item kind')
  }
  if (
    typeof value.disposition !== 'string'
    || !DISPOSITIONS.has(value.disposition as CollectMediaDisposition)
  ) {
    fail(`${path}.disposition`, 'unsupported disposition')
  }
  const originalFileName = readNullableString(
    value.originalFileName,
    `${path}.originalFileName`,
    COLLECT_MEDIA_LIMITS.maxFileNameCharacters,
  )
  const collectedRelativePath = readNullableString(
    value.collectedRelativePath,
    `${path}.collectedRelativePath`,
    COLLECT_MEDIA_LIMITS.maxRelativePathCharacters,
  )
  if (collectedRelativePath) assertCollectedRelativePath(collectedRelativePath)
  if (value.disposition === 'included' && value.kind !== 'font' && !collectedRelativePath) {
    fail(`${path}.collectedRelativePath`, 'included copyable items need an archive path')
  }
  if (value.disposition !== 'included' && collectedRelativePath) {
    fail(`${path}.collectedRelativePath`, 'omitted items cannot claim an archive path')
  }
  if (typeof value.reason !== 'string' || value.reason.length === 0 || value.reason.length > COLLECT_MEDIA_LIMITS.maxReasonCharacters) {
    fail(`${path}.reason`, 'invalid reason')
  }
  const error = readNullableString(
    value.error,
    `${path}.error`,
    COLLECT_MEDIA_LIMITS.maxReasonCharacters,
  )
  return {
    id: value.id,
    kind: value.kind as CollectMediaItemKind,
    disposition: value.disposition as CollectMediaDisposition,
    originalFileName,
    collectedRelativePath,
    size: readNullableInteger(value.size, `${path}.size`, 0),
    lastModified: readNullableInteger(value.lastModified, `${path}.lastModified`, 0),
    mimeType: readNullableString(value.mimeType, `${path}.mimeType`, 256),
    fingerprint: readFingerprint(value.fingerprint, `${path}.fingerprint`),
    reason: value.reason,
    error,
  }
}

export function parseCollectMediaManifest(value: unknown): CollectMediaManifest {
  if (!isRecord(value)) fail('$', 'expected an object')
  exactKeys(value, [
    'format',
    'formatVersion',
    'status',
    'createdAt',
    'projectFileName',
    'inclusionPolicy',
    'items',
    'errors',
  ], [], '$')
  if (value.format !== COLLECT_MEDIA_MANIFEST_FORMAT) {
    fail('$.format', 'unsupported collect-media format')
  }
  if (value.formatVersion !== COLLECT_MEDIA_MANIFEST_VERSION) {
    fail('$.formatVersion', 'unsupported collect-media version')
  }
  if (value.status !== 'complete' && value.status !== 'partial') {
    fail('$.status', 'must be complete or partial')
  }
  if (!Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0) {
    fail('$.createdAt', 'expected a non-negative safe integer')
  }
  if (
    typeof value.projectFileName !== 'string'
    || !isCollectArchiveProjectFileName(value.projectFileName)
  ) {
    fail('$.projectFileName', `expected a safe ${PROJECT_FILE_EXTENSION} file name`)
  }
  if (!Array.isArray(value.items)) fail('$.items', 'expected an array')
  if (value.items.length > COLLECT_MEDIA_LIMITS.maxItems) {
    fail('$.items', `exceeds ${COLLECT_MEDIA_LIMITS.maxItems} items`)
  }
  if (!Array.isArray(value.errors)) fail('$.errors', 'expected an array')
  if (value.errors.length > COLLECT_MEDIA_LIMITS.maxErrors) {
    fail('$.errors', `exceeds ${COLLECT_MEDIA_LIMITS.maxErrors} errors`)
  }
  const ids = new Set<string>()
  const paths = new Set<string>()
  const items = value.items.map((item, index) => {
    const parsed = readItem(item, `$.items[${index}]`)
    if (ids.has(parsed.id)) fail(`$.items[${index}].id`, 'duplicate identity')
    ids.add(parsed.id)
    if (parsed.collectedRelativePath) {
      const key = parsed.collectedRelativePath.toLowerCase()
      if (paths.has(key)) fail(`$.items[${index}].collectedRelativePath`, 'duplicate path')
      paths.add(key)
    }
    return parsed
  })
  const errors = value.errors.map((entry, index) => {
    if (
      typeof entry !== 'string'
      || entry.length === 0
      || entry.length > COLLECT_MEDIA_LIMITS.maxReasonCharacters
    ) {
      fail(`$.errors[${index}]`, 'invalid error text')
    }
    return entry
  })
  return {
    format: COLLECT_MEDIA_MANIFEST_FORMAT,
    formatVersion: COLLECT_MEDIA_MANIFEST_VERSION,
    status: value.status,
    createdAt: value.createdAt as number,
    projectFileName: value.projectFileName,
    inclusionPolicy: readPolicy(value.inclusionPolicy, '$.inclusionPolicy'),
    items,
    errors,
  }
}

export function serializeCollectMediaManifest(manifest: CollectMediaManifest): string {
  const parsed = parseCollectMediaManifest(manifest)
  const serialized = JSON.stringify(parsed)
  if (serialized.length > COLLECT_MEDIA_LIMITS.maxSerializedCharacters) {
    throw new CollectMediaError(
      `Collect-media manifest exceeds ${COLLECT_MEDIA_LIMITS.maxSerializedCharacters} characters`,
    )
  }
  return serialized
}

export function collectArchiveIsComplete(
  manifest: CollectMediaManifest,
  hasIncompleteMarker: boolean,
): boolean {
  if (hasIncompleteMarker) return false
  if (manifest.status !== 'complete') return false
  return manifest.errors.length === 0
    && manifest.items.every((item) => (
      item.disposition !== 'included' || (item.collectedRelativePath !== null && item.error === null)
    ))
}

export function manifestItemFromPreflight(
  item: CollectMediaPreflightItem,
  extras: {
    fingerprint?: CollectMediaFingerprint | null
    error?: string | null
    disposition?: CollectMediaDisposition
    collectedRelativePath?: string | null
    reason?: string
  } = {},
): CollectMediaManifestItem {
  const disposition = extras.disposition ?? item.disposition
  const collectedRelativePath = extras.collectedRelativePath !== undefined
    ? extras.collectedRelativePath
    : disposition === 'included' ? item.plannedRelativePath : null
  if (collectedRelativePath) assertCollectedRelativePath(collectedRelativePath)
  return {
    id: item.id,
    kind: item.kind,
    disposition,
    originalFileName: item.originalFileName,
    collectedRelativePath,
    size: item.size,
    lastModified: item.lastModified,
    mimeType: item.mimeType,
    fingerprint: extras.fingerprint ?? null,
    reason: extras.reason ?? item.reason,
    error: extras.error ?? null,
  }
}

export const COLLECT_MEDIA_INCOMPLETE_MARKER_TEXT = [
  'This collect-media archive is incomplete.',
  'Do not treat it as a finished portable package.',
  `See ${COLLECT_MEDIA_MANIFEST_FILE} for copied paths, omissions, and errors.`,
].join('\n')
