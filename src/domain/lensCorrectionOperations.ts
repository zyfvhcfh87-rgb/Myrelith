/** Immutable history-ready edits for manual source-geometry intent. */

import type { ClipId, TimelineDoc } from './schema'
import {
  isManualLensCorrectionModel,
  lensCorrectionValidationError,
  sameManualLensCorrectionModel,
  type ManualLensCorrectionModel,
} from './lensCorrection'

export function setManualLensCorrection(
  doc: TimelineDoc,
  clipId: ClipId,
  model: Readonly<ManualLensCorrectionModel> | null,
): TimelineDoc {
  for (let trackIndex = 0; trackIndex < doc.tracks.length; trackIndex++) {
    const track = doc.tracks[trackIndex]!
    const clipIndex = track.clips.findIndex((clip) => clip.id === clipId)
    if (clipIndex < 0) continue
    const clip = track.clips[clipIndex]!
    if (track.locked || track.kind !== 'video' || clip.text !== undefined) return doc
    if (model !== null) {
      const error = lensCorrectionValidationError(model)
      if (error) return doc
    }
    const current = clip.lensCorrection ?? null
    if (
      (current === null && model === null)
      || (
        model !== null
        && isManualLensCorrectionModel(current)
        && sameManualLensCorrectionModel(current, model)
      )
    ) return doc

    const clips = track.clips.slice()
    clips[clipIndex] = {
      ...clip,
      lensCorrection: model === null ? null : { ...model },
    }
    const tracks = doc.tracks.slice()
    tracks[trackIndex] = { ...track, clips }
    return { ...doc, tracks }
  }
  return doc
}
