import type { Clip, MediaAsset, SourceTimeMap, TimeRange, TimelineDoc, TrackId } from '../schema';
import { clipAnimation, clipAnimationKeyframeCount, clipAnimationKindError, clipAnimationValidationError, cloneClipAnimation, defaultClipAnimation, documentAnimationKeyframeGrowthAllowed } from '../clipAnimation';
import { clipAudioSettings, clipAudioSettingsValidationError, clipVisualSettings, clipVisualSettingsValidationError, defaultClipAudioSettings, defaultClipVisualSettings, transformScaleValidationError } from '../clipInspector';
import { defaultTextProps, proceduralTextAssetId, textOverlayName, textPropsValidationError } from '../textOverlay';
import { DEFAULT_BLEND_MODE } from '../blendModes';
import { effectCollectionAppendBudgetError } from '../effectBounds';
import { audioEffectCollectionAppendBudgetError, clipAudioEffects } from '../audioEffectBounds';
import { cloneAudioEffectStack } from '../audioEffectStack';
import { clipSourceTimeMap, cloneSourceTimeMap, defaultSourceTimeMap, sourceRangeForMap, sourceTimeMapValidationError, SOURCE_TIME_TICKS_PER_FRAME } from '../sourceTimeMap';
import { byStart, locateClip, newId, overlapsAny, reconcileTransitions, reject, withTrack } from './operationInternals';

/**
 * Build a Clip that plays `asset` for `durationFrames` timeline frames,
 * starting at `timelineStartFrame`, from document-rate source frame
 * `sourceStartFrame`. Pure factory — it does NOT validate against a doc
 * (insertClip does that). Still images ignore `sourceStartFrame` and keep
 * the canonical one-frame source. When `linkGroupId` is given (the A/V
 * drop/insert path), it is stamped onto the clip; omitted, the key is left
 * absent.
 */
export function clipFromAssetRange(
  asset: MediaAsset,
  timelineStartFrame: number,
  sourceStartFrame: number,
  durationFrames: number,
  linkGroupId?: string,
): Clip {
  const still = asset.kind === 'image'
  const sourceStart = still ? 0 : sourceStartFrame
  const sourceDuration = still ? 1 : durationFrames
  return {
    id: newId('clip'),
    assetId: asset.id,
    name: asset.fileName,
    sourceMode: still ? 'still' : 'timed',
    sourceRange: {
      startFrame: sourceStart,
      durationFrames: sourceDuration,
    },
    sourceTimeMap: defaultSourceTimeMap(sourceStart, sourceDuration),
    timelineRange: { startFrame: timelineStartFrame, durationFrames },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    blendMode: DEFAULT_BLEND_MODE,
    volume: 1,
    lensCorrection: null,
    visual: defaultClipVisualSettings(),
    audio: defaultClipAudioSettings(),
    animation: defaultClipAnimation(),
    effects: [],
    audioEffects: [],
    ...(linkGroupId ? { linkGroupId } : {}),
  }
}

/**
 * Build a default Clip that plays `asset` in full, starting at timeline
 * frame `startFrame`. Delegates to {@link clipFromAssetRange}. Per the MVP
 * conformance note in schema.ts, asset.durationFrames is already measured
 * in document-rate frames.
 */
export function clipFromAsset(
  asset: MediaAsset,
  startFrame: number,
  linkGroupId?: string,
): Clip {
  return clipFromAssetRange(
    asset,
    startFrame,
    0,
    asset.durationFrames,
    linkGroupId,
  )
}

/** Build one bounded procedural text clip at an explicit timeline range. */
export function createTextClip(
  doc: TimelineDoc,
  startFrame: number,
  durationFrames: number,
  content = 'Your text',
): Clip {
  if (!Number.isSafeInteger(startFrame) || startFrame < 0) {
    throw new RangeError('Text overlay start frame must be a safe integer at or after 0.')
  }
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 1) {
    throw new RangeError('Text overlay duration must be a positive safe integer.')
  }
  const id = newId('text')
  const text = defaultTextProps(doc.width, doc.height, content)
  const error = textPropsValidationError(text)
  if (error) throw new RangeError(error)
  return {
    id,
    assetId: proceduralTextAssetId(id),
    name: textOverlayName(content),
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames },
    sourceTimeMap: defaultSourceTimeMap(0, durationFrames),
    timelineRange: { startFrame, durationFrames },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    blendMode: DEFAULT_BLEND_MODE,
    volume: 1,
    lensCorrection: null,
    visual: defaultClipVisualSettings(),
    audio: defaultClipAudioSettings(),
    animation: defaultClipAnimation(),
    effects: [],
    audioEffects: [],
    text,
  }
}

/**
 * Insert a new clip onto a track. The clip is defensively deep-copied so
 * later mutation of the caller's object cannot reach into the doc. Rejected
 * on unknown/locked track, duplicate clip id, non-integer or negative
 * frames, duration < 1, invalid timed/still source geometry, or overlap with
 * an existing clip.
 *
 * Asset-kind vs track-kind compatibility is NOT checked here: assets live in
 * state/mediaStore and domain/ cannot see them (same boundary as the
 * source-length note in the file header). The UI gates that before calling.
 */
