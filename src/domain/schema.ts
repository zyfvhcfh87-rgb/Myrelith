/**
 * domain/schema.ts — Data-model contracts for the WebCut timeline document.
 *
 * Phase 0. Types only — no logic, no browser APIs (see ARCHITECTURE.md:
 * domain/ imports nothing). All positions and durations on the timeline are
 * INTEGER frame counts; seconds exist only at the encoder/decoder/audio-clock
 * boundary, converted via domain/time.ts.
 *
 * Timed clips play at speed 1.0 and assets are treated as conformed to the
 * document frame rate, so `sourceRange` is measured in document-rate frames
 * from asset start and its duration matches `timelineRange`. Still clips use
 * the explicit one-frame source below while their timeline duration is
 * independently editable.
 */

/* ------------------------------------------------------------------ */
/* Time primitives                                                      */
/* ------------------------------------------------------------------ */

/**
 * Exact rational frame rate: fps = num / den.
 * NTSC 29.97 is { num: 30000, den: 1001 } — never store 29.97 as a float.
 */
export interface FrameRate {
  /** Rate numerator (e.g. 30000). Positive integer. */
  num: number
  /** Rate denominator (e.g. 1001). Positive integer. */
  den: number
}

/**
 * A point (or delta) on a timebase: an integer frame count paired with the
 * rate that gives it meaning. Convert to/from seconds only through the
 * helpers in domain/time.ts.
 */
export interface RationalTime {
  /** Integer frame count. May be negative when representing a delta. */
  frames: number
  /** The frame rate this count is measured at. */
  rate: FrameRate
}

/**
 * Half-open frame range [startFrame, startFrame + durationFrames), in integer
 * frames at the owning document's frame rate. Half-open means two ranges that
 * merely touch (end of A == start of B) do NOT overlap.
 */
export interface TimeRange {
  /** First frame of the range, inclusive. Integer; >= 0 within a document. */
  startFrame: number
  /** Length in frames. Integer >= 0; clip ranges must be >= 1. */
  durationFrames: number
}

/* ------------------------------------------------------------------ */
/* Ids                                                                  */
/* ------------------------------------------------------------------ */

/** Unique id of an imported media asset (stable across sessions). */
export type AssetId = string
/** Unique id of a track within a document. */
export type TrackId = string
/** Unique id of a clip within a document. */
export type ClipId = string
/** Unique id of an effect instance on a clip. */
export type EffectId = string
/** Unique id of a transition instance on a track. */
export type TransitionId = string

/* ------------------------------------------------------------------ */
/* Media assets                                                         */
/* ------------------------------------------------------------------ */

/** Track kind exposed to the editor after any explicit partial projection. */
export type AssetKind = 'video' | 'audio' | 'image'

/** A durable, explicitly confirmed choice to omit one source track kind. */
export type PartialTrackImportSelection = 'video-only' | 'audio-only'

/**
 * An imported source file, registered in state/mediaStore. Immutable once
 * imported; clips reference it by id and never copy its data.
 */
export interface MediaAsset {
  /** Unique asset id. */
  id: AssetId
  /** Original file name, for display in the media pool. */
  fileName: string
  /** Original browser-reported MIME type, retained for save/relink matching. */
  mimeType: string
  /** Original file size in bytes, retained for save/relink matching. */
  size: number
  /** Original File.lastModified timestamp, retained for save/relink matching. */
  lastModified: number
  /**
   * Object URL for the underlying File/Blob. Session-scoped: NOT valid across
   * page reloads, so it is excluded from project serialization and must be
   * re-linked on load.
   */
  objectUrl: string
  /** Effective track kind available to timeline and runtime consumers. */
  kind: AssetKind
  /**
   * Present only when the user explicitly imported one usable track kind from
   * a multi-track source. The choice is durable so relinking never silently
   * restores an omitted track on another browser or machine.
   */
  partialTrackSelection?: PartialTrackImportSelection
  /**
   * Total playable length in document-rate frames (see MVP note in the file
   * header). Images use a nominal default chosen at import.
   */
  durationFrames: number
  /**
   * Canonical playable duration in integer microseconds, independent of the
   * document frame rate. Re-conforming an asset to another project rate must
   * derive durationFrames from this value rather than from its native frame
   * count, otherwise a 60fps source becomes twice as long in a 30fps project.
   */
  durationMicroseconds: number
  /** Native frame rate of the video stream; null for audio-only and images. */
  frameRate: FrameRate | null
  /** Pixel width of the video/image stream; null for audio-only. */
  width: number | null
  /** Pixel height of the video/image stream; null for audio-only. */
  height: number | null
  /** True only when audio is included in this imported projection. */
  hasAudio: boolean
  /** Sample rate (Hz) of the audio stream; null when hasAudio is false. */
  audioSampleRate: number | null
  /** Channel count of the audio stream; null when hasAudio is false. */
  audioChannels: number | null
  /**
   * Serialized VideoDecoderConfig for the video stream, as JSON with the
   * binary `description` field (if present) base64-encoded. Lets workers
   * configure a VideoDecoder without re-demuxing. Null until demuxed or for
   * assets with no video stream. (Stored as a plain string so domain/ stays
   * free of browser types.)
   */
  decoderConfigB64: string | null
}

