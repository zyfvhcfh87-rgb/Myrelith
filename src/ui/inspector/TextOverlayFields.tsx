import { useState } from 'react'
import type { TextPropsPatch } from '../../domain/operations'
import type { Clip, TextFontFamily } from '../../domain/schema'
import {
  TEXT_FONT_FAMILIES,
  TEXT_OVERLAY_LIMITS,
  textPropsValidationError,
} from '../../domain/textOverlay'
import { useDocumentStore } from '../../state/documentStore'
import { useTransportStore } from '../../state/transportStore'
import { NumberField, TextAreaField } from './InspectorFields'

export default function TextOverlayFields({ clip, locked }: { clip: Clip; locked: boolean }) {
  const text = clip.text
  const [message, setMessage] = useState<string | null>(null)
  if (!text) return null

  const commit = (patch: TextPropsPatch): void => {
    if (locked) {
      setMessage('Unlock this video track before editing its text.')
      return
    }
    const error = textPropsValidationError({ ...text, ...patch })
    if (error) {
      setMessage(error)
      return
    }
    useDocumentStore.getState().updateTextClip(clip.id, patch)
    setMessage(null)
  }
  const toggle = (key: 'bold' | 'italic' | 'backgroundEnabled' | 'outlineEnabled' | 'shadowEnabled') => (
    <label className="inspector-toggle">
      <input
        type="checkbox"
        checked={text[key]}
        disabled={locked}
        onChange={(event) => commit({ [key]: event.target.checked })}
      />
      <span>{key === 'backgroundEnabled' ? 'Background' : key === 'outlineEnabled' ? 'Outline' : key === 'shadowEnabled' ? 'Shadow' : key[0].toUpperCase() + key.slice(1)}</span>
    </label>
  )
  const color = (
    label: string,
    key: 'color' | 'backgroundColor' | 'outlineColor' | 'shadowColor',
  ) => (
    <label className="inspector-field inspector-color-field">
      <span className="inspector-field-label">{label}</span>
      <input
        type="color"
        value={text[key].slice(0, 7)}
        disabled={locked}
        onChange={(event) => commit({ [key]: event.target.value })}
      />
    </label>
  )

  return (
    <section className="inspector-text" aria-labelledby="inspector-text-heading">
      <div className="inspector-section-heading" id="inspector-text-heading">Text</div>
      <div className="inspector-grid">
        <TextAreaField value={text.content} disabled={locked} onCommit={(content) => commit({ content })} />
        <label className="inspector-field">
          <span className="inspector-field-label">Font family</span>
          <select
            data-testid="inspector-text-font"
            value={text.fontFamily}
            disabled={locked}
            onChange={(event) => commit({ fontFamily: event.target.value as TextFontFamily })}
          >
            {TEXT_FONT_FAMILIES.map((family) => <option key={family} value={family}>{family}</option>)}
          </select>
        </label>
        <NumberField label="Font size" value={text.fontSizePx} step={1} min={TEXT_OVERLAY_LIMITS.minFontSizePx} max={TEXT_OVERLAY_LIMITS.maxFontSizePx} testId="inspector-text-size" disabled={locked} onCommit={(fontSizePx) => commit({ fontSizePx })} />
        <label className="inspector-field">
          <span className="inspector-field-label">Alignment</span>
          <select value={text.align} disabled={locked} onChange={(event) => commit({ align: event.target.value as 'left' | 'center' | 'right' })}>
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </label>
        {color('Text color', 'color')}
        <div className="inspector-toggle-row inspector-field-wide">{toggle('bold')}{toggle('italic')}</div>
        <NumberField label="Box width" value={text.boxWidthPx} step={1} min={TEXT_OVERLAY_LIMITS.minBoxSizePx} max={TEXT_OVERLAY_LIMITS.maxBoxSizePx} testId="inspector-text-width" disabled={locked} onCommit={(boxWidthPx) => commit({ boxWidthPx })} />
        <NumberField label="Box height" value={text.boxHeightPx} step={1} min={TEXT_OVERLAY_LIMITS.minBoxSizePx} max={TEXT_OVERLAY_LIMITS.maxBoxSizePx} testId="inspector-text-height" disabled={locked} onCommit={(boxHeightPx) => commit({ boxHeightPx })} />
        <NumberField label="Padding" value={text.paddingPx} step={1} min={0} max={TEXT_OVERLAY_LIMITS.maxPaddingPx} testId="inspector-text-padding" disabled={locked} onCommit={(paddingPx) => commit({ paddingPx })} />
        <div className="inspector-toggle-row">{toggle('backgroundEnabled')}</div>
        {color('Background', 'backgroundColor')}
        <div className="inspector-toggle-row">{toggle('outlineEnabled')}</div>
        {color('Outline color', 'outlineColor')}
        <NumberField label="Outline width" value={text.outlineWidthPx} step={1} min={0} max={TEXT_OVERLAY_LIMITS.maxOutlineWidthPx} testId="inspector-text-outline" disabled={locked} onCommit={(outlineWidthPx) => commit({ outlineWidthPx })} />
        <div className="inspector-toggle-row">{toggle('shadowEnabled')}</div>
        {color('Shadow color', 'shadowColor')}
        <NumberField label="Shadow blur" value={text.shadowBlurPx} step={1} min={0} max={TEXT_OVERLAY_LIMITS.maxShadowBlurPx} testId="inspector-text-shadow-blur" disabled={locked} onCommit={(shadowBlurPx) => commit({ shadowBlurPx })} />
        <NumberField label="Shadow X" value={text.shadowOffsetXPx} step={1} min={-TEXT_OVERLAY_LIMITS.maxShadowOffsetPx} max={TEXT_OVERLAY_LIMITS.maxShadowOffsetPx} testId="inspector-text-shadow-x" disabled={locked} onCommit={(shadowOffsetXPx) => commit({ shadowOffsetXPx })} />
        <NumberField label="Shadow Y" value={text.shadowOffsetYPx} step={1} min={-TEXT_OVERLAY_LIMITS.maxShadowOffsetPx} max={TEXT_OVERLAY_LIMITS.maxShadowOffsetPx} testId="inspector-text-shadow-y" disabled={locked} onCommit={(shadowOffsetYPx) => commit({ shadowOffsetYPx })} />
      </div>
      <div className="inspector-text-status" role={message ? 'alert' : 'status'} aria-live="polite">
        {message ?? (locked ? 'Unlock this video track to edit the overlay.' : 'Ctrl/Cmd+Enter commits multiline text.')}
      </div>
      <button
        type="button"
        className="inspector-delete-text"
        disabled={locked}
        onClick={() => {
          useDocumentStore.getState().rippleDelete(clip.id)
          useTransportStore.getState().setSelectedClip(null)
        }}
      >
        Delete text overlay
      </button>
    </section>
  )
}
