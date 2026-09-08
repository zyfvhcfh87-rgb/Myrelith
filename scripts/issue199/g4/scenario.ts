import { observeProjectSession, type SessionEvent } from './sessionObservation'
import { RECOVERY_SAVE_DELAY_MS } from '../../../src/app/projectPersistenceController'
import { useProjectSessionStore } from '../../../src/state/projectSessionStore'
import { PcmCoverage } from './pcmCoverage'
import { buildFixtureProject } from './fixture'
import { G4PreparedExportFailure, runPreparedExport, type PreparedExportEvent } from './preparedExport'
/** Disposable source-module browser adapter. Never imported by the production app. */
import { Output, BufferTarget, CanvasSource, WebMOutputFormat, Input, BlobSource, ALL_FORMATS, VideoSampleSink, AudioBufferSink, EncodedPacketSink } from 'mediabunny'
import { importMedia } from '../../../src/app/mediaImportController'
import { useDocumentStore } from '../../../src/state/documentStore'
import { useMediaStore } from '../../../src/state/mediaStore'
import { useTransportStore } from '../../../src/state/transportStore'
import { planTitleEdit } from '../../../src/domain/titleEditing'
import { createProjectFileSnapshot, parseProjectFile, serializeProjectFile } from '../../../src/domain/projectFile'
import { exportPresetById } from '../../../src/domain/exportProfile'
import { disposeExport } from '../../../src/app/exportController'
import { disposePluginPreparedExportOwner } from '../../../src/app/pluginPreparedExportOwner'
import { subscribePreviewRenderDiagnostics, disposePreview } from '../../../src/app/previewController'
import { pauseAndDrainPlayback, disposeTransport } from '../../../src/app/transportController'
import { mediaResourceAdmission } from '../../../src/app/mediaResourceAdmission'

