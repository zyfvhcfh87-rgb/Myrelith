import type { EffectPreset } from './effectPresets'
import { COLOR_CURVES_TYPE, DEFAULT_COLOR_CURVES } from './colorCurves'
import { COLOR_WHEELS_TYPE, DEFAULT_COLOR_WHEELS } from './colorWheels'

/** Versioned numeric starting points; no third-party LUT, media or hidden grade. */
export const COLOR_GRADING_RECIPES: readonly (EffectPreset & { readonly description: string })[] = [
  { id: 'gentle-contrast-v1', name: 'Gentle contrast', description: 'A mild master S-curve. Edit its points to suit the shot.', colorLuts: [],
    effects: [{ id: 'recipe-curves', type: COLOR_CURVES_TYPE, version: 1, enabled: true, params: { ...DEFAULT_COLOR_CURVES, master: '[[0,0],[0.25,0.2],[0.75,0.8],[1,1]]' } }] },
  { id: 'lifted-shadows-v1', name: 'Lifted shadows', description: 'Raise dark tones slightly while keeping the white endpoint.', colorLuts: [],
    effects: [{ id: 'recipe-wheels', type: COLOR_WHEELS_TYPE, version: 1, enabled: true, params: { ...DEFAULT_COLOR_WHEELS, liftR: 0.04, liftG: 0.04, liftB: 0.04 } }] },
  { id: 'warm-balance-v1', name: 'Warm balance', description: 'A small warm channel balance, ready for manual adjustment.', colorLuts: [],
    effects: [{ id: 'recipe-wheels', type: COLOR_WHEELS_TYPE, version: 1, enabled: true, params: { ...DEFAULT_COLOR_WHEELS, gainR: 1.03, gainB: 0.97 } }] },
]
