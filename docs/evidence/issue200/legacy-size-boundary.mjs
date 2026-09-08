// Evidence-only size proof. No product source imports this module.
// Run from the issue200 worktree with DEVELOPER_DIR set as documented.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
assert.equal(root, process.cwd(), 'Run this evidence script from its own issue worktree')
const baseline = 'ce91074c276ca6892a74addb7dd673b9a19c7eeb'
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const sourceTree = git('rev-parse', 'HEAD:src')
assert.equal(sourceTree, git('rev-parse', `${baseline}:src`), 'This proof requires unchanged baseline production source')
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  server: { middlewareMode: true, ws: false, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true },
})

try {
  const projectFile = await server.ssrLoadModule('/src/domain/projectFile.ts')
  const { createTextClip } = await server.ssrLoadModule('/src/domain/operations/creation.ts')
  const { updateTextClip } = await server.ssrLoadModule('/src/domain/operations/audioText.ts')
  const { proceduralTextAssetId } = await server.ssrLoadModule('/src/domain/textOverlay.ts')
  const { defaultClipTransform, defaultClipVisualSettings } = await server.ssrLoadModule('/src/domain/clipInspector.ts')
  const { serializeProjectFile, parseProjectFile, createProjectFileSnapshot } = projectFile
  const limit = projectFile.PROJECT_FILE_LIMITS.maxSerializedCharacters
  assert.equal(limit, 10_000_000)

  function document(id) {
    return {
      id, name: id, schemaVersion: projectFile.CURRENT_TIMELINE_SCHEMA_VERSION,
      width: 1920, height: 1080, frameRate: { num: 30, den: 1 }, audioSampleRate: 48000,
      tracks: [{
        id: `${id}-video`, name: 'Video', kind: 'video', clips: [],
        sequenceInstances: [], multicamInstances: [], adjustments: [], transitions: [],
        hidden: false, muted: false, solo: false, locked: false,
        volume: 1, balance: 0, audioEffects: [], videoEffects: [],
      }],
      captionTracks: [], markers: [], masterVideoEffects: [],
      masterAudio: { volume: 1, balance: 0, muted: false, audioEffects: [] },
    }
  }

  function fixture(targetLength) {
    const sequences = [document('root-sequence'), document('dormant-sequence')]
    for (const sequence of sequences) {
      for (let index = 0; index < 300; index++) {
        const clip = createTextClip(sequence, index * 30, 30, '')
        clip.id = `${sequence.id}-text-${String(index).padStart(3, '0')}`
        clip.assetId = proceduralTextAssetId(clip.id)
        clip.name = 'A'.repeat(77) + '...'
        sequence.tracks[0].clips.push(clip)
      }
    }
    const project = createProjectFileSnapshot({
      id: 'boundary-project', name: 'Boundary', rootSequenceId: sequences[0].id,
      sequences, multicams: [], colorLuts: [],
    }, [])
    let remaining = targetLength - serializeProjectFile(project).length
    assert(remaining > 0)
    for (const sequence of project.sequences) {
      for (const clip of sequence.tracks[0].clips) {
        const count = Math.min(20_000, remaining)
        clip.text.content = 'A'.repeat(count)
        remaining -= count
      }
    }
    assert.equal(remaining, 0)
    return project
  }

  // This constructs the plan's candidate envelope for size measurement only.
  // It is not a production migration, title validator or new serializer.
  function proposedExpandedClip(clip) {
    const { text, ...other } = clip
    const { fontFamily, ...style } = text
    return {
      ...other,
      transform: defaultClipTransform(), visual: defaultClipVisualSettings(),
      title: { version: 1, elements: [{
        id: `${clip.id}-element`, version: 1, kind: 'text', name: 'Legacy text',
        enabled: true, transform: clip.transform, visual: clip.visual, opacity: 1,
        text: style, font: { family: fontFamily, fallbackFamily: null },
      }] },
    }
  }

  const singleUpgradeDelta = (() => {
    const clip = fixture(limit).sequences[0].tracks[0].clips[0]
    return JSON.stringify(proposedExpandedClip(clip)).length - JSON.stringify(clip).length
  })()
  assert(singleUpgradeDelta > 1)
  const rows = []
  for (const targetLength of [limit - singleUpgradeDelta, limit - singleUpgradeDelta + 1, limit - 1, limit]) {
    const project = fixture(targetLength)
    const serialized = serializeProjectFile(project)
    assert.equal(serialized.length, targetLength)
    const reopened = parseProjectFile(serialized)
    assert.equal(serializeProjectFile(reopened), serialized)
    assert(reopened.sequences[1].tracks[0].clips.some((clip) => clip.text.content.length > 0))
    const sourceClip = reopened.sequences[0].tracks[0].clips[0]
    const editedDoc = updateTextClip(reopened.sequences[0], sourceClip.id, {
      content: 'B' + sourceClip.text.content.slice(1), color: '#eeeeee',
    })
    assert.notEqual(editedDoc, reopened.sequences[0])
    const edited = { ...reopened, sequences: [editedDoc, reopened.sequences[1]] }
    const editedSerialized = serializeProjectFile(edited)
    assert.equal(editedSerialized.length, targetLength)
    assert.equal(parseProjectFile(editedSerialized).sequences[0].tracks[0].clips[0].text.content[0], 'B')

    const compatibility = {
      ...reopened,
      sequences: reopened.sequences.map((sequence) => ({ ...sequence, schemaVersion: 23 })),
    }
    // Character-count projection only: schema21/22/23 each have two digits;
    // preserving Clip.text and omitting empty new collections adds no fields.
    assert.equal(JSON.stringify(compatibility).length, targetLength)
    const expandedOne = {
      ...compatibility,
      sequences: compatibility.sequences.map((sequence, sequenceIndex) => ({
        ...sequence,
        tracks: sequence.tracks.map((track) => ({ ...track, clips: track.clips.map((clip, clipIndex) => (
          sequenceIndex === 0 && clipIndex === 0 ? proposedExpandedClip(clip) : clip
        )) })),
      })),
    }
    const expandedAll = {
      ...compatibility,
      sequences: compatibility.sequences.map((sequence) => ({ ...sequence,
        tracks: sequence.tracks.map((track) => ({ ...track, clips: track.clips.map(proposedExpandedClip) })),
      })),
    }
    const oneLength = JSON.stringify(expandedOne).length
    const allLength = JSON.stringify(expandedAll).length
    assert.equal(oneLength, targetLength + singleUpgradeDelta)
    assert.equal(oneLength <= limit, targetLength === limit - singleUpgradeDelta)
    assert(allLength > oneLength)
    rows.push({
      targetCharacters: targetLength,
      baselineParseSerializeEqual: true,
      equalLengthLegacyContentAndColorEditSave: true,
      compatibilityProjectionCharacters: JSON.stringify(compatibility).length,
      proposedSingleUpgradeCharacters: oneLength,
      proposedSingleUpgradeGrowth: oneLength - targetLength,
      proposedForcedAllUpgradeCharacters: allLength,
      proposedForcedAllUpgradeGrowth: allLength - targetLength,
      proposedUpgradeWithinCharacterBudget: oneLength <= limit,
    })
  }

  const atLimit = fixture(limit)
  const growable = atLimit.sequences.flatMap((sequence) => sequence.tracks[0].clips)
    .find((clip) => clip.text.content.length < 20_000)
  assert(growable)
  growable.text.content += 'A'
  assert.equal(JSON.stringify(atLimit).length, limit + 1)
  assert.throws(() => serializeProjectFile(atLimit), /exceeds 10000000 characters/)
  assert.throws(() => parseProjectFile(JSON.stringify(atLimit)), /exceeds 10000000 characters/)
  const result = {
    evidenceVersion: 1,
    baseline,
    productionSourceTree: sourceTree,
    qualification: 'Baseline validation is real. Future compatibility and expanded-title encodings are size projections only; no new schema parser or UI was exercised.',
    fixture: { sequences: 2, textClipsPerSequence: 300, dormantSequence: true, content: 'bounded ASCII padding in real text payloads', maxCharactersPerText: 20_000 },
    rows,
    oneOverLimit: { characters: limit + 1, baselineParseRejects: true, baselineSerializeRejects: true },
  }
  const output = new URL('./legacy-size-boundary-result.json', import.meta.url)
  await writeFile(output, JSON.stringify(result, null, 2) + '\n')
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} finally {
  await server.close()
}