export function insertClip(
  doc: TimelineDoc,
  trackId: TrackId,
  clip: Clip,
): TimelineDoc {
  const op = 'insertClip'
  const tl = clip.timelineRange
  const src = clip.sourceRange

  if (!Number.isInteger(tl.startFrame) || tl.startFrame < 0) {
    return reject(doc, op, `timeline start must be an integer >= 0, got ${tl.startFrame}`)
  }
  if (!Number.isInteger(tl.durationFrames) || tl.durationFrames < 1) {
    return reject(doc, op, `duration must be an integer >= 1, got ${tl.durationFrames}`)
  }
  if (!Number.isInteger(src.startFrame) || src.startFrame < 0) {
    return reject(doc, op, `source start must be an integer >= 0, got ${src.startFrame}`)
  }
  if (clip.sourceMode !== 'timed' && clip.sourceMode !== 'still') {
    return reject(doc, op, `unknown source mode ${String(clip.sourceMode)}`)
  }
  let sourceTimeMap: SourceTimeMap
  try {
    sourceTimeMap = clipSourceTimeMap(clip)
  } catch (error) {
    return reject(
      doc,
      op,
      error instanceof Error ? error.message : 'invalid source-time mapping',
    )
  }
  const sourceTimeMapError = sourceTimeMapValidationError(sourceTimeMap)
  if (sourceTimeMapError) return reject(doc, op, sourceTimeMapError)
  if (
    clip.sourceMode === 'still'
    && (src.startFrame !== 0 || src.durationFrames !== 1)
  ) {
    return reject(
      doc,
      op,
      'still clips must use source frame 0 with duration 1',
    )
  }
  if (clip.sourceMode !== 'still') {
    let mappedSourceRange: TimeRange
    try {
      mappedSourceRange = sourceRangeForMap(sourceTimeMap, tl.durationFrames)
    } catch (error) {
      return reject(
        doc,
        op,
        error instanceof Error ? error.message : 'invalid source-time mapping',
      )
    }
    if (
      mappedSourceRange.startFrame !== src.startFrame
      || mappedSourceRange.durationFrames !== src.durationFrames
    ) {
      return reject(
        doc,
        op,
        'sourceRange must equal the source-time mapping envelope',
      )
    }
  }
  if (
    clip.sourceMode === 'still'
    && (
      sourceTimeMap.sourceStartTicks !== 0
      || sourceTimeMap.sourceDurationTicks !== SOURCE_TIME_TICKS_PER_FRAME
      || sourceTimeMap.rate.numerator !== 1
      || sourceTimeMap.rate.denominator !== 1
    )
  ) {
    return reject(
      doc,
      op,
      'still clips must use the canonical 1x source-time map',
    )
  }
  if (clip.text !== undefined) {
    if (clip.assetId !== proceduralTextAssetId(clip.id)) {
      return reject(doc, op, 'text clips must use their reserved procedural asset id')
    }
    if (clip.sourceMode !== 'timed') {
      return reject(doc, op, 'text clips must use procedural timed source mode')
    }
    if (src.startFrame !== 0) {
      return reject(doc, op, 'text clips must use procedural source start 0')
    }
    const textError = textPropsValidationError(clip.text)
    if (textError) return reject(doc, op, textError)
  }
  const scaleError = transformScaleValidationError(clip.transform)
  if (scaleError) return reject(doc, op, scaleError)
  const visualError = clipVisualSettingsValidationError(
    clipVisualSettings(clip),
  )
  if (visualError) return reject(doc, op, visualError)
  const audioError = clipAudioSettingsValidationError(
    clipAudioSettings(clip),
    tl.durationFrames,
  )
  if (audioError) return reject(doc, op, audioError)
  const animation = clipAnimation(clip)
  const animationError = clipAnimationValidationError(animation)
  if (animationError) return reject(doc, op, animationError)

  const trackIndex = doc.tracks.findIndex((t) => t.id === trackId)
  if (trackIndex === -1) return reject(doc, op, `track ${trackId} not found`)
  const track = doc.tracks[trackIndex]
  if (track.locked) return reject(doc, op, `track ${track.id} is locked`)
  if (clip.text !== undefined && track.kind !== 'video') {
    return reject(doc, op, 'text clips can only be placed on video tracks')
  }
  const animationKindError = clipAnimationKindError(
    track.kind,
    clip.text !== undefined,
    animation,
  )
  if (animationKindError) return reject(doc, op, animationKindError)

  if (locateClip(doc, clip.id)) {
    return reject(doc, op, `clip id ${clip.id} already exists in the document`)
  }
  if (overlapsAny(track, tl)) {
    return reject(doc, op, 'insert would overlap a clip on the target track')
  }
  const effectBudgetError = effectCollectionAppendBudgetError(doc, clip.effects)
  if (effectBudgetError) return reject(doc, op, effectBudgetError)
  const audioEffectBudgetError = audioEffectCollectionAppendBudgetError(
    doc,
    clipAudioEffects(clip),
  )
  if (audioEffectBudgetError) return reject(doc, op, audioEffectBudgetError)
  if (!documentAnimationKeyframeGrowthAllowed(
    doc,
    clipAnimationKeyframeCount(animation),
  )) return reject(doc, op, 'insert would exceed the document keyframe budget')

  const copy: Clip = {
    ...clip,
    sourceRange: { ...src },
    sourceTimeMap: cloneSourceTimeMap(sourceTimeMap),
    timelineRange: { ...tl },
    transform: { ...clip.transform },
    visual: {
      ...clipVisualSettings(clip),
      crop: { ...clipVisualSettings(clip).crop },
    },
    audio: { ...clipAudioSettings(clip) },
    animation: cloneClipAnimation(animation),
    effects: clip.effects.map((e) => ({ ...e, params: { ...e.params } })),
    audioEffects: cloneAudioEffectStack(clip.audioEffects),
    ...(clip.text === undefined ? {} : { text: { ...clip.text } }),
  }

  const clips = [...track.clips, copy].sort(byStart)
  const nextTrack = reconcileTransitions(track, { ...track, clips })
  return withTrack(doc, trackIndex, nextTrack)
}
