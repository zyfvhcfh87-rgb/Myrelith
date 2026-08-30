/**
 * domain/schema.ts — Data-model contracts for the Myrelith timeline document.
 *
 * Phase 0. Types only — no logic, no browser APIs (see ARCHITECTURE.md:
 * domain/ imports nothing). All positions and durations on the timeline are
 * INTEGER frame counts; seconds exist only at the encoder/decoder/audio-clock
 * boundary, converted via domain/time.ts.
 *
 * Timed assets are treated as conformed to the document frame rate.
 * `sourceTimeMap` is the canonical affine timeline-to-source mapping; its
 * fixed-point origin and rational rate keep constant-speed edits exact without
 * accumulating floating-point drift. `sourceRange` is the integer source-frame
 * envelope touched by that mapping. Still clips use the explicit one-frame
 * source below while their timeline duration is independently editable.
 */

import type { LensCorrectionIntent } from './lensCorrection'

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

/** Exact 25%-step rational constant-speed multiplier (source / timeline). */
export interface SourceTimeRate {
  numerator: number
  denominator: number
}

/** Named fixed-polynomial interpolation for one outgoing speed segment. */
export type SourceTimeSpeedEasing = 'hold' | 'linear' | 'smooth'

/** One speed handle in the durable curve coordinate space. */
export interface SourceTimeSpeedPoint {
  frame: number
  /** Canonical 0x freeze or a 25%-step rate from 1/4x through 4x. */
  rate: SourceTimeRate
  /** Interpolation from this handle to the next handle. */
  easing: SourceTimeSpeedEasing
}

/**
 * Piecewise speed authoring retained independently from clip trims/splits.
 * `originFrame` is the curve-space frame represented by clip-local frame 0.
 */
export interface SourceTimeSpeedCurve {
  originFrame: number
  points: SourceTimeSpeedPoint[]
}

/**
 * Affine source-time origin, preserved source span, and rate. Tick values use
 * the fixed precision declared by domain/sourceTimeMap.ts. The explicit span
 * retains an exact out-point when a rate produces a fractional final timeline
 * frame, so changing speed repeatedly cannot nibble source time away.
 */
