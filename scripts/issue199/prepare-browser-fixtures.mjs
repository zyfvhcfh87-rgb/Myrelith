// Canonical portable fixtures only. Never imported by production.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const output = new URL('./fixtures/', import.meta.url)
mkdirSync(output, { recursive: true })
const server = await createServer({ root, configFile: false, envFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true } })
try {
  const { expandedTitleProject } = await server.ssrLoadModule('/src/test/titleOwnerFixtures.ts')
  const { attributeClip, ATTRIBUTE_ASSET_DESCRIPTOR } = await server.ssrLoadModule('/src/test/clipAttributeFixtures.ts')
  const { createMaskEffect, createColorAdjustEffect, DEFAULT_MASK_BEZIER_PATH } = await server.ssrLoadModule('/src/domain/effectStack.ts')
  const { createProjectFileSnapshot, serializeProjectFile, parseProjectFile } = await server.ssrLoadModule('/src/domain/projectFile.ts')
  const key = (frame, value, easing = { type: 'linear' }) => ({ frame, value, easing })
  const project = structuredClone(expandedTitleProject()), doc = project.sequences[0], title = doc.tracks[0].clips[0]
  project.name = 'Animation observable fixture'; doc.name = project.name
  title.name = 'Native curve title'
  title.animation = { tracks: [{ property: 'opacity', keyframes: [key(0, .2, { type: 'cubic-bezier', x1: .42, y1: 0, x2: .58, y2: 1 }), key(40, .8, { type: 'hold' }), key(80, .4)] }], titleTracks: [{ elementId: 'root-element', property: 'opacity', propertyVersion: 1, keyframes: [key(5, .4), key(70, .9)] }], effectTracks: [{ effectId: 'title-color', parameter: 'exposure', keyframes: [key(0, .1)] }] }
  title.effects = [createColorAdjustEffect('title-color')]
  const video = attributeClip('ordinary-video', 120); video.name = 'Offline video with held mask'; video.effects = [createMaskEffect('mask', 'bezier'), createColorAdjustEffect('color')]
  video.animation = { tracks: [{ property: 'opacity', keyframes: [key(-150, .25), key(20, .7), key(200, .5)] }, { property: 'future-property', propertyVersion: 7, keyframes: [key(0, .3)] }], effectTracks: [{ effectId: 'color', parameter: 'exposure', keyframes: [key(0, 0), key(30, .5)] }, { effectId: 'orphan', parameter: 'intent', keyframes: [key(0, 4)] }], effectPathTracks: [{ effectId: 'mask', parameter: 'path', valueType: 'mask-bezier-path', valueVersion: 1, keyframes: [key(0, DEFAULT_MASK_BEZIER_PATH, { type: 'hold' }), key(30, DEFAULT_MASK_BEZIER_PATH, { type: 'hold' })] }] }
  doc.tracks[0].clips.push(video)
  const audio = attributeClip('ordinary-audio', 0); audio.name = 'Offline clip audio'; audio.assetId = 'audio-asset'; audio.animation = { tracks: [{ property: 'volume', keyframes: [key(0, .25), key(30, .75)] }, { property: 'balance', keyframes: [key(0, -.5), key(30, .5)] }] }
  doc.tracks.find((track) => track.kind === 'audio').clips.push(audio)
  doc.tracks[1].adjustments = [{ kind: 'adjustment', id: 'adjustment', name: 'Adjustment color', timelineRange: { startFrame: 120, durationFrames: 60 }, enabled: true, opacity: 1, animation: { tracks: [{ property: 'opacity', keyframes: [key(0, .5), key(20, 1)] }], effectTracks: [{ effectId: 'adjust-color', parameter: 'exposure', keyframes: [key(0, 0), key(20, .5)] }] }, effects: [createColorAdjustEffect('adjust-color')] }]
  const audioDescriptor = { ...ATTRIBUTE_ASSET_DESCRIPTOR, id: 'audio-asset', fileName: 'silent-offline.wav', mimeType: 'audio/wav', kind: 'audio', width: null, height: null, hasAudio: true, audioSampleRate: 48000, audioChannels: 2, nativeFrameRate: null, sourceBounds: { video: null, audio: { status: 'unknown' } } }
  const save = (name, candidate, assets) => {
    const serialized = serializeProjectFile(createProjectFileSnapshot(candidate, assets))
    parseProjectFile(serialized)
    writeFileSync(new URL(name, output), serialized + '\n')
    return { bytes: Buffer.byteLength(serialized + '\n'), characters: serialized.length, sha256: createHash('sha256').update(serialized + '\n').digest('hex') }
  }
  const files = { 'mixed.myrelith': save('mixed.myrelith', project, [ATTRIBUTE_ASSET_DESCRIPTOR, audioDescriptor]) }
  const dense = structuredClone(project); dense.name = '100000 authored keys'; dense.sequences = [dense.sequences[0]]
  for (const track of dense.sequences[0].tracks) { track.clips = []; track.adjustments = [] }
  const denseClip = attributeClip('dense-clip'); denseClip.name = 'Dense exact navigation'; denseClip.animation = { tracks: [], effectTracks: [] }
  let remaining = 100000
  for (let lane = 0; remaining > 0; lane++) { const count = Math.min(remaining, 1024); denseClip.animation.effectTracks.push({ effectId: 'future-owner', parameter: `lane-${lane}`, keyframes: Array.from({ length: count }, (_, frame) => key(frame, frame % 2)) }); remaining -= count }
  dense.sequences[0].tracks[0].clips = [denseClip]
  files['dense.myrelith'] = save('dense.myrelith', dense, [ATTRIBUTE_ASSET_DESCRIPTOR])
  const lanes = structuredClone(dense); lanes.name = '1280 dormant lanes and distant owners'; const owner = lanes.sequences[0].tracks[0].clips[0]
  owner.animation.effectTracks = Array.from({ length: 1280 }, (_, lane) => ({ effectId: 'future-owner', parameter: `lane-${lane}`, keyframes: [key(-100, lane), key(1000000, lane)] }))
  lanes.sequences[0].tracks[0].clips.push(...Array.from({ length: 1000 }, (_, index) => attributeClip(`empty-${index}`, 10000000 + index * 100)))
  files['many-lanes.myrelith'] = save('many-lanes.myrelith', lanes, [ATTRIBUTE_ASSET_DESCRIPTOR])
  writeFileSync(new URL('manifest.json', output), JSON.stringify({ productSource: '87d8032f25ef469449d59741fba56d1b76eda6aa', format: 'canonical portable Myrelith; source assets intentionally offline; no media output', generatorSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'), files }, null, 2) + '\n')
  console.log(JSON.stringify(files))
} finally { await server.close() }
