import VideoBusInspector from './VideoBusInspector'
/**
 * Contextual Inspector composition root. Focused panels live under ui/inspector.
 * Layering remains ui/ -> state/ + domain selectors only.
 */
import { lazy, useEffect, useState, type KeyboardEvent } from 'react'
import { FileAudio, FileVideo } from '@phosphor-icons/react'
import {
  ANIMATABLE_AUDIO_PROPERTIES,
  ANIMATABLE_VISUAL_PROPERTIES,
  resolveClipAnimationAtFrame,
  findAdjustment,
  findClip,
  linkedPartners,
  trackOfClip,
} from '../state/editorUi'
import type { Clip } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import LazySurfaceBoundary from './LazySurfaceBoundary'
import AudioInspectorSection from './inspector/AudioInspectorSection'
import AudioEffectStackInspector from './AudioEffectStackInspector'
import LoudnessInspectorSection from './inspector/LoudnessInspectorSection'
import LinkSelectionControls from './inspector/LinkSelectionControls'
import TextOverlayFields from './inspector/TextOverlayFields'
import TimingInspectorSection from './inspector/TimingInspectorSection'
import VideoInspectorSections from './inspector/VideoInspectorSections'
import AdjustmentInspector from './AdjustmentInspector'
import ClipAttributeControls from './ClipAttributeControls'

const AnimationCurveEditor = lazy(() => import('./AnimationCurveEditor'))
const DynamicZoomEditor = lazy(() => import('./DynamicZoomEditor'))
const StabilizationEditor = lazy(() => import('./StabilizationEditor'))
const MotionTrackingEditor = lazy(() => import('./MotionTrackingEditor'))

export default function Inspector() {
  return <><VideoBusInspector /><ClipInspector /></>
}