/* ------------------------------------------------------------------ */
/* Clip payload types                                                   */
/* ------------------------------------------------------------------ */

/**
 * 2D placement of a clip within the composition, applied around the anchor
 * point in this order: scale, rotate, then translate.
 */
export interface Transform {
  /** Horizontal offset in canvas pixels from the default centered position. */
  x: number
  /** Vertical offset in canvas pixels from the default centered position. */
  y: number
  /** Horizontal scale factor; 1 = 100%. */
  scaleX: number
  /** Vertical scale factor; 1 = 100%. */
  scaleY: number
  /** Rotation in degrees, clockwise-positive. */
  rotation: number
  /** Anchor X, normalized 0..1 across the clip's bounds (0.5 = center). */
  anchorX: number
  /** Anchor Y, normalized 0..1 across the clip's bounds (0.5 = center). */
  anchorY: number
}

/** Allowed value types for a single effect parameter. */
export type EffectParamValue = number | string | boolean

/**
 * An effect instance applied to one clip. `type` selects the implementation
 * in the render pipeline; `params` is that implementation's config.
 */
export interface Effect {
  /** Unique effect-instance id. */
  id: EffectId
  /** Effect implementation key, e.g. 'brightness', 'blur'. */
  type: string
  /** When false, the render pipeline skips this effect without removing it. */
  enabled: boolean
  /** Implementation-defined parameters, keyed by parameter name. */
  params: Record<string, EffectParamValue>
}

/**
 * A transition between two adjacent clips on the same track. MVP supports
 * crossfade only; the union grows as implementations land.
 */
export interface Transition {
  /** Unique transition-instance id. */
  id: TransitionId
  /** Transition implementation key. MVP: crossfade only. */
  type: 'crossfade'
  /** Clip on the outgoing (earlier) side. Must be on the owning track. */
  fromClipId: ClipId
  /** Clip on the incoming (later) side. Must be on the owning track. */
  toClipId: ClipId
  /** Transition length in document-rate frames. Integer >= 1. */
  durationFrames: number
}

/** Styling and content for a text clip (a clip whose `text` field is set). */
export interface TextProps {
  /** The string rendered on screen. */
  content: string
  /** CSS font-family name. */
  fontFamily: string
  /** Font size in canvas pixels (at scale 1). */
  fontSizePx: number
  /** Fill color as a CSS color string, e.g. '#ffffff'. */
  color: string
  /** Horizontal alignment of lines within the text box. */
  align: 'left' | 'center' | 'right'
  /** Bold weight on/off. */
  bold: boolean
  /** Italic style on/off. */
  italic: boolean
}

/* ------------------------------------------------------------------ */
/* Timeline structure                                                   */
/* ------------------------------------------------------------------ */

/** How a media clip maps timeline frames onto its source. */
export type ClipSourceMode = 'timed' | 'still'

/**
 * One piece of media placed on a track. Invariants (enforced by
 * domain/operations.ts, assumed everywhere else):
 * - timelineRange.durationFrames >= 1
 * - timed sourceRange.durationFrames === timelineRange.durationFrames
 * - still sourceRange is always exactly frame 0 with duration 1
 * - never overlaps another clip on the same track (half-open ranges)
 */