export interface SourceTimeMap {
  sourceStartTicks: number
  sourceDurationTicks: number
  rate: SourceTimeRate
  /**
   * Schema-12 piecewise speed curve. Optional typing keeps historical pure
   * fixtures source-compatible; current persisted documents always include it.
   */
  speedCurve?: SourceTimeSpeedCurve
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
/** Unique id of a full-frame post-composite adjustment item. */
export type AdjustmentItemId = string
/** Unique id of an effect instance on a clip. */
export type EffectId = string
/** Unique id of a transition instance on a track. */
export type TransitionId = string
/** Unique id of a sequence-level timeline marker. */
export type TimelineMarkerId = string
/** Unique id of a semantic caption track. */
export type CaptionTrackId = string
/** Unique id of a semantic caption item. */
export type CaptionItemId = string

/* ------------------------------------------------------------------ */
/* Media assets                                                         */
/* ------------------------------------------------------------------ */

/** Track kind exposed to the editor after any explicit partial projection. */
export type AssetKind = 'video' | 'audio' | 'image'

/** A durable, explicitly confirmed choice to omit one source track kind. */
export type PartialTrackImportSelection = 'video-only' | 'audio-only'

/** Proven timestamp extent for one primary timed stream, in integer µs. */
export type SourceTimestampBounds =
  | { status: 'exact'; firstTimestampUs: number; endTimestampUs: number }
  | { status: 'unknown' }

/**
 * Timestamp extents for the effective imported projection. `null` means that
 * stream kind is absent; `unknown` means a legacy project proves presence but
 * did not persist enough metadata to prove exact source handles.
 */
export interface MediaSourceBounds {
  video: SourceTimestampBounds | null
  audio: SourceTimestampBounds | null
}

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
  /** Independent primary-video/audio timestamp extents for handle planning. */
  sourceBounds: MediaSourceBounds
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

/** Non-destructive source-edge crop, normalized against the full source. */
export interface CropInsets {
  /** Fraction removed from the source's left edge, from 0 (none) to < 1. */
  left: number
  /** Fraction removed from the source's right edge, from 0 (none) to < 1. */
  right: number
  /** Fraction removed from the source's top edge, from 0 (none) to < 1. */
  top: number
  /** Fraction removed from the source's bottom edge, from 0 (none) to < 1. */
  bottom: number
}

/** Static visual Inspector settings shared by preview and export. */
export interface ClipVisualSettings {
  /** Source crop; opposing edges must always leave a non-empty rectangle. */
  crop: CropInsets
  /** Mirror the cropped source around the authored anchor. */
  flipHorizontal: boolean
  /** Mirror the cropped source around the authored anchor. */
  flipVertical: boolean
  /** Inspector editing constraint; when enabled, scale X and Y stay equal. */
  scaleLocked: boolean
}

/** Static audio Inspector settings shared by playback and export. */
export interface ClipAudioSettings {
  /** False excludes this clip from the audible contributor plan. */
  enabled: boolean
  /** Stereo balance from -1 (left) through 0 (center) to 1 (right). */
  balance: number
  /** Linear fade-in duration in document-rate integer frames. */
  fadeInFrames: number
  /** Linear fade-out duration in document-rate integer frames. */
  fadeOutFrames: number
}

/** First supported scalar properties for deterministic clip animation. */
export type ClipAnimationProperty =
  | 'position-x'
  | 'position-y'
  | 'scale-x'
  | 'scale-y'
  | 'rotation'
  | 'opacity'

/** Outgoing interpolation from one keyframe to the next. */
export type ClipAnimationEasing =
  | { type: 'hold' }
  | { type: 'linear' }
  | { type: 'cubic-bezier'; x1: number; y1: number; x2: number; y2: number }

/** One exact clip-local integer-frame value. */
export interface ClipAnimationKeyframe {
  frame: number
  /**
   * Absolute source-time intent used to recover authored timing after a
   * constant-speed map quantizes this key onto an integer timeline frame.
   * Legacy in-memory values may omit it; current portable files require it.
   */
  sourceTimeTicks?: number
  value: number
  easing: ClipAnimationEasing
}

export interface ClipAnimationTrack {
  property: ClipAnimationProperty
  /** Strictly increasing, unique clip-local frames. */
  keyframes: ClipAnimationKeyframe[]
}

/** One scalar parameter track addressed to a stable effect-instance id. */
export interface EffectAnimationTrack {
  effectId: EffectId
  parameter: string
  /** Strictly increasing, unique clip-local frames. */
  keyframes: ClipAnimationKeyframe[]
}

export interface ClipAnimation {
  /** At most one track for each supported property. */
  tracks: ClipAnimationTrack[]
  /**
   * Scalar effect tracks retain opaque future/dangling targets so portable
   * authoring intent is never discarded. Current files always include this
   * list; optional typing keeps historical pure fixtures source-compatible.
   */
  effectTracks?: EffectAnimationTrack[]
}

/** Allowed value types for a single effect parameter. */
export type EffectParamValue = number | string | boolean

/**
 * A serializable effect instance applied to one clip. `type` and `version`
 * select one registry contract; unknown descriptors stay opaque and ordered
 * so newer projects can round-trip through an older build without data loss.
 */
export interface EffectDescriptor {
  /** Unique effect-instance id. */
  id: EffectId
  /** Stable effect implementation key, e.g. `builtin.color-adjust`. */
  type: string
  /** Registry schema version. Zero is reserved for migrated legacy effects. */
  version: number
  /** When false, the render pipeline skips this effect without removing it. */
  enabled: boolean
  /** Implementation-defined parameters, keyed by parameter name. */
  params: Record<string, EffectParamValue>
}

/** Backward-compatible name for the durable descriptor contract. */
export type Effect = EffectDescriptor

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
  /** Audio behavior for this authored transition. */
  audio: TransitionAudioSettings
}

export type TransitionAudioCurve = 'linear' | 'equal-power'

export interface TransitionAudioSettings {
  enabled: boolean
  curve: TransitionAudioCurve
}

/** Generic families supported identically by worker preview and export. */
export type TextFontFamily =
  | 'sans-serif'
  | 'serif'
  | 'monospace'
  | 'cursive'
  | 'fantasy'
  | 'system-ui'