export const FRAMES = [0, 7, 14, 15, 22, 29] as const
const encode = (bytes: Uint8Array) => { let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(binary) }
const digest = async (bytes: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((v) => v.toString(16).padStart(2, '0')).join('')
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
let originals: File[] = []
let portable = ''
let referenceProject: ReturnType<typeof useDocumentStore.getState>['project'] | null = null
let encoded: Uint8Array<ArrayBuffer> | null = null
let raw: { frame: number; pixels: number[]; glyph: ReturnType<typeof glyph> }[] = []
const profile = { ...exportPresetById('web').profile, videoBitrate: 5_000_000, audioCodec: 'opus' as const, audioChannelLayout: 'stereo' as const, audioBitrate: 192_000, audioBitrateMode: 'variable' as const }

function wave(silent: boolean): File {
  const bytes = new Uint8Array(44 + 48000 * 4), v = new DataView(bytes.buffer)
  const text = (at: number, value: string) => [...value].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)))
  text(0, 'RIFF'); v.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt '); v.setUint32(16, 16, true)
  v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, 48000, true); v.setUint32(28, 192000, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true)
  text(36, 'data'); v.setUint32(40, bytes.length - 44, true)
  for (let i = 0; i < 48000; i++) for (let channel = 0; channel < 2; channel++) v.setInt16(44 + i * 4 + channel * 2, silent ? 0 : Math.round(4096 * Math.sin(2 * Math.PI * 250 * i / 48000)), true)
  return new File([bytes], silent ? 'g4-silence.wav' : 'g4-oracle.wav', { type: 'audio/wav' })
}
async function mediaFile(): Promise<File> {
  const canvas = new OffscreenCanvas(1280, 720), ctx = canvas.getContext('2d')!
  const target = new BufferTarget(), output = new Output({ format: new WebMOutputFormat(), target }), source = new CanvasSource(canvas, { codec: 'vp9', bitrate: 5_000_000 })
  output.addVideoTrack(source, { frameRate: 30 }); let finalized = false, closed = false
  try {
    await output.start()
    for (let f = 0; f < 60; f++) {
      ctx.fillStyle = '#204060'; ctx.fillRect(0, 0, 1280, 720)
      ctx.fillStyle = '#903020'; ctx.fillRect(50 + f * 12, 520, 80, 80)
      await source.add(f / 30, 1 / 30)
    }
    source.close(); closed = true; await output.finalize(); finalized = true
    check(target.buffer, 'Empty generated video')
    return new File([target.buffer], 'g4-source.webm', { type: 'video/webm' })
  } finally { try { if (!closed) source.close(); if (!finalized) await output.cancel() } finally { canvas.width = canvas.height = 0 } }
}
async function imported(file: File) {
  const result = await importMedia(file)
  check(result.status === 'imported', `Import failed: ${JSON.stringify(result)}`)
  const asset = useMediaStore.getState().assets.get(result.assetId); check(asset, 'Imported asset absent'); return asset
}
export async function prepare() {
  const launcherProject = useDocumentStore.getState().project
  originals = [await mediaFile(), wave(true)]
  const video = await imported(originals[0]), sound = await imported(originals[1])
  const project = buildFixtureProject(video, sound)
  check(useDocumentStore.getState().project === launcherProject, 'Fixture generation changed the active project')
  return savePortable(project)
}
export function retimeAndSplit() {
  const project = useDocumentStore.getState().project
  check(project.id === 'g4' && JSON.stringify(project.sequences) === JSON.stringify(parseProjectFile(portable).sequences), 'Canonical fixture activation differs')
  const videoId = project.sequences[0].tracks.flatMap((t) => t.clips).find((c) => c.id === 'g4-video')!.assetId
  const beforeRetime = useDocumentStore.getState().project
  useDocumentStore.getState().retimeClip('g4-video', { numerator: 2, denominator: 1 })
  check(useDocumentStore.getState().project !== beforeRetime, 'Retime was refused')
  const retimed = useDocumentStore.getState().doc.tracks.flatMap((t) => t.clips).find((c) => c.id === 'g4-video')!
  check(retimed.timelineRange.durationFrames === 30, 'Retime duration is not 30')
  const beforeSplit = useDocumentStore.getState().project
  useDocumentStore.getState().splitClipAt('g4-video', 15)
  check(useDocumentStore.getState().project !== beforeSplit, 'Split was refused')
  const split = useDocumentStore.getState().project
  useDocumentStore.getState().undo(); check(useDocumentStore.getState().project === beforeSplit, 'Split undo differs')
  useDocumentStore.getState().redo(); check(useDocumentStore.getState().project === split, 'Split redo differs')
  useTransportStore.getState().setSelectedClip('g4-video'); useTransportStore.getState().setPlayheadFrame(1)
  return { retimed: retimed.sourceTimeMap, split: useDocumentStore.getState().doc.tracks.flatMap((t) => t.clips).filter((c) => c.assetId === videoId).map((c) => ({ id: c.id, timeline: c.timelineRange, source: c.sourceTimeMap, animation: c.animation })) }
}
let titleKeyCheckpoint: ReturnType<typeof useDocumentStore.getState> | null = null
export function titleKeyFrame(frame: number) { titleKeyCheckpoint ??= useDocumentStore.getState(); useTransportStore.getState().setPlayheadFrame(frame) }
export function verifyTitleKeyEdit() {
  check(titleKeyCheckpoint, 'No title key checkpoint')
  const state = useDocumentStore.getState(), clip = state.doc.tracks.flatMap((t) => t.clips).find((c) => c.id === 'g4-title')!
  const lane = clip.animation!.titleTracks!.find((t) => t.elementId === 'g4-shape' && t.property === 'position-y')!
  check(state.past.length === titleKeyCheckpoint.past.length + 3, 'Title Set/value/paste did not each commit once')
  check(JSON.stringify(lane.keyframes.map((k) => [k.frame, k.sourceTimeTicks])) === JSON.stringify([[0, 0], [14, 14_000_000], [20, 20_000_000], [29, 29_000_000]]), 'Title UI source-time keys differ')
  check(lane.keyframes[1].value === -120 && lane.keyframes[2].value === -120, 'Title UI value/copy/paste differs')
  titleKeyCheckpoint = null; useTransportStore.getState().setPlayheadFrame(1)
  return { keys: lane.keyframes, exactThreeHistoryEntries: true }
}
export async function installOracleAndSave() {
  await pauseAndDrainPlayback()
  const audioFile = wave(false), asset = await imported(audioFile); originals = [originals[0], audioFile]
  const project = useDocumentStore.getState().project
  useDocumentStore.getState().setProject({ ...project, sequences: project.sequences.map((s) => ({ ...s, tracks: s.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => c.id === 'g4-audio' ? { ...c, assetId: asset.id, name: audioFile.name } : c) })) })) })
  return savePortable(useDocumentStore.getState().project)
}
async function savePortable(project: ReturnType<typeof useDocumentStore.getState>['project']) {
  const used = new Set(project.sequences.flatMap((s) => s.tracks.flatMap((t) => t.clips.map((c) => c.assetId))))
  portable = serializeProjectFile(createProjectFileSnapshot(project, [...useMediaStore.getState().descriptors.values()].filter((d) => used.has(d.id))))
  return { portable, files: await Promise.all(originals.map(async (f) => { const bytes = new Uint8Array(await f.arrayBuffer()); return { name: f.name, bytes: encode(bytes), sha256: await digest(bytes) } })) }
}
export function verifyReopened() {
  const expected = parseProjectFile(portable), current = useDocumentStore.getState().project
  check(JSON.stringify(current.sequences) === JSON.stringify(expected.sequences), 'Reopened sequences differ')
  referenceProject = current; useTransportStore.getState().setPlayheadFrame(1)
  return { exactSequences: true, retainedUnknownEffect: current.sequences[0].tracks.flatMap((t) => t.clips).some((c) => c.effects.some((e) => e.id === 'g4-future' && e.params.literal === 'preserve me')) }
}
function glyph(data: Uint8ClampedArray) {
  let count = 0, x = 0, y = 0
  for (let p = 0; p < data.length; p += 4) if (data[p] > 235 && data[p + 1] > 235 && data[p + 2] > 235) { count++; x += (p / 4) % 1280; y += Math.floor(p / 4 / 1280) }
  return { count, x: count ? x / count : null, y: count ? y / count : null }
}
function sampled(data: Uint8ClampedArray) {
  const samples: number[] = []
  for (let y = 4; y < 720; y += 8) for (let x = 4; x < 1280; x += 8) { const at = (y * 1280 + x) * 4; samples.push(data[at], data[at + 1], data[at + 2]) }
  return samples
}
export async function capture(frame: number) {
  const pinned = useDocumentStore.getState(), canvas = document.querySelector<HTMLCanvasElement>('[data-testid="preview-canvas"]')
  check(pinned.project === referenceProject, 'Reference differs from the reopened project')
  const previewsClear = () => { const t = useTransportStore.getState(); return !t.effectDocumentPreview && !t.clipVisualPreview && !t.textOverlayPreview }
  check(previewsClear(), 'Reference has an active disposable preview')
  check(pinned.doc.width === 1280 && pinned.doc.height === 720 && pinned.activeSequenceId === 'g4', 'Reference project/dimensions differ')
  check(canvas?.isConnected && canvas.width === 1280 && canvas.height === 720, 'Reference canvas/backing dimensions differ')
  const expectedDrawn = pinned.doc.tracks.filter((t) => t.kind === 'video' && !t.hidden).flatMap((t) => t.clips.filter((c) => c.timelineRange.startFrame <= frame && frame < c.timelineRange.startFrame + c.timelineRange.durationFrames).map((c) => c.id)).sort()
  let proof: unknown
  await new Promise<void>((resolve, reject) => {
    const start = performance.now(), timer = setTimeout(() => { stop(); reject(new Error(`Program frame ${frame} missing`)) }, 10000)
    const stop = subscribePreviewRenderDiagnostics((event) => { if (event.frame === frame && event.requestedAt >= start && event.result.status === 'drawn') { clearTimeout(timer); stop(); if (event.result.missingClipIds.length || event.result.message || JSON.stringify([...event.result.drawnClipIds].sort()) !== JSON.stringify(expectedDrawn)) reject(new Error('Program reference has missing clips or render error')); else { proof = event; resolve() } } })
    useTransportStore.getState().setPlayheadFrame(frame)
  })
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const now = useDocumentStore.getState()
  check(previewsClear() && now.project === pinned.project && now.projectGeneration === pinned.projectGeneration && now.activeSequenceId === pinned.activeSequenceId, 'Reference project changed')
  check(canvas === document.querySelector('[data-testid="preview-canvas"]') && canvas.isConnected && canvas.width === 1280 && canvas.height === 720 && useTransportStore.getState().playheadFrame === frame, 'Reference canvas/frame changed')
  const sample = new OffscreenCanvas(1280, 720), ctx = sample.getContext('2d', { willReadFrequently: true })!
  try { ctx.drawImage(canvas, 0, 0, 1280, 720); const data = ctx.getImageData(0, 0, 1280, 720).data; const result = { frame, pixels: sampled(data), glyph: glyph(data) }; raw.push(result); return { ...result, proof, projectId: now.project.id, generation: now.projectGeneration, dimensions: [canvas.width, canvas.height] } }
  finally { sample.width = sample.height = 0 }
}
export async function exportEncoded(progress: (event: PreparedExportEvent) => Promise<void>) {
  await pauseAndDrainPlayback()
  const before = useDocumentStore.getState().project
  check(before === referenceProject, 'Export differs from the reopened reference project')
  const result = await runPreparedExport(profile, before, progress); check(result?.destination === 'download', 'Export did not produce bytes')
  encoded = new Uint8Array(result.buffer)
  return { projectUnchanged: useDocumentStore.getState().project === before, bytes: encode(encoded), sha256: await digest(encoded), size: encoded.length }
}
export async function decodeOutput(progress: (value: unknown) => Promise<void>) {
  check(encoded, 'No preserved export bytes')
  const bytes = encoded, admission = mediaResourceAdmission.snapshot()
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([bytes])) })
  const partial: { frames: unknown[]; packetTimeline?: { timestamp: number; duration: number }[]; pcm?: unknown; error?: string } = { frames: [] }
  const canvas = new OffscreenCanvas(1280, 720), ctx = canvas.getContext('2d', { willReadFrequently: true })!
  try {
    const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack(); check(video && audio, 'Missing encoded A/V tracks')
    const packetTimeline: { timestamp: number; duration: number }[] = []
    partial.packetTimeline = packetTimeline
    for await (const packet of new EncodedPacketSink(video).packets(undefined, undefined, { metadataOnly: true })) {
      packetTimeline.push({ timestamp: packet.timestamp, duration: packet.duration })
      check(packetTimeline.length <= 30, 'More than 30 encoded video packets')
    }
    await progress(partial)
    const sink = new VideoSampleSink(video), frames = []
    for (const frame of FRAMES) {
      const sample = await sink.getSample((frame + 0.5) / 30); check(sample, `Missing encoded frame ${frame}`)
      const timestamp = sample.timestamp, duration = sample.duration
      try { check(Math.abs(timestamp - frame / 30) <= 0.001, `Decoded frame timestamp mismatch: ${frame} at ${timestamp}`); sample.draw(ctx, 0, 0, 1280, 720) } finally { sample.close() }
      const data = ctx.getImageData(0, 0, 1280, 720).data, reference = raw.find((r) => r.frame === frame); check(reference, 'Raw reference absent')
      const values = sampled(data), errors = values.map((value, i) => Math.abs(value - reference.pixels[i])).sort((a, b) => a - b)
      const decodedPng = encode(new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()))
      frames.push({ frame, timestamp, duration, decodedPng, rawGlyph: reference.glyph, decodedGlyph: glyph(data), rgbMeanError: errors.reduce((a, b) => a + b, 0) / errors.length, rgbP95Error: errors[Math.floor(errors.length * 0.95)] })
      partial.frames = frames.map(({ decodedPng: _png, ...facts }) => facts); await progress(partial)
    }
    partial.frames = frames.map(({ decodedPng: _png, ...facts }) => facts); await progress(partial)
    const coverage = new PcmCoverage()
    for await (const wrapped of new AudioBufferSink(audio).buffers(0, 1)) {
      partial.pcm = { ...coverage.snapshot(), nextBuffer: { timestamp: wrapped.timestamp, samples: wrapped.buffer.length, sampleRate: wrapped.buffer.sampleRate, channels: wrapped.buffer.numberOfChannels } }
      await progress(partial)
      check(wrapped.buffer.numberOfChannels === 2, 'Decoded PCM channel count differs')
      coverage.add(wrapped.timestamp, wrapped.buffer.sampleRate, [wrapped.buffer.getChannelData(0), wrapped.buffer.getChannelData(1)])
    }
    partial.pcm = coverage.snapshot(); await progress(partial)
    const complete = coverage.finish(), pcm = coverage.channels
    const rms = (channel: number, start: number) => Math.sqrt(pcm[channel].slice(start, start + 2400).reduce((sum, value) => sum + value * value, 0) / 2400)
    return { sha256: await digest(bytes), size: bytes.length, duration: await input.computeDuration(), videoDuration: await video.computeDuration(), width: video.displayWidth, height: video.displayHeight,
      videoCodec: await video.getCodec(), audioCodec: await audio.getCodec(), videoPackets: await video.computePacketStats(), packetTimeline, frames, pcm: { through: complete.coveredSamples, coverage: complete, early: [rms(0, 9600), rms(1, 9600)], late: [rms(0, 33600), rms(1, 33600)] }, admission, afterAdmission: mediaResourceAdmission.snapshot() }
  } catch (error) { partial.error = String(error); await progress(partial); throw error } finally { input.dispose(); canvas.width = canvas.height = 0; await disposeExport(); raw = []; encoded = null }
}
export async function rejectMissingFont(progress: (event: PreparedExportEvent) => Promise<void>) {
  const before = useDocumentStore.getState().project
  const missing = planTitleEdit(before, { sequenceId: 'g4', clipId: 'g4-title' }, { kind: 'patch', ids: ['g4-words'], patch: { font: { family: 'G4 Missing Named Font', fallbackFamily: null } } }, () => 'g4-unused')
  useDocumentStore.getState().setProject(missing)
  let reason = '', unexpected: Awaited<ReturnType<typeof runPreparedExport>>
  try { unexpected = await runPreparedExport(profile, missing, progress) }
  catch (error) {
    if (!(error instanceof G4PreparedExportFailure) || error.stage !== 'start') throw error
    reason = String(error.cause)
  }
  finally { try { await disposeExport() } finally { useDocumentStore.getState().setProject(before) } }
  if (unexpected) return { unexpected: true, destination: unexpected.destination, bytes: unexpected.destination === 'download' ? encode(new Uint8Array(unexpected.buffer)) : null }
  check(/font|fallback/i.test(reason), `Missing font refusal absent: ${reason}`); return { reason }
}
export async function dispose() { await pauseAndDrainPlayback(); await disposePluginPreparedExportOwner('issue199-g4-dispose'); await disposeExport(); await disposeTransport(); await disposePreview(); originals = []; raw = []; portable = ''; encoded = null; referenceProject = null; return mediaResourceAdmission.snapshot() }

let sessionObservation: ReturnType<typeof observeProjectSession> | null = null
export function observeSession(write: (event: SessionEvent) => Promise<void>) {
  check(!sessionObservation, 'Session observation already active')
  sessionObservation = observeProjectSession(write)
  return sessionObservation.flush()
}
export async function sessionCheckpoint() {
  check(sessionObservation, 'Session observation is absent')
  await sessionObservation.flush()
  const events = sessionObservation.snapshot()
  check(events.every((e) => !e.errors.length), 'Project session error was observed')
  return { events: events.length, last: events.at(-1) }
}
export async function finishSessionObservation() {
  // Allow the real recovery debounce to fire, then await its projected terminal state.
  await new Promise((resolve) => setTimeout(resolve, RECOVERY_SAVE_DELAY_MS + 100))
  const start = performance.now()
  while (useProjectSessionStore.getState().recoveryPhase === 'saving' || useProjectSessionStore.getState().savePhase === 'saving') {
    check(performance.now() - start < 3000, 'Project persistence did not settle')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  // Keep observing through the driver's final evidence and context-close cleanup.
  return sessionCheckpoint()
}