function ClipInspector() {
  const selectedClipId = useTransportStore((s) => s.selectedClipId)
  const selectedAdjustmentId = useTransportStore((s) => s.selectedAdjustmentId)
  const visualPreview = useTransportStore((s) => s.clipVisualPreview)
  const playheadFrame = useTransportStore((s) => s.playheadFrame)
  const timelineDoc = useDocumentStore((s) => s.doc)
  const clip = selectedClipId ? findClip(timelineDoc, selectedClipId) : null
  const adjustment = selectedAdjustmentId
    ? findAdjustment(timelineDoc, selectedAdjustmentId)
    : null
  const [activeVideoTab, setActiveVideoTab] = useState<
    'transform' | 'crop' | 'effects' | 'animation'
  >('transform')
  const [animationSurfaceOpened, setAnimationSurfaceOpened] = useState(false)
  const videoTabs = ['transform', 'crop', 'effects', 'animation'] as const

  useEffect(() => {
    if (activeVideoTab === 'animation') setAnimationSurfaceOpened(true)
  }, [activeVideoTab])

  const handleVideoTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const currentIndex = videoTabs.indexOf(activeVideoTab)
    let nextIndex = currentIndex
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % videoTabs.length
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + videoTabs.length) % videoTabs.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = videoTabs.length - 1
    else return

    event.preventDefault()
    const nextTab = videoTabs[nextIndex]
    setActiveVideoTab(nextTab)
    const buttons = event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    buttons?.[nextIndex]?.focus()
  }

  if (adjustment) {
    return (
      <AdjustmentInspector
        adjustment={adjustment}
        doc={timelineDoc}
        playheadFrame={playheadFrame}
      />
    )
  }

  if (!clip) {
    return (
      <div className="panel-placeholder inspector-empty-state">
        <span className="placeholder-title inspector-empty-title">Inspector</span>
        <LinkSelectionControls key="linking-controls" />
        <span className="placeholder-note">
          <span>select a clip to edit it</span>
          <small> or choose an adjustment layer</small>
        </span>
        <AudioEffectStackInspector
          doc={timelineDoc}
          target={{ kind: 'master' }}
          locked={false}
          heading="Master audio effects"
        />
        <LoudnessInspectorSection />
      </div>
    )
  }

  let videoClip: Clip | null = null
  let audioClip: Clip | null = null
  for (const member of [clip, ...linkedPartners(timelineDoc, clip.id)]) {
    const kind = trackOfClip(timelineDoc, member.id)?.kind
    if (kind === 'video' && videoClip === null) videoClip = member
    if (kind === 'audio' && audioClip === null) audioClip = member
  }
  const videoLocked = videoClip === null
    ? false
    : (trackOfClip(timelineDoc, videoClip.id)?.locked ?? true)
  const audioLocked = audioClip === null
    ? false
    : (trackOfClip(timelineDoc, audioClip.id)?.locked ?? true)
  const audioEffectClip = audioClip ?? videoClip
  const audioEffectTrack = audioEffectClip
    ? trackOfClip(timelineDoc, audioEffectClip.id) ?? null
    : null
  const audioEffectLocked = audioEffectClip === audioClip ? audioLocked : videoLocked
  const resolvedVideoClip = videoClip
    ? resolveClipAnimationAtFrame(videoClip, playheadFrame)
    : null
  const displayedVideoClip = resolvedVideoClip && visualPreview?.clipId === resolvedVideoClip.id
    ? {
        ...resolvedVideoClip,
        transform: visualPreview.transform,
        visual: visualPreview.visual,
      }
    : resolvedVideoClip

  return (
    <div className="inspector-panel" data-testid="inspector-panel">
      <div className="inspector-title">Inspector</div>
      <div className="inspector-clip-summary">
        <span className="inspector-clip-icon" aria-hidden="true">
          {videoClip
            ? <FileVideo size={24} weight="regular" />
            : <FileAudio size={24} weight="regular" />}
        </span>
        <span>
          <strong>{clip.name}</strong>
          <small>{videoClip ? 'Video clip' : 'Audio clip'}</small>
        </span>
      </div>
      {videoClip && (
        <div className="inspector-tabs" role="tablist" aria-label="Video inspector sections">
          {videoTabs.map((tab) => (
            <button
              key={tab}
              id={`inspector-${tab}-tab`}
              type="button"
              role="tab"
              aria-selected={activeVideoTab === tab}
              aria-controls={`inspector-${tab}-panel`}
              tabIndex={activeVideoTab === tab ? 0 : -1}
              className={activeVideoTab === tab ? 'active' : ''}
              onClick={() => setActiveVideoTab(tab)}
              onKeyDown={handleVideoTabKeyDown}
            >
              {tab[0].toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      )}
      <LinkSelectionControls key="linking-controls" />
      <TimingInspectorSection clip={clip} doc={timelineDoc} />
      <ClipAttributeControls clipId={clip.id} />
      {videoClip?.text && (
        <TextOverlayFields
          key={`text:${videoClip.id}`}
          clip={videoClip}
          locked={videoLocked}
        />
      )}
      {displayedVideoClip && (
        <VideoInspectorSections
          doc={timelineDoc}
          clip={displayedVideoClip}
          locked={videoLocked}
          playheadFrame={playheadFrame}
          activeTab={activeVideoTab}
        />
      )}
      {videoClip && (
        <div
          id="inspector-animation-panel"
          role="tabpanel"
          aria-labelledby="inspector-animation-tab"
          hidden={activeVideoTab !== 'animation'}
        >
          {videoClip.text
            ? <span className="inspector-note">Animation controls are not available for text overlays yet.</span>
            : animationSurfaceOpened && (
                <LazySurfaceBoundary
                  loadingLabel="Loading animation curves…"
                  failureTitle="Animation curves could not load"
                >
                  <DynamicZoomEditor
                    clip={videoClip}
                    locked={videoLocked}
                  />
                  <StabilizationEditor
                    clip={videoClip}
                    locked={videoLocked}
                    playheadFrame={playheadFrame}
                  />
                  <MotionTrackingEditor
                    clip={videoClip}
                    locked={videoLocked}
                    playheadFrame={playheadFrame}
                  />
                  <AnimationCurveEditor
                    clip={videoClip}
                    locked={videoLocked}
                    playheadFrame={playheadFrame}
                    properties={audioClip
                      ? ANIMATABLE_VISUAL_PROPERTIES
                      : [...ANIMATABLE_VISUAL_PROPERTIES, ...ANIMATABLE_AUDIO_PROPERTIES]}
                  />
                </LazySurfaceBoundary>
              )}
        </div>
      )}
      {audioClip && (
        <AudioInspectorSection clip={audioClip} locked={audioLocked} />
      )}
      {audioClip && (
        <LazySurfaceBoundary
          loadingLabel="Loading animation curves…"
          failureTitle="Animation curves could not load"
        >
          <AnimationCurveEditor
            clip={audioClip}
            locked={audioLocked}
            playheadFrame={playheadFrame}
            properties={ANIMATABLE_AUDIO_PROPERTIES}
          />
        </LazySurfaceBoundary>
      )}
      {audioEffectClip && (
        <AudioEffectStackInspector
          doc={timelineDoc}
          target={{ kind: 'clip', clipId: audioEffectClip.id }}
          locked={audioEffectLocked}
          heading="Clip audio effects"
        />
      )}
      {audioEffectTrack && (
        <AudioEffectStackInspector
          doc={timelineDoc}
          target={{ kind: 'track', trackId: audioEffectTrack.id }}
          locked={audioEffectTrack.locked}
          heading={`${audioEffectTrack.name} audio effects`}
        />
      )}
      <AudioEffectStackInspector
        doc={timelineDoc}
        target={{ kind: 'master' }}
        locked={false}
        heading="Master audio effects"
      />
      <LoudnessInspectorSection />
    </div>
  )
}
