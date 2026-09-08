import { useState } from 'react'
import type { CaptionReviewController } from '../app/captionReviewController'
import { CAPTION_STYLE_LABELS, captionStyleSummary } from '../app/captionStylePresentation'
import type { CaptionStyleV1 } from '../domain/captionStyle'
import type { CaptionTrack } from '../domain/schema'
import { TEXT_FONT_FAMILIES } from '../domain/textOverlay'

const choices: Partial<Record<keyof CaptionStyleV1, readonly string[]>> = {
  fontFamily: TEXT_FONT_FAMILIES, align: ['left', 'center', 'right'], position: ['top', 'middle', 'bottom'],
}
const numbers: Partial<Record<keyof CaptionStyleV1, { min: number; max: number; value: string }>> = {
  fontSizePermille: { min: 0.8, max: 15, value: '4.8' }, outlinePermille: { min: 0, max: 1, value: '0.2' },
  marginXPermille: { min: 0, max: 25, value: '6' }, marginYPermille: { min: 0, max: 25, value: '6' },
}
const booleans = new Set<keyof CaptionStyleV1>(['bold', 'italic', 'backgroundEnabled', 'shadowEnabled', 'outlineEnabled'])
export default function CaptionStyleTools({ track, selectedIds, controller, onReview }: {
  track: CaptionTrack; selectedIds: readonly string[]; controller: CaptionReviewController;
  onReview(action: () => boolean): void;
}) {
  const [target, setTarget] = useState<'track' | 'selected'>('selected')
  const [field, setField] = useState<keyof CaptionStyleV1>('italic')
  const [inherit, setInherit] = useState(false)
  const [value, setValue] = useState('true')
  const ids = target === 'track' ? null : selectedIds
  const numeric = numbers[field], options = choices[field], boolean = booleans.has(field)
  const disabled = target === 'selected' && !selectedIds.length
  return <fieldset className="caption-style-tools">
    <legend>Style overrides</legend>
    <p>{captionStyleSummary(track.style, `the ${track.stylePreset} preset`)}</p>
    <label>Style target<select value={target} onChange={event => setTarget(event.target.value as typeof target)}>
      <option value="selected">Selected cues ({selectedIds.length})</option><option value="track">Track defaults</option>
    </select></label>
    <label>Style field<select value={field} onChange={event => {
      const next = event.target.value as keyof CaptionStyleV1
      setField(next); setValue(numbers[next]?.value ?? choices[next]?.[0] ?? (booleans.has(next) ? 'true' : '#ffffffff'))
    }}>
      {(Object.keys(CAPTION_STYLE_LABELS) as (keyof CaptionStyleV1)[]).map(key => <option key={key} value={key}>{CAPTION_STYLE_LABELS[key]}</option>)}
    </select></label>
    <label className="caption-checkbox"><input type="checkbox" checked={inherit} onChange={event => setInherit(event.target.checked)} />Inherit this field</label>
    <label>{numeric ? `New value (% of canvas ${field === 'marginXPermille' ? 'width' : 'height'})` : 'New style value'}
      {options ? <select value={value} disabled={inherit} onChange={event => setValue(event.target.value)}>{options.map(option => <option key={option}>{option}</option>)}</select>
        : boolean ? <select value={value} disabled={inherit} onChange={event => setValue(event.target.value)}><option value="true">On</option><option value="false">Off</option></select>
          : <input value={value} disabled={inherit} type={numeric ? 'number' : 'text'} min={numeric?.min} max={numeric?.max}
            step={numeric ? 'any' : undefined} maxLength={numeric ? undefined : 9} placeholder={numeric ? undefined : '#rrggbbaa'}
            onChange={event => setValue(event.target.value)} />}
    </label>
    {!numeric && !options && !boolean && <p>Use #rrggbbaa: the last two digits control opacity, from 00 to ff.</p>}
    <button type="button" disabled={disabled} onClick={() => onReview(() => controller.prepareStyleField(track.id, ids, field,
      inherit ? null : numeric ? (value.trim() ? Number(value) * 10 : NaN) : boolean ? value === 'true' : value))}>Review style change</button>
    <div className="caption-row-actions">
      <button type="button" disabled={disabled} onClick={() => onReview(() => controller.prepareStyle(track.id, ids, null))}>Review removal of overrides</button>
      <button type="button" disabled={disabled} onClick={() => onReview(() => controller.prepareStyle(track.id, ids, { version: 1, params: {} }))}>Review empty supported overrides</button>
    </div>
    <p>Cue values override track defaults. Removing an override restores inheritance. Unavailable settings need explicit replacement or removal and loss review.</p>
  </fieldset>
}
