import { useState } from 'react'
import type { CaptionReviewController } from '../app/captionReviewController'
import type { CaptionBatchScope, CaptionBatchOperation } from '../domain/captionBatch'

const number = (text: string) => text.trim() ? Number(text) : NaN
export default function CaptionBatchTools({ trackId, total, selectedIds, activeId, controller, onReview }: {
  trackId: string; total: number; selectedIds: readonly string[]; activeId: string | null;
  controller: CaptionReviewController; onReview(action: () => boolean): void;
}) {
  const [scopeKind, setScopeKind] = useState<CaptionBatchScope['kind']>('selected')
  const [operation, setOperation] = useState<CaptionBatchOperation['kind']>('shift')
  const [shift, setShift] = useState('1'), [anchor, setAnchor] = useState('0')
  const [numerator, setNumerator] = useState('1'), [denominator, setDenominator] = useState('1')
  const [find, setFind] = useState(''), [replacement, setReplacement] = useState('')
  const [caseValue, setCaseValue] = useState<'upper' | 'lower'>('upper')
  const scope: CaptionBatchScope = scopeKind === 'all' ? { kind: 'all' }
    : scopeKind === 'following' ? { kind: 'following', fromId: activeId ?? '' } : { kind: 'selected', ids: selectedIds }
  const disabled = scopeKind === 'all' ? !total : scopeKind === 'following' ? !activeId : !selectedIds.length
  function prepare(): boolean {
    if (operation === 'split') return controller.prepareMidpointSplits(trackId, scope)
    const edit: CaptionBatchOperation = operation === 'shift' ? { kind: 'shift', deltaFrames: number(shift) }
      : operation === 'stretch' ? { kind: 'stretch', anchorFrame: number(anchor), numerator: number(numerator), denominator: number(denominator) }
        : operation === 'replace' ? { kind: 'replace', find, replacement }
          : operation === 'case' ? { kind: 'case', value: caseValue } : { kind: 'merge' }
    return controller.prepareBatch(trackId, scope, edit)
  }
  return <fieldset className="caption-batch-tools">
    <legend>Batch captions</legend>
    <label>Scope<select value={scopeKind} onChange={event => setScopeKind(event.target.value as CaptionBatchScope['kind'])}>
      <option value="selected">Selected cues ({selectedIds.length})</option><option value="following">Active cue and following</option><option value="all">All cues ({total})</option>
    </select></label>
    <label>Operation<select value={operation} onChange={event => setOperation(event.target.value as CaptionBatchOperation['kind'])}>
      <option value="shift">Shift timing</option><option value="stretch">Stretch timing</option><option value="split">Split at midpoint</option>
      <option value="merge">Merge touching cues</option><option value="replace">Find and replace</option><option value="case">Change case</option>
    </select></label>
    {operation === 'shift' && <label>Shift frames<input type="number" step="1" value={shift} onChange={event => setShift(event.target.value)} /></label>}
    {operation === 'stretch' && <>
      <label>Anchor frame<input type="number" min="0" step="1" value={anchor} onChange={event => setAnchor(event.target.value)} /></label>
      <label>Stretch numerator<input type="number" min="1" max="1000" step="1" value={numerator} onChange={event => setNumerator(event.target.value)} /></label>
      <label>Stretch denominator<input type="number" min="1" max="1000" step="1" value={denominator} onChange={event => setDenominator(event.target.value)} /></label>
      <p>Both boundaries stretch around the anchor. The ratio must be between 0.1 and 10.</p>
    </>}
    {operation === 'split' && <p>Split each cue at its middle frame and the nearest word boundary. Review both resulting texts and times.</p>}
    {operation === 'merge' && <p>Only adjacent cues with touching times and compatible styles and origin can merge.</p>}
    {operation === 'replace' && <>
      <label>Find text<input spellCheck={false} value={find} maxLength={4000} onChange={event => setFind(event.target.value)} /></label>
      <label>Replacement text<input spellCheck={false} value={replacement} maxLength={4000} onChange={event => setReplacement(event.target.value)} /></label>
      <p>Literal, case-sensitive text matching.</p>
    </>}
    {operation === 'case' && <label>Letter case<select value={caseValue} onChange={event => setCaseValue(event.target.value as 'upper' | 'lower')}>
      <option value="upper">UPPERCASE</option><option value="lower">lowercase</option>
    </select></label>}
    <button type="button" disabled={disabled} onClick={() => onReview(prepare)}>Review {operation}</button>
  </fieldset>
}
