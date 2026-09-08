import { useState } from 'react'
import { addGradingEffect, type ColorGradingTarget } from '../app/colorGradingController'
import { COLOR_CURVES_TYPE, COLOR_WHEELS_TYPE } from '../state/editorUi'
import ColorLutPicker from './ColorLutPicker'

export default function ColorGradingAdd({ target, disabled }: { target: ColorGradingTarget; disabled: boolean }) {
  const [error, setError] = useState<string | null>(null)
  return <div className="grading-add">
    <div className="inspector-effect-actions">
      <ColorLutPicker target={target} disabled={disabled} />
      <button type="button" disabled={disabled} onClick={() => setError(addGradingEffect(target, COLOR_CURVES_TYPE))}>Add RGB curves</button>
      <button type="button" disabled={disabled} onClick={() => setError(addGradingEffect(target, COLOR_WHEELS_TYPE))}>Add color wheels</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </div>
}