/** Styling, content, and bounded canvas geometry for a text clip. */
export interface TextProps {
  /** The string rendered on screen. */
  content: string
  /** Explicit supported generic CSS font family. */
  fontFamily: TextFontFamily
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
  /** Untransformed text-box width in composition pixels. */
  boxWidthPx: number
  /** Untransformed text-box height in composition pixels. */
  boxHeightPx: number
  /** Inner padding shared by background, wrapping, and clipping. */
  paddingPx: number
  /** Paint a solid box behind the text. */
  backgroundEnabled: boolean
  /** Hex background color. */
  backgroundColor: string
  /** Stroke glyph outlines before filling them. */
  outlineEnabled: boolean
  /** Hex outline color. */
  outlineColor: string
  /** Glyph outline width in composition pixels. */
  outlineWidthPx: number
  /** Paint one Canvas2D shadow behind the filled glyphs. */
  shadowEnabled: boolean
  /** Hex shadow color. */
  shadowColor: string
  /** Canvas2D shadow blur in composition pixels. */
  shadowBlurPx: number
  /** Horizontal shadow offset in composition pixels. */
  shadowOffsetXPx: number
  /** Vertical shadow offset in composition pixels. */
  shadowOffsetYPx: number
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
 * - timed sourceRange is the exact integer envelope of sourceTimeMap over the
 *   clip's half-open timeline duration
 * - still sourceRange is always exactly frame 0 with duration 1
 * - never overlaps another clip on the same track (half-open ranges)
 */
export interface Clip {
  /** Unique clip id. */
  id: ClipId
  /**
   * The media asset this clip plays. Procedural text clips use a reserved
   * text id and require no entry in the media catalog.
   */
  assetId: AssetId
  /** Display name, defaults to the asset's fileName. */
  name: string
  /**
   * Explicit timeline-to-source mapping. Historical documents are migrated
   * before they enter the current in-memory schema, so every live clip must
   * carry this field.
   */
  sourceMode: ClipSourceMode
  /**
   * Timed: the played source range in document-rate frames. Still: the
   * canonical one-frame range `{ startFrame: 0, durationFrames: 1 }`.
   */
  sourceRange: TimeRange
  /**
   * Canonical timeline-frame to source-time mapping. Optional typing keeps
   * historical pure fixtures source-compatible; current persisted documents
   * always include it after schema migration.
   */
  sourceTimeMap?: SourceTimeMap
  /** Where the clip sits on the timeline, in document-rate frames. */
  timelineRange: TimeRange
  /** Placement within the composition. */
  transform: Transform
  /** Overall clip opacity, 0..1 (1 = opaque). Applied after effects. */
  opacity: number
  /**
   * Serialized compositing intent. Current names are normal, multiply,
   * screen, and overlay; unknown strings are retained and render as normal.
   * Optional typing keeps pre-schema-9 pure fixtures source compatible.
   */
  blendMode?: string
  /** Linear audio gain, 0..1 (1 = unity). Ignored for silent assets. */
  volume: number
  /**
   * Versioned manual source-geometry intent, evaluated after decoded source
   * orientation and before authored crop. `null` means no remap. Unknown
   * future versions remain bounded opaque data and never render implicitly.
   * Optional typing keeps historical pure fixtures source-compatible; current
   * portable schema-14 files always include the field.
   */
  lensCorrection?: LensCorrectionIntent | null
  /**
   * Static visual Inspector settings. Current persisted documents always
   * include this object; optional typing keeps pure helpers tolerant of
   * historical/in-memory fixtures until they cross the migration boundary.
   */
  visual?: ClipVisualSettings
  /**
   * Static audio Inspector settings. Current persisted documents always
   * include this object; optional typing preserves the same legacy tolerance
   * as `visual` without weakening project-file validation.
   */
  audio?: ClipAudioSettings
  /**
   * Optional in memory so historical test fixtures remain tolerant. Current
   * project files carry the canonical empty object when no property animates.
   */
  animation?: ClipAnimation
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

/** Adjustment keyframes are timeline-local only and deliberately own no source time. */
export interface AdjustmentAnimationKeyframe {
  frame: number
  value: number
  easing: ClipAnimationEasing
}

export interface AdjustmentOpacityAnimationTrack {
  property: 'opacity'
  keyframes: AdjustmentAnimationKeyframe[]
}

export interface AdjustmentEffectAnimationTrack {
  effectId: EffectId
  parameter: string
  keyframes: AdjustmentAnimationKeyframe[]
}

export interface AdjustmentAnimation {
  tracks: AdjustmentOpacityAnimationTrack[]
  effectTracks: AdjustmentEffectAnimationTrack[]
}

/**
 * Serializable edit intent for one full-frame post-composite adjustment.
 * The discriminator is explicit so this can grow into a wider timeline-item
 * union without pretending the item owns media, source time, audio, or spatial
 * source geometry.
 */
export interface AdjustmentItem {
  kind: 'adjustment'
  id: AdjustmentItemId
  name: string
  /** Exact half-open document-rate interval in which the adjustment runs. */
  timelineRange: TimeRange
  /** Item-level bypass. Disabled items remain portable and selectable. */
  enabled: boolean
  /** Mix between the untouched lower composition and the adjusted result. */
  opacity: number
  /** Opacity and supported effect-parameter animation only. */
  animation: AdjustmentAnimation
  /** Durable authored order; unsupported/source-stage effects stay bypassed. */
  effects: EffectDescriptor[]
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
  /**
   * Full-frame post-composite items on this lane. Current schema-15 project
   * files always include the array; optional typing keeps historical pure
   * fixtures source-compatible until they cross migration/validation.
   */
  adjustments?: AdjustmentItem[]
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

/** Deliberately small, portable palette shared by marker files and UI. */
export type TimelineMarkerColor =
  | 'yellow'
  | 'orange'
  | 'red'
  | 'pink'
  | 'purple'
  | 'blue'
  | 'green'

/** A durable sequence-level annotation at one exact integer frame. */
export interface TimelineMarker {
  /** Stable across edit, save/load, duplicate, undo, and redo. */
  id: TimelineMarkerId
  /** Integer document frame. Markers do not extend render/export duration. */
  frame: number
  /** Short accessible name shown on the ruler and in the editor. */
  label: string
  /** Portable semantic color from TimelineMarkerColor. */
  color: TimelineMarkerColor
  /** Optional longer annotation; absent rather than empty when unused. */
  note?: string
}

/** Intended downstream use. The model is ready for additional roles later. */
export type CaptionTrackRole = 'subtitles' | 'captions'

/** Portable rendering treatments shared by preview and export. */
export type CaptionStylePreset = 'classic' | 'boxed' | 'minimal'

/** One semantic caption cue on the document's integer-frame timebase. */
export interface CaptionItem {
  /** Stable across edit, split/merge history, save/load, undo, and redo. */
  id: CaptionItemId
  /** Half-open authored interval [start, end), with at least one frame. */
  range: TimeRange
  /** Plain text. Newlines are preserved; markup and empty text are rejected. */
  text: string
}

/** A language/role-ready caption lane, independent from media/text clips. */
export interface CaptionTrack {
  /** Stable track identity. */
  id: CaptionTrackId
  /** Accessible editor label. */
  name: string
  /** BCP-47-compatible language tag, or `und` when unspecified. */
  language: string
  /** Semantic downstream role. */
  role: CaptionTrackRole
  /** Portable visual treatment used by every composition surface. */
  stylePreset: CaptionStylePreset
  /** Hidden tracks are retained but excluded from preview/export. */
  hidden: boolean
  /** Cues sorted by (startFrame, endFrame, id); bounded overlap is allowed. */
  items: CaptionItem[]
}

/**
 * The whole editable project document. Pure data: serializable with
 * JSON.stringify/parse with no loss (undo history snapshots rely on this).
 * Overall duration is DERIVED from track contents via domain/selectors.ts,
 * never stored, so it cannot go stale.
 */
export interface TimelineDoc {
  /** Schema version for forward-compatible project files. Currently 8. */
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
  /**
   * Sequence-level markers sorted by (frame, id). Optional only so historical
   * in-memory fixtures remain source-compatible; current project files always
   * validate and serialize an explicit array.
   */
  markers?: TimelineMarker[]
  /**
   * Semantic caption lanes. Optional only for historical in-memory fixtures;
   * current project files validate and serialize an explicit array.
   */
  captionTracks?: CaptionTrack[]
}
