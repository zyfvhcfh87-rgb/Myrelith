import { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_MANUAL_LENS_CORRECTION,
  isManualLensCorrectionModel,
  lensCorrectionCoverage,
  lensCorrectionValidationError,
  MANUAL_LENS_CORRECTION_LIMITS,
  type ManualLensCorrectionModel,
} from '../../domain/lensCorrection'
import type { Clip } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import { usePreviewStatusStore } from '../../state/previewStatusStore'
import { InspectorSection, NumberField, ToggleField } from './InspectorFields'

export default function ManualLensCorrectionSection({
  clip,
  locked,
}: {
  clip: Clip
  locked: boolean
}) {
  const renderer = usePreviewStatusStore((state) => state.rendererCapabilities)
  const intent = clip.lensCorrection ?? null
  const intentSignature = `${clip.id}:${JSON.stringify(intent)}`
  const [message, setMessage] = useState<{
    readonly signature: string
    readonly text: string
  } | null>(null)
  const [draftRevision, setDraftRevision] = useState(0)
  const visibleMessage = message?.signature === intentSignature
    ? message.text
    : null
  const supported = intent === null || isManualLensCorrectionModel(intent)
  const enabled = intent !== null && supported
  const model: Readonly<ManualLensCorrectionModel> = enabled
    ? intent
    : DEFAULT_MANUAL_LENS_CORRECTION
  const coverage = useMemo(
    () => supported ? lensCorrectionCoverage(model) : null,
    [model, supported],
  )
  const controlsDisabled = locked || !enabled || !supported

  useEffect(() => {
    setMessage((current) => (
      current !== null && current.signature !== intentSignature
        ? null
        : current
    ))
  }, [intentSignature])

  const replace = (next: Readonly<ManualLensCorrectionModel> | null): void => {
    const before = useDocumentStore.getState().doc
    useDocumentStore.getState().setManualLensCorrection(clip.id, next)
    const after = useDocumentStore.getState().doc
    if (after === before) {
      setMessage({
        signature: intentSignature,
        text: 'Lens correction was not changed. Unlock the video track or use values inside the safe mapping envelope.',
      })
      setDraftRevision((value) => value + 1)
      return
    }
    setMessage({
      signature: `${clip.id}:${JSON.stringify(next)}`,
      text: next === null
        ? 'Manual lens correction reset.'
        : 'Manual lens correction updated.',
    })
  }

  const patchModel = (patch: Partial<ManualLensCorrectionModel>): void => {
    const next = { ...model, ...patch }
    const error = lensCorrectionValidationError(next)
    if (error) {
      setMessage({
        signature: intentSignature,
        text: `${error}. The previous correction was kept.`,
      })
      setDraftRevision((value) => value + 1)
      return
    }
    replace(next)
  }

  const capability = renderer?.lensRemap
  const capabilityDetail = !enabled
    ? 'Enable the manual model to probe the Program Monitor WebGL2 path.'
    : capability === undefined
      ? 'Program Monitor lens-remap capability is being detected.'
      : capability.status === 'available'
        ? `${capability.backendVersion} is available (maximum texture ${capability.maximumTextureSize}px).`
        : `Program Monitor unavailable: ${capability.reason}`

  return (
    <InspectorSection
      title="Manual lens correction"
      resetLabel="Reset manual lens correction"
      disabled={locked || intent === null || !supported}
      onReset={() => replace(null)}
    >
      {!supported ? (
        <span className="inspector-note" data-testid="inspector-lens-unsupported">
          Lens-correction version {intent?.version} is preserved but unsupported by this build. Preview and export refuse it instead of substituting a different model, and the stored intent has not been changed.
        </span>
      ) : (
        <>
          <ToggleField
            label="Enable manual correction"
            checked={enabled}
            disabled={locked}
            testId="inspector-lens-enabled"
            onChange={(checked) => replace(
              checked ? { ...DEFAULT_MANUAL_LENS_CORRECTION } : null,
            )}
          />
          <div
            className="inspector-grid inspector-lens-grid"
            key={`${clip.id}:${draftRevision}:${enabled ? 'on' : 'off'}`}
          >
            <NumberField label="Principal point X" value={model.centerX} step={0.01} min={MANUAL_LENS_CORRECTION_LIMITS.centerMinimum} max={MANUAL_LENS_CORRECTION_LIMITS.centerMaximum} testId="inspector-lens-center-x" disabled={controlsDisabled} clamp onCommit={(centerX) => patchModel({ centerX })} />
            <NumberField label="Principal point Y" value={model.centerY} step={0.01} min={MANUAL_LENS_CORRECTION_LIMITS.centerMinimum} max={MANUAL_LENS_CORRECTION_LIMITS.centerMaximum} testId="inspector-lens-center-y" disabled={controlsDisabled} clamp onCommit={(centerY) => patchModel({ centerY })} />
            <NumberField label="Focal X" value={model.focalX} step={0.01} min={MANUAL_LENS_CORRECTION_LIMITS.focalMinimum} max={MANUAL_LENS_CORRECTION_LIMITS.focalMaximum} testId="inspector-lens-focal-x" disabled={controlsDisabled} clamp onCommit={(focalX) => patchModel({ focalX })} />
            <NumberField label="Focal Y" value={model.focalY} step={0.01} min={MANUAL_LENS_CORRECTION_LIMITS.focalMinimum} max={MANUAL_LENS_CORRECTION_LIMITS.focalMaximum} testId="inspector-lens-focal-y" disabled={controlsDisabled} clamp onCommit={(focalY) => patchModel({ focalY })} />
            <NumberField label="Radial k1" value={model.k1} step={0.01} min={MANUAL_LENS_CORRECTION_LIMITS.radialMinimum} max={MANUAL_LENS_CORRECTION_LIMITS.radialMaximum} testId="inspector-lens-k1" disabled={controlsDisabled} clamp onCommit={(k1) => patchModel({ k1 })} />
            <NumberField label="Radial k2" value={model.k2} step={0.01} min={MANUAL_LENS_CORRECTION_LIMITS.radialMinimum} max={MANUAL_LENS_CORRECTION_LIMITS.radialMaximum} testId="inspector-lens-k2" disabled={controlsDisabled} clamp onCommit={(k2) => patchModel({ k2 })} />
            <NumberField label="Radial k3" value={model.k3} step={0.01} min={MANUAL_LENS_CORRECTION_LIMITS.radialMinimum} max={MANUAL_LENS_CORRECTION_LIMITS.radialMaximum} testId="inspector-lens-k3" disabled={controlsDisabled} clamp onCommit={(k3) => patchModel({ k3 })} />
            <NumberField label="Tangential p1" value={model.p1} step={0.001} min={MANUAL_LENS_CORRECTION_LIMITS.tangentialMinimum} max={MANUAL_LENS_CORRECTION_LIMITS.tangentialMaximum} testId="inspector-lens-p1" disabled={controlsDisabled} clamp onCommit={(p1) => patchModel({ p1 })} />
            <NumberField label="Tangential p2" value={model.p2} step={0.001} min={MANUAL_LENS_CORRECTION_LIMITS.tangentialMinimum} max={MANUAL_LENS_CORRECTION_LIMITS.tangentialMaximum} testId="inspector-lens-p2" disabled={controlsDisabled} clamp onCommit={(p2) => patchModel({ p2 })} />
            <NumberField label="Strength" value={model.strength} step={0.01} min={MANUAL_LENS_CORRECTION_LIMITS.strengthMinimum} max={MANUAL_LENS_CORRECTION_LIMITS.strengthMaximum} testId="inspector-lens-strength" disabled={controlsDisabled} clamp onCommit={(strength) => patchModel({ strength })} />
            <NumberField label="Output scale" value={model.outputScale} step={0.01} min={MANUAL_LENS_CORRECTION_LIMITS.outputScaleMinimum} max={MANUAL_LENS_CORRECTION_LIMITS.outputScaleMaximum} testId="inspector-lens-output-scale" disabled={controlsDisabled} clamp onCommit={(outputScale) => patchModel({ outputScale })} />
          </div>
          <span className="inspector-note" data-testid="inspector-lens-coverage">
            {coverage?.covered
              ? `Corrected edges are fully covered at ${model.outputScale.toFixed(2)}× output scale.`
              : `Transparent corrected edges extend up to ${((coverage?.maximumOverscan ?? 0) * 100).toFixed(2)}% beyond the source. Increase output scale explicitly to hide them.`}
          </span>
          <span className="inspector-note" data-testid="inspector-lens-capability">
            {capabilityDetail}
          </span>
          <span
            className="inspector-text-status"
            role={visibleMessage ? 'status' : undefined}
            aria-live="polite"
            aria-atomic="true"
          >
            {visibleMessage ?? (locked ? 'Unlock this video track to edit lens correction.' : '')}
          </span>
        </>
      )}
    </InspectorSection>
  )
}