export interface Clip {
  /** Unique clip id. */
  id: ClipId
  /** The media asset this clip plays. */
  assetId: AssetId
  /** Display name, defaults to the asset's fileName. */
  name: string
  /**
   * Explicit timeline-to-source mapping. New and portable clips always carry
   * this field. It remains optional in the in-memory type so historical
   * timeline fixtures and pre-migration documents safely retain timed
   * behavior until the project-file migration normalizes them.
   */
  sourceMode?: ClipSourceMode
  /**
   * Timed: the played source range in document-rate frames. Still: the
   * canonical one-frame range `{ startFrame: 0, durationFrames: 1 }`.
   */
  sourceRange: TimeRange
  /** Where the clip sits on the timeline, in document-rate frames. */
  timelineRange: TimeRange
  /** Placement within the composition. */
  transform: Transform
  /** Overall clip opacity, 0..1 (1 = opaque). Applied after effects. */
  opacity: number
  /** Linear audio gain, 0..1 (1 = unity). Ignored for silent assets. */
  volume: number
  /** Effect chain, applied in array order before compositing. */
  effects: Effect[]
  /** Present only on text clips; such clips render text instead of media. */
  text?: TextProps
  /**
   * Clips sharing this id are LINKED: edits follow the link at the store
   * layer (moving/trimming/splitting/deleting one member applies the same
   * edit to the rest). Created either at A/V drop, when one dropped asset
   * yields a video clip + audio clip pair, or by the pure manual-link domain
   * operation. Manually linked clips may have different assets and ranges.
   * Absent means unlinked (the common case).
   * By construction a present linkGroupId implies at least one partner
   * clip exists somewhere in the doc — operations that would orphan a
   * member (leaving it alone in its group) strip or reassign the id
   * instead. Optional so old serialized docs without this field stay
   * valid (schemaVersion is NOT bumped for it).
   */
  linkGroupId?: string
}

/** What a track holds; a track only accepts clips compatible with its kind. */
export type TrackKind = 'video' | 'audio'

/**
 * An ordered lane of non-overlapping clips. Track order in
 * TimelineDoc.tracks defines compositing: index 0 is drawn first (bottom).
 */
export interface Track {
  /** Unique track id. */
  id: TrackId
  /** Whether this lane composites video or mixes audio. */
  kind: TrackKind
  /** Display name, e.g. 'V1', 'A1'. */
  name: string
  /**
   * Clips on this lane, sorted by timelineRange.startFrame, pairwise
   * non-overlapping (operations.ts rejects edits that would violate this).
   */
  clips: Clip[]
  /** Transitions between adjacent clip pairs on this track. */
  transitions: Transition[]
  /** Video: excluded from compositing when true. */
  hidden: boolean
  /** Audio: excluded from the mix when true. */
  muted: boolean
  /**
   * Audio: exclusive listen. While ANY audio track is solo, every non-solo
   * audio track is excluded from the mix; mute still wins on a solo track.
   * The mix-set rule lives in selectors.audibleTracks — consumers (Phase 5
   * export, future playback audio) must go through it, not re-derive it.
   */
  solo: boolean
  /** When true, edit operations targeting this track are rejected. */
  locked: boolean
}

/**
 * The whole editable project document. Pure data: serializable with
 * JSON.stringify/parse with no loss (undo history snapshots rely on this).
 * Overall duration is DERIVED from track contents via domain/selectors.ts,
 * never stored, so it cannot go stale.
 */
export interface TimelineDoc {
  /** Schema version for forward-compatible project files. Currently 1. */
  schemaVersion: number
  /** Unique document id. */
  id: string
  /** Project display name. */
  name: string
  /** Document frame rate; all TimeRanges in the doc are at this rate. */
  frameRate: FrameRate
  /** Composition width in pixels. */
  width: number
  /** Composition height in pixels. */
  height: number
  /** Audio render/mix sample rate in Hz (e.g. 48000). */
  audioSampleRate: number
  /** All tracks, bottom-to-top compositing order (index 0 drawn first). */
  tracks: Track[]
}
